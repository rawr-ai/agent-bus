import { expect, test } from "bun:test";
import type { HistoryInput, PublicMessage } from "../viewer/shared/public";
import type { ConversationContext } from "../viewer/src/features/conversations/model";
import {
  EMPTY_READING_SNAPSHOT,
  type ReadingIntent,
  type ReadingUnit,
  reconcileReadingUnit,
} from "../viewer/src/reading-unit";

const message = (id: string): PublicMessage => ({
  id,
  ts: "opaque time",
  from: "sender",
  to: ["#alpha"],
  kind: "message",
  body: id,
});
const flow = (
  ids: readonly string[],
  context: ConversationContext = { kind: "topic", value: "#alpha" },
  criteria: HistoryInput = { limit: 200 }
): ReadingUnit => ({
  kind: "flow",
  context,
  messages: ids.map(message),
  criteria,
  observedAt: "older observation",
});
const conversation = (
  ids: readonly string[],
  selectedMessageId = "C",
  criteria: HistoryInput = { limit: 200 }
): ReadingUnit => {
  const messages = ids.map(message);
  return {
    kind: "conversation",
    selectedMessageId,
    messages,
    criteria,
    observedAt: "older observation",
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
