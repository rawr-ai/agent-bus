import { ORPCError } from "@orpc/client";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { busPage, entryRow } from "../test/bus-pages";
import type { ViewerClient } from "../viewer/shared/client-types";
import {
  type InvestigationPage,
  type InvestigationPageInput,
  type InvestigationReference,
  projectInvestigationPage,
} from "../viewer/shared/public";
import {
  PinnedInvestigation,
  type ReadPage,
} from "../viewer/src/features/pinned/PinnedInvestigation";
import { investigationHash } from "../viewer/src/features/pinned/reference";
import { ViewerRoute } from "../viewer/src/ViewerRoute";
import { enterValue } from "./enter-value";
import { StatusError } from "./story-bus";

// Every reading here is the real traversal over a scripted page reader. Each page is built as
// the bus sends it and checked by the viewer's own projection, so no story can show a page
// the server would refuse. Expected words are written out by hand, never imported.

const REFERENCE: InvestigationReference = {
  name: "history",
  catalogueVersion: 1,
  ledger: "story-ledger",
  t: 9,
  criteria: {
    participants: ["#ops‮", "#review"],
    fromTs: "2026-11-01T10:00:00.000Z",
    toTs: "2026-11-01T11:00:00Z",
    kinds: ["message"],
    direction: "forward",
  },
};

/** Entry n, written at a commit at or before the reference's, with a body naming only it. */
const entry = (n: number, extra: Record<string, unknown> = {}) =>
  entryRow(
    {
      id: `e${String(n).padStart(3, "0")}`,
      ts: new Date(Date.parse("2026-11-01T10:00:00.000Z") + n * 1000).toISOString(),
      from: "agent/lead",
      to: ["#review"],
      kind: "message",
      subject: `Entry ${n}`,
      body: `Entry ${n} body.`,
      ...extra,
    },
    Math.min(REFERENCE.t, 2 + Math.floor(n / 50))
  );
const entries = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => entry(from + index));
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `e${String(from + index).padStart(3, "0")}`);

const page = (
  rows: ReadonlyArray<unknown>,
  options: { next?: string; damaged?: number } = {},
  reference = REFERENCE
): InvestigationPage => {
  const checked = projectInvestigationPage(
    busPage({
      name: "history",
      ledger: reference.ledger,
      t: reference.t,
      args: { ...reference.criteria, limit: 200 },
      rows,
      ...options,
    }),
    reference
  );
  if (!("page" in checked)) throw new Error("A story page the server would refuse");
  return checked.page;
};

/** A page held open until the play answers it. */
class Held {
  release: (reply: InvestigationPage | Error) => void = () => {};
  readonly promise = new Promise<InvestigationPage>((resolve, reject) => {
    this.release = (reply) => (reply instanceof Error ? reject(reply) : resolve(reply));
  });
}
type Reply = InvestigationPage | Error | Held;

// The script a story sets before it renders; each page request takes the next reply.
let replies: Reply[] = [];
const calls: Array<{ readonly input: InvestigationPageInput }> = [];
const readPage: ReadPage = (input, signal) => {
  calls.push({ input });
  // As fetch does: an already-aborted request is never sent.
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const reply = replies.shift();
  if (reply === undefined) return Promise.reject(new Error("No scripted page"));
  if (reply instanceof Held) return reply.promise;
  return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
};
const script = (...next: Reply[]) => {
  replies = next;
  calls.length = 0;
};

const clearHash = () => history.replaceState(null, "", location.pathname + location.search);
const meta = {
  title: "Viewer/Pinned investigation",
  component: PinnedInvestigation,
  args: { reference: REFERENCE, readPage, onOpen: () => {} },
  beforeEach: () => {
    clearHash();
    return clearHash;
  },
} satisfies Meta<typeof PinnedInvestigation>;
export default meta;
type Story = StoryObj<typeof meta>;

