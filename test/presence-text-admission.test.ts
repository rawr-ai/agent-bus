// Every join and leave writes a presence entry whose full-text-indexed body is
// `<address> <status>`, held like any searchable text to 32,768 UTF-8 bytes (message-carrier.ts).
// A join, renewal or takeover is refused before it stages a cursor or writes when its presence
// body would be over the limit; ordinary holdings keep renewing and leaving, and a holding from
// before the limit can still leave. Use the production exact-address cursor files.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { latestPresences, Message, Origin, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { MAX_INDEXED_FIELD_BYTES } from "../src/message-carrier.ts";
import { flureeFetch, freshLedger } from "./fluree-server.ts";

const L = MAX_INDEXED_FIELD_BYTES;
/** The longest address a join admits: `<address> joined` (7 more bytes) at the limit. */
const A = L - " joined".length;
const HOST = "fixture-host";
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const dir = mkdtempSync(join(tmpdir(), "agent-bus-presence-text-"));
const cwd = dir;

const cursorFile = (cursors: string, address: string) =>
  join(cursors, Cursors.cursorFileName(address));

const busOn = async (name: string) => {
  const config = await freshLedger(name);
  const cursors = join(dir, name);
  const runtime = ManagedRuntime.make(
    Bus.layer("fixture", () => HOST).pipe(
      Layer.provideMerge(layerFluree(config).pipe(Layer.provide(platform))),
      Layer.provideMerge(Cursors.layerFiles(cursors)),
      Layer.provide(platform)
    )
  );
  const run = <A, E>(effect: Effect.Effect<A, E, Bus.Bus | Ledger | Cursors.Cursors>) =>
    runtime.runPromise(effect);
  const head = () => run(Effect.flatMap(Ledger, (ledger) => ledger.end));
  const presences = async () =>
    latestPresences((await run(Effect.flatMap(Ledger, (ledger) => ledger.presenceAt()))).entries);
  const joinAs = (address: string, session: string, takeover?: string) =>
    run(
      Effect.flatMap(Bus.Bus, (bus) =>
        bus.join({ address, session, runtime: "other", cwd, ...(takeover ? { takeover } : {}) })
      )
    );
  const leave = (address: string, session: string) =>
    run(Effect.flatMap(Bus.Bus, (bus) => bus.leave(address, session)));
  /** Replay would stage zero if admitted; a refusal must not replace even a retained cursor. */
  const refused = async (address: string, session: string, takeover?: string) => {
    const before = await head();
    const holding = (await presences()).get(address)?.joinId;
    const path = cursorFile(cursors, address);
    const cursor = existsSync(path)
      ? { bytes: readFileSync(path), inode: statSync(path).ino }
      : undefined;
    const error = await run(
      Effect.flip(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({
            address,
            session,
            runtime: "other",
            cwd,
            replay: true,
            ...(takeover ? { takeover } : {}),
          })
        )
      )
    );
    expect(error._tag).toBe("InvalidQuery");
    expect(await head()).toBe(before);
    if (cursor === undefined) expect(existsSync(path)).toBe(false);
    else {
      expect(readFileSync(path)).toEqual(cursor.bytes);
      expect(statSync(path).ino).toBe(cursor.inode);
    }
    expect((await presences()).get(address)?.joinId).toBe(holding);
    return error.message;
  };
  return { config, cursors, runtime, run, head, presences, joinAs, leave, refused };
};
type Fixture = Awaited<ReturnType<typeof busOn>>;
const fixtures: Array<Fixture> = [];
const fixture = async (name: string) => {
  const made = await busOn(name);
  fixtures.push(made);
  return made;
};
afterAll(async () => {
  for (const made of fixtures) await made.runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** An address of exactly `bytes` UTF-8 bytes. */
const addressOf = (bytes: number, fill = "a") => `probe/${fill.repeat(bytes - "probe/".length)}`;
const refusal = (bytes: number) =>
  `This address takes ${bytes} UTF-8 bytes, so the presence every join and leave records for it would be over the 32768-byte limit for searchable text. Nothing was changed. Join under a shorter address.`;

test("a join is refused before any cursor or presence when its presence is over the limit", async () => {
  const bus = await fixture("presence-text");
  expect(A).toBe(32_761);
  expect(await bus.refused(addressOf(A + 1), "s-over")).toBe(refusal(A + 1));
  // Bytes, not characters: 2-byte é makes an address far shorter in characters over the limit.
  const wide = `probe/${"é".repeat((A - 5) / 2)}`;
  expect(Buffer.byteLength(wide, "utf8")).toBe(A + 1);
  expect(wide.length).toBeLessThan(A);
  expect(await bus.refused(wide, "s-wide")).toBe(refusal(A + 1));

  // At the limit the join is admitted, with its digest-named cursor and its presence.
  const address = addressOf(A);
  const before = await bus.head();
  await bus.joinAs(address, "s-limit");
  expect(await bus.head()).toBe(before + 1);
  expect(
    Schema.decodeUnknownSync(Cursors.CursorJson)(
      readFileSync(cursorFile(bus.cursors, address), "utf8")
    )
  ).toEqual({ address, cursor: before });
  expect((await bus.presences()).get(address)?.presence.status).toBe("joined");
}, 120_000);

/** Waits until the ledger's index covers `t`, and returns its complete history read. */
const historyOnceIndexed = async (bus: Fixture, t: number) => {
  const path = `/v1/fluree/info/${encodeURIComponent(bus.config.ledger)}`;
  let indexed = 0;
  for (let attempt = 0; attempt < 300 && indexed < t; attempt++) {
    indexed = ((await (await flureeFetch(path)).json()) as { ledger: { "index-t": number } })
      .ledger["index-t"];
    if (indexed < t) await Bun.sleep(100);
  }
  expect(indexed).toBeGreaterThanOrEqual(t);
  return (await bus.run(Effect.flatMap(Ledger, (ledger) => ledger.read(0)))).entries;
};

/** Seeds a holding from before the limit; its seeded body leaves the address out. */
const seedHolding = (bus: Fixture, address: string, session: string) =>
  bus.run(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const read = yield* ledger.presenceAt();
      const admitted = yield* ledger.admit(
        new Message({
          id: Bun.randomUUIDv7(),
          ts: new Date().toISOString(),
          from: address,
          to: ["*"],
          kind: "presence",
          body: "seeded holding joined",
          origin: new Origin({ host: HOST, cwd }),
          presence: new Presence({ runtime: "other", status: "joined", topics: [], session }),
        }),
        read.cut
      );
      if (admitted.status !== "ADMITTED") throw new Error("Seeded presence not admitted.");
      const cursor = read.cut.head;
      const cursors = yield* Cursors.Cursors;
      yield* cursors.set(address, cursor);
      return cursor;
    })
  );

