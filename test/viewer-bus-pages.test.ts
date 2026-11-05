import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CATALOGUE_VERSION, MAX_ENVELOPE_BYTES, operations } from "../src/catalogue.ts";
import {
  historyOf,
  peersOf,
  resetStoryBus,
  type StoryPeer,
  storyBusPages,
  threadOf,
} from "../stories/story-bus.ts";
import {
  checkReference,
  isSupportedContinuation,
  type PublicMessage,
  projectInvestigationPage,
} from "../viewer/shared/public.ts";
import { acceptPage, emptyProgress, type Step } from "../viewer/src/features/pinned/traversal.ts";
import { PAGE_CATALOGUE_VERSION, PAGE_UNITS } from "./bus-pages.ts";
import { PRESENCE_TREE, presenceTreePage } from "./presence-tree.ts";
import {
  FIXTURE_LEDGER,
  FIXTURE_MODES,
  FIXTURE_PAGE_BYTES,
  fixturePages,
  INVESTIGATION_ARGS,
  MALFORMED_MODES,
  STRESS_MESSAGES,
} from "./viewer-reading-fixture.ts";

// The viewer's synthetic buses (the browser fixture and the stories) answer with pages the
// real bus could send: rows decode with the catalogue's own row schemas, and the envelope's
// metadata matches the catalogue's literals. Their semantic expectations stay handwritten in
// the fixture and the stories; this checks only that their inputs are the bus's.

const ENVELOPE_KEYS = [
  "name",
  "catalogueVersion",
  "ledger",
  "t",
  "currentHeadT",
  "unit",
  "args",
  "rows",
  "damage",
  "damaged",
  "damagedAt",
  "damagedTotal",
  "exhausted",
  "complete",
  "next",
  "note",
];
/** Fields an operation adds to its envelope, as the catalogue's fetch returns them. */
const EXTRA_KEYS: Record<string, readonly string[]> = {
  history: [],
  search: [],
  peers: [],
  thread: ["root", "members", "missingReplyTargets"],
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("not a page");
  return value as Record<string, unknown>;
};

/** Every row of a page that its operation's row schema refuses, excess keys included. */
const refusedRows = (page: Record<string, unknown>) => {
  const operation = operations.find((candidate) => candidate.name === page.name);
  if (operation === undefined) throw new Error(`no operation ${String(page.name)}`);
  const decode = Schema.decodeUnknownExit(operation.Row as Schema.Codec<unknown, unknown>);
  const rows = page.rows as unknown[];
  return rows.filter((row) => decode(row, { onExcessProperty: "error" })._tag === "Failure");
};

/** Envelope metadata, checked against the catalogue's operation and its literals. */
const expectEnvelope = (value: unknown) => {
  const page = record(value);
  const operation = operations.find((candidate) => candidate.name === page.name);
  expect(operation).toBeDefined();
  if (operation === undefined) return;
  const extras = EXTRA_KEYS[operation.name] ?? [];
  for (const key of Object.keys(page)) expect([...ENVELOPE_KEYS, ...extras]).toContain(key);
  expect(page.catalogueVersion).toBe(CATALOGUE_VERSION);
  expect(page.unit).toBe(operation.unit);
  expect(page.damage).toBe("checked");
  expect(Number.isSafeInteger(page.t) && (page.t as number) >= 1).toBe(true);
  if ("currentHeadT" in page) expect(page.currentHeadT as number).toBeGreaterThan(page.t as number);
  expect(page.exhausted).toBe(!("next" in page));
  expect(page.complete).toBe(
    page.exhausted === true && page.damagedTotal === 0 && operation.coverage === "entries"
  );
  expect(page.damaged as number).toBeLessThanOrEqual(page.damagedTotal as number);
  if (operation.name === "thread") {
    expect(Number.isSafeInteger(page.members)).toBe(true);
    expect(Array.isArray(page.missingReplyTargets)).toBe(true);
  }
  // The bus refuses a page over its budget, even a page of one row.
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
};