const REST = "The rest were not kept, and nothing is claimed about them.";
const ZERO = "0 entries kept · 0 pages read · 0 omitted by the viewer · 0 unreadable";

interface Screen {
  readonly status: string;
  readonly coverage: string | null;
  readonly counts: string;
  readonly ids: ReadonlyArray<string>;
}
const observe = (root: HTMLElement): Screen => ({
  status: root.querySelector(".pinned-status")?.textContent ?? "",
  coverage: root.querySelector(".pinned-coverage")?.textContent ?? null,
  counts: root.querySelector(".pinned-counts")?.textContent ?? "",
  ids: Array.from(
    root.querySelectorAll(".pinned-entries article"),
    (article) => article.querySelector(".provenance-fields div:last-child dd")?.textContent ?? ""
  ),
});
/** The whole state line, coverage, counts and kept entries at one moment, matched exactly. */
const expectScreen = async (root: HTMLElement, expected: Screen, timeout = 1000) => {
  await waitFor(() => expect(observe(root)).toEqual(expected), { timeout });
  const summary = root.querySelector(".pinned-summary")?.textContent ?? "";
  if (expected.status.startsWith("Complete:")) await expect(summary).not.toMatch(/\bpartial\b/i);
  else await expect(summary).not.toMatch(/\bcomplete\b/i);
};
/** The identity header, as the bus echoed the story's reference. */
const expectIdentity = async (root: HTMLElement) => {
  const rows = Array.from(root.querySelectorAll(".pinned-identity > div"), (row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);
  await expect(rows).toEqual([
    ["Ledger", "story-ledger"],
    ["Commit", "commit 9"],
    ["Catalogue version", "1"],
    ["Participants", "#ops\\u202e#review"],
    ["From", "2026-11-01T10:00:00.000Z"],
    ["To (exclusive)", "2026-11-01T11:00:00Z"],
    ["Reading", "Messages, oldest first"],
    ["Page size", "200"],
    ["Entry bound", "200"],
  ]);
};
const buttons = (root: HTMLElement) =>
  Array.from(root.querySelectorAll(".pinned-actions button"), (button) => button.textContent);

/** Lists inside a message body: the evidence's own numbering, bullets and nesting. */
const LISTS =
  "1. First step\n2. Second step\n   - nested a\n   - nested b\n3. Third step\n\n- loose bullet";

/**
 * The message body's lists keep their markers, indentation and lack of separators: the outer
 * entry list's styles stop at its own items. Exact text cannot see lost numbering.
 */
const expectBodyLists = async (root: HTMLElement) => {
  const body = root.querySelectorAll(".pinned-entries article")[2]?.querySelector(".markdown");
  const style = (selector: string) => {
    const node = body?.querySelector(selector);
    return node ? getComputedStyle(node) : undefined;
  };
  // Bullet shapes follow the browser's nesting depth, which counts the entry list; any marker
  // is the body's own, and none is the defect.
  const marked = (selector: string) => {
    const type = style(selector)?.listStyleType;
    return type !== undefined && type !== "none";
  };
  const items = Array.from(body?.querySelectorAll("li") ?? []);
  await expect({
    ordered: style(":scope > ol")?.listStyleType,
    orderedIndented: Number.parseFloat(style(":scope > ol")?.paddingLeft ?? "0") > 0,
    nested: marked("ol > li > ul"),
    nestedIndented: Number.parseFloat(style("ol > li > ul")?.paddingLeft ?? "0") > 0,
    bullets: marked(":scope > ul"),
    items: items.length,
    separators: items.filter((item) => getComputedStyle(item).borderTopStyle !== "none").length,
  }).toEqual({
    ordered: "decimal",
    orderedIndented: true,
    nested: true,
    nestedIndented: true,
    bullets: true,
    items: 6,
    separators: 0,
  });
  // The outer list still separates entries, and only entries.
  const outer = Array.from(root.querySelectorAll(".pinned-entries > ol > li"));
  await expect(outer.map((item) => getComputedStyle(item).borderTopStyle)).toEqual([
    "none",
    ...outer.slice(1).map(() => "solid"),
  ]);
};

export const CompleteWithEntries: Story = {
  beforeEach: () =>
    script(
      page([...entries(1, 2), entry(3, { body: LISTS }), entry(4, { replyTo: "e002" })], {
        next: "c1",
      }),
      page([entry(5, { replyTo: "outside" })])
    ),
  play: async ({ canvasElement }) => {
    await expectScreen(canvasElement, {
      status: "Complete: all 5 messages matching these criteria at commit 9.",
      coverage: null,
      counts: "5 entries kept · 2 pages read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 5),
    });
    await expectIdentity(canvasElement);
    await expect(buttons(canvasElement)).toEqual(["Read again"]);
    // The cursor goes back unchanged, with the same reference.
    await expect(calls.map((call) => call.input)).toEqual([
      { reference: REFERENCE },
      { reference: REFERENCE, cursor: "c1" },
    ]);
    // A reply resolves only within the kept entries.
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /Entry 2/ })).toBeVisible();
    await expect(canvas.getByText("Target not in this observation")).toBeVisible();
    await expectBodyLists(canvasElement);
  },
};

