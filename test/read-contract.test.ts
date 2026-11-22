// The read-and-acknowledge contract on the JSONL test ledger: keyed reads and their replay,
// peeks and bus_ack, and the refusals that write nothing. The Fluree-only cases (real damage,
// races, uncertain writes, the MCP wire) are in read-contract-fluree.test.ts.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer } from "effect";
import type * as Bus from "../src/Bus.ts";
import { runOf } from "../src/domain.ts";
import { Ledger } from "../src/Ledger.ts";
import { type MailboxAck, mailboxServedDigest, mailboxTopicsDigest } from "../src/mailbox-model.ts";
import { carrierBytes, EMPTY_READ_RESULT_BYTES, readResult } from "../src/message-carrier.ts";
import type { WakeCoverage } from "../src/wake-observation.ts";
import { layerJsonl } from "./jsonl-ledger.ts";
import {
  ack,
  acks,
  bus,
  cwd,
  failure,
  head,
  hold,
  holdingOf,
  ids,
  inbox,
  joinInbox,
  joinSender,
  leaveInbox,
  type Machine,
  machine,
  mailbox,
  owner,
  type Probe,
  platform,
  position,
  READ_ID,
  reached,
  read,
  receiptOf,
  release,
  replayedReceipt,
  send,
  successor,
  wait,
} from "./read-contract-support.ts";

const TIMEOUT = 60_000;

/** A fresh JSONL ledger and one installation's Bus over it, removed however the test ends. */
const fixture = async (
  body: (context: {
    readonly a: Machine;
    readonly file: string;
    readonly root: string;
    readonly probe: Probe;
    readonly another: (probe?: Probe) => Machine;
  }) => Promise<void>
) => {
  const root = mkdtempSync(join(tmpdir(), "agent-bus-read-contract-"));
  const file = join(root, "ledger.jsonl");
  const store = layerJsonl(file).pipe(Layer.provide(platform));
  const probe: Probe = {};
  const machines: Array<Machine> = [];
  const another = (extra: Probe = {}) => {
    const runtime = machine(store, root, "installation-a", extra);
    machines.push(runtime);
    return runtime;
  };
  const a = another(probe);
  try {
    await body({ a, file, root, probe, another });
  } finally {
    await Promise.all(machines.map((runtime) => runtime.dispose()));
    rmSync(root, { recursive: true, force: true });
  }
};

/** The exact public result size of an outcome, as the MCP carrier counts it. */
const bytesOf = (outcome: Bus.ReadOutcome) =>
  carrierBytes(readResult(outcome.messages, outcome.receipt, outcome.nextReadId));

const peekReceipt = (outcome: Bus.ReadOutcome): Bus.AckInput["receipt"] => {
  const receipt = outcome.receipt;
  if (receipt?.basis === undefined || receipt.served === undefined)
    throw new Error("The peek returned no peek receipt.");
  return {
    readId: receipt.readId,
    from: receipt.from,
    through: receipt.through,
    basis: receipt.basis,
    served: receipt.served,
  };
};

test.each(["bus_read", "bus_wait"] as const)(
  "a lost result is recovered by repeating %s with its readId after later reads, writing nothing",
  (via) =>
    fixture(async ({ a }) => {
      const joined = await joinInbox(a);
      await joinSender(a);
      // The join's own id keys the first read, so no caller ever mints one.
      expect(joined.nextReadId).toMatch(READ_ID);
      const readId = joined.nextReadId;
      const first = await send(a, inbox, "first");
      const lost = await read(a, { readId });
      expect(ids(lost)).toEqual([first.id]);
      expect(lost.receipt).toEqual({
        readId,
        from: joined.cursor,
        through: await position(a),
        replayed: false,
      });
      const stored = await receiptOf(a, readId);
      expect(stored.status === "FOUND" && stored.record.operation).toBe(readId);
      const second = await send(a, inbox, "second");
      const later = await read(a, { readId: lost.nextReadId });
      expect(ids(later)).toEqual([second.id]);

      const before = { head: await head(a), position: await position(a), acks: await acks(a) };
      const again =
        via === "bus_read"
          ? await read(a, { readId })
          : await wait(a, { readId, timeoutSeconds: 0 });
      expect(ids(again)).toEqual([first.id]);
      expect(again.messages).toEqual(lost.messages);
      expect(again.receipt).toEqual(replayedReceipt(lost.receipt));
      expect({ head: await head(a), position: await position(a), acks: await acks(a) }).toEqual(
        before
      );
      // A replay hands out an id distinct from every id used so far.
      const used = [readId, lost.nextReadId, later.nextReadId, later.receipt?.readId];
      expect(again.nextReadId).toMatch(READ_ID);
      expect(used).not.toContain(again.nextReadId);
    }),
  TIMEOUT
);

