// The browser's traversal of a pinned investigation over hand-built page sequences: the bound,
// page faults, transport stops, busy retries, deadlines and cancellation. The server keeps no
// traversal state, so these rules are only here. Expected ends are written from the frame.
import { expect, test } from "bun:test";
import { MAX_CONTINUATION_LENGTH } from "../viewer/shared/limits";
import type {
  InvestigationPage,
  InvestigationPageInput,
  InvestigationReference,
} from "../viewer/shared/public";
import { requestBytes } from "../viewer/shared/request-size";
import {
  acceptPage,
  classifyRejection,
  createPinnedTraversal,
  emptyProgress,
  type Fault,
  type Progress,
  type Step,
  type TraversalEnd,
} from "../viewer/src/features/pinned/traversal";

const reference: InvestigationReference = {
  name: "history",
  catalogueVersion: 1,
  ledger: "fixture-ledger",
  t: 900,
  criteria: { kinds: ["message"], direction: "forward" },
};
let serial = 0;
const entry = (t = 1, id = `m${String(++serial).padStart(5, "0")}`) => ({
  t,
  message: {
    id,
    ts: "2026-11-01T12:00:00.000Z",
    from: "fixture/a",
    to: ["#review"],
    kind: "message" as const,
    body: id,
  },
});
const entries = (count: number, t = 1) => Array.from({ length: count }, () => entry(t));
const page = (overrides: Partial<InvestigationPage> = {}): InvestigationPage => ({
  entries: [],
  omitted: 0,
  damaged: 0,
  damagedTotal: 0,
  exhausted: false,
  complete: false,
  ...overrides,
});
const more = (rows: InvestigationPage["entries"], next = `bq1.${++serial}`) =>
  page({ entries: rows, next });
const last = (rows: InvestigationPage["entries"], claims: Partial<InvestigationPage> = {}) =>
  page({ entries: rows, exhausted: true, complete: true, ...claims });

/** Joins pages in order until one ends the reading. */
const read = (pages: ReadonlyArray<InvestigationPage>) => {
  let progress: Progress = emptyProgress;
  for (const [index, current] of pages.entries()) {
    const step: Step = acceptPage(progress, current);
    progress = step.progress;
    if ("end" in step) return { end: step.end, progress, used: index + 1 };
  }
  return { end: undefined, progress, used: pages.length };
};
const ends = (pages: ReadonlyArray<InvestigationPage>) => {
  const result = read(pages);
  return [result.end?.kind, result.progress.entries.length];
};

test("199 and 200 exhausted entries are complete; 200 with more and 201 stop at the bound", () => {
  expect(ends([more(entries(150)), last(entries(49))])).toEqual(["complete", 199]);
  expect(ends([more(entries(150)), last(entries(50))])).toEqual(["complete", 200]);
  expect(ends([last(entries(200))])).toEqual(["complete", 200]);
  expect(ends([more(entries(200))])).toEqual(["bound", 200]);
  expect(ends([more(entries(150)), more(entries(50)), last(entries(1))])).toEqual(["bound", 200]);
  // 201: the page that crosses the bound is cut, and its exhausted, complete claim is not borrowed.
  expect(ends([more(entries(1)), last(entries(200))])).toEqual(["bound", 200]);
  expect(ends([more(entries(150)), last(entries(51))])).toEqual(["bound", 200]);
});

test("a page cut at the bound stops as damaged on any damage it reports, else omitted, else bound", () => {
  const cut = (claims: Partial<InvestigationPage>) =>
    ends([more(entries(196)), { ...more(entries(7)), ...claims }]);
  // The page carries counts only, so damage in its kept head and in its dropped tail are one case.
  expect(cut({ damaged: 1, damagedTotal: 1 })).toEqual(["damaged", 200]);
  expect(cut({ omitted: 1 })).toEqual(["omitted", 200]);
  expect(cut({})).toEqual(["bound", 200]);
});