export const CompleteEmpty: Story = {
  beforeEach: () => script(page([])),
  play: async ({ canvasElement }) => {
    await expectScreen(canvasElement, {
      status: "Complete: no messages match these criteria at commit 9.",
      coverage: null,
      counts: "0 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: [],
    });
    await expectIdentity(canvasElement);
  },
};

let boundPage = new Held();
export const BoundAfterProgress: Story = {
  beforeEach: () => {
    boundPage = new Held();
    script(page(entries(1, 150), { next: "c1" }), boundPage);
  },
  play: async ({ canvasElement }) => {
    // Progress shows only what has arrived, with Cancel offered.
    await expectScreen(canvasElement, {
      status: "Reading page 2 at commit 9.",
      coverage: null,
      counts: "150 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 150),
    });
    await expect(buttons(canvasElement)).toEqual(["Cancel"]);
    boundPage.release(page(entries(151, 210), { next: "c2" }));
    await expectScreen(canvasElement, {
      status: "Stopped at the 200-entry bound.",
      coverage: `Partial: the earliest 200 entries of the window. ${REST}`,
      counts: "200 entries kept · 2 pages read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 200),
    });
    await expectIdentity(canvasElement);
  },
};

export const DamagedWithPartial: Story = {
  beforeEach: () => script(page(entries(1, 3), { damaged: 1 })),
  play: async ({ canvasElement }) => {
    await expectScreen(canvasElement, {
      status: "Stopped: the bus met 1 unreadable entry.",
      coverage: `Partial: 3 readable entries from the start of the window; 1 unreadable met while reading. ${REST}`,
      counts: "3 entries kept · 1 page read · 0 omitted by the viewer · 1 unreadable",
      ids: ids(1, 3),
    });
    await expectIdentity(canvasElement);
  },
};

export const OmittedOnCutPage: Story = {
  beforeEach: () =>
    script(
      page(entries(1, 150), { next: "c1" }),
      // Entry 160 is not a message the viewer can show; the page is cut at the bound.
      page([...entries(151, 159), entry(160, { body: 42 }), ...entries(161, 210)], { next: "c2" })
    ),
  play: async ({ canvasElement }) => {
    await expectScreen(canvasElement, {
      status: "Stopped: the viewer omitted 1 record it cannot show.",
      coverage: `Partial: 200 readable entries from the start of the window; 1 omitted by the viewer met while reading. ${REST}`,
      counts: "200 entries kept · 2 pages read · 1 omitted by the viewer · 0 unreadable",
      ids: [...ids(1, 159), ...ids(161, 201)],
    });
    await expectIdentity(canvasElement);
  },
};

