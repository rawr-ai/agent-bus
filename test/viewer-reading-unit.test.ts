import { describe, expect, test } from "bun:test";
import {
  type HistoryInput,
  type PublicMessage,
  projectHistory,
  projectThread,
  type Snapshot,
} from "../viewer/shared/public";
import type { ConversationContext } from "../viewer/src/features/conversations/model";
import {
  EMPTY_READING_SNAPSHOT,
  type ReadingIntent,
  type ReadingUnit,
  reconcileReadingUnit,
} from "../viewer/src/reading-unit";
import { treeLabel, upstreamNotes, windowLabel } from "../viewer/src/snapshot-labels";
import { busPage, entryRow } from "./bus-pages";
import { PRESENCE_TREE, presenceTreePage, presenceTreeRows } from "./presence-tree";

const message = (id: string): PublicMessage => ({
  id,
  ts: "opaque time",
  from: "sender",
  to: ["#alpha"],
  kind: "message",
  body: id,
});
const AT: Snapshot = { ledger: "ledger-a", t: 10 };
const flow = (
  ids: readonly string[],
  context: ConversationContext = { kind: "topic", value: "#alpha" },
  criteria: HistoryInput = { limit: 200 },
  snapshot: Snapshot = AT
): ReadingUnit => ({
  kind: "flow",
  context,
  messages: ids.map(message),
  criteria,
  observedAt: "older observation",
  snapshot,
  window: "latest",
  count: ids.length,
  damaged: 0,
  omitted: 0,
  complete: false,
});
const conversation = (
  ids: readonly string[],
  selectedMessageId = "C",
  criteria: HistoryInput = { limit: 200 },
  snapshot: Snapshot = AT
): ReadingUnit => {
  const messages = ids.map(message);
  return {
    kind: "conversation",
    selectedMessageId,
    messages,
    criteria,
    observedAt: "older observation",
    snapshot,
    tree: { missingReplyTargets: [], exhausted: true, damaged: 0, complete: true, omitted: 0 },
    conversation: {
      anchorMessageId: ids[0] ?? "",
      messages,
      missingTargetIds: [],
      latestSourceIndex: ids.length - 1,
      cyclic: false,
    },
  };
};
const selected: ReadingIntent = { kind: "conversation", selectedMessageId: "C" };
const alpha: ReadingIntent = { kind: "flow", context: { kind: "topic", value: "#alpha" } };
const initial = (unit: ReadingUnit) => ({ unit, retained: false });

test("conversation retains any evicted member even while user-selected C remains current", () => {
  const before = conversation(["A", "B", "C"]);
  const current = conversation(["B", "C"]);
  const result = reconcileReadingUnit(initial(before), selected, current);
  expect(result.retained).toBe(true);
  expect(result.unit).toBe(before);
  expect(result.unit?.messages.map((item) => item.id)).toEqual(["A", "B", "C"]);
  expect(current.messages.map((item) => item.id)).toEqual(["B", "C"]);
});

test("flow eviction retains the whole literal flow, not an invented conversation or union", () => {
  const before = flow(["A", "B", "C"]);
  const current = flow(["B", "C", "D"]);
  const retained = reconcileReadingUnit(initial(before), alpha, current);
  expect(retained.retained).toBe(true);
  expect(retained.unit).toBe(before);
  expect(retained.unit?.kind).toBe("flow");
  expect(retained.unit?.messages.map((item) => item.id)).toEqual(["A", "B", "C"]);
  const later = reconcileReadingUnit(retained, alpha, flow(["E"]));
  expect(later).toBe(retained);
  expect(later.unit).toBe(before);
});

test("retention is one snapshot until explicit acceptance, including when old IDs reappear", () => {
  const before = flow(["A", "B"]);
  const retained = reconcileReadingUnit(initial(before), alpha, flow(["B", "C"]));
  const reappeared = flow(["A", "B", "D"]);
  expect(reconcileReadingUnit(retained, alpha, reappeared)).toBe(retained);
  const accepted = reconcileReadingUnit(EMPTY_READING_SNAPSHOT, alpha, reappeared);
  expect(accepted.retained).toBe(false);
  expect(accepted.unit).toBe(reappeared);
  expect(accepted.unit?.messages.map((item) => item.id)).toEqual(["A", "B", "D"]);
});

test("new replies, merges and reordered source records advance when no prior ID is evicted", () => {
  const before = conversation(["A", "B", "C"]);
  const current = conversation(["E", "D", "A", "C", "B"]);
  const result = reconcileReadingUnit(initial(before), selected, current);
  expect(result.retained).toBe(false);
  expect(result.unit).toBe(current);
  expect(result.unit?.messages.map((item) => item.id)).toEqual(["E", "D", "A", "C", "B"]);
  const oldFlow = flow(["B", "A"]);
  const currentFlow = flow(["D", "B", "A"]);
  expect(reconcileReadingUnit(initial(oldFlow), alpha, currentFlow).unit).toBe(currentFlow);
});

