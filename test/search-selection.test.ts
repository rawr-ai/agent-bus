// Search's kept rankings, over a stub gateway whose scores move on every evaluation: the
// Fluree behaviour that let offset pages repeat or omit matches, made certain.
import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import { TestClock } from "effect/testing";
import { search } from "../src/catalogue.ts";
import { LedgerError, Message, MessageJson } from "../src/domain.ts";
import { historyPreset } from "../src/mcp.ts";
import { QueryGateway } from "../src/Query.ts";
import {
  CALL_ENTRIES,
  callScoped,
  descriptorBytes,
  type Policy,
  PROCESS_POLICY,
  RankedSelections,
  make as selectionStore,
} from "../src/RankedSelections.ts";

const encodeJson = Schema.encodeSync(MessageJson);
const HEAD = 20_000;

const messageAt = (n: number) =>
  new Message({
    id: `m-${String(n).padStart(4, "0")}`,
    ts: new Date(Date.parse("2026-11-01T09:00:00Z") + n * 60_000).toISOString(),
    from: "claude/a",
    to: ["codex/b"],
    kind: "message",
    body: `kiwi ${n}`,
  });

type Json = Record<string, unknown>;

/** One entry as an evaluation ranked it. */
interface Ranked {
  readonly id: string;
  readonly score: number;
  readonly t: number;
}

/**
 * A ledger of `count` matching entries, the nth committed at t=n, read as of each query's t. Each
 * evaluation of the ranking rotates the scores, so no two evaluations order the entries alike,
 * and is recorded in `orderings`. `damaged` entries' stored JSON is missing; `beforeHydration`,
 * read at each call, runs before a page's entries are read.
 */
const stubLedger = (
  count: number,
  damaged: ReadonlySet<number> = new Set(),
  hooks: { beforeHydration?: Effect.Effect<void, LedgerError> } = {}
) => {
  const messages = Array.from({ length: count }, (_, k) => messageAt(k + 1));
  const bySubject = new Map(
    messages.map((message, k) => [`urn:agent-bus:message:${message.id}`, { message, t: k + 1 }])
  );
  const orderings: Array<ReadonlyArray<Ranked>> = [];
  /** The row limit each ranking query asked Fluree for. */
  const rankLimits: Array<number> = [];
  const hydrated: Array<number> = [];
  const gateway = QueryGateway.of({
    pin: Effect.succeed({ head: HEAD, incarnation: "stub" }),
    jsonld: (at, query: Json) => {
      if ((query.select as Array<string> | undefined)?.some((v) => v.includes("collect"))) {
        return Effect.sync(() => {
          rankLimits.push(query.limit as number);
          const shift = orderings.length;
          const ranked = messages
            .map((message, k) => ({
              id: message.id,
              t: k + 1,
              score: 1 + ((k + shift * 7) % count) / count,
            }))
            .filter((entry) => entry.t <= at);
          ranked.sort((a, b) => b.score - a.score || a.t - b.t);
          orderings.push(ranked);
          return ranked
            .slice(0, query.limit as number)
            .map(({ id, t, score }) => [t, id, score, [`urn:agent-bus:message:${id}`]]);
        });
      }
      return Effect.andThen(
        hooks.beforeHydration ?? Effect.void,
        Effect.sync(() => {
          const subjects = (query.values as [unknown, Array<[{ "@value": string }]>])[1].map(
            ([subject]) => subject["@value"]
          );
          hydrated.push(subjects.length);
          return subjects.flatMap((subject) => {
            const found = bySubject.get(subject);
            if (found === undefined || found.t > at) return [];
            return [
              [
                subject,
                found.t,
                found.message.id,
                damaged.has(found.t) ? null : encodeJson(found.message),
              ],
            ];
          });
        })
      );
    },
    sparql: () => Effect.die("unexpected query"),
  });
  return {
    gateway,
    messages,
    orderings,
    evaluations: () => orderings.length,
    rankLimits,
    hydrated,
  };
};