test(
  "a keyed read that returns nothing writes nothing and leaves its id for a fresh read",
  () =>
    fixture(async ({ a }) => {
      const { nextReadId: readId } = await joinInbox(a);
      await joinSender(a);
      const before = await head(a);
      const empty = await read(a, { readId });
      expect(empty).toEqual({ messages: [], nextReadId: expect.stringMatching(READ_ID) });
      expect(empty.nextReadId).not.toBe(readId);
      expect(await head(a)).toBe(before);
      expect((await receiptOf(a, readId)).status).toBe("ABSENT");
      const mail = await send(a, inbox, "after the empty read");
      const fresh = await read(a, { readId });
      expect(ids(fresh)).toEqual([mail.id]);
      expect(fresh.receipt).toMatchObject({ readId, replayed: false });
      expect((await receiptOf(a, readId)).status).toBe("FOUND");
    }),
  TIMEOUT
);

test(
  "an un-keyed read is unchanged, and carries a receipt naming the id the bus chose",
  () =>
    fixture(async ({ a }) => {
      await joinInbox(a);
      await joinSender(a);
      const mail = await send(a, inbox, "un-keyed");
      const outcome = await read(a);
      expect(ids(outcome)).toEqual([mail.id]);
      const chosen = outcome.receipt?.readId ?? "";
      expect(chosen).toMatch(READ_ID);
      expect((await acks(a)).map(({ operation }) => operation)).toEqual([chosen]);
      expect((await read(a)).messages).toEqual([]);
    }),
  TIMEOUT
);

test(
  "a same-run renewal that changes topics still replays the batch served under the old topics",
  () =>
    fixture(async ({ a }) => {
      const { nextReadId: readId } = await joinInbox(a, { topics: ["alpha"] });
      await joinSender(a);
      const alpha = await send(a, "#alpha", "alpha mail");
      const direct = await send(a, inbox, "direct mail");
      const served = await read(a, { readId });
      expect(ids(served)).toEqual([alpha.id, direct.id]);
      const run = runOf(await holdingOf(a));
      await joinInbox(a, { topics: ["beta"] });
      expect(runOf(await holdingOf(a))).toBe(run);
      const beta = await send(a, "#beta", "beta mail");
      const before = await head(a);
      const again = await read(a, { readId });
      expect(ids(again)).toEqual([alpha.id, direct.id]);
      expect(again.receipt?.replayed).toBe(true);
      expect(await head(a)).toBe(before);
      expect(ids(await read(a))).toEqual([beta.id]);
    }),
  TIMEOUT
);

const runEnds = {
  "a leave and rejoin": async (runtime: Machine) => {
    await leaveInbox(runtime);
    await joinInbox(runtime);
    return owner;
  },
  "a replay join": async (runtime: Machine) => {
    await joinInbox(runtime, { replay: true });
    return owner;
  },
  "a takeover": async (runtime: Machine) => {
    const { joinId } = await holdingOf(runtime);
    await joinInbox(runtime, { session: successor, takeover: joinId });
    return successor;
  },
} as const;

for (const [ending, end] of Object.entries(runEnds)) {
  test(
    `after ${ending}, a recorded readId is refused for replay and bus_ack; an unused one reads fresh`,
    () =>
      fixture(async ({ a }) => {
        const { nextReadId: keyed } = await joinInbox(a);
        await joinSender(a);
        await send(a, inbox, "read by key");
        const served = await read(a, { readId: keyed });
        await send(a, inbox, "peeked and acknowledged");
        const peeked = await read(a, { peek: true, readId: served.nextReadId });
        await ack(a, peekReceipt(peeked));
        const unused = Bun.randomUUIDv7();
        const session = await end(a);
        const before = await head(a);
        const earlier = "was recorded in an earlier run of this holding";
        expect(await failure(read(a, { session, readId: keyed }))).toContain(earlier);
        expect(await failure(ack(a, peekReceipt(peeked), session))).toContain(earlier);
        expect(await head(a)).toBe(before);
        await send(a, inbox, "after the new run began");
        const fresh = await read(a, { session, readId: unused });
        expect(fresh.receipt).toMatchObject({ readId: unused, replayed: false });
      }),
    TIMEOUT
  );
}