test("the shared page builder claims the catalogue's version, units and budget", () => {
  expect(PAGE_CATALOGUE_VERSION).toBe(CATALOGUE_VERSION);
  expect(FIXTURE_PAGE_BYTES).toBe(MAX_ENVELOPE_BYTES);
  for (const [name, unit] of Object.entries(PAGE_UNITS))
    expect(operations.find((operation) => operation.name === name)?.unit).toBe(unit);
});

test("the presence-tree fixture is a page the bus could send: exhausted, complete, whole", () => {
  const page = record(presenceTreePage("ledger-a"));
  expectEnvelope(page);
  // Every row, the presence included, decodes with the catalogue's thread row.
  expect(refusedRows(page)).toEqual([]);
  expect((page.rows as Array<{ id: string }>).map((row) => row.id)).toEqual([
    PRESENCE_TREE.root,
    PRESENCE_TREE.presence,
    PRESENCE_TREE.selected,
  ]);
  expect([page.exhausted, page.complete, page.damagedTotal, page.missingReplyTargets]).toEqual([
    true,
    true,
    0,
    [],
  ]);
});

describe("the browser fixture", () => {
  const valid = FIXTURE_MODES.filter((mode) => !MALFORMED_MODES.includes(mode));

  for (const mode of valid) {
    test(`${mode}: every page decodes with the catalogue's row schema and literals`, () => {
      const pages = fixturePages(mode);
      // Each operation the viewer reads is answered.
      expect(new Set(pages.map((page) => record(page).name))).toEqual(
        new Set(["history", "search", "peers", "thread"])
      );
      for (const page of pages) {
        expectEnvelope(page);
        expect(refusedRows(record(page))).toEqual([]);
      }
    });
  }

  test("the large source needs more than one history page, as the bus would page it", () => {
    const history = fixturePages("stress").filter((page) => record(page).name === "history");
    expect(history.length).toBeGreaterThan(1);
  });

  test("a pinned investigation of the stress mode is two byte-cut pages the viewer reads whole", () => {
    // Handwritten: the large source fits after the fourteen initial entries, and the control
    // notation entry takes a page of its own. Commits 1 to 14 are `initial`, 21 and 22 `stress`.
    const expected = [
      { commits: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 21], next: "fixture.history.15" },
      { commits: [22], next: undefined },
    ];
    const pages = fixturePages("stress")
      .map(record)
      .filter((page) => page.name === "history" && record(page.args).direction === "forward");
    const { limit: _, ...criteria } = INVESTIGATION_ARGS;
    const checked = checkReference({
      name: "history",
      catalogueVersion: PAGE_CATALOGUE_VERSION,
      ledger: FIXTURE_LEDGER,
      t: 40,
      criteria,
    });
    if (!("reference" in checked)) throw new Error("The fixture's reference is refused");
    let progress = emptyProgress;
    let step: Step | undefined;
    const split = pages.map((raw) => {
      const result = projectInvestigationPage(raw, checked.reference);
      if (!("page" in result)) throw new Error(`Identity mismatch on ${result.mismatch}`);
      expect(result.page.omitted).toBe(0);
      if (result.page.next !== undefined) {
        expect(isSupportedContinuation(result.page.next)).toBe(true);
      }
      step = acceptPage(progress, result.page);
      progress = step.progress;
      return { commits: result.page.entries.map((entry) => entry.t), next: result.page.next };
    });
    expect(split).toEqual(expected);
    expect(step && "end" in step ? step.end : undefined).toEqual({ kind: "complete" });
    expect(progress.entries.map((entry) => entry.message.id)).toEqual(
      STRESS_MESSAGES.map((message) => message.id)
    );
  });

  test("the malformed modes are labelled, and each breaks the row contract", () => {
    expect(MALFORMED_MODES).toEqual(["quarantined"]);
    for (const mode of MALFORMED_MODES) {
      const pages = fixturePages(mode).map(record);
      for (const page of pages) expectEnvelope(page);
      const history = pages.find((page) => page.name === "history");
      const peers = pages.find((page) => page.name === "peers");
      // A bad kind is refused by the schema; duplicates decode, and only the viewer withholds them.
      expect(history && refusedRows(history).length).toBe(1);
      expect(peers && refusedRows(peers).length).toBe(1);
    }
  });
});