/** Rows as (id, score, t), to compare with an evaluation's own record. */
const ranked = (
  rows: ReadonlyArray<{ readonly id: string; readonly score: number; readonly t: number }>
) => rows.map(({ id, score, t }) => ({ id, score, t }));

/** A runtime over the stub, with its own store under `policy`, on a TestClock. */
const runtimeOf = (gateway: typeof QueryGateway.Service, policy: Policy = PROCESS_POLICY) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(QueryGateway, gateway),
      Layer.effect(RankedSelections, selectionStore(policy)),
      TestClock.layer()
    )
  );

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

test("a traversal evaluates its ranking once, and limit-1 pages are that ranking exactly", async () => {
  const ledger = stubLedger(12);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(QueryGateway, ledger.gateway),
      Layer.effect(RankedSelections, selectionStore(PROCESS_POLICY))
    )
  );
  const whole = await runtime.runPromise(search.run({ text: "kiwi", limit: 50 }, {}, undefined));
  expect(whole.rows).toHaveLength(12);
  // The falsifier is live: a second evaluation at the same t ranks differently.
  const again = await runtime.runPromise(
    search.run({ text: "kiwi", limit: 50 }, { t: HEAD }, undefined)
  );
  expect(ids(again.rows)).not.toEqual(ids(whole.rows));

  const before = ledger.evaluations();
  const paged: Array<{ readonly id: string; readonly score: number; readonly t: number }> = [];
  let page = await runtime.runPromise(search.run({ text: "kiwi", limit: 1 }, {}, undefined));
  const first = page;
  paged.push(...page.rows);
  while (page.next !== undefined) {
    page = await runtime.runPromise(
      search.run({ text: "kiwi", limit: 1 }, { cursor: page.next }, undefined)
    );
    paged.push(...page.rows);
  }
  expect(ledger.evaluations() - before).toBe(1);
  // Exactly the one evaluation: every entry once, in its order, with its score and own commit.
  expect(ranked(paged)).toEqual([...(ledger.orderings[before] ?? [])]);
  expect(ranked(paged)).not.toEqual(ranked(again.rows));
  expect(first.selection).toMatchObject({ entries: 12, truncated: false });
  expect(first.selection?.expiresAt).toBeString();
  expect(page).toMatchObject({ exhausted: true, selection: { entries: 12, truncated: false } });
  // Each page reads only its own entries.
  expect(ledger.hydrated.slice(-12)).toEqual(Array(12).fill(1));
  await runtime.dispose();
});

test("a kept ranking serves the page any of its cursors names, final page included, until it expires", async () => {
  const ledger = stubLedger(3);
  const runtime = runtimeOf(ledger.gateway);
  const one = await runtime.runPromise(search.run({ text: "kiwi", limit: 2 }, {}, undefined));
  expect(one.next).toBeString();
  const two = await runtime.runPromise(
    search.run({ text: "kiwi", limit: 2 }, { cursor: one.next }, undefined)
  );
  expect(two).toMatchObject({ exhausted: true });
  expect(two.next).toBeUndefined();
  await runtime.runPromise(TestClock.adjust("9 minutes"));
  const replayed = await runtime.runPromise(
    search.run({ text: "kiwi", limit: 2 }, { cursor: one.next }, undefined)
  );
  expect(replayed.rows).toEqual(two.rows);
  expect(ranked([...one.rows, ...replayed.rows])).toEqual([...(ledger.orderings[0] ?? [])]);
  expect(ledger.evaluations()).toBe(1);

  await runtime.runPromise(TestClock.adjust("1 minute"));
  const refused = await runtime.runPromise(
    Effect.flip(search.run({ text: "kiwi", limit: 2 }, { cursor: one.next }, undefined))
  );
  expect(refused._tag).toBe("InvalidQuery");
  expect(refused.message).toContain("ranking is no longer held");
  expect(refused.message).toContain(`t=${HEAD}`);
  await runtime.dispose();
});

