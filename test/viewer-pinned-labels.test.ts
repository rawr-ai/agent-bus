// Every word a pinned investigation shows about its state, written out by hand: the screen
// renders only these functions, so this table is the wording oracle for every end.
import { expect, test } from "bun:test";
import type { InvestigationEntry, InvestigationReference } from "../viewer/shared/public.ts";
import { countsLabel, coverageLabel, statusLabel } from "../viewer/src/features/pinned/labels.ts";
import {
  emptyProgress,
  type Progress,
  type TraversalPhase,
  type TraversalSnapshot,
} from "../viewer/src/features/pinned/traversal.ts";

const reference: InvestigationReference = {
  name: "history",
  catalogueVersion: 1,
  ledger: "fixture-ledger",
  t: 9,
  criteria: { kinds: ["message"], direction: "forward" },
};
const kept = (count: number): InvestigationEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    t: 5,
    message: {
      id: `m${index}`,
      ts: "2026-11-01T12:00:00.000Z",
      from: "fixture/a",
      to: ["#review"],
      kind: "message",
      body: "body",
    },
  }));
const snapshot = (
  phase: TraversalPhase,
  progress: Partial<Progress> & { kept?: number } = {}
): TraversalSnapshot => {
  const { kept: count = 0, ...rest } = progress;
  return {
    reference,
    phase,
    progress: { ...emptyProgress, entries: kept(count), ...rest },
    calls: 0,
  };
};
const ended = (end: Extract<TraversalPhase, { kind: "ended" }>["end"]) =>
  ({ kind: "ended", end }) as const;
const REST = "The rest were not kept, and nothing is claimed about them.";

test("running phases say what is happening, on which page, and claim nothing", () => {
  expect(statusLabel(snapshot({ kind: "idle" }))).toBe("Not started.");
  expect(statusLabel(snapshot({ kind: "reading" }))).toBe("Reading page 1 at commit 9.");
  expect(statusLabel(snapshot({ kind: "reading" }, { kept: 3, pages: 2 }))).toBe(
    "Reading page 3 at commit 9."
  );
  expect(statusLabel(snapshot({ kind: "busy" }, { kept: 3, pages: 2 }))).toBe(
    "Waiting: the viewer is busy with other reads. Retrying page 3."
  );
  expect(statusLabel(snapshot({ kind: "too-large" }))).toBe(
    "Not read: this reference is too large to send with a continuation. Ask the agent for a reference with fewer participants."
  );
  for (const phase of [
    { kind: "idle" },
    { kind: "reading" },
    { kind: "busy" },
    { kind: "too-large" },
  ] as const) {
    expect(coverageLabel(snapshot(phase, { kept: 3, pages: 1 }))).toBeUndefined();
  }
});

test("complete names the criteria and commit, and carries no partial label", () => {
  expect(statusLabel(snapshot(ended({ kind: "complete" }), { kept: 0, pages: 1 }))).toBe(
    "Complete: no messages match these criteria at commit 9."
  );
  expect(statusLabel(snapshot(ended({ kind: "complete" }), { kept: 1, pages: 1 }))).toBe(
    "Complete: all 1 message matching these criteria at commit 9."
  );
  expect(statusLabel(snapshot(ended({ kind: "complete" }), { kept: 200, pages: 3 }))).toBe(
    "Complete: all 200 messages matching these criteria at commit 9."
  );
  expect(
    coverageLabel(snapshot(ended({ kind: "complete" }), { kept: 200, pages: 3 }))
  ).toBeUndefined();
});