/** Peers of every activity and every mute scope, in a deliberately unsorted mute order. */
const ACTIVITY_PEERS: ReadonlyArray<string | StoryPeer> = [
  "agent/on",
  { address: "agent/away", activity: "inactive", activeSince: "2026-01-01T08:00:00Z" },
  { address: "agent/unread", activity: "unknown" },
  {
    address: "agent/quiet",
    mutes: [
      { scope: "topic", topic: "review" },
      { scope: "programme" },
      { scope: "concern", directory: "opa", concern: "ux" },
      { scope: "directory", directory: "opa" },
    ],
  },
];

describe("the story bus", () => {
  const message = (id: string, replyTo?: string): PublicMessage => ({
    id,
    ts: "2026-01-01T10:00:00Z",
    from: "agent/lead",
    to: ["#alpha"],
    kind: "message",
    body: `Body ${id}`,
    ...(replyTo === undefined ? {} : { replyTo, subject: "Reply" }),
  });

  test("answers with pages the bus could send, and projects them as the viewer does", () => {
    resetStoryBus();
    const first = historyOf([message("a"), message("b", "a")]);
    const later = historyOf([message("c", "b")], {
      window: "latest",
      damaged: 2,
      omitted: 1,
      currentHeadT: 9,
    });
    const ranked = historyOf([message("c", "b")], {
      criteria: { limit: 10, query: "Body", participant: "#alpha" },
    });
    const tree = threadOf({ id: "c", ledger: first.snapshot.ledger, t: later.snapshot.t });
    const cut = threadOf({ id: "b", ledger: first.snapshot.ledger, t: first.snapshot.t });
    const peers = peersOf(["agent/lead"]);
    const pages = storyBusPages();
    expect(pages).toHaveLength(6);
    for (const page of pages) {
      expectEnvelope(page);
      expect(refusedRows(record(page))).toEqual([]);
    }
    // Literal projections of those pages: the stories see what the viewer's server would send.
    expect(first.window).toBe("all");
    expect(first.complete).toBe(true);
    expect(later.window).toBe("latest");
    expect(later.damaged).toBe(2);
    expect(later.omitted).toBe(1);
    expect(later.snapshot).toEqual({ ledger: first.snapshot.ledger, t: 2, currentHeadT: 9 });
    expect(ranked.window).toBe("ranked");
    expect(ranked.complete).toBe(false);
    expect(tree.messages.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(tree.exhausted).toBe(true);
    expect(cut.messages.map((item) => item.id)).toEqual(["a", "b"]);
    expect(peers.peers.map((peer) => peer.address)).toEqual(["agent/lead"]);
  });

  test("a current serve's activity and mutes are rows the bus could send; an older serve has none", () => {
    resetStoryBus();
    const activityKeys = ["activity", "activeSince", "mutes"];
    peersOf(ACTIVITY_PEERS);
    peersOf(ACTIVITY_PEERS, 0, "older");
    const [current, older] = storyBusPages().map(record);
    if (current === undefined || older === undefined) throw new Error("expected two pages");
    expectEnvelope(current);
    expect(refusedRows(current)).toEqual([]);
    const currentRows = current.rows as Array<Record<string, unknown>>;
    expect(currentRows.map((row) => row.activity)).toEqual([
      "active",
      "inactive",
      "unknown",
      "active",
    ]);
    expectEnvelope(older);
    // The same rows with only the three fields left out.
    expect(older.rows).toEqual(
      currentRows.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => !activityKeys.includes(key)))
      )
    );
  });

  test("withheld peers are deliberately malformed rows, and only they", () => {
    resetStoryBus();
    const peers = peersOf(["agent/lead"], 2);
    expect(peers.omitted).toBe(2);
    const [page] = storyBusPages().map(record);
    expect(page && refusedRows(page).length).toBe(2);
  });
});
