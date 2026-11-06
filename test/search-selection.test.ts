// Search's kept rankings, over a stub gateway whose scores move on every evaluation: the
// Fluree behaviour that let offset pages repeat or omit matches, made certain.
import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { TestClock } from "effect/testing";
import { search } from "../src/catalogue.ts";
import { Message, MessageJson } from "../src/domain.ts";
import { historyPreset } from "../src/mcp.ts";
import { QueryGateway } from "../src/Query.ts";
import {
  type Policy,
  PROCESS_POLICY,
  RankedSelections,
  make as selectionStore,
} from "../src/RankedSelections.ts";

const encodeJson = Schema.encodeSync(MessageJson);
const HEAD = 100;

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

/**
 * A ledger of `count` matching entries, the nth committed at t=n. Each evaluation of the ranking
 * rotates the scores, so no two evaluations order the entries alike. `damaged` entries' stored
 * JSON is missing.
 */
const stubLedger = (count: number, damaged: ReadonlySet<number> = new Set()) => {
  const messages = Array.from({ length: count }, (_, k) => messageAt(k + 1));
  const bySubject = new Map(
    messages.map((message, k) => [`urn:agent-bus:message:${message.id}`, { message, t: k + 1 }])
  );
  let evaluations = 0;
  const hydrated: Array<number> = [];
  const gateway = QueryGateway.of({
    pin: Effect.succeed({ head: HEAD, incarnation: "stub" }),
    jsonld: (_t, query: Json) =>
      Effect.sync(() => {
        if ((query.select as Array<string> | undefined)?.some((v) => v.includes("collect"))) {
          const shift = evaluations++;
          const ranked = messages.map((message, k) => ({
            message,
            t: k + 1,
            score: 1 + ((k + shift * 7) % count) / count,
          }));
          ranked.sort((a, b) => b.score - a.score || a.t - b.t);
          return ranked
            .slice(0, query.limit as number)
            .map(({ message, t, score }) => [
              t,
              message.id,
              score,
              [`urn:agent-bus:message:${message.id}`],
            ]);
        }
        const subjects = (query.values as [unknown, Array<[{ "@value": string }]>])[1].map(
          ([subject]) => subject["@value"]
        );
        hydrated.push(subjects.length);
        return subjects.flatMap((subject) => {
          const found = bySubject.get(subject);
          if (found === undefined) return [];
          return [
            [
              subject,
              found.t,
              found.message.id,
              damaged.has(found.t) ? null : encodeJson(found.message),
            ],
          ];
        });
      }),
    sparql: () => Effect.die("unexpected query"),
  });
  return {
    gateway,
    messages,
    evaluations: () => evaluations,
    hydrated,
  };
};

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
  const paged: Array<{ readonly id: string; readonly score: number }> = [];
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
  // Every entry once, in the one evaluation's order, each with that evaluation's score.
  expect(new Set(ids(paged)).size).toBe(12);
  const scores = paged.map((row) => row.score);
  expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  expect(first.selection).toMatchObject({ entries: 12, truncated: false });
  expect(first.selection?.expiresAt).toBeString();
  expect(page).toMatchObject({ exhausted: true, selection: { entries: 12, truncated: false } });
  // Each page reads only its own entries.
  expect(ledger.hydrated.slice(-12)).toEqual(Array(12).fill(1));
  await runtime.dispose();
});

test("a kept ranking serves any page it issued, final page included, until it expires", async () => {
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

test("search refuses cursors without a held ranking; other operations' cursors are unchanged", async () => {
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
  expect(refused._tag).toBe("QueryCapacity");
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
  expect(new Set(pages.flatMap((page) => ids(page.rows))).size).toBe(6);
  expect(ledger.evaluations()).toBe(2);
  await runtime.dispose();
});