test("missing current selection retains prior unit, but no reading intent clears it", () => {
  const before = conversation(["A", "C"]);
  const retained = reconcileReadingUnit(initial(before), selected, null);
  expect(retained).toEqual({ unit: before, retained: true });
  expect(reconcileReadingUnit(retained, null, null)).toBe(EMPTY_READING_SNAPSHOT);
  expect(reconcileReadingUnit(EMPTY_READING_SNAPSHOT, selected, null)).toBe(EMPTY_READING_SNAPSHOT);
});

test("reading identity is user-selected ID or exact literal context, never arbitrary group anchor", () => {
  const before = conversation(["A", "B", "C"]);
  const newSelection: ReadingIntent = { kind: "conversation", selectedMessageId: "B" };
  const current = conversation(["B"], "B");
  expect(reconcileReadingUnit(initial(before), newSelection, current)).toEqual({
    unit: current,
    retained: false,
  });
  for (const context of [
    { kind: "topic", value: "#Alpha" },
    { kind: "topic", value: "#alpha " },
    { kind: "address", value: "#alpha" },
    { kind: "address", value: "" },
  ] as const) {
    const next = flow(["new"], context);
    expect(reconcileReadingUnit(initial(flow(["old"])), { kind: "flow", context }, next)).toEqual({
      unit: next,
      retained: false,
    });
  }
  expect(reconcileReadingUnit(initial(flow(["A"])), selected, before).unit).toBe(before);
});

test("changed criteria/time never relabel retained group or flow metadata", () => {
  const oldCriteria = { limit: 200, query: " OLD ", participant: "Peer/A" };
  const newCriteria = { limit: 100, query: "new", participant: "Peer/B" };
  for (const [intent, before, current] of [
    [selected, conversation(["A", "C"], "C", oldCriteria), conversation(["C"], "C", newCriteria)],
    [
      alpha,
      flow(["A", "C"], alpha.kind === "flow" ? alpha.context : { kind: "all" }, oldCriteria),
      flow(["C"], { kind: "topic", value: "#alpha" }, newCriteria),
    ],
  ] as const) {
    const result = reconcileReadingUnit(initial(before), intent, {
      ...current,
      observedAt: "new observation",
    });
    expect(result.unit?.criteria).toBe(oldCriteria);
    expect(result.unit?.observedAt).toBe("older observation");
    expect(result.retained).toBe(true);
  }
});

test("empty IDs are meaningful and 200-record units preserve full source order without mutation", () => {
  const before = conversation(["", "tail"], "tail");
  expect(
    reconcileReadingUnit(
      initial(before),
      { kind: "conversation", selectedMessageId: "tail" },
      conversation(["tail"], "tail")
    ).retained
  ).toBe(true);
  const ids = Array.from({ length: 200 }, (_, index) => String(index));
  const oldFlow = flow(ids);
  const newFlow = flow([...ids].reverse());
  Object.freeze(oldFlow.messages);
  Object.freeze(oldFlow.criteria);
  Object.freeze(oldFlow);
  const state = Object.freeze(initial(oldFlow));
  const result = reconcileReadingUnit(state, alpha, newFlow);
  expect(result.unit).toBe(newFlow);
  expect(result.unit?.messages.map((item) => item.id)).toEqual([...ids].reverse());
  expect(oldFlow.messages.map((item) => item.id)).toEqual(ids);
  expect(state.retained).toBe(false);
});

test("mismatched candidates and over-bound units refuse without reflecting values", () => {
  expect(() => reconcileReadingUnit(EMPTY_READING_SNAPSHOT, alpha, conversation(["C"]))).toThrow(
    "Reading observation rejected"
  );
  expect(() =>
    reconcileReadingUnit(
      EMPTY_READING_SNAPSHOT,
      alpha,
      flow(Array.from({ length: 201 }, (_, i) => `private-${i}`))
    )
  ).toThrow("Reading observation rejected");
});

