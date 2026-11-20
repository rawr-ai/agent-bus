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
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { type Admission, type EntryRead, Ledger } from "../src/Ledger.ts";
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

/** One serve on `file`, whose Ledger reads and writes can be staged through `seams`. */
const serve = (file: string, seams: Seams = {}) => {
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
    Bus.layer("test-installation").pipe(
      Layer.provideMerge(ledger),
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
const world = async (seams: Seams = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-bus-publish-op-")), "ledger.jsonl");
  const bus = serve(file, seams);
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
      expect(results.filter((result) => result.replayed === true)).toHaveLength(1);
      expect(stored(operation)).toBe(1);
    },
    TIMEOUT
  );
});