test(
  "a replay refits only within limits that hold the whole recorded batch, naming what it needs",
  () =>
    fixture(async ({ a }) => {
      const { nextReadId: readId } = await joinInbox(a);
      await joinSender(a);
      await send(a, inbox, 'quoted " \\ €\n  and \u0001 control');
      await send(a, inbox, "second commit");
      const served = await read(a, { readId });
      expect(served.messages).toHaveLength(2);
      // Fitted exactly, it replays at that size: true is a byte shorter than false in each copy.
      const exact = bytesOf(served);
      const replay = await read(a, { readId, maxResultBytes: exact });
      const needed = bytesOf(replay);
      expect(needed).toBe(exact - 2);
      const before = await head(a);
      for (const [limits, expected] of [
        [{ maxResultBytes: needed - 1 }, `needs ${needed} result bytes and a limit of at least 2`],
        [{ limit: 1 }, "a limit of at least 2"],
      ] as const) {
        expect(await failure(read(a, { readId, ...limits }))).toContain(expected);
        expect(await head(a)).toBe(before);
      }
      expect(ids(await read(a, { readId, maxResultBytes: needed, limit: 2 }))).toEqual(ids(served));
    }),
  TIMEOUT
);

test(
  "readIds that name no replayable batch of this address are refused, writing and disclosing nothing",
  () =>
    fixture(async ({ a, probe }) => {
      const other = "fixture/read-contract-other";
      await joinInbox(a);
      await joinSender(a);
      await bus(a, (service) =>
        service.join({ address: other, runtime: "other", session: "session:other", cwd })
      );
      const othersRead = Bun.randomUUIDv7();
      const secret = await send(a, other, "SECRET-BODY-of-another-address");
      await bus(a, (service) =>
        service.read({ address: other, session: "session:other", readId: othersRead })
      );

      await send(a, inbox, "acknowledged before the checkpoint");
      const served = await read(a);
      const real = served.receipt?.readId ?? "";
      const realFound = await receiptOf(a, real);
      if (realFound.status !== "FOUND") throw new Error("Missing the recorded read.");
      await send(a, "fixture/elsewhere", "moves the head");
      // A checkpoint, as D2 may write one: a position that served no batch.
      const holding = await holdingOf(a);
      const checkpoint = Bun.randomUUIDv7();
      await a.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const basis = (yield* ledger.presenceAt()).cut;
          const record: MailboxAck = {
            version: 1,
            kind: "ack",
            operation: checkpoint,
            address: inbox,
            mode: "checkpoint",
            run: runOf(holding),
            from: served.receipt?.through ?? 0,
            through: basis.head,
            dataCut: basis,
            subscription: {
              presenceId: holding.joinId,
              topicsDigest: mailboxTopicsDigest(holding.presence.topics),
            },
            servedCount: 0,
            servedDigest: mailboxServedDigest([]),
            carrierBytes: 0,
          };
          expect((yield* ledger.appendMailboxAck(record, basis)).status).toBe("APPLIED");
        })
      );
      const state = await mailbox(a);
      const start = state.status === "FOUND" ? state.records[0]?.record.operation : undefined;
      if (start === undefined) throw new Error("Missing the join's start.");
      const unreferenced = Bun.randomUUIDv7();
      const rows: ReadonlyArray<readonly [string, string, Probe["forgeReceipt"]?]> = [
        [othersRead, "is recorded for another address"],
        [start, "served no batch"],
        [checkpoint, "served no batch"],
        [real.toUpperCase(), "must be a lowercase UUIDv7"],
        [
          real,
          "could not be established",
          (found) =>
            found.status === "FOUND" && found.record.kind === "ack"
              ? { ...found, record: { ...found.record, servedDigest: "0".repeat(64) } }
              : found,
        ],
        // A well-formed receipt that the mailbox never named as its position.
        [
          unreferenced,
          "could not be established",
          (found, operation) =>
            operation === unreferenced
              ? { ...realFound, record: { ...realFound.record, operation: unreferenced } }
              : found,
        ],
      ];
      for (const [readId, refusal, forge] of rows) {
        if (forge !== undefined) probe.forgeReceipt = forge;
        const before = { head: await head(a), state: await mailbox(a) };
        const message = await failure(read(a, { readId }));
        expect(message).toContain(refusal);
        expect(message).not.toContain(secret.id);
        expect(message).not.toContain(secret.body);
        expect({ head: await head(a), state: await mailbox(a) }).toEqual(before);
        delete probe.forgeReceipt;
      }
    }),
  TIMEOUT
);