test("ordinary holders renew and leave; an older over-limit holding can only leave", async () => {
  const bus = await fixture("presence-holdings");
  const ordinary = "probe/ordinary";
  await bus.joinAs(ordinary, "s-ordinary");
  const first = (await bus.presences()).get(ordinary)?.joinId;
  await bus.joinAs(ordinary, "s-ordinary");
  expect((await bus.presences()).get(ordinary)?.presence.rejoinOf).toBe(first);
  await bus.leave(ordinary, "s-ordinary");
  expect((await bus.presences()).get(ordinary)?.presence.status).toBe("left");

  // LEGACY LEAVE EXCEPTION. A holding from before the limit, whose `<address> left` is one byte
  // over it (and `<address> joined` more), seeded into this disposable ledger.
  const legacy = addressOf(A + 3, "b");
  expect(Buffer.byteLength(`${legacy} left`, "utf8")).toBe(L + 1);
  const legacyCursor = await seedHolding(bus, legacy, "s-old");
  expect(legacyCursor).toBeGreaterThan(0);
  const holder = (await bus.presences()).get(legacy)?.joinId;
  if (holder === undefined) throw new Error("Seeded legacy holding not readable.");
  // Its renewal and a takeover would each record the address again: refused, nothing written.
  expect(await bus.refused(legacy, "s-old")).toBe(refusal(A + 3));
  expect(await bus.refused(legacy, "s-new", holder)).toBe(refusal(A + 3));
  // An activity command records no searchable text, so it still applies.
  const activity = await bus.run(
    Effect.flatMap(Bus.Bus, (b) =>
      b.activity({
        address: legacy,
        session: "s-old",
        operation: Bun.randomUUIDv7(),
        activity: "inactive",
      })
    )
  );
  expect(activity.status).toBe("APPLIED");
  // It leaves under the fixed body; `from` and the stored entry still name the address.
  const before = await bus.head();
  await bus.leave(legacy, "s-old");
  const left = (await bus.presences()).get(legacy);
  expect(left?.presence.status).toBe("left");
  expect(left?.presence.session).toBe("s-old");

  // Exactly at the limit, `<address> left` is recorded as is: a holding whose join is over the
  // limit by two bytes, but whose leave is not.
  const edge = addressOf(A + 2, "c");
  expect(Buffer.byteLength(`${edge} left`, "utf8")).toBe(L);
  await seedHolding(bus, edge, "s-edge");
  expect(await bus.refused(edge, "s-edge")).toBe(refusal(A + 2));
  await bus.leave(edge, "s-edge");

  // The indexed history stays readable and holds both leaves as written.
  const entries = await historyOnceIndexed(bus, await bus.head());
  const leaves = entries
    .filter((entry) => entry.end > before && entry.message.presence?.status === "left")
    .map((entry) => entry.message);
  expect(leaves.map((message) => [message.from, message.body])).toEqual([
    [legacy, "An address too long to index left"],
    [edge, `${edge} left`],
  ]);
}, 120_000);

test("an admitted maximal address keeps the indexed ledger's history readable", async () => {
  const bus = await fixture("presence-maximal");
  // One unbroken word: with " joined", the join entry's body is exactly at the limit.
  const address = "a".repeat(A);
  await bus.joinAs(address, "s-max");
  await bus.joinAs(address, "s-max");
  await bus.leave(address, "s-max");
  // The complete history read, which an unindexable term breaks once indexed.
  const entries = await historyOnceIndexed(bus, await bus.head());
  expect(
    entries.filter((entry) => entry.message.from === address).map((e) => e.message.body)
  ).toEqual([`${address} joined`, `${address} joined`, `${address} left`]);
}, 120_000);