test("a reading stays frozen at its snapshot: another ledger or an earlier commit is never mixed in", () => {
  for (const [intent, make] of [
    [selected, (snapshot: Snapshot) => conversation(["A", "C"], "C", { limit: 200 }, snapshot)],
    [
      alpha,
      (snapshot: Snapshot) =>
        flow(["A", "C"], { kind: "topic", value: "#alpha" }, { limit: 200 }, snapshot),
    ],
  ] as const) {
    const before = make(AT);
    // The same messages from a replaced ledger are not the same reading.
    const replaced = reconcileReadingUnit(initial(before), intent, make({ ...AT, ledger: "b" }));
    expect(replaced).toEqual({ unit: before, retained: true });
    // An answer from an earlier commit never replaces a later one.
    const earlier = reconcileReadingUnit(initial(before), intent, make({ ...AT, t: 9 }));
    expect(earlier).toEqual({ unit: before, retained: true });
    // A later commit holding every displayed message advances, carrying its own t.
    const later = make({ ...AT, t: 11, currentHeadT: 12 });
    const advanced = reconcileReadingUnit(initial(before), intent, later);
    expect(advanced).toEqual({ unit: later, retained: false });
    expect(advanced.unit?.snapshot.t).toBe(11);
    // Accepting the current unit (explicit selection) moves to the current commit.
    const accepted = reconcileReadingUnit(
      EMPTY_READING_SNAPSHOT,
      intent,
      make({ ...AT, ledger: "b" })
    );
    expect(accepted.unit?.snapshot.ledger).toBe("b");
    expect(accepted.retained).toBe(false);
  }
});

test("labels name the commit and come from the bus's exhaustion, damage and ranking", () => {
  const at: Snapshot = { ledger: "l", t: 812 };
  const all = { limit: 200 };
  expect(windowLabel("latest", at, 200, all, 0, 0)).toBe(
    "Latest 200 entries at commit 812; older entries exist"
  );
  expect(windowLabel("latest", at, 1, all, 0, 0)).toBe(
    "Latest 1 entry at commit 812; older entries exist"
  );
  // 200 rows that are every entry are all of them, not "latest 200".
  expect(windowLabel("all", at, 200, all, 0, 0)).toBe("All entries at commit 812");
  expect(windowLabel("all", at, 3, { limit: 200, participant: "#x" }, 0, 0)).toBe(
    "All entries naming this participant at commit 812"
  );
  expect(windowLabel("readable", at, 3, all, 2, 0)).toBe(
    "All readable entries at commit 812; 2 unreadable"
  );
  expect(windowLabel("readable", at, 3, { limit: 200, participant: "#x" }, 1, 0)).toBe(
    "All readable entries naming this participant at commit 812; 1 unreadable"
  );
  expect(windowLabel("ranked", at, 3, { limit: 200, query: "q" }, 0, 0)).toBe(
    "Best matches at commit 812; ranked, not complete"
  );
  const tree = (exhausted: boolean, damaged: number, missing: number, omitted = 0) => ({
    exhausted,
    damaged,
    missingReplyTargets: Array.from({ length: missing }, (_, index) => `gone-${index}`),
    omitted,
  });
  expect(treeLabel(tree(true, 0, 0), at, 4)).toBe("Whole reply tree at commit 812");
  expect(treeLabel(tree(true, 3, 0), at, 4)).toBe(
    "All readable entries of the reply tree at commit 812; 3 unreadable"
  );
  expect(treeLabel(tree(true, 0, 1), at, 2)).toBe(
    "Reply tree at commit 812; cut at 1 missing entry"
  );
  expect(treeLabel(tree(true, 1, 2), at, 2)).toBe(
    "Reply tree at commit 812; cut at 2 missing entries; 1 unreadable"
  );
  expect(treeLabel(tree(false, 0, 0), at, 200)).toBe(
    "First 200 entries of the reply tree at commit 812; more exist"
  );
  expect(treeLabel(tree(false, 1, 2), at, 200)).toBe(
    "First 200 entries of the reply tree at commit 812; more exist; cut at 2 missing entries; 1 unreadable"
  );
  // The viewer's own omissions are named apart from the bus's damage, and prevent "whole".
  expect(treeLabel(tree(true, 0, 0, 1), at, 3)).toBe(
    "All entries of the reply tree at commit 812; 1 omitted by the viewer"
  );
  expect(treeLabel(tree(true, 2, 0, 1), at, 3)).toBe(
    "All readable entries of the reply tree at commit 812; 2 unreadable; 1 omitted by the viewer"
  );
  expect(treeLabel(tree(true, 0, 1, 2), at, 3)).toBe(
    "Reply tree at commit 812; cut at 1 missing entry; 2 omitted by the viewer"
  );
  expect(treeLabel(tree(false, 0, 0, 1), at, 200)).toBe(
    "First 200 entries of the reply tree at commit 812; more exist; 1 omitted by the viewer"
  );
  expect(windowLabel("all", at, 3, all, 0, 1)).toBe(
    "All entries at commit 812; 1 omitted by the viewer"
  );
  expect(windowLabel("readable", at, 3, all, 1, 2)).toBe(
    "All readable entries at commit 812; 1 unreadable; 2 omitted by the viewer"
  );
  expect(windowLabel("latest", at, 3, all, 0, 1)).toBe(
    "Latest 3 entries at commit 812; older entries exist; 1 omitted by the viewer"
  );
  expect(windowLabel("ranked", at, 3, { limit: 200, query: "q" }, 0, 1)).toBe(
    "Best matches at commit 812; ranked, not complete; 1 omitted by the viewer"
  );
  expect(upstreamNotes(at, 0)).toEqual([]);
  // Visible text says "commit N"; each note keeps the raw t it names for its tooltip.
  expect(upstreamNotes({ ...at, currentHeadT: 815 }, 2)).toEqual([
    { text: "2 entries unreadable at commit 812", t: 812 },
    { text: "The bus reached commit 815 while this was read", t: 815 },
  ]);
});