test(
  "a peek writes nothing; bus_ack acknowledges exactly its batch, once, and later mail stays unread",
  () =>
    fixture(async ({ a }) => {
      await joinInbox(a);
      await joinSender(a);
      const first = await send(a, inbox, "peeked");
      const before = { head: await head(a), position: await position(a) };
      const peeked = await read(a, { peek: true });
      expect(ids(peeked)).toEqual([first.id]);
      const receipt = peekReceipt(peeked);
      expect(receipt).toMatchObject({
        from: before.position,
        through: before.head,
        basis: { t: before.head },
        served: { count: 1, digest: mailboxServedDigest([first.id]) },
      });
      expect({ head: await head(a), position: await position(a) }).toEqual(before);
      // Mail after the peek: the acknowledgement moves to the receipt's end, not to the head.
      const later = await send(a, inbox, "arrived after the peek");
      const acked = await ack(a, receipt);
      expect(acked.receipt).toEqual({
        readId: receipt.readId,
        from: receipt.from,
        through: receipt.through,
        replayed: false,
      });
      expect(await position(a)).toBe(receipt.through);
      const recorded = await acks(a);
      const again = await ack(a, receipt);
      expect(again.receipt.replayed).toBe(true);
      expect(again.nextReadId).not.toBe(acked.nextReadId);
      expect(await acks(a)).toEqual(recorded);
      // The peek's id replays its batch like any keyed read.
      const replay = await read(a, { readId: receipt.readId });
      expect(ids(replay)).toEqual([first.id]);
      expect(replay.receipt?.replayed).toBe(true);
      expect(ids(await read(a))).toEqual([later.id]);
    }),
  TIMEOUT
);

test.each(["identical batches", "the same end under different topics"] as const)(
  "two peeks with %s: only the one read under the current holding is acknowledgeable",
  (shape) =>
    fixture(async ({ a }) => {
      await joinInbox(a, { topics: ["alpha"] });
      await joinSender(a);
      const limit = shape === "identical batches" ? undefined : 2;
      if (shape === "the same end under different topics") {
        await send(a, "#alpha", "alpha mail");
        await send(a, "#beta", "beta mail");
      }
      const direct = await send(a, inbox, "direct to both");
      if (limit !== undefined) await send(a, inbox, "later direct");
      const first = await read(a, { peek: true, limit });
      await joinInbox(a, { topics: ["beta"] });
      const second = await read(a, { peek: true, limit });
      expect(ids(first).at(-1)).toBe(direct.id);
      expect(ids(second).at(-1)).toBe(direct.id);
      if (shape === "identical batches") {
        expect(peekReceipt(first).served).toEqual(peekReceipt(second).served);
      } else {
        expect(peekReceipt(first).through).toBe(peekReceipt(second).through);
        expect(ids(first)).not.toEqual(ids(second));
      }
      const before = await head(a);
      expect(await failure(ack(a, peekReceipt(first)))).toContain("changed since this peek");
      expect(await head(a)).toBe(before);
      expect((await ack(a, peekReceipt(second))).receipt.replayed).toBe(false);
    }),
  TIMEOUT
);

test(
  "a stale or altered peek receipt is refused, writing nothing",
  () =>
    fixture(async ({ a }) => {
      await joinInbox(a);
      await joinSender(a);
      await send(a, inbox, "one");
      await send(a, inbox, "two");
      const peeked = await read(a, { peek: true, limit: 1 });
      const receipt = peekReceipt(peeked);
      const before = await head(a);
      for (const [altered, refusal] of [
        [{ ...receipt, through: receipt.through + 1 }, "does not match the mail its peek served"],
        [
          { ...receipt, served: { ...receipt.served, digest: "0".repeat(64) } },
          "does not match the mail its peek served",
        ],
        [{ ...receipt, served: { ...receipt.served, count: 2 } }, "does not match"],
        [{ ...receipt, basis: { ...receipt.basis, ledger: "another" } }, "replaced ledger"],
        [{ ...receipt, from: receipt.from + 1 }, "changed since this peek"],
      ] as const) {
        expect(await failure(ack(a, altered))).toContain(refusal);
        expect(await head(a)).toBe(before);
      }
      // Another read advances the position: the untouched receipt is stale.
      await read(a);
      const advanced = await head(a);
      expect(await failure(ack(a, receipt))).toContain("changed since this peek");
      expect(await head(a)).toBe(advanced);
    }),
  TIMEOUT
);