test("one-row pages end at the bound on page 200, or complete when page 200 is exhausted", () => {
  const rows = Array.from({ length: 199 }, () => more(entries(1)));
  const bound = read([...rows, more(entries(1)), more(entries(1))]);
  expect([bound.end?.kind, bound.used, bound.progress.pages]).toEqual(["bound", 200, 200]);
  const complete = read([...rows, last(entries(1))]);
  expect([complete.end?.kind, complete.used]).toEqual(["complete", 200]);
});

test("empty, damage-only and omitting pages end with their own labels", () => {
  expect(ends([last([])])).toEqual(["complete", 0]);
  expect(ends([more(entries(3)), { ...more([]), damaged: 2, damagedTotal: 2 }])).toEqual([
    "damaged",
    3,
  ]);
  // A damaged page keeps its validated rows, and no later page is read.
  const damaged = read([{ ...more(entries(2)), damaged: 1, damagedTotal: 1 }, more(entries(5))]);
  expect([damaged.end?.kind, damaged.progress.entries.length, damaged.used]).toEqual([
    "damaged",
    2,
    1,
  ]);
  // Viewer omissions stop the reading, on an exhausted page or one with more to read.
  expect(ends([last(entries(2), { omitted: 1 })])).toEqual(["omitted", 2]);
  expect(ends([{ ...more([]), omitted: 2 }])).toEqual(["omitted", 0]);
});

test("each page shape the bus never returns is its own fault, and the faulting page keeps no rows", () => {
  const first = more(entries(3, 5));
  const cases: Array<[ReadonlyArray<InvestigationPage>, Fault]> = [
    [[more([])], "stalled"],
    [[{ ...last(entries(1)), next: "bq1.after-end" }], "continuation-after-end"],
    [[page({ entries: entries(1) })], "missing-continuation"],
    // Fresh ids each time, so only the repeated continuation can fire.
    [[more(entries(1, 6), first.next)], "repeated-continuation"],
    [[more(entries(1, 6), "bq1.B"), more(entries(1, 6), first.next)], "repeated-continuation"],
    [[more([entry(5, first.entries[0]?.message.id)])], "repeated-entry"],
    [[more([entry(4)])], "out-of-order"],
    [[more([entry(6), entry(5)])], "out-of-order"],
    [[{ ...more(entries(1, 6)), damagedTotal: 1 }], "damage-count"],
    [[last(entries(1, 6), { complete: false })], "unclaimed-end"],
  ];
  for (const [rest, fault] of cases) {
    const result = read([first, ...rest]);
    expect([result.end, result.progress.entries.length]).toEqual([
      { kind: "fault", fault },
      3 + rest.length - 1,
    ]);
  }
  // A shape fault past the bound still faults: every row the bus sent is checked.
  const tail = read([more(entries(199, 5)), more([entry(5), entry(4)])]);
  expect(tail.end).toEqual({ kind: "fault", fault: "out-of-order" });
});

test("orders the bus may lawfully return are kept as returned", () => {
  // The same commit across a page boundary, and ids within one commit in non-lexical order.
  const result = read([more([entry(4, "b")]), last([entry(4, "a"), entry(4, "c"), entry(5, "0")])]);
  expect([result.end?.kind, result.progress.entries.map((kept) => kept.message.id)]).toEqual([
    "complete",
    ["b", "a", "c", "0"],
  ]);
});

test("a late continuation outside the supported subset stops as transport, keeping its page", () => {
  for (const next of [
    "A".repeat(MAX_CONTINUATION_LENGTH + 1),
    "bq1.é",
    "bq1.a+b",
    "bq1.ab==",
    'bq1."',
  ]) {
    const result = read([more(entries(2)), more(entries(3), next)]);
    expect([result.end?.kind, result.progress.entries.length]).toEqual(["transport", 5]);
  }
  expect(read([more(entries(2), "A".repeat(MAX_CONTINUATION_LENGTH))]).end).toBeUndefined();
});