/** A stop after a first page of two entries: its own words, the two kept, Read again. */
const stoppedAfterFirstPage =
  (status: string): NonNullable<Story["play"]> =>
  async ({ canvasElement }) => {
    await expectScreen(canvasElement, {
      status,
      coverage: `Partial: the earliest 2 entries of the window. ${REST}`,
      counts: "2 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 2),
    });
    await expectIdentity(canvasElement);
    await expect(buttons(canvasElement)).toEqual(["Read again"]);
  };
/** A stop on the first page: nothing kept. */
const stoppedOnFirstPage =
  (status: string): NonNullable<Story["play"]> =>
  async ({ canvasElement }) => {
    await expectScreen(canvasElement, {
      status,
      coverage: "No entries were kept before the stop.",
      counts: ZERO,
      ids: [],
    });
    await expectIdentity(canvasElement);
    await expect(buttons(canvasElement)).toEqual(["Read again"]);
  };
const firstPage = () => page(entries(1, 2), { next: "c1" });

export const TransportStop: Story = {
  beforeEach: () => script(page(entries(1, 2), { next: "outside+subset" })),
  play: async ({ canvasElement }) => {
    await expectScreen(canvasElement, {
      status: "Stopped: the next page cannot be requested within the viewer's request limits.",
      coverage: `Partial: the earliest 2 entries of the window. ${REST}`,
      counts: "2 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 2),
    });
    await expect(calls).toHaveLength(1);
  },
};
export const DeadlineStop: Story = {
  beforeEach: () => script(firstPage(), new ORPCError("GATEWAY_TIMEOUT", { status: 504 })),
  play: stoppedAfterFirstPage("Stopped: a page did not answer in time."),
};
export const FaultStop: Story = {
  beforeEach: () => script(firstPage(), page(entries(3, 4), { next: "c1" })),
  play: stoppedAfterFirstPage("Stopped: the bus returned a continuation it had already returned."),
};
export const BusErrorStop: Story = {
  beforeEach: () => script(firstPage(), new ORPCError("BUS_ERROR", { status: 502, defined: true })),
  play: stoppedAfterFirstPage("Stopped: the bus refused the page."),
};
export const UnavailableStop: Story = {
  beforeEach: () => script(firstPage(), new ORPCError("SERVICE_UNAVAILABLE", { status: 503 })),
  play: stoppedAfterFirstPage("Stopped: the viewer could not reach the bus."),
};
export const IdentityStop: Story = {
  beforeEach: () =>
    script(
      new ORPCError("IDENTITY_MISMATCH", { status: 502, defined: true, data: { field: "ledger" } })
    ),
  play: stoppedOnFirstPage("Stopped: the bus answered for a different ledger than this reference."),
};
export const RejectedStop: Story = {
  beforeEach: () => script(new ORPCError("PAGE_REJECTED", { status: 502, defined: true })),
  play: stoppedOnFirstPage("Stopped: the bus returned a page the viewer cannot read."),
};