describe("from the bus's pages to the label a reader sees", () => {
  const LEDGER = "ledger-a";
  const T = 40;
  const row = (id: string, t: number, replyTo?: string) =>
    entryRow(
      {
        id,
        ts: "opaque time",
        from: "sender",
        to: ["#alpha"],
        kind: "message",
        body: id,
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      t
    );
  const window = (page: Parameters<typeof busPage>[0]) => {
    const observation = projectHistory([busPage(page)], { limit: 50 }, "at");
    return windowLabel(
      observation.window,
      observation.snapshot,
      observation.messages.length + observation.omitted,
      observation.criteria,
      observation.damaged,
      observation.omitted
    );
  };
  const tree = (page: Omit<Parameters<typeof busPage>[0], "name" | "args" | "ledger" | "t">) => {
    const observation = projectThread(
      [busPage({ name: "thread", args: { id: "a", limit: 200 }, ledger: LEDGER, t: T, ...page })],
      { id: "a", ledger: LEDGER, t: T },
      "at"
    );
    return treeLabel(
      observation,
      observation.snapshot,
      observation.messages.length + observation.omitted
    );
  };
  const history = { name: "history", args: { limit: 50 }, ledger: LEDGER, t: T } as const;
  const rows = [row("a", 1), row("b", 2, "a")];

  test("clean and exhausted: all entries, the whole tree", () => {
    expect(window({ ...history, rows })).toBe("All entries at commit 40");
    expect(tree({ rows, extra: { missingReplyTargets: [] } })).toBe(
      "Whole reply tree at commit 40"
    );
  });

  test("not exhausted: the latest entries, the first of the tree", () => {
    expect(window({ ...history, rows, next: "more" })).toBe(
      "Latest 2 entries at commit 40; older entries exist"
    );
    expect(tree({ rows, next: "more", extra: { missingReplyTargets: [] } })).toBe(
      "First 2 entries of the reply tree at commit 40; more exist"
    );
  });

  test("damaged and exhausted: all readable entries, never all or whole", () => {
    expect(window({ ...history, rows, damaged: 1 })).toBe(
      "All readable entries at commit 40; 1 unreadable"
    );
    expect(tree({ rows, damaged: 1, extra: { missingReplyTargets: [] } })).toBe(
      "All readable entries of the reply tree at commit 40; 1 unreadable"
    );
  });

  test("a presence withheld inside an exhausted tree: every message kept, never whole", () => {
    // Codex's reproduction: root <- presence <- selected, exhausted, undamaged, complete.
    const page = presenceTreePage(LEDGER, T);
    const request = { id: PRESENCE_TREE.selected, ledger: LEDGER, t: T };
    const observation = projectThread([page], request, "at");
    expect(page.exhausted && page.complete && page.damaged === 0).toBe(true);
    expect(observation.messages.map((message) => message.id)).toEqual([
      PRESENCE_TREE.root,
      PRESENCE_TREE.selected,
    ]);
    expect(observation.omitted).toBe(1);
    expect(observation.missingReplyTargets).toEqual([]);
    expect(
      treeLabel(
        observation,
        observation.snapshot,
        observation.messages.length + observation.omitted
      )
    ).toBe("All entries of the reply tree at commit 40; 1 omitted by the viewer");
    // The same withheld record in a history window: all entries, but not all shown.
    expect(window({ ...history, rows: presenceTreeRows })).toBe(
      "All entries at commit 40; 1 omitted by the viewer"
    );
  });

  test("a missing target, exhausted: the tree is cut there, never whole", () => {
    const cut = [row("a", 1, "gone"), row("b", 2, "a")];
    expect(tree({ rows: cut, extra: { missingReplyTargets: ["gone"] } })).toBe(
      "Reply tree at commit 40; cut at 1 missing entry"
    );
  });
});