const reencode = (cursor: string, change: (decoded: Json) => Json) =>
  `bq1.${Buffer.from(
    JSON.stringify(change(JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString())))
  ).toString("base64url")}`;

test("search refuses cursors without a held ranking", async () => {
  const ledger = stubLedger(3);
  const runtime = runtimeOf(ledger.gateway);
  const one = await runtime.runPromise(search.run({ text: "kiwi", limit: 2 }, {}, undefined));
  const next = one.next as string;
  const refusal = (cursor: string) =>
    runtime.runPromise(Effect.flip(search.run({ text: "kiwi", limit: 2 }, { cursor }, undefined)));

  // A cursor from before kept rankings: the same fields, without the revision and handle.
  const legacy = await refusal(reencode(next, ({ r: _r, s: _s, ...rest }) => rest));
  expect(legacy.message).toContain("predates kept rankings");
  // A handle this server never issued.
  const foreign = await refusal(reencode(next, (decoded) => ({ ...decoded, s: "A".repeat(22) })));
  expect(foreign.message).toContain("ranking is no longer held");
  // The handle is bound to its args and page size.
  const otherArgs = await runtime.runPromise(
    Effect.flip(search.run({ text: "kiwi", limit: 1 }, { cursor: next }, undefined))
  );
  expect(otherArgs._tag).toBe("InvalidQuery");
  // A search revision this bus does not run.
  const revision = await refusal(reencode(next, (decoded) => ({ ...decoded, r: 2 })));
  expect(revision._tag).toBe("InvalidQuery");
  await runtime.dispose();
});

test("a ranking over its bounds is refused before any result", async () => {
  const ledger = stubLedger(5);
  const runtime = runtimeOf(ledger.gateway, { ...PROCESS_POLICY, subjects: 4 });
  const refused = await runtime.runPromise(
    Effect.flip(search.run({ text: "kiwi", limit: 50 }, {}, undefined))
  );
  expect(refused).toMatchObject({ _tag: "QueryCapacity" });
  expect(ledger.hydrated).toEqual([]);
  await runtime.dispose();
});

test("a ranked match beyond the entry bound is cut and reported, never dropped silently", async () => {
  const ledger = stubLedger(5);
  const runtime = runtimeOf(ledger.gateway, { ...PROCESS_POLICY, entries: 3 });
  const page = await runtime.runPromise(search.run({ text: "kiwi", limit: 50 }, {}, undefined));
  expect(page.rows).toHaveLength(3);
  expect(page).toMatchObject({ exhausted: true, selection: { entries: 3, truncated: true } });
  await runtime.dispose();
});

test("the store holds a fixed number of rankings, however small", async () => {
  const ledger = stubLedger(3);
  const runtime = runtimeOf(ledger.gateway, { ...PROCESS_POLICY, records: 2 });
  for (let k = 0; k < 2; k++) {
    const held = await runtime.runPromise(search.run({ text: "kiwi", limit: 1 }, {}, undefined));
    expect(held.next).toBeString();
  }
  const refused = await runtime.runPromise(
    Effect.flip(search.run({ text: "kiwi", limit: 1 }, {}, undefined))
  );
  expect(refused._tag).toBe("QueryCapacity");
  await runtime.dispose();
});

test("the store refuses a selection with more entries than its bound, rather than trim it", async () => {
  const store = await Effect.runPromise(selectionStore({ ...PROCESS_POLICY, entries: 1 }));
  const entry = (id: string) => ({ t: 1, id, score: 1, subjects: [`urn:x:${id}`] });
  const refused = await Effect.runPromise(
    Effect.flip(
      store.admit(
        { entries: [entry("a"), entry("b")], truncated: false },
        { incarnation: "stub", t: 1, hash: "h", size: 1 }
      )
    )
  );
  expect(refused._tag).toBe("QueryCapacity");
});