test(
  "a wait blocked under an unused id returns the batch another read records under it, as a replay",
  () =>
    fixture(async ({ a, another }) => {
      const { nextReadId: readId } = await joinInbox(a);
      await joinSender(a);
      const seen = Effect.runSync(Deferred.make<void>());
      const probe: Probe = { lookedUp: { operation: readId, seen } };
      const waiter = another(probe);
      const waiting = wait(waiter, { readId, timeoutSeconds: 30 });
      await Effect.runPromise(Deferred.await(seen).pipe(Effect.timeout("20 seconds")));
      // Its next pass is held before it can look the id up again.
      const held = hold();
      probe.holdLookup = held;
      const mail = await send(a, inbox, "recorded by the read");
      await reached(held);
      await send(a, "fixture/elsewhere", "a later cut for the read");
      const served = await read(a, { readId });
      expect(ids(served)).toEqual([mail.id]);
      await release(held);
      const returned = await waiting;
      expect(ids(returned)).toEqual([mail.id]);
      expect(returned.receipt).toEqual(replayedReceipt(served.receipt));
      expect((await acks(a)).filter(({ operation }) => operation === readId)).toHaveLength(1);
    }),
  TIMEOUT
);

test(
  "a readId whose acknowledgement a restore lost reads afresh, delivering at least once",
  () =>
    fixture(async ({ a, file }) => {
      const { nextReadId: readId } = await joinInbox(a);
      await joinSender(a);
      const mail = await send(a, inbox, "delivered twice across a restore");
      const retained = await head(a);
      const served = await read(a, { readId });
      expect(served.receipt?.replayed).toBe(false);
      // A disposable restore from a copy taken before the acknowledgement.
      truncateSync(file, retained);
      expect((await receiptOf(a, readId)).status).toBe("ABSENT");
      const again = await read(a, { readId });
      expect(ids(again)).toEqual([mail.id]);
      expect(again.receipt).toMatchObject({ readId, replayed: false });
      expect((await receiptOf(a, readId)).status).toBe("FOUND");
    }),
  TIMEOUT
);

test(
  "the empty result fits the minimum however wide the positions are",
  () =>
    fixture(async ({ a }) => {
      await joinInbox(a);
      await joinSender(a);
      // JSONL positions are byte offsets: make them wide.
      await send(a, "fixture/elsewhere", "w".repeat(30_000));
      await send(a, inbox, "consumed first");
      await read(a);
      expect(await position(a)).toBeGreaterThan(30_000);
      const empty = await read(a, { maxResultBytes: EMPTY_READ_RESULT_BYTES });
      expect(empty.messages).toEqual([]);
      expect(bytesOf(empty)).toBe(EMPTY_READ_RESULT_BYTES);
    }),
  TIMEOUT
);

test(
  "wake coverage, which hosted Events checkpoints, moves only with an acknowledgement",
  () =>
    fixture(async ({ a }) => {
      await joinInbox(a);
      await joinSender(a);
      await send(a, inbox, "one");
      await send(a, inbox, "two");
      const observe = (previousCoverage?: WakeCoverage) =>
        bus(a, (service) =>
          service.observeWake({
            address: inbox,
            session: owner,
            ...(previousCoverage === undefined ? {} : { previousCoverage }),
          })
        );
      const first = await observe();
      const coverage = first.nextCoverage;
      if (coverage === undefined) throw new Error("No coverage was proposed.");
      // A peek and a replay write nothing: the same coverage is not news.
      const peeked = await read(a, { peek: true, limit: 1 });
      await read(a, { readId: Bun.randomUUIDv7(), peek: true });
      const unchanged = await observe(coverage);
      expect(unchanged.news).toBe(false);
      expect(unchanged.nextCoverage?.cursor).toBe(coverage.cursor);
      // bus_ack moves the read position forward only, as a partial read does.
      await ack(a, peekReceipt(peeked));
      const moved = await observe(coverage);
      expect(moved.nextCoverage?.cursor).toBe(peekReceipt(peeked).through);
      expect(moved.nextCoverage?.cursor).toBeGreaterThan(coverage.cursor);
      expect(moved.news).toBe(true);
    }),
  TIMEOUT
);