let cancelledPage = new Held();
let rerunPage = new Held();
export const CancelledThenReadAgain: Story = {
  beforeEach: () => {
    cancelledPage = new Held();
    rerunPage = new Held();
    script(page(entries(1, 3), { next: "c1" }), cancelledPage);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expectScreen(canvasElement, {
      status: "Reading page 2 at commit 9.",
      coverage: null,
      counts: "3 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 3),
    });
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    const cancelled: Screen = {
      status: "Cancelled: you stopped the reading.",
      coverage: `Partial: the earliest 3 entries of the window. ${REST}`,
      counts: "3 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 3),
    };
    await expectScreen(canvasElement, cancelled);
    await expect(calls.at(-1)?.input.cursor).toBe("c1");
    // The cancelled page answers anyway: nothing joins and nothing more is asked.
    cancelledPage.release(page(entries(4, 8)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(observe(canvasElement)).toEqual(cancelled);
    await expect(calls).toHaveLength(2);
    // Read again starts from nothing, at page 1, and shows no earlier entries meanwhile.
    replies.push(rerunPage);
    await userEvent.click(canvas.getByRole("button", { name: "Read again" }));
    await expectScreen(canvasElement, {
      status: "Reading page 1 at commit 9.",
      coverage: null,
      counts: ZERO,
      ids: [],
    });
    await expect(calls.at(-1)?.input).toEqual({ reference: REFERENCE });
    rerunPage.release(page(entries(1, 2)));
    await expectScreen(canvasElement, {
      status: "Complete: all 2 messages matching these criteria at commit 9.",
      coverage: null,
      counts: "2 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 2),
    });
  },
};

export const BusyThenComplete: Story = {
  beforeEach: () =>
    script(new ORPCError("TOO_MANY_REQUESTS", { status: 429 }), page(entries(1, 2))),
  play: async ({ canvasElement }) => {
    // Busy is not a stop: no partial label, counts unchanged, Cancel still offered.
    await expectScreen(canvasElement, {
      status: "Waiting: the viewer is busy with other reads. Retrying page 1.",
      coverage: null,
      counts: ZERO,
      ids: [],
    });
    await expect(buttons(canvasElement)).toEqual(["Cancel"]);
    await expectScreen(
      canvasElement,
      {
        status: "Complete: all 2 messages matching these criteria at commit 9.",
        coverage: null,
        counts: "2 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
        ids: ids(1, 2),
      },
      3000
    );
    // The retry asks for the same first page.
    await expect(calls.map((call) => call.input)).toEqual([
      { reference: REFERENCE },
      { reference: REFERENCE },
    ]);
  },
};

const OVERSIZED: InvestigationReference = {
  ...REFERENCE,
  criteria: {
    ...REFERENCE.criteria,
    participants: Array.from({ length: 8 }, (_, index) => `#${index}${"f".repeat(500)}`),
  },
};
export const TooLarge: Story = {
  args: { reference: OVERSIZED },
  beforeEach: () => script(),
  play: async ({ canvasElement }) => {
    await expectScreen(canvasElement, {
      status:
        "Not read: this reference is too large to send with a continuation. Ask the agent for a reference with fewer participants.",
      coverage: null,
      counts: ZERO,
      ids: [],
    });
    // Nothing is sent, and neither a rerun nor another window can make it fit.
    await expect(calls).toHaveLength(0);
    await expect(buttons(canvasElement)).toEqual([]);
    await expect(canvasElement.querySelector(".pinned-window")).toBeNull();
  },
};

// The connected screens: the fragment chooses the screen, and a window opens as a new link.
const live: ViewerClient = {
  history: () => Promise.reject(new StatusError(503)),
  peers: () => Promise.reject(new StatusError(503)),
  thread: () => Promise.reject(new StatusError(503)),
  investigationPage: (input, options) =>
    readPage(input, options?.signal ?? new AbortController().signal),
};
const routed: Story = { render: () => <ViewerRoute client={live} /> };

export const RefusedLink: Story = {
  ...routed,
  beforeEach: () => {
    script();
    history.replaceState(null, "", `${location.pathname}${location.search}#investigation=nope`);
    return clearHash;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Reference refused" })
    ).toBeVisible();
    await expect(canvasElement.querySelector(".pinned-status")?.textContent).toBe(
      "This link does not carry a pinned history reference in the form the bus returns."
    );
    await expect(calls).toHaveLength(0);
  },
};

export const LinkOpensAndReturnsToLive: Story = {
  ...routed,
  beforeEach: () => {
    script(page(entries(1, 2)));
    clearHash();
    return clearHash;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("heading", { name: "Contexts" })).toBeVisible();
    location.hash = investigationHash(REFERENCE);
    await expectScreen(canvasElement, {
      status: "Complete: all 2 messages matching these criteria at commit 9.",
      coverage: null,
      counts: "2 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 2),
    });
    await expect(canvas.queryByRole("heading", { name: "Contexts" })).toBeNull();
    await userEvent.click(canvas.getByRole("link", { name: "Live viewer" }));
    await expect(await canvas.findByRole("heading", { name: "Contexts" })).toBeVisible();
    await expect(canvasElement.querySelector(".pinned-summary")).toBeNull();
  },
};

