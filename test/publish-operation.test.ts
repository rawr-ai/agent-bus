// A send that names its own id (`operation`) on the JSONL delivery double: the entry stored under
// that id decides every attempt (docs/architecture/messaging.md rule 8). The JSONL ledger can't
// lose an answer or commit a no-op at a coincident commit, so those cases are staged here with a
// Ledger wrapper and run for real against Fluree in test/lifecycle-takeover-race.test.ts.
//
// The oracle is the file itself, parsed here: how many lines hold an entry with the id, and
// whether the file changed at all. It never goes through the Ledger reads under test.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Message } from "../src/domain.ts";
import { type Admission, type EntryRead, Ledger } from "../src/Ledger.ts";
import {
  MAX_ENTRY_CARRIER_BYTES,
  MAX_STORED_ENTRY_BYTES,
  messageCarrierBytes,
  readableEntry,
  storedReadBytes,
} from "../src/message-carrier.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const sender = "claude/sender";
const receiver = "claude/receiver";
const other = "claude/other";
const sid = (address: string) => `session:${address}`;
const TIMEOUT = 20_000;

interface Failure {
  readonly _tag?: string;
  readonly code?: string;
  readonly message?: string;
}
type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: Failure };

/** What a test changes about the next Ledger calls of one serve. */
interface Seams {
  /** Replaces the next readEntry result. */
  readEntry?: (() => Promise<EntryRead | undefined>) | undefined;
  /** Runs instead of the next admit; `write` performs the real one. */
  admit?: ((write: () => Promise<Admission>) => Promise<Admission>) | undefined;
}

const runtimes: Array<{ dispose: () => Promise<void> }> = [];
afterAll(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.dispose()));
});

/** The host name a serve records in each origin; tests can lengthen it between attempts. */
interface Host {
  name: string;
}

/** One serve on `file`, whose Ledger reads and writes can be staged through `seams`. */
const serve = (
  file: string,
  seams: Seams = {},
  host: Host = { name: "fixture-host" },
  /** Every serve made with it reads the same time, as two attempts in one millisecond do. */
  frozen = false,
  /** A lowered stored-entry budget, so its bound is reached without a 32 MiB entry. */
  storedEntryBytes?: number
) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-publish-op-"));
  const ledger = Layer.effect(
    Ledger,
    Effect.map(Ledger, (inner) =>
      Ledger.of({
        ...inner,
        readEntry: (id) =>
          Effect.flatMap(
            Effect.promise(async () => {
              const staged = seams.readEntry;
              seams.readEntry = undefined;
              return staged?.();
            }),
            (staged) => (staged === undefined ? inner.readEntry(id) : Effect.succeed(staged))
          ),
        admit: (message, basis) => {
          const staged = seams.admit;
          if (staged === undefined) return inner.admit(message, basis);
          seams.admit = undefined;
          return Effect.promise(() => staged(() => Effect.runPromise(inner.admit(message, basis))));
        },
      })
    )
  ).pipe(Layer.provideMerge(layerJsonl(file).pipe(Layer.provide(platform))));
  const runtime = ManagedRuntime.make(
    Bus.layer("test-installation", () => host.name, storedEntryBytes).pipe(
      Layer.provideMerge(ledger),
      Layer.provideMerge(frozen ? TestClock.layer() : Layer.empty),
      Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
      Layer.provide(platform)
    )
  );
  runtimes.push(runtime);
  const outcome = <A, E>(effect: Effect.Effect<A, E, Bus.Bus | Ledger>): Promise<Outcome<A>> =>
    runtime.runPromise(
      Effect.match(effect, {
        onFailure: (error): Outcome<A> => ({ ok: false, error: error as Failure }),
        onSuccess: (value): Outcome<A> => ({ ok: true, value }),
      })
    );
  return {
    join: (address: string, extra: Partial<Bus.JoinInput> = {}) =>
      outcome(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({
            address,
            runtime: "claude",
            session: sid(address),
            cwd: process.cwd(),
            ...extra,
          })
        )
      ),
    leave: (address: string) =>
      outcome(Effect.flatMap(Bus.Bus, (bus) => bus.leave(address, sid(address)))),
    publish: (input: Partial<Bus.PublishInput> & { readonly body: string }) =>
      outcome(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.publish({ from: sender, session: sid(sender), to: [receiver], ...input })
        )
      ),
    activity: (address: string, activity: "active" | "inactive") =>
      outcome(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.activity({
            address,
            session: sid(address),
            operation: Bun.randomUUIDv7(),
            activity,
          })
        )
      ),
    take: (address: string) =>
      runtime.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          Effect.map(bus.take(address, sid(address)), (entries) =>
            entries.filter((entry) => entry.kind === "message").map((entry) => entry.id)
          )
        )
      ),
    peer: (address: string) =>
      runtime.runPromise(
        Effect.map(
          Effect.flatMap(Bus.Bus, (bus) => bus.peers),
          (peers) => peers.find((peer) => peer.address === address)
        )
      ),
  };
};