test("the process store holds a viewer's abandoned traversals with room to spare, and refuses beyond its bounds", async () => {
  const runtime = ManagedRuntime.make(TestClock.layer());
  const store = await runtime.runPromise(selectionStore(PROCESS_POLICY));
  const start = await runtime.runPromise(Clock.currentTimeMillis);
  let n = 0;
  // The largest selection the policy admits: one entry whose accounting is exactly its byte bound.
  const largest = (extra = 0) => {
    n += 1;
    const id = `m${n}`;
    const subject = "s".repeat(PROCESS_POLICY.bytes - 24 - id.length + extra);
    return { entries: [{ t: 1, id, score: 1, subjects: [subject] }], truncated: false };
  };
  const admit = (selection = largest()) =>
    runtime.runPromise(
      Effect.exit(store.admit(selection, { incarnation: "stub", t: 1, hash: "h", size: 1 }))
    );
  expect(descriptorBytes(largest().entries)).toBe(PROCESS_POLICY.bytes);

  // A viewer refreshing every 15 seconds for the whole expiry, abandoning two traversals each time.
  const viewer: Array<boolean> = [];
  for (let tick = 0; tick < 40; tick += 1) {
    if (tick > 0) await runtime.runPromise(TestClock.adjust("15 seconds"));
    for (const _ of [1, 2]) viewer.push(Exit.isSuccess(await admit()));
  }
  expect(viewer).toEqual(Array.from({ length: 80 }, () => true));
  // Room remains for 32 more at once, and from then on each one is refused explicitly.
  const others: Array<boolean> = [];
  for (let k = 0; k < 32; k += 1) others.push(Exit.isSuccess(await admit()));
  expect(others).toEqual(Array.from({ length: 32 }, () => true));
  let held = 112;
  while (held <= PROCESS_POLICY.records && Exit.isSuccess(await admit())) held += 1;
  expect(held).toBe(128);
  const refused = await runtime.runPromise(
    Effect.flip(store.admit(largest(), { incarnation: "stub", t: 1, hash: "h", size: 1 }))
  );
  expect(refused).toMatchObject({
    _tag: "QueryCapacity",
    message: expect.stringContaining(
      `Retry after ${new Date(start + PROCESS_POLICY.ttlMillis).toISOString()}, or narrow the search.`
    ),
  });
  // One byte over a selection's own bound is refused whatever room there is.
  await runtime.runPromise(TestClock.adjust("10 minutes"));
  expect(Exit.isFailure(await admit(largest(1)))).toBe(true);
  expect(Exit.isSuccess(await admit())).toBe(true);
  await runtime.dispose();
});

test("the rolling expiry returns room two at a time as a viewer's oldest traversals end", async () => {
  const runtime = ManagedRuntime.make(TestClock.layer());
  const store = await runtime.runPromise(selectionStore(PROCESS_POLICY));
  const one = (id: string) => ({
    entries: [
      { t: 1, id, score: 1, subjects: ["s".repeat(PROCESS_POLICY.bytes - 24 - id.length)] },
    ],
    truncated: false,
  });
  const admit = (id: string) =>
    runtime
      .runPromise(
        Effect.exit(store.admit(one(id), { incarnation: "stub", t: 1, hash: "h", size: 1 }))
      )
      .then(Exit.isSuccess);
  const results: Array<boolean> = [];
  // Three expiries' worth: 240 admissions, far more than the store's 128 at once.
  for (let tick = 0; tick < 120; tick += 1) {
    if (tick > 0) await runtime.runPromise(TestClock.adjust("15 seconds"));
    results.push(await admit(`a${tick}`), await admit(`b${tick}`));
  }
  // After the first 40 ticks, two expire as each tick admits two, so the store never fills.
  expect(results).toEqual(Array.from({ length: 240 }, () => true));
  // It holds exactly the last 40 ticks' 80: 48 more fit, and the next is refused.
  const more: Array<boolean> = [];
  for (let k = 0; k <= 48; k += 1) more.push(await admit(`c${k}`));
  expect(more).toEqual([...Array.from({ length: 48 }, () => true), false]);
  await runtime.dispose();
});