const NARROWED: InvestigationReference = {
  ...REFERENCE,
  criteria: { ...REFERENCE.criteria, fromTs: "2026-11-01T10:30:00Z" },
};
let firstWindow = new Held();
export const NarrowedWindowReplacesTheReading: Story = {
  ...routed,
  beforeEach: () => {
    firstWindow = new Held();
    script(firstWindow, page([entry(1800), entry(1801)], {}, NARROWED));
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}${investigationHash(REFERENCE)}`
    );
    return clearHash;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expectScreen(canvasElement, {
      status: "Reading page 1 at commit 9.",
      coverage: null,
      counts: ZERO,
      ids: [],
    });
    const from = canvas.getByRole("textbox", { name: "From" });
    // A value the bus would not echo unchanged is refused beside the fields, and nothing opens.
    enterValue(from, "2026-11-01 10:30");
    await userEvent.click(canvas.getByRole("button", { name: "Read this window" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "From and To must be UTC instants such as 2026-11-01T17:31:12Z, with From before To."
    );
    await expect(location.hash).toBe(investigationHash(REFERENCE));
    enterValue(from, "2026-11-01T10:30:00Z");
    await userEvent.click(canvas.getByRole("button", { name: "Read this window" }));
    await expect(location.hash).toBe(investigationHash(NARROWED));
    // The first window's page answers late; none of it reaches the new reading.
    firstWindow.release(page(entries(1, 3)));
    await expectScreen(canvasElement, {
      status: "Complete: all 2 messages matching these criteria at commit 9.",
      coverage: null,
      counts: "2 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: ["e1800", "e1801"],
    });
    const fromRow = Array.from(canvasElement.querySelectorAll(".pinned-identity > div")).find(
      (row) => row.querySelector("dt")?.textContent === "From"
    );
    await expect(fromRow?.querySelector("dd")?.textContent).toBe("2026-11-01T10:30:00Z");
    await expect(calls.at(-1)?.input).toEqual({ reference: NARROWED });
  },
};

const LONG: InvestigationReference = {
  ...REFERENCE,
  ledger: `story-ledger-${"x".repeat(200)}`,
  criteria: {
    ...REFERENCE.criteria,
    participants: [`#${"long-participant-".repeat(12)}`, "#review"],
  },
};
/**
 * The page's ThemeToggle applies the stored preference (its key in viewer/src/ThemeToggle.tsx),
 * else the host's colour scheme, over the story's theme global; storing dark makes the story's
 * theme independent of the host. Restores the previous value, or its absence.
 */
const VIEWER_THEME_KEY = "agent-bus-viewer-theme";
const preferDark = () => {
  const previous = localStorage.getItem(VIEWER_THEME_KEY);
  localStorage.setItem(VIEWER_THEME_KEY, "dark");
  return () => {
    if (previous === null) localStorage.removeItem(VIEWER_THEME_KEY);
    else localStorage.setItem(VIEWER_THEME_KEY, previous);
  };
};
export const DarkNarrow: Story = {
  globals: { theme: "dark", viewport: { value: "narrow", isRotated: false } },
  args: { reference: LONG },
  beforeEach: () => {
    script(page([entry(1, { subject: `Long ${"subject-".repeat(20)}` }), entry(2)], {}, LONG));
    return preferDark();
  },
  play: async ({ canvasElement }) => {
    await expect(document.documentElement.dataset.theme).toBe("dark");
    await expect(window.innerWidth).toBe(320);
    await expectScreen(canvasElement, {
      status: "Complete: all 2 messages matching these criteria at commit 9.",
      coverage: null,
      counts: "2 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable",
      ids: ids(1, 2),
    });
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