/** A fresh file with the sender and receiver joined on one serve. */
const world = async (seams: Seams = {}, host?: Host, storedEntryBytes?: number) => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-bus-publish-op-")), "ledger.jsonl");
  const bus = serve(file, seams, host, false, storedEntryBytes);
  for (const address of [sender, receiver]) {
    const joined = await bus.join(address, { topics: ["watch"] });
    if (!joined.ok) throw new Error(`join failed: ${joined.error.message}`);
  }
  /** The file's text: unchanged text means nothing was written. */
  const text = () => readFileSync(file, "utf8");
  /** How many lines hold an entry with this id, read from the file directly. */
  const stored = (id: string) =>
    text()
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith('{"@command":'))
      .filter((line) => (JSON.parse(line) as { id?: unknown }).id === id).length;
  return { file, bus, text, stored };
};

const sent = (result: Outcome<Bus.Posted | Bus.NotSent>) => {
  if (!result.ok) throw new Error(`publish failed: ${result.error._tag}: ${result.error.message}`);
  if ("status" in result.value) throw new Error("publish returned a preview");
  return result.value;
};
const preview = (result: Outcome<Bus.Posted | Bus.NotSent>) => {
  if (!result.ok) throw new Error(`publish failed: ${result.error.message}`);
  if (!("status" in result.value)) throw new Error("publish sent instead of previewing");
  return result.value;
};
const refused = (result: Outcome<unknown>) => {
  if (result.ok) throw new Error("the call was not refused");
  return result.error;
};
const mismatch = (result: Outcome<unknown>) => {
  const error = refused(result);
  expect(error._tag).toBe("InvalidQuery");
  expect(error.code).toBe("IDENTITY_MISMATCH");
  expect(error.message).toContain("Nothing was written");
  return error;
};