test("a full store refuses a search that needs another page, and still serves one that does not", async () => {
  const ledger = stubLedger(4);
  // Room for one ranking of these four entries (58 descriptor bytes each), not two.
  const one = { ...PROCESS_POLICY, totalBytes: 300 };
  const runtime = runtimeOf(ledger.gateway, one);
  const held = await runtime.runPromise(search.run({ text: "kiwi", limit: 2 }, {}, undefined));
  expect(held.next).toBeString();
  const refused = await runtime.runPromise(
    Effect.flip(search.run({ text: "kiwi", limit: 3 }, {}, undefined))
  );
  expect(refused._tag).toBe("QueryCapacity");
  expect(refused.message).toContain("Retry after");
  const whole = await runtime.runPromise(search.run({ text: "kiwi", limit: 50 }, {}, undefined));
  expect(whole.rows).toHaveLength(4);
  // Room returns when the held ranking expires.
  await runtime.runPromise(TestClock.adjust("10 minutes"));
  const later = await runtime.runPromise(search.run({ text: "kiwi", limit: 3 }, {}, undefined));
  expect(later.next).toBeString();
  await runtime.dispose();
});

test("bus_history pages one ranking of its own, holds nothing in the process store, and fails rather than fall short", async () => {
  const admitted: Array<unknown> = [];
  const process = Effect.map(selectionStore(PROCESS_POLICY), (store) =>
    RankedSelections.of({
      ...store,
      admit: (selection, binding) => {
        admitted.push(binding);
        return store.admit(selection, binding);
      },
    })
  );
  const runWith = (ledger: ReturnType<typeof stubLedger>) =>
    ManagedRuntime.make(
      Layer.mergeAll(
        Layer.succeed(QueryGateway, ledger.gateway),
        Layer.effect(RankedSelections, process)
      )
    );

  const plenty = stubLedger(450);
  const runtime = runWith(plenty);
  const found = await runtime.runPromise(historyPreset({ query: "kiwi", limit: 420 }));
  expect(new Set(found.messages.map((m) => m.id)).size).toBe(420);
  expect(plenty.evaluations()).toBe(1);
  expect(admitted).toEqual([]);
  await runtime.dispose();

  // More matches than one call ranks, and too many of those it ranked unreadable.
  const damaged = new Set(Array.from({ length: 1001 }, (_, k) => k + 1).filter((t) => t % 2 === 0));
  const short = stubLedger(1001, damaged);
  const shortRuntime = runWith(short);
  const refused = await shortRuntime.runPromise(
    Effect.flip(historyPreset({ query: "kiwi", limit: 600 }))
  );
  expect(refused._tag).toBe("QueryCapacity");
  expect(admitted).toEqual([]);
  await shortRuntime.dispose();
});