test("rejections are named from status and code, never from their text", () => {
  const named = (cause: unknown) => classifyRejection(cause);
  expect(named({ status: 429, code: "TOO_MANY_REQUESTS" })).toEqual({ kind: "busy" });
  expect(named({ status: 429, code: "ANYTHING" })).toEqual({ kind: "busy" });
  expect(named({ status: 504, code: "GATEWAY_TIMEOUT" })).toEqual({ kind: "deadline" });
  expect(named({ status: 413 })).toEqual({ kind: "transport" });
  expect(named({ status: 502, code: "BUS_ERROR" })).toEqual({ kind: "bus-error" });
  expect(named({ status: 502, code: "PAGE_REJECTED" })).toEqual({ kind: "rejected" });
  expect(named({ status: 502, code: "IDENTITY_MISMATCH", data: { field: "ledger" } })).toEqual({
    kind: "identity",
    field: "ledger",
  });
  expect(named({ status: 502, code: "IDENTITY_MISMATCH", data: { field: "other" } })).toEqual({
    kind: "identity",
    field: undefined,
  });
  for (const cause of [
    { status: 503, code: "SERVICE_UNAVAILABLE", message: "Viewer busy" },
    { status: 503, code: "UPSTREAM_UNAVAILABLE" },
    { status: 499, code: "OBSERVATION_CANCELLED" },
    { status: 500, code: "INTERNAL_SERVER_ERROR", message: "Investigation busy" },
    new TypeError("fetch failed"),
    undefined,
  ]) {
    expect(named(cause)).toEqual({ kind: "unavailable" });
  }
});