describe("publish with an operation (jsonl)", () => {
  test(
    "the same send twice is stored once and returns the original id and ts, replayed",
    async () => {
      const { bus, stored } = await world();
      const operation = Bun.randomUUIDv7();
      const first = sent(await bus.publish({ body: "once", operation }));
      await Bun.sleep(2);
      const second = sent(await bus.publish({ body: "once", operation }));

      expect(first.message.id).toBe(operation);
      expect(first.replayed).toBeUndefined();
      expect(second.replayed).toBe(true);
      expect(second.message.id).toBe(operation);
      expect(second.message.ts).toBe(first.message.ts);
      expect(stored(operation)).toBe(1);
      expect(await bus.take(receiver)).toEqual([operation]);
    },
    TIMEOUT
  );

  test(
    "without an operation nothing changes: a fresh id, no replayed, and a repeat is a new message",
    async () => {
      const { bus, stored } = await world();
      const first = sent(await bus.publish({ body: "plain" }));
      const second = sent(await bus.publish({ body: "plain" }));
      expect(first.replayed).toBeUndefined();
      expect(second.replayed).toBeUndefined();
      expect(second.message.id).not.toBe(first.message.id);
      expect(stored(first.message.id)).toBe(1);
      expect(await bus.take(receiver)).toEqual([first.message.id, second.message.id]);
    },
    TIMEOUT
  );

  test.each([
    ["body", { body: "changed" }],
    ["subject", { subject: "another subject" }],
    ["replyTo", { replyTo: Bun.randomUUIDv7() }],
    ["audience", { to: [receiver] }],
    ["audience order", { to: ["#watch", receiver] }],
    ["named pierce", { to: ["#watch"], pierce: [receiver] }],
  ] as const)(
    "the same operation with a different %s is an identity mismatch that writes nothing",
    async (_, change) => {
      const { bus, text } = await world();
      const operation = Bun.randomUUIDv7();
      sent(
        await bus.publish({
          body: "original",
          subject: "subject",
          to: [receiver, "#watch"],
          operation,
        })
      );
      const before = text();
      const error = mismatch(
        await bus.publish({
          body: "original",
          subject: "subject",
          to: [receiver, "#watch"],
          ...change,
          operation,
        })
      );
      expect(error.message).not.toContain("original");
      expect(text()).toBe(before);
    },
    TIMEOUT
  );

  test(
    "an omitted pierce, [] and a pierce of only direct recipients are the same send",
    async () => {
      const { bus, stored } = await world();
      const operation = Bun.randomUUIDv7();
      sent(await bus.publish({ body: "same", operation }));
      for (const pierce of [[], [receiver], [receiver, receiver]]) {
        expect(sent(await bus.publish({ body: "same", pierce, operation })).replayed).toBe(true);
      }
      expect(stored(operation)).toBe(1);
    },
    TIMEOUT
  );

  test(
    "a named pierce retried in another order or with repeats replays: it compares as stored",
    async () => {
      const { bus, stored } = await world();
      expect((await bus.join(other, { topics: ["watch"] })).ok).toBe(true);
      const operation = Bun.randomUUIDv7();
      const first = sent(
        await bus.publish({ body: "two", to: ["#watch"], pierce: [receiver, other], operation })
      );
      expect(first.message.pierce).toEqual([other, receiver].sort());
      for (const pierce of [
        [other, receiver],
        [receiver, other, receiver],
      ]) {
        const retry = sent(await bus.publish({ body: "two", to: ["#watch"], pierce, operation }));
        expect(retry.replayed).toBe(true);
      }
      mismatch(await bus.publish({ body: "two", to: ["#watch"], pierce: [other], operation }));
      expect(stored(operation)).toBe(1);
    },
    TIMEOUT
  );

  test(
    "a named pierce retry replays after the pierced peer has left",
    async () => {
      const { bus, stored } = await world();
      const operation = Bun.randomUUIDv7();
      const call = { body: "pierced", to: ["#watch"], pierce: [receiver], operation };
      const first = sent(await bus.publish(call));
      expect(first.message.pierce).toEqual([receiver]);
      expect((await bus.leave(receiver)).ok).toBe(true);
      const retry = sent(await bus.publish(call));
      expect(retry.replayed).toBe(true);
      expect(retry.message.ts).toBe(first.message.ts);
      expect(stored(operation)).toBe(1);
    },
    TIMEOUT
  );

  test(
    "a confirmed pierce of all replays by its stored set, though the set would now differ",
    async () => {
      const { bus, text, stored } = await world();
      expect((await bus.activity(receiver, "inactive")).ok).toBe(true);
      const operation = Bun.randomUUIDv7();
      const call = { body: "everyone", to: ["#watch"], pierce: "all" as const, operation };
      const first = preview(await bus.publish(call));
      expect(first.bypass).toEqual([receiver]);
      const confirmed = sent(await bus.publish({ ...call, confirm: first.digest }));
      expect(confirmed.message.pierce).toEqual([receiver]);

      // Another suppressed subscriber: a fresh preview would now name a different set.
      expect((await bus.join(other, { topics: ["watch"] })).ok).toBe(true);
      expect((await bus.activity(other, "inactive")).ok).toBe(true);
      const now = preview(await bus.publish({ ...call, operation: Bun.randomUUIDv7() }));
      expect(now.bypass).toEqual([other, receiver]);

      const retry = sent(await bus.publish({ ...call, confirm: first.digest }));
      expect(retry.replayed).toBe(true);
      expect(retry.message.ts).toBe(confirmed.message.ts);
      const before = text();
      mismatch(await bus.publish({ ...call, confirm: now.digest }));
      // Without confirm it is not the confirmed send, though the same message.
      mismatch(await bus.publish(call));
      expect(text()).toBe(before);
      expect(stored(operation)).toBe(1);
    },
    TIMEOUT
  );

  test(
    "ownership comes first: a retry after a takeover or a leave is refused and writes nothing",
    async () => {
      const { bus, text, stored } = await world();
      const operation = Bun.randomUUIDv7();
      sent(await bus.publish({ body: "mine", operation }));
      const holding = await bus.peer(sender);

      // A renewal by the same session keeps the address: the retry replays.
      expect((await bus.join(sender)).ok).toBe(true);
      expect(sent(await bus.publish({ body: "mine", operation })).replayed).toBe(true);

      const taken = await bus.join(sender, {
        session: "session:successor",
        takeover: (await bus.peer(sender))?.joinId ?? holding?.joinId,
      });
      expect(taken.ok).toBe(true);
      const before = text();
      const retry = refused(await bus.publish({ body: "mine", operation }));
      const fresh = refused(await bus.publish({ body: "mine", operation: Bun.randomUUIDv7() }));
      expect(retry._tag).toBe("NotOwner");
      // The refusal neither reveals whether the operation names a stored entry nor claims
      // that nothing was sent: an earlier attempt may have committed.
      expect(retry.message).toBe(
        (fresh.message ?? "").replace(/operation \S+:/, `operation ${operation}:`)
      );
      expect(retry.message).toContain("may have committed");
      expect(retry.message).not.toMatch(/nothing was (sent|changed|written)/i);
      expect(text()).toBe(before);
      expect(stored(operation)).toBe(1);
    },
    TIMEOUT
  );

  test(
    "a retry after the sender left is refused and writes nothing",
    async () => {
      const { bus, text } = await world();
      const operation = Bun.randomUUIDv7();
      sent(await bus.publish({ body: "before leaving", operation }));
      expect((await bus.leave(sender)).ok).toBe(true);
      const before = text();
      const error = refused(await bus.publish({ body: "before leaving", operation }));
      expect(error._tag).toBe("NotJoined");
      expect(error.message).toContain(`operation ${operation}`);
      expect(error.message).not.toMatch(/nothing was (sent|changed|written)/i);
      expect(text()).toBe(before);
    },
    TIMEOUT
  );

  test(
    "an operation naming a presence or another address's message is a mismatch",
    async () => {
      const { bus, text, stored } = await world();
      const presence = (await bus.peer(receiver))?.joinId;
      if (presence === undefined) throw new Error("the receiver has no join id");
      expect((await bus.join(other)).ok).toBe(true);
      const theirs = Bun.randomUUIDv7();
      const sentByOther = await bus.publish({
        from: other,
        session: sid(other),
        body: "same body",
        operation: theirs,
      });
      sent(sentByOther);
      const before = text();
      mismatch(await bus.publish({ body: "same body", operation: presence }));
      mismatch(await bus.publish({ body: "same body", operation: theirs }));
      expect(text()).toBe(before);
      expect(stored(theirs)).toBe(1);
    },
    TIMEOUT
  );

  test.each([
    ["uppercase", () => Bun.randomUUIDv7().toUpperCase()],
    ["UUIDv4", () => crypto.randomUUID()],
    ["not a UUID", () => "retry-1"],
  ])("an operation that is %s is refused before anything is read or written", async (_, make) => {
    let reads = 0;
    const seams: Seams = {};
    const { bus, text } = await world(seams);
    seams.readEntry = async () => {
      reads++;
      return undefined;
    };
    const before = text();
    const error = refused(await bus.publish({ body: "bad id", operation: make() }));
    expect(error._tag).toBe("InvalidQuery");
    expect(error.message).toContain("lowercase UUIDv7");
    expect(reads).toBe(0);
    expect(text()).toBe(before);
  });

  test(
    "an unreadable stored entry before the write sends nothing",
    async () => {
      const seams: Seams = {};
      const { bus, text, stored } = await world(seams);
      const operation = Bun.randomUUIDv7();
      seams.readEntry = async () => ({ status: "UNAVAILABLE" });
      const before = text();
      const error = refused(await bus.publish({ body: "unread", operation }));
      expect(error._tag).toBe("LedgerError");
      expect(error.message).toContain("nothing was sent");
      expect(text()).toBe(before);
      expect(stored(operation)).toBe(0);
    },
    TIMEOUT
  );

  test(
    "an answer lost after the write is settled by the stored entry; lost before it, a retry sends once",
    async () => {
      const seams: Seams = {};
      const { bus, stored } = await world(seams);

      const landed = Bun.randomUUIDv7();
      seams.admit = async (write) => {
        await write();
        return { status: "UNKNOWN" };
      };
      const settled = sent(await bus.publish({ body: "landed", operation: landed }));
      expect(settled.message.id).toBe(landed);
      expect(settled.replayed).toBeUndefined();
      expect(stored(landed)).toBe(1);

      const lost = Bun.randomUUIDv7();
      seams.admit = async () => ({ status: "UNKNOWN" });
      const error = refused(await bus.publish({ body: "lost", operation: lost }));
      expect(error._tag).toBe("LedgerError");
      expect(error.message).toContain("it may have committed");
      expect(error.message).toContain(`Retry the identical call with operation ${lost}`);
      expect(stored(lost)).toBe(0);
      const retry = sent(await bus.publish({ body: "lost", operation: lost }));
      expect(retry.replayed).toBeUndefined();
      expect(stored(lost)).toBe(1);
      expect(await bus.take(receiver)).toEqual([landed, lost]);
    },
    TIMEOUT
  );

  test(
    "an unconfirmed send without an operation names the id that retries it safely",
    async () => {
      const seams: Seams = {};
      const { bus, stored } = await world(seams);
      seams.admit = async (write) => {
        await write();
        return { status: "UNKNOWN" };
      };
      const error = refused(await bus.publish({ body: "unnamed" }));
      const id = /operation ([0-9a-f-]{36})/.exec(error.message ?? "")?.[1];
      if (id === undefined) throw new Error(`no id in: ${error.message}`);
      expect(stored(id)).toBe(1);
      const retry = sent(await bus.publish({ body: "unnamed", operation: id }));
      expect(retry.replayed).toBe(true);
      expect(stored(id)).toBe(1);
    },
    TIMEOUT
  );

  test(
    "two serves racing one operation store it once and both answer with it",
    async () => {
      const seamsA: Seams = {};
      const seamsB: Seams = {};
      const { file, bus: a, stored } = await world(seamsA);
      const b = serve(file, seamsB);
      const operation = Bun.randomUUIDv7();
      // Both look the operation up before either writes.
      const looked = Effect.runSync(Deferred.make<void>());
      const both = { count: 0 };
      const barrier = async () => {
        both.count++;
        if (both.count === 2) Effect.runSync(Deferred.succeed(looked, undefined));
        await Effect.runPromise(Deferred.await(looked));
        return undefined;
      };
      seamsA.readEntry = barrier;
      seamsB.readEntry = barrier;
      const [first, second] = await Promise.all([
        a.publish({ body: "raced", operation }),
        b.publish({ body: "raced", operation }),
      ]);
      const results = [sent(first), sent(second)];
      expect(both.count).toBe(2);
      expect(results.map((result) => result.message.id)).toEqual([operation, operation]);
      expect(results[0]?.message.ts).toBe(results[1]?.message.ts ?? "");
      // Which attempt wrote it is not asserted: `replayed` promises only that its call wrote
      // nothing, and its absence only that the message is stored once.
      expect(stored(operation)).toBe(1);
    },
    TIMEOUT
  );

  test(
    "two identical attempts with one time and origin, both read as admitted: stored once, neither claims too much",
    async () => {
      const file = join(mkdtempSync(join(tmpdir(), "agent-bus-publish-op-")), "ledger.jsonl");
      const host: Host = { name: "fixture-host" };
      const seamsA: Seams = {};
      const seamsB: Seams = {};
      const a = serve(file, seamsA, host, true);
      const b = serve(file, seamsB, host, true);
      for (const address of [sender, receiver]) expect((await a.join(address)).ok).toBe(true);
      const text = () => readFileSync(file, "utf8");
      const operation = Bun.randomUUIDv7();
      const looked = Effect.runSync(Deferred.make<void>());
      let waiting = 0;
      const barrier = async () => {
        waiting++;
        if (waiting === 2) Effect.runSync(Deferred.succeed(looked, undefined));
        await Effect.runPromise(Deferred.await(looked));
        return undefined;
      };
      seamsA.readEntry = barrier;
      seamsB.readEntry = barrier;
      // As Fluree answers a guarded insert that found the id taken at a coincident commit:
      // the attempt is reported admitted though it committed nothing.
      const misread = async (write: () => Promise<Admission>) => {
        const real = await write();
        return real.status === "REFUSED" ? { status: "ADMITTED" as const, cut: real.cut } : real;
      };
      seamsA.admit = misread;
      seamsB.admit = misread;
      const results = (
        await Promise.all([
          a.publish({ body: "same instant", operation }),
          b.publish({ body: "same instant", operation }),
        ])
      ).map(sent);
      const lines = text()
        .split("\n")
        .filter((line) => line.includes(`"id":"${operation}"`));
      expect(lines).toHaveLength(1);
      for (const result of results) {
        expect(result.message.id).toBe(operation);
        expect(result.message.ts).toBe(results[0]?.message.ts ?? "");
        // Same time and origin: nothing certain says either wrote nothing, so neither says so.
        expect(result.replayed).toBeUndefined();
      }
    },
    TIMEOUT
  );

  test(
    "a stored entry that cannot be read back after the write is unconfirmed, never a mismatch",
    async () => {
      const seams: Seams = {};
      const { bus, stored } = await world(seams);
      const operation = Bun.randomUUIDv7();
      // The lookup reads for real; the read after the write fails.
      seams.readEntry = async () => {
        seams.readEntry = async () => ({ status: "UNAVAILABLE" });
        return undefined;
      };
      const error = refused(await bus.publish({ body: "unread after", operation }));
      expect(error._tag).toBe("LedgerError");
      expect(error.code).toBeUndefined();
      expect(error.message).toContain("it may have committed");
      expect(error.message).toContain(`Retry the identical call with operation ${operation}`);
      expect(stored(operation)).toBe(1);
      const retry = sent(await bus.publish({ body: "unread after", operation }));
      expect(retry.replayed).toBe(true);
      expect(stored(operation)).toBe(1);
    },
    TIMEOUT
  );
  test(
    "a send stored at the carrier bound replays after its origin grows; a new one is refused",
    async () => {
      const host: Host = { name: "fixture-host" };
      const { bus, text, stored } = await world({}, host);
      // The origin this serve records, taken from a stored probe, so the bound can be met.
      const probe = sent(await bus.publish({ body: "probe", operation: Bun.randomUUIDv7() }));
      const carrier = (pad: number) =>
        messageCarrierBytes([
          new Message({
            id: Bun.randomUUIDv7(),
            ts: probe.message.ts,
            from: sender,
            to: [receiver, `claude/${"p".repeat(pad)}`],
            kind: "message",
            body: "at the bound",
            ...(probe.message.origin === undefined ? {} : { origin: probe.message.origin }),
          }),
        ]);
      // Recipients count in the carrier but not in the searchable-text limit: pad one.
      let pad = 0;
      for (let step = 0; step < 8; step++) {
        pad += Math.floor((MAX_ENTRY_CARRIER_BYTES - carrier(pad)) / 2);
      }
      const bytes = carrier(pad);
      expect(bytes).toBeLessThanOrEqual(MAX_ENTRY_CARRIER_BYTES);
      // Every ASCII character counts twice, so the bound is met exactly or one byte under.
      expect(bytes).toBeGreaterThanOrEqual(MAX_ENTRY_CARRIER_BYTES - 1);
      const call = {
        body: "at the bound",
        to: [receiver, `claude/${"p".repeat(pad)}`],
      };

      const operation = Bun.randomUUIDv7();
      const first = sent(await bus.publish({ ...call, operation }));
      expect(messageCarrierBytes([first.message])).toBe(bytes);
      expect(stored(operation)).toBe(1);

      // The same holder's origin grows past what the bound left: the stored send still answers.
      host.name = `${host.name}-with-a-longer-name`;
      const before = text();
      const retry = sent(await bus.publish({ ...call, operation }));
      expect(retry.replayed).toBe(true);
      expect(retry.message.id).toBe(operation);
      expect(retry.message.ts).toBe(first.message.ts);
      expect(text()).toBe(before);

      // The identical inputs as a new send now exceed the bound: refused, nothing written.
      const fresh = Bun.randomUUIDv7();
      const error = refused(await bus.publish({ ...call, operation: fresh }));
      expect(error._tag).toBe("InvalidQuery");
      expect(error.message).toContain("This message is too large");
      expect(error.message).toContain("Nothing was sent or written");
      expect(text()).toBe(before);
      expect(stored(fresh)).toBe(0);
    },
    TIMEOUT
  );
  describe("a new send's stored entry fits the point read", () => {
    const call = {
      body: "sized \u00e9 \u{1f680}",
      to: ["#watch"],
      pierce: [receiver],
    };
    /** The stored-read bytes of the entry this call stores, from a probe's time and origin. */
    const sizeOf = async (host: Host) => {
      const { bus } = await world({}, host);
      const probe = sent(await bus.publish({ body: "probe", operation: Bun.randomUUIDv7() }));
      return storedReadBytes(
        new Message({
          id: Bun.randomUUIDv7(),
          ts: probe.message.ts,
          from: sender,
          to: [...call.to],
          kind: "message",
          body: call.body,
          ...(probe.message.origin === undefined ? {} : { origin: probe.message.origin }),
          pierce: [...call.pierce],
        })
      );
    };

    test("the pierce set and the escaping a read applies both count", () => {
      const base = new Message({
        id: Bun.randomUUIDv7(),
        ts: new Date().toISOString(),
        from: sender,
        to: ["#watch"],
        kind: "message",
        body: "plain",
      });
      const pierced = new Message({ ...base, pierce: ["claude/a", "claude/b"] });
      expect(storedReadBytes(pierced)).toBeGreaterThan(storedReadBytes(base));
      // One non-ASCII character counts as a six-byte escape, not its two UTF-8 bytes.
      const accented = new Message({ ...base, body: "plain\u00e9" });
      expect(storedReadBytes(accented) - storedReadBytes(base)).toBe(6);
      // A quote counts as the read escapes it: twice in the stored JSON's own string escape.
      const quoted = new Message({ ...base, body: 'plain"' });
      expect(storedReadBytes(quoted) - storedReadBytes(base)).toBe(4);
      expect(MAX_STORED_ENTRY_BYTES).toBeLessThan(32 * 1024 * 1024);
      const size = storedReadBytes(pierced);
      expect(Effect.runSync(Effect.exit(readableEntry(pierced, size)))._tag).toBe("Success");
      expect(Effect.runSync(Effect.exit(readableEntry(pierced, size - 1)))._tag).toBe("Failure");
    });

    for (const named of [true, false]) {
      test(
        `${named ? "with" : "without"} an operation: exactly at the budget it is sent; one byte over, nothing is written`,
        async () => {
          const host: Host = { name: "fixture-host" };
          const size = await sizeOf(host);

          const fits = await world({}, host, size);
          const operation = Bun.randomUUIDv7();
          const ok = sent(await fits.bus.publish({ ...call, ...(named ? { operation } : {}) }));
          expect(ok.message.pierce).toEqual([receiver]);
          expect(storedReadBytes(ok.message)).toBe(size);
          expect(fits.stored(ok.message.id)).toBe(1);

          const over = await world({}, host, size - 1);
          const before = over.text();
          const error = refused(
            await over.bus.publish({ ...call, ...(named ? { operation } : {}) })
          );
          expect(error._tag).toBe("InvalidQuery");
          expect(error.message).toContain(`would take ${size} bytes to read back`);
          expect(error.message).toContain("Nothing was sent or written");
          expect(over.text()).toBe(before);
          if (named) expect(over.stored(operation)).toBe(0);
        },
        TIMEOUT
      );
    }

    test(
      "a stored send replays without being sized again",
      async () => {
        const host: Host = { name: "fixture-host" };
        const size = await sizeOf(host);
        const { file, bus, stored } = await world({}, host, size);
        const operation = Bun.randomUUIDv7();
        const first = sent(await bus.publish({ ...call, operation }));
        // A serve whose budget no entry fits still answers the stored send.
        const tight = serve(file, {}, host, false, 1);
        const retry = sent(await tight.publish({ ...call, operation }));
        expect(retry.replayed).toBe(true);
        expect(retry.message.ts).toBe(first.message.ts);
        expect(stored(operation)).toBe(1);
        expect(refused(await tight.publish({ ...call, operation: Bun.randomUUIDv7() }))._tag).toBe(
          "InvalidQuery"
        );
      },
      TIMEOUT
    );
  });
});