test("bus_history ranks at most CALL_ENTRIES however large its limit, and a short answer is only natural exhaustion", async () => {
  const huge = 1_000_000;
  const policy = (await Effect.runPromise(callScoped(huge))).policy;
  expect(policy).toMatchObject({
    entries: CALL_ENTRIES,
    subjects: 2 * CALL_ENTRIES,
    bytes: 4 * 1024 * 1024,
    totalBytes: 4 * 1024 * 1024,
    records: 1,
  });
  expect(CALL_ENTRIES).toBe(10_000);

  const admitted: Array<unknown> = [];
  const runWith = (ledger: ReturnType<typeof stubLedger>) =>
    ManagedRuntime.make(
      Layer.mergeAll(
        Layer.succeed(QueryGateway, ledger.gateway),
        Layer.effect(
          RankedSelections,
          Effect.map(selectionStore(PROCESS_POLICY), (store) =>
            RankedSelections.of({
              ...store,
              admit: (selection, binding) => {
                admitted.push(binding);
                return store.admit(selection, binding);
              },
            })
          )
        )
      )
    );

  // Every match ranked and read: fewer than asked is the whole answer, from one bounded query.
  const few = stubLedger(3);
  const fewRuntime = runWith(few);
  const all = await fewRuntime.runPromise(historyPreset({ query: "kiwi", limit: huge }));
  expect(all.messages.map((m) => m.id).sort()).toEqual(few.messages.map((m) => m.id).sort());
  expect(few.rankLimits).toEqual([CALL_ENTRIES + 1]);
  await fewRuntime.dispose();

  // More matches than the cap: the ranking is cut short of the limit, so the call fails rather
  // than return the 10,000 it could, still from one bounded query.
  const many = stubLedger(CALL_ENTRIES + 50);
  const manyRuntime = runWith(many);
  const refused = await manyRuntime.runPromise(
    Effect.flip(historyPreset({ query: "kiwi", limit: huge }))
  );
  expect(refused._tag).toBe("QueryCapacity");
  expect(many.rankLimits).toEqual([CALL_ENTRIES + 1]);
  // Up to the cap, the same ledger answers in full.
  const capped = await manyRuntime.runPromise(
    historyPreset({ query: "kiwi", limit: CALL_ENTRIES })
  );
  expect(new Set(capped.messages.map((m) => m.id)).size).toBe(CALL_ENTRIES);
  expect(many.rankLimits).toEqual([CALL_ENTRIES + 1, CALL_ENTRIES + 1]);
  await manyRuntime.dispose();
  expect(admitted).toEqual([]);
});

test("a page trimmed to its byte budget keeps the ranking for the rest", async () => {
  const ledger = stubLedger(6);
  const runtime = runtimeOf(ledger.gateway);
  const whole = await runtime.runPromise(search.run({ text: "kiwi", limit: 50 }, {}, undefined));
  expect(whole.next).toBeUndefined();
  const budget = Buffer.byteLength(JSON.stringify(whole)) - 200;
  const pages = [
    await runtime.runPromise(search.run({ text: "kiwi", limit: 50 }, { t: HEAD }, budget)),
  ];
  while (pages.at(-1)?.next !== undefined) {
    pages.push(
      await runtime.runPromise(
        search.run({ text: "kiwi", limit: 50 }, { cursor: pages.at(-1)?.next }, budget)
      )
    );
  }
  expect(pages.length).toBeGreaterThan(1);
  expect(pages[0]?.selection?.expiresAt).toBeString();
  expect(ledger.evaluations()).toBe(2);
  // Evaluation 0 sized the budget; the traversal is evaluation 1 exactly, which ranks differently.
  const traversed = ranked(pages.flatMap((page) => page.rows));
  expect(traversed).toEqual([...(ledger.orderings[1] ?? [])]);
  expect(traversed).not.toEqual([...(ledger.orderings[0] ?? [])]);
  await runtime.dispose();
});