/** A driver whose pages and timers are answered by the test. */
const driven = (reference_ = reference) => {
  const requests: Array<{
    input: InvestigationPageInput;
    signal: AbortSignal;
    resolve: (page: InvestigationPage) => void;
    reject: (cause: unknown) => void;
  }> = [];
  const timers: Array<{ run: () => void; millis: number; active: boolean }> = [];
  const traversal = createPinnedTraversal({
    reference: reference_,
    readPage: (input, signal) =>
      new Promise((resolve, reject) => requests.push({ input, signal, resolve, reject })),
    busyRetryMillis: 750,
    pageDeadlineMillis: 12_000,
    schedule: (run, millis) => {
      const timer = { run, millis, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const fire = async (millis: number) => {
    for (const timer of timers.filter((each) => each.active && each.millis === millis)) {
      timer.active = false;
      timer.run();
    }
    await settle();
  };
  return {
    traversal,
    requests,
    timers,
    settle,
    start: async () => {
      traversal.start();
      await settle();
    },
    retry: () => fire(750),
    expire: () => fire(12_000),
    pending: (millis: number) =>
      timers.filter((each) => each.active && each.millis === millis).length,
    answer: async (value: InvestigationPage) => {
      requests.at(-1)?.resolve(value);
      await settle();
    },
    refuse: async (cause: unknown) => {
      requests.at(-1)?.reject(cause);
      await settle();
    },
  };
};
const ended = (end: TraversalEnd) => ({ kind: "ended" as const, end });

test("one-row pages end at the bound after exactly 200 page calls and no 201st", async () => {
  const run = driven();
  await run.start();
  for (let index = 0; index < 200; index++) await run.answer(more(entries(1)));
  await run.settle();
  const snapshot = run.traversal.getSnapshot();
  expect([snapshot.phase, snapshot.calls, snapshot.progress.entries.length]).toEqual([
    ended({ kind: "bound" }),
    200,
    200,
  ]);
  expect(run.requests).toHaveLength(200);
});

test("each page passes the previous continuation back unchanged, with the same reference", async () => {
  const run = driven();
  await run.start();
  const first = more(entries(2));
  await run.answer(first);
  await run.answer(last(entries(1)));
  expect<unknown>(run.requests.map((request) => request.input)).toEqual([
    { reference },
    { reference, cursor: first.next },
  ]);
  expect(Object.hasOwn(run.requests[0]?.input ?? {}, "cursor")).toBe(false);
  expect(run.traversal.getSnapshot().phase).toEqual(ended({ kind: "complete" }));
});

test("busy is retried after its pause, with the same page, and never counts as a page call", async () => {
  const run = driven();
  await run.start();
  await run.answer(more(entries(1)));
  const cursor = run.requests.at(-1)?.input.cursor;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sent = run.requests.length;
    await run.refuse({ status: 429, code: "TOO_MANY_REQUESTS" });
    expect(run.traversal.getSnapshot().phase).toEqual({ kind: "busy" });
    // Nothing is sent before the pause ends.
    await run.settle();
    expect(run.requests).toHaveLength(sent);
    expect(run.pending(750)).toBe(1);
    await run.retry();
  }
  expect(run.requests.at(-1)?.input.cursor).toBe(cursor);
  await run.answer(last(entries(1)));
  const snapshot = run.traversal.getSnapshot();
  expect([snapshot.phase, snapshot.calls, run.requests.length]).toEqual([
    ended({ kind: "complete" }),
    2,
    4,
  ]);
});

test("a bus error is a terminal failed page, never retried", async () => {
  const run = driven();
  await run.start();
  await run.answer(more(entries(4)));
  await run.refuse({ status: 502, code: "BUS_ERROR" });
  expect(run.pending(750)).toBe(0);
  const snapshot = run.traversal.getSnapshot();
  expect([snapshot.phase, snapshot.progress.entries.length, run.requests.length]).toEqual([
    ended({ kind: "bus-error" }),
    4,
    2,
  ]);
});

test("a page that never settles ends the reading as a deadline stop, keeping what was read", async () => {
  const run = driven();
  await run.start();
  await run.answer(more(entries(3)));
  const stuck = run.requests.at(-1);
  await run.expire();
  expect(stuck?.signal.aborted).toBe(true);
  const snapshot = run.traversal.getSnapshot();
  expect([snapshot.phase, snapshot.progress.entries.length]).toEqual([
    ended({ kind: "deadline" }),
    3,
  ]);
  // A late answer changes nothing.
  await run.answer(last(entries(1)));
  expect(run.traversal.getSnapshot()).toBe(snapshot);
});

test("cancelling during page k aborts it, page k+1 never starts, and the entries stay", async () => {
  for (const late of ["answer", "refuse"] as const) {
    const run = driven();
    await run.start();
    await run.answer(more(entries(3)));
    const pending = run.requests.at(-1);
    run.traversal.cancel();
    expect(pending?.signal.aborted).toBe(true);
    // The page settles anyway: nothing is joined and nothing more is sent.
    if (late === "answer") await run.answer(more(entries(5)));
    else await run.refuse({ status: 499, code: "OBSERVATION_CANCELLED" });
    const snapshot = run.traversal.getSnapshot();
    expect([snapshot.phase, snapshot.progress.entries.length, run.requests.length]).toEqual([
      ended({ kind: "cancelled" }),
      3,
      2,
    ]);
  }
});

test("a page aborted without the reader cancelling is unavailable, not cancelled", async () => {
  const run = driven();
  await run.start();
  await run.refuse({ status: 499, code: "OBSERVATION_CANCELLED" });
  expect(run.traversal.getSnapshot().phase).toEqual(ended({ kind: "unavailable" }));
});

test("cancelling while busy clears the retry; disposing stops notifications", async () => {
  const run = driven();
  await run.start();
  await run.refuse({ status: 429 });
  run.traversal.cancel();
  await run.retry();
  expect([run.traversal.getSnapshot().phase, run.requests.length]).toEqual([
    ended({ kind: "cancelled" }),
    1,
  ]);

  const disposed = driven();
  let notified = 0;
  disposed.traversal.subscribe(() => notified++);
  await disposed.start();
  const before = notified;
  disposed.traversal.dispose();
  await disposed.answer(last(entries(1)));
  expect(notified).toBe(before);
});

test("cancel and dispose retire a never-settling page's deadline, and a queued one changes nothing", async () => {
  const cancelled = driven();
  await cancelled.start();
  await cancelled.answer(more(entries(3)));
  cancelled.traversal.cancel();
  const after = cancelled.traversal.getSnapshot();
  expect(cancelled.pending(12_000)).toBe(0);
  // A deadline already queued when it was cleared runs anyway, and is ignored.
  for (const timer of cancelled.timers) timer.run();
  await cancelled.settle();
  expect(cancelled.traversal.getSnapshot()).toBe(after);
  expect([after.phase, after.progress.entries.length, cancelled.requests.length]).toEqual([
    ended({ kind: "cancelled" }),
    3,
    2,
  ]);

  const disposed = driven();
  let notified = 0;
  disposed.traversal.subscribe(() => notified++);
  await disposed.start();
  await disposed.answer(more(entries(3)));
  const before = [disposed.traversal.getSnapshot(), notified];
  disposed.traversal.dispose();
  expect([disposed.pending(12_000), disposed.pending(750)]).toEqual([0, 0]);
  for (const timer of disposed.timers) timer.run();
  await disposed.settle();
  expect([disposed.traversal.getSnapshot(), notified]).toEqual(before);
  expect(disposed.requests.length).toBe(2);
});

test("a listener that cancels or disposes as reading or busy is published stops before any page or timer", async () => {
  for (const action of ["cancel", "dispose"] as const) {
    const run = driven();
    run.traversal.subscribe(() => {
      if (run.traversal.getSnapshot().phase.kind === "reading") run.traversal[action]();
    });
    await run.start();
    expect([run.requests.length, run.timers.length]).toEqual([0, 0]);
    if (action === "cancel") {
      expect(run.traversal.getSnapshot().phase).toEqual(ended({ kind: "cancelled" }));
    }
  }
  const busy = driven();
  busy.traversal.subscribe(() => {
    if (busy.traversal.getSnapshot().phase.kind === "busy") busy.traversal.cancel();
  });
  await busy.start();
  await busy.refuse({ status: 429 });
  expect([
    busy.timers.filter((timer) => timer.millis === 750).length,
    busy.pending(12_000),
  ]).toEqual([0, 0]);
  expect(busy.traversal.getSnapshot().phase).toEqual(ended({ kind: "cancelled" }));
});

test("a page reader that throws synchronously ends the reading as unavailable", async () => {
  const traversal = createPinnedTraversal({
    reference,
    readPage: () => {
      throw new Error("synchronous");
    },
  });
  traversal.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(traversal.getSnapshot().phase).toEqual(ended({ kind: "unavailable" }));
  traversal.dispose();
});

test("a reference refused for size makes no call; one exactly at the fit starts", async () => {
  // Pads one participant until the request with a longest continuation is exactly the limit.
  const at = (padding: number): InvestigationReference => ({
    ...reference,
    criteria: {
      ...reference.criteria,
      participants: [
        ...Array.from({ length: 5 }, (_, index) => `#${index}${"f".repeat(500)}`),
        `~${"p".repeat(padding)}`,
      ],
    },
  });
  const longest = (value: InvestigationReference) =>
    requestBytes({ reference: value, cursor: "A".repeat(MAX_CONTINUATION_LENGTH) });
  let padding = 0;
  while (longest(at(padding + 1)) <= 4_096) padding++;
  expect([longest(at(padding)), longest(at(padding + 1))]).toEqual([4_096, 4_097]);

  const fits = driven(at(padding));
  await fits.start();
  expect([fits.traversal.getSnapshot().phase, fits.requests.length]).toEqual([
    { kind: "reading" },
    1,
  ]);
  const over = driven(at(padding + 1));
  await over.start();
  expect([over.traversal.getSnapshot().phase, over.requests.length]).toEqual([
    { kind: "too-large" },
    0,
  ]);
});