test("each stop has its own words, and none says complete", () => {
  const stops = [
    [{ kind: "bound" }, "Stopped at the 200-entry bound."],
    [
      { kind: "transport" },
      "Stopped: the next page cannot be requested within the viewer's request limits.",
    ],
    [{ kind: "deadline" }, "Stopped: a page did not answer in time."],
    [{ kind: "cancelled" }, "Cancelled: you stopped the reading."],
    [{ kind: "bus-error" }, "Stopped: the bus refused the page."],
    [{ kind: "rejected" }, "Stopped: the bus returned a page the viewer cannot read."],
    [{ kind: "unavailable" }, "Stopped: the viewer could not reach the bus."],
    [
      { kind: "fault", fault: "continuation-after-end" },
      "Stopped: the bus returned a continuation after its last page.",
    ],
    [
      { kind: "fault", fault: "missing-continuation" },
      "Stopped: the bus returned no continuation before its last page.",
    ],
    [
      { kind: "fault", fault: "repeated-continuation" },
      "Stopped: the bus returned a continuation it had already returned.",
    ],
    [
      { kind: "fault", fault: "repeated-entry" },
      "Stopped: the bus returned an entry already read.",
    ],
    [
      { kind: "fault", fault: "out-of-order" },
      "Stopped: the bus returned entries out of commit order.",
    ],
    [
      { kind: "fault", fault: "stalled" },
      "Stopped: the bus returned an empty page that did not end the reading.",
    ],
    [
      { kind: "fault", fault: "damage-count" },
      "Stopped: the bus returned a damage total that does not add up.",
    ],
    [
      { kind: "fault", fault: "unclaimed-end" },
      "Stopped: the bus returned a clean last page that did not claim the whole window.",
    ],
    [
      { kind: "identity", field: undefined },
      "Stopped: the bus answered for a different reading than this reference.",
    ],
    [
      { kind: "identity", field: "name" },
      "Stopped: the bus answered for a different query than this reference.",
    ],
    [
      { kind: "identity", field: "catalogueVersion" },
      "Stopped: the bus answered for a different catalogue version than this reference.",
    ],
    [
      { kind: "identity", field: "ledger" },
      "Stopped: the bus answered for a different ledger than this reference.",
    ],
    [
      { kind: "identity", field: "t" },
      "Stopped: the bus answered for a different commit than this reference.",
    ],
    [
      { kind: "identity", field: "criteria" },
      "Stopped: the bus answered for a different set of criteria than this reference.",
    ],
    [
      { kind: "identity", field: "limit" },
      "Stopped: the bus answered for a different page size than this reference.",
    ],
    [{ kind: "damaged" }, "Stopped: the bus met 1 unreadable entry.", { damaged: 1 }],
    [{ kind: "damaged" }, "Stopped: the bus met 3 unreadable entries.", { damaged: 3 }],
    [{ kind: "omitted" }, "Stopped: the viewer omitted 1 record it cannot show.", { omitted: 1 }],
    [{ kind: "omitted" }, "Stopped: the viewer omitted 2 records it cannot show.", { omitted: 2 }],
  ] as const;
  for (const [end, words, met] of stops) {
    for (const count of [0, 4]) {
      const stopped = snapshot(ended(end), { kept: count, pages: 2, ...met });
      expect(statusLabel(stopped)).toBe(words);
      expect(statusLabel(stopped)).not.toMatch(/complete/i);
      expect(coverageLabel(stopped) ?? "").not.toMatch(/complete/i);
    }
  }
});

test("kept entries beside a stop are partial; earliest only when nothing was met between them", () => {
  const coverage = (kept: number, met: Partial<Progress> = {}) =>
    coverageLabel(snapshot(ended({ kind: "bound" }), { kept, pages: 2, ...met }));
  expect(coverage(0)).toBe("No entries were kept before the stop.");
  expect(coverage(0, { damaged: 1 })).toBe("No entries were kept before the stop.");
  expect(coverage(1)).toBe(`Partial: the earliest 1 entry of the window. ${REST}`);
  expect(coverage(200)).toBe(`Partial: the earliest 200 entries of the window. ${REST}`);
  expect(coverage(196, { damaged: 1 })).toBe(
    `Partial: 196 readable entries from the start of the window; 1 unreadable met while reading. ${REST}`
  );
  expect(coverage(1, { omitted: 2 })).toBe(
    `Partial: 1 readable entry from the start of the window; 2 omitted by the viewer met while reading. ${REST}`
  );
  expect(coverage(4, { damaged: 2, omitted: 1 })).toBe(
    `Partial: 4 readable entries from the start of the window; 2 unreadable and 1 omitted by the viewer met while reading. ${REST}`
  );
});

test("counts name every quantity the reading kept or met", () => {
  expect(countsLabel(snapshot({ kind: "idle" }))).toBe(
    "0 entries kept · 0 pages read · 0 omitted by the viewer · 0 unreadable"
  );
  expect(countsLabel(snapshot({ kind: "reading" }, { kept: 1, pages: 1 }))).toBe(
    "1 entry kept · 1 page read · 0 omitted by the viewer · 0 unreadable"
  );
  expect(
    countsLabel(snapshot(ended({ kind: "damaged" }), { kept: 7, pages: 3, damaged: 2, omitted: 1 }))
  ).toBe("7 entries kept · 3 pages read · 1 omitted by the viewer · 2 unreadable");
});