test("admission holds under competition, interruption, failed reads and abandoned traversals", async () => {
  const one = { ...PROCESS_POLICY, records: 1 };
  const first = (runtime: ReturnType<typeof runtimeOf>) =>
    runtime.runPromise(Effect.exit(search.run({ text: "kiwi", limit: 1 }, {}, undefined)));

  // Two first pages race for the last record: one is held, the other refused, never both.
  const ledger = stubLedger(3);
  const runtime = runtimeOf(ledger.gateway, one);
  const raced = await runtime.runPromise(
    Effect.all(
      [0, 1].map(() => Effect.exit(search.run({ text: "kiwi", limit: 1 }, {}, undefined))),
      { concurrency: "unbounded" }
    )
  );
  const won = raced.filter(Exit.isSuccess);
  expect(won).toHaveLength(1);
  expect(raced.filter(Exit.isFailure).map((exit) => JSON.stringify(exit.cause))).toEqual([
    expect.stringContaining("QueryCapacity"),
  ]);
  // The refusal leaves the held ranking serving its pages.
  const held = won[0]?.value;
  const second = await runtime.runPromise(
    search.run({ text: "kiwi", limit: 1 }, { cursor: held?.next }, undefined)
  );
  const winner = ledger.orderings.find((ordering) => ordering[0]?.id === held?.rows[0]?.id);
  expect(ranked(second.rows)).toEqual(winner?.slice(1, 2) ?? []);
  expect(second.rows).toHaveLength(1);
  await runtime.dispose();

  // Interrupted while reading its first page, a search holds nothing.
  let block = true;
  const started = Effect.runSync(Deferred.make<void>());
  const gated = stubLedger(3, new Set(), {
    beforeHydration: Effect.suspend(() =>
      block ? Effect.andThen(Deferred.succeed(started, undefined), Effect.never) : Effect.void
    ),
  });
  const gatedRuntime = runtimeOf(gated.gateway, one);
  await gatedRuntime.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(search.run({ text: "kiwi", limit: 1 }, {}, undefined));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
    })
  );
  block = false;
  expect(Exit.isSuccess(await first(gatedRuntime))).toBe(true);
  await gatedRuntime.dispose();

  // A first page whose read fails holds nothing either.
  let fail = true;
  const failing = stubLedger(3, new Set(), {
    beforeHydration: Effect.suspend(() =>
      fail ? Effect.fail(new LedgerError({ message: "read failed" })) : Effect.void
    ),
  });
  const failingRuntime = runtimeOf(failing.gateway, one);
  const failed = await first(failingRuntime);
  expect(JSON.stringify(Exit.isFailure(failed) && failed.cause)).toContain("LedgerError");
  fail = false;
  expect(Exit.isSuccess(await first(failingRuntime))).toBe(true);
  await failingRuntime.dispose();

  // Abandoned traversals fill the store until they expire, and then all their room returns.
  const burst = runtimeOf(stubLedger(3).gateway, { ...PROCESS_POLICY, records: 3 });
  for (let k = 0; k < 3; k++) expect(Exit.isSuccess(await first(burst))).toBe(true);
  expect(Exit.isSuccess(await first(burst))).toBe(false);
  await burst.runPromise(TestClock.adjust("10 minutes"));
  for (let k = 0; k < 3; k++) expect(Exit.isSuccess(await first(burst))).toBe(true);
  await burst.dispose();
});

test("a replaced ledger refuses its rankings at once, and their room returns only at expiry", async () => {
  let incarnation = "first";
  const ledger = stubLedger(3);
  const runtime = runtimeOf(
    QueryGateway.of({
      ...ledger.gateway,
      pin: Effect.sync(() => ({ head: HEAD, incarnation })),
    }),
    { ...PROCESS_POLICY, records: 1 }
  );
  const first = (input = {}) => search.run({ text: "kiwi", limit: 1 }, input, undefined);
  const old = await runtime.runPromise(first());
  expect(old.next).toBeString();

  incarnation = "second";
  const stale = await runtime.runPromise(Effect.flip(first({ cursor: old.next })));
  expect(stale._tag).toBe("InvalidQuery");
  // The old ranking is still charged: room is reclaimed only at its original expiry.
  const full = await runtime.runPromise(Effect.flip(first()));
  expect(full._tag).toBe("QueryCapacity");
  await runtime.runPromise(TestClock.adjust("10 minutes"));
  const fresh = await runtime.runPromise(first());
  expect(fresh.next).toBeString();
  // A late request with the old cursor is refused and leaves the new ranking in place.
  const late = await runtime.runPromise(Effect.flip(first({ cursor: old.next })));
  expect(late._tag).toBe("InvalidQuery");
  const continued = await runtime.runPromise(first({ cursor: fresh.next }));
  expect(continued.rows).toHaveLength(1);
  await runtime.dispose();
});
