import { expect, test } from "bun:test";
import type { HistoryInput, PublicMessage, Snapshot } from "../viewer/shared/public";
import type { ConversationContext } from "../viewer/src/features/conversations/model";
import {
  EMPTY_READING_SNAPSHOT,
  type ReadingIntent,
  type ReadingUnit,
  reconcileReadingUnit,
} from "../viewer/src/reading-unit";
import { treeLabel, upstreamNotes, windowLabel } from "../viewer/src/snapshot-labels";

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

test("window labels come from the bus's exhaustion and ranking, not from the row count", () => {
  const at: Snapshot = { ledger: "l", t: 812 };
  expect(windowLabel("latest", at, 200, { limit: 200 })).toBe(
    "Latest 200 entries at t=812; older entries exist"
  );
  expect(windowLabel("latest", at, 1, { limit: 200 })).toBe(
    "Latest 1 entry at t=812; older entries exist"
  );
  // 200 rows that are every entry are all of them, not "latest 200".
  expect(windowLabel("all", at, 200, { limit: 200 })).toBe("All entries at t=812");
  expect(windowLabel("all", at, 3, { limit: 200, participant: "#x" })).toBe(
    "All entries naming this participant at t=812"
  );
  expect(windowLabel("ranked", at, 3, { limit: 200, query: "q" })).toBe(
    "Best matches at t=812; ranked, not complete"
  );
  expect(treeLabel(true, at, 4, 0)).toBe("Whole reply tree at t=812");
  expect(treeLabel(true, at, 2, 1)).toBe("Reply tree at t=812; cut at 1 missing entry");
  expect(treeLabel(false, at, 200, 0)).toBe(
    "First 200 entries of the reply tree at t=812; more exist"
  );
  expect(treeLabel(false, at, 200, 2)).toBe(
    "First 200 entries of the reply tree at t=812; more exist; cut at 2 missing entries"
  );
  expect(upstreamNotes(at, 0)).toEqual([]);
  expect(upstreamNotes({ ...at, currentHeadT: 815 }, 2)).toEqual([
    "2 entries unreadable at t=812",
    "The bus reached t=815 while this was read",
  ]);
});
