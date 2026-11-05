import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { PRESENCE_TREE_ENTRIES, presenceTreePage } from "../test/presence-tree";
import type { ViewerClient } from "../viewer/shared/client-types";
import type {
  HistoryObservation,
  PeersObservation,
  PublicMessage,
  ThreadInput,
  ThreadObservation,
} from "../viewer/shared/public";
import { projectThread } from "../viewer/shared/public";
import { App } from "../viewer/src/App";
import { formatTime } from "../viewer/src/Text";
import { enterValue } from "./enter-value";
import { historyOf, peersOf, resetStoryBus, StatusError, threadOf } from "./story-bus";

type Reply<T> = T | StatusError;

// Each story sets the replies before it renders; a play changes them before a manual refresh.
// Replies stay until changed, so a repeated or automatic read observes the same state.
const script: {
  history: Reply<HistoryObservation>;
  peers: Reply<PeersObservation>;
  /** The reply tree read for a request; the story bus's whole tree unless a play changes it. */
  thread: (input: ThreadInput) => Reply<ThreadObservation>;
  historyCalls: number;
} = {
  history: new StatusError(503),
  peers: new StatusError(503),
  thread: threadOf,
  historyCalls: 0,
};
const reply = async <T,>(value: Reply<T>): Promise<T> => {
  if (value instanceof StatusError) throw value;
  return value;
};
const client: ViewerClient = {
  history: async () => {
    script.historyCalls++;
    return reply(script.history);
  },
  peers: async () => reply(script.peers),
  thread: async (input) => reply(script.thread(input)),

  investigationPage: async () => {
    throw new Error("This story reads no investigation");
  },
};

const request: PublicMessage = {
  id: "a",
  ts: "2026-01-01T10:00:00Z",
  from: "agent/lead",
  to: ["#alpha"],
  kind: "message",
  subject: "Review request",
  body: "Please review **the proposal**.",
};
const answer: PublicMessage = {
  id: "b",
  ts: "2026-01-01T10:01:00Z",
  from: "agent/reviewer",
  to: ["agent/lead"],
  kind: "message",
  subject: "Review reply",
  body: "Confirmed with one note.",
  replyTo: "a",
};
const followUp: PublicMessage = {
  id: "c",
  ts: "2026-01-01T10:02:00Z",
  from: "agent/lead",
  to: ["#alpha"],
  kind: "message",
  subject: "Follow-up",
  body: "Thanks for the note.",
  replyTo: "b",
};
const unrelated: PublicMessage = {
  id: "d",
  ts: "2026-01-01T10:03:00Z",
  from: "agent/ops",
  to: ["#gamma"],
  kind: "message",
  subject: "Status update",
  body: "Deployment window moved.",
};

const meta = {
  title: "Viewer/Observation states",
  component: App,
  args: { client },
  beforeEach: () => {
    history.replaceState(null, "", location.pathname + location.search);
    script.historyCalls = 0;
    script.thread = threadOf;
    resetStoryBus();
  },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The two polite regions, history first; the visible observation lines are not live. */
const announcements = (root: HTMLElement) => {
  const regions = root.querySelectorAll<HTMLElement>(".visually-hidden[role='status']");
  return { history: regions[0]!, peers: regions[1]! };
};
const observationLines = (root: HTMLElement) =>
  Array.from(root.querySelectorAll(".observation"), (node) => node.textContent ?? "");

export const EmptyAndAllOmitted: Story = {
  beforeEach: () => {
    script.history = historyOf([]);
    script.peers = peersOf([], 1);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const live = announcements(canvasElement);
    await waitFor(() => expect(live.history).toHaveTextContent("History observed: 0 messages."));
    // A first observation whose every record is omitted says so, not just "0 peers".
    await waitFor(() =>
      expect(live.peers).toHaveTextContent("Current peers observed: 0 peers, 1 record omitted.")
    );
    await expect(canvasElement.querySelectorAll(".observation[role]")).toHaveLength(0);
    await expect(canvas.getByText("No matching messages in this observation.")).toBeVisible();
    script.history = historyOf([], { observedAt: "2026-01-01T12:01:00Z", omitted: 2 });
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await expect(
      await canvas.findByText("No displayable messages in this observation.")
    ).toBeVisible();
    await expect(canvas.getAllByText("2 records omitted")[0]).toBeVisible();
    // The displayed records are unchanged, but the omitted count changed: that is announced.
    await waitFor(() => expect(live.history).toHaveTextContent("History: 2 records omitted."));
    // A refresh that observes the same records and omissions stays quiet.
    const spoken = live.history.firstElementChild;
    script.history = historyOf([], { observedAt: "2026-01-01T12:02:00Z", omitted: 2 });
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    const observed = `Observed ${formatTime("2026-01-01T12:02:00Z")}`;
    await waitFor(() =>
      expect(observationLines(canvasElement).some((line) => line.startsWith(observed))).toBe(true)
    );
    await expect(live.history.firstElementChild).toBe(spoken);
    await userEvent.click(canvas.getByRole("button", { name: "Current peers" }));
    await expect(canvas.getByText("No displayable peers in this observation.")).toBeVisible();
  },
};

export const UnavailableThenObserved: Story = {
  beforeEach: () => {
    script.history = new StatusError(503);
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const live = announcements(canvasElement);
    await waitFor(() => expect(live.history).toHaveTextContent("History unavailable."));
    await expect(observationLines(canvasElement)).toContain("Observation unavailable");
    await expect(canvasElement.querySelector(".conversation-scroll .empty")).toHaveTextContent(
      "History unavailable."
    );
    script.history = new StatusError(504);
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(live.history).toHaveTextContent("History timed out."));
    await expect(observationLines(canvasElement)).toContain("Observation timed out");
    script.history = historyOf([request, answer, followUp]);
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(live.history).toHaveTextContent("History observed: 3 messages."));
    await expect(
      canvas.getByRole("button", { name: /Review request.*3 observed messages/ })
    ).toBeVisible();
  },
};

export const FailedRefreshKeepsLastGood: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer, followUp]);
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const live = announcements(canvasElement);
    await waitFor(() => expect(live.history).toHaveTextContent("History observed: 3 messages."));
    script.history = new StatusError(503);
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() =>
      expect(live.history).toHaveTextContent(
        "History refresh failed; showing the last observation."
      )
    );
    await expect(
      observationLines(canvasElement).some((line) =>
        line.startsWith("Refresh failed · last observed")
      )
    ).toBe(true);
    await expect(
      canvas.getByRole("button", { name: /Review request.*3 observed messages/ })
    ).toBeVisible();
    // The same failure again is not announced again.
    const spoken = live.history.firstElementChild;
    const calls = script.historyCalls;
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(script.historyCalls).toBe(calls + 1));
    await waitFor(() =>
      expect(
        observationLines(canvasElement).some((line) => line.startsWith("Refresh failed"))
      ).toBe(true)
    );
    await expect(live.history.firstElementChild).toBe(spoken);
    script.history = new StatusError(504);
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() =>
      expect(live.history).toHaveTextContent(
        "History refresh timed out; showing the last observation."
      )
    );
    await expect(
      observationLines(canvasElement).some((line) =>
        line.startsWith("Refresh timed out · last observed")
      )
    ).toBe(true);
  },
};

export const RefreshAnnouncesArrivals: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer]);
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const live = announcements(canvasElement);
    await waitFor(() => expect(live.history).toHaveTextContent("History observed: 2 messages."));
    const alpha = canvas.getByRole("button", { name: "#alpha" });
    await userEvent.click(alpha);
    await expect(alpha).toHaveAttribute("aria-current", "true");
    await expect(canvas.getByRole("button", { name: "All messages" })).not.toHaveAttribute(
      "aria-current"
    );
    await userEvent.click(canvas.getByRole("button", { name: /Review request.*2 observed/ }));
    await expect(
      canvas.getByRole("button", { name: /Review request.*2 observed/ })
    ).toHaveAttribute("aria-current", "true");
    script.history = historyOf([request, answer, followUp], { observedAt: "2026-01-01T12:01:00Z" });
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(live.history).toHaveTextContent("History: 1 new message."));
    await expect(
      canvas.getByRole("button", { name: /Review request.*3 observed messages/ })
    ).toHaveAttribute("aria-current", "true");
    await expect(canvas.getByText("Thanks for the note.")).toBeVisible();

    script.peers = peersOf(["agent/lead", "agent/reviewer"]);
    await userEvent.click(canvas.getByRole("button", { name: "Current peers" }));
    await userEvent.click(canvas.getByRole("button", { name: "Refresh current peers" }));
    await waitFor(() => expect(live.peers).toHaveTextContent("Current peers: 1 new peer."));
    for (const address of ["agent/lead", "agent/reviewer"])
      await expect(
        canvas.getByRole("button", { name: `Investigate exact address ${address}` })
      ).toBeVisible();
    script.peers = peersOf(["agent/reviewer"]);
    await userEvent.click(canvas.getByRole("button", { name: "Refresh current peers" }));
    await waitFor(() =>
      expect(live.peers).toHaveTextContent("Current peers: 1 peer no longer listed.")
    );
  },
};

/** A peer's row on the current peers page, found by its exact address. */
const peerRowOf = (root: HTMLElement, address: string): HTMLElement => {
  const row = Array.from(root.querySelectorAll<HTMLElement>(".peer-row")).find(
    (candidate) => candidate.querySelector(".peer-address")?.textContent === address
  );
  if (!row) throw new Error(`No listed peer ${address}`);
  return row;
};
const ACTIVITY_TEXT = ["Inactive", "Activity unknown", "Muted"] as const;
/** A topic carrying a bidi override: peer-controlled text that must reach the page escaped. */
const MUTED_TOPIC = "review‮";

/**
 * The serve's folded activity is shown as read-only text: inactive and unknown peers say so, an
 * unknown peer with the reason its serve sent, muted scopes are listed in the row's order, and an
 * active peer or an older serve's peer shows nothing extra. Every peer stays listed.
 */
export const PeerActivityShownReadOnly: Story = {
  beforeEach: () => {
    script.history = historyOf([request]);
    script.peers = peersOf([
      "agent/on",
      { address: "agent/away", activity: "inactive", activeSince: "2026-01-01T08:00:00Z" },
      { address: "agent/unread", activity: "unknown" },
      { address: "agent/mail", activity: "unknown", activityReason: "damaged-mail" },
      { address: "agent/scan", activity: "unknown", activityReason: "incomplete-scan" },
      {
        address: "agent/quiet",
        activity: "active",
        mutes: [
          { scope: "topic", topic: MUTED_TOPIC },
          { scope: "programme" },
          { scope: "concern", directory: "opa", concern: "ux" },
          { scope: "directory", directory: "opa" },
        ],
      },
    ]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const textOf = (address: string) => peerRowOf(canvasElement, address).textContent ?? "";
    const shows = async (address: string, expected: readonly string[]) => {
      const text = textOf(address);
      for (const label of ACTIVITY_TEXT)
        await expect({ address, label, shown: text.includes(label) }).toEqual({
          address,
          label,
          shown: expected.includes(label),
        });
    };
    await userEvent.click(canvas.getByRole("button", { name: "Current peers" }));
    await waitFor(() => expect(canvasElement.querySelectorAll(".peer-row")).toHaveLength(6));

    await shows("agent/away", ["Inactive"]);
    await shows("agent/unread", ["Activity unknown"]);
    // Unknown says why, as text after the label; with no reason sent, the label stands alone.
    await expect(textOf("agent/unread")).not.toContain("Activity unknown:");
    for (const [address, shown] of [
      ["agent/mail", "Activity unknown: damaged mail"],
      ["agent/scan", "Activity unknown: incomplete scan"],
    ] as const) {
      await shows(address, ["Activity unknown"]);
      await expect({ address, shown: textOf(address).includes(shown) }).toEqual({
        address,
        shown: true,
      });
    }
    await shows("agent/quiet", ["Muted"]);
    await shows("agent/on", []);
    // Each scope as text after the label, in the row's own order, the topic escaped.
    const muted = textOf("agent/quiet");
    const positions = ["Muted", "#review\\u202e", "*", "concern opa/ux", "directory opa"].map(
      (part) => muted.indexOf(part)
    );
    await expect(positions).not.toContain(-1);
    await expect(positions).toEqual([...positions].sort((a, b) => a - b));
    await expect(muted).not.toContain("‮");
    // Read-only: each row's only control is the existing exact-address investigation.
    for (const row of canvasElement.querySelectorAll<HTMLElement>(".peer-row"))
      await expect(
        Array.from(
          row.querySelectorAll(
            "button, input, select, textarea, a[href], [role='button'], [role='switch'], [role='checkbox'], [role='menu']"
          ),
          (control) => control.textContent
        )
      ).toEqual(["Investigate exact address"]);
    const activeText = textOf("agent/on");

    // The same peers through an older serve, which sends no activity: nothing is invented.
    script.peers = peersOf(
      ["agent/on", "agent/away", "agent/unread", "agent/quiet", "agent/older"],
      0,
      "older"
    );
    await userEvent.click(canvas.getByRole("button", { name: "Refresh current peers" }));
    await waitFor(() => expect(canvasElement.querySelectorAll(".peer-row")).toHaveLength(5));
    for (const address of ["agent/on", "agent/away", "agent/unread", "agent/quiet", "agent/older"])
      await shows(address, []);
    // An active peer shows exactly what a peer without activity shows.
    await expect(textOf("agent/on")).toBe(activeText);
  },
};

/** A conversation follows the bus: its reply tree is read again at each new history commit. */
export const ConversationFollowsCommits: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer, followUp]);
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const state = () =>
      canvasElement.querySelector(".reading-observation-state")?.textContent?.trim();
    await userEvent.click(
      await canvas.findByRole("button", { name: /Review request.*3 observed messages/ })
    );
    await expect(canvas.getByRole("heading", { name: /^Conversation$/ })).toBeVisible();
    await expect(await canvas.findByText("Whole reply tree at commit 1")).toBeVisible();
    await expect(state()).toBe("");
    // The window moves past the conversation; the bus still holds it, so it is read at t=2.
    script.history = historyOf([unrelated], { observedAt: "2026-01-01T12:05:00Z" });
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await expect(await canvas.findByText("Whole reply tree at commit 2")).toBeVisible();
    await expect(state()).toBe("");
    await expect(canvas.getByText("Confirmed with one note.")).toBeVisible();
    const status = canvas.getByRole("button", { name: /Status update/ });
    await userEvent.click(status);
    await expect(status).toHaveAttribute("aria-current", "true");
    await expect(canvas.getByText("Deployment window moved.")).toBeVisible();
    await expect(canvas.queryByText("Confirmed with one note.")).toBeNull();
  },
};

/** A failed tree read is retried at the same commit, by its own action or an automatic read. */
export const ThreadRetriedAtSameCommit: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer, followUp, unrelated]);
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const reads: Array<readonly [string, number]> = [];
    let failure: StatusError | null = new StatusError(504);
    script.thread = (input) => {
      reads.push([input.id, input.t]);
      return failure ?? threadOf(input);
    };
    // Paused, so no timer read lands between the counted ones.
    await userEvent.click(canvas.getByRole("button", { name: "Pause automatic refresh" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /Review request.*3 observed messages/ })
    );
    await expect(await canvas.findByText("Conversation timed out.")).toBeVisible();
    failure = new StatusError(503);
    await userEvent.click(canvas.getByRole("button", { name: "Retry conversation" }));
    await expect(await canvas.findByText("Conversation unavailable.")).toBeVisible();
    // Service returns while the bus stays at commit 1: the retry reads that commit again.
    failure = null;
    await userEvent.click(canvas.getByRole("button", { name: "Retry conversation" }));
    await expect(await canvas.findByText("Whole reply tree at commit 1")).toBeVisible();
    await expect(canvas.getByText("Confirmed with one note.")).toBeVisible();
    await expect(reads).toEqual([
      ["a", 1],
      ["a", 1],
      ["a", 1],
    ]);
    // Resuming reads at once: it retries a failed read at the unchanged commit.
    failure = new StatusError(503);
    await userEvent.click(canvas.getByRole("button", { name: /Status update/ }));
    await expect(await canvas.findByText("Conversation unavailable.")).toBeVisible();
    failure = null;
    const historyCalls = script.historyCalls;
    await userEvent.click(canvas.getByRole("button", { name: "Resume automatic refresh" }));
    await expect(await canvas.findByText("Deployment window moved.")).toBeVisible();
    await waitFor(() => expect(script.historyCalls).toBe(historyCalls + 1));
    await expect(reads.slice(3)).toEqual([
      ["d", 1],
      ["d", 1],
    ]);
    // Refresh all leaves a good read alone.
    await userEvent.click(canvas.getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(script.historyCalls).toBe(historyCalls + 2));
    await expect(reads).toHaveLength(5);
  },
};

/** A context flow whose messages leave the window is frozen at the commit it was read at. */
export const RetainedReading: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer, followUp]);
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const live = announcements(canvasElement);
    const state = () =>
      canvasElement.querySelector(".reading-observation-state")?.textContent?.trim();
    await userEvent.click(await canvas.findByRole("button", { name: "#alpha" }));
    await userEvent.click(canvas.getByRole("button", { name: "Read context" }));
    await expect(canvas.getByRole("heading", { name: "Context flow" })).toBeVisible();
    await expect(state()).toBe("");
    script.history = historyOf([unrelated], {
      observedAt: "2026-01-01T12:05:00Z",
      window: "latest",
    });
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(state()).toBe("Outside current observation"));
    await expect(live.history).toHaveTextContent("History: 1 new message.");
    await expect(
      canvas.getByText(/^Not in the current observation · frozen at commit 1 · last observed/)
    ).toBeVisible();
    // The frozen reading keeps the label of the window it was read from.
    await expect(canvas.getAllByText("All entries at commit 1")[0]).toBeVisible();
    await expect(canvas.getByText("Confirmed with one note.")).toBeVisible();
  },
};

/** A replaced ledger never replaces a reading: the conversation stays frozen at its commit. */
export const LedgerReplacedFreezesConversation: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer, followUp]);
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const state = () =>
      canvasElement.querySelector(".reading-observation-state")?.textContent?.trim();
    await userEvent.click(
      await canvas.findByRole("button", { name: /Review request.*3 observed messages/ })
    );
    await expect(await canvas.findByText("Whole reply tree at commit 1")).toBeVisible();
    script.history = historyOf([request, answer, followUp, unrelated], {
      ledger: "story-ledger-replaced",
      t: 1,
      observedAt: "2026-01-01T12:06:00Z",
    });
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(state()).toBe("Outside current observation"));
    await expect(
      canvas.getByText(/^Not in the current observation · frozen at commit 1 · last observed/)
    ).toBeVisible();
    await expect(canvas.getByText("Confirmed with one note.")).toBeVisible();
  },
};

/** Upstream incompleteness is labelled from the bus's own answer, apart from omissions. */
export const OlderEntriesDamageAndMovedHead: Story = {
  beforeEach: () => {
    script.history = historyOf([answer, followUp], {
      t: 7,
      currentHeadT: 9,
      window: "latest",
      damaged: 2,
      omitted: 1,
    });
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      (
        await canvas.findAllByText(
          "Latest 3 entries at commit 7; older entries exist; 1 omitted by the viewer"
        )
      )[0]
    ).toBeVisible();
    await expect(canvas.getAllByText("2 entries unreadable at commit 7")[0]).toBeVisible();
    await expect(
      canvas.getAllByText("The bus reached commit 9 while this was read")[0]
    ).toBeVisible();
    await expect(canvas.getAllByText("1 record omitted")[0]).toBeVisible();
    // The answer's parent is not an entry on this synthetic bus, so the tree is cut there.
    await userEvent.click(canvas.getByRole("button", { name: /Review reply/ }));
    await expect(
      await canvas.findByText("Reply tree at commit 7; cut at 1 missing entry")
    ).toBeVisible();
    await expect(canvas.getByText("Target is not an entry at commit 7")).toBeVisible();
  },
};

const readingPane = (root: HTMLElement) => within(root.querySelector<HTMLElement>(".thread-view")!);

/** A retained flow keeps every caveat it was read with, never the current window's. */
export const RetainedReadingKeepsCaveats: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer, followUp], {
      t: 3,
      currentHeadT: 4,
      window: "latest",
      damaged: 2,
      omitted: 1,
    });
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = readingPane(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "#alpha" }));
    await userEvent.click(canvas.getByRole("button", { name: "Read context" }));
    script.history = historyOf([unrelated], { t: 5, observedAt: "2026-01-01T12:05:00Z" });
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await expect(
      await pane.findByText(/^Not in the current observation · frozen at commit 3 ·/)
    ).toBeVisible();
    const label = pane.getByText(
      "Latest 4 entries at commit 3; older entries exist; 1 omitted by the viewer"
    );
    await expect(label).toHaveAttribute("data-t", "3");
    await expect(label).toHaveAttribute("title", "Ledger t=3");
    await expect(pane.getByText("2 entries unreadable at commit 3")).toBeVisible();
    await expect(pane.getByText("The bus reached commit 4 while this was read")).toBeVisible();
    await expect(pane.getByText("1 record omitted")).toBeVisible();
    // No longer being read: no receipt or loading line for the frozen unit.
    await expect(pane.queryByText(/^Observed /)).toBeNull();
  },
};

/**
 * A tree read under one criteria keeps them: when history under new criteria succeeds and the
 * tree's reread at that commit fails, the tree stays frozen as it was read.
 */
export const TreeKeepsItsCriteria: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer, followUp], { observedAt: "2026-01-01T12:00:00Z" });
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = readingPane(canvasElement);
    const state = () =>
      canvasElement.querySelector(".reading-observation-state")?.textContent?.trim();
    await userEvent.click(
      await canvas.findByRole("button", { name: /Review request.*3 observed messages/ })
    );
    await expect(await pane.findByText("Whole reply tree at commit 1")).toBeVisible();
    // New criteria: their history succeeds at commit 2, but the tree cannot be read there.
    const criteria = { limit: 200, participant: "#alpha" };
    script.history = historyOf([request, followUp], {
      criteria,
      observedAt: "2026-01-01T12:07:00Z",
    });
    script.thread = () => new StatusError(503);
    const participant = canvas.getByRole("textbox", { name: "Exact participant/address" });
    enterValue(participant, "#alpha");
    await userEvent.click(canvas.getByRole("button", { name: "Apply search" }));
    await waitFor(() => expect(state()).toBe("Outside current observation"));
    await expect(
      pane.getByText(/^Not in the current observation · frozen at commit 1 · last observed/)
    ).toHaveTextContent(formatTime("2026-01-01T12:00:02Z"));
    await expect(pane.getByText("Whole reply tree at commit 1")).toBeVisible();
    // Labelled with the criteria it was read under, not the ones that replaced them.
    await expect(pane.getByText("This retained reading uses earlier criteria.")).toBeVisible();
    await expect(pane.getByText("Confirmed with one note.")).toBeVisible();

    // Service returns while the bus stays at commit 2: Refresh all retries the failed read
    // there, and the retained reading keeps its commit and criteria.
    const reads: number[] = [];
    script.thread = (input) => {
      const tree = threadOf(input);
      reads.push(input.t);
      return tree;
    };
    await userEvent.click(canvas.getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(reads).toEqual([2]));
    await expect(state()).toBe("Outside current observation");
    await expect(pane.getByText("Whole reply tree at commit 1")).toBeVisible();
    await expect(pane.getByText("This retained reading uses earlier criteria.")).toBeVisible();
    await expect(pane.queryByText("Whole reply tree at commit 2")).toBeNull();

    // Recovery: the next observation, at commit 3 under the same criteria, reads the tree.
    script.history = historyOf([request, followUp], {
      criteria,
      observedAt: "2026-01-01T12:09:00Z",
    });
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(reads).toContain(3));
    // A successful reread does not replace a retained reading: only the reader's action does.
    await expect(state()).toBe("Outside current observation");
    await expect(pane.getByText("Whole reply tree at commit 1")).toBeVisible();
    await expect(pane.getByText("This retained reading uses earlier criteria.")).toBeVisible();
    await expect(pane.queryByText("Whole reply tree at commit 3")).toBeNull();

    // Acceptance: selecting the conversation again replaces it with the current reading.
    await userEvent.click(
      await canvas.findByRole("button", { name: /Review request.*1 observed message/ })
    );
    await expect(await pane.findByText("Whole reply tree at commit 3")).toBeVisible();
    await expect(state()).toBe("");
    await expect(pane.queryByText("Whole reply tree at commit 1")).toBeNull();
    await expect(pane.queryByText(/^Not in the current observation/)).toBeNull();
    await expect(pane.queryByText("This retained reading uses earlier criteria.")).toBeNull();
    await expect(pane.getByText("Confirmed with one note.")).toBeVisible();
  },
};

/**
 * A presence the viewer withholds in the middle of the bus's whole tree: every message the
 * tree's projection emitted is read, and the label never calls it whole.
 */
export const WithheldPresenceKeepsTree: Story = {
  beforeEach: () => {
    script.history = historyOf([PRESENCE_TREE_ENTRIES.root, PRESENCE_TREE_ENTRIES.selected], {
      t: 3,
    });
    script.peers = peersOf(["agent/lead"]);
    script.thread = (input) =>
      projectThread([presenceTreePage(input.ledger, input.t)], input, "2026-01-01T12:00:02Z");
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = readingPane(canvasElement);
    // The window shows the reply apart from the root: its target is not in the window.
    await userEvent.click(
      await canvas.findByRole("button", { name: /Tree reply.*1 observed message/ })
    );
    await expect(
      await pane.findByText("All entries of the reply tree at commit 3; 1 omitted by the viewer")
    ).toBeVisible();
    await expect(pane.queryByText(/^Whole reply tree/)).toBeNull();
    // Both readable messages are read, in the bus's order; the presence is not shown.
    const shown = Array.from(
      canvasElement.querySelectorAll<HTMLElement>(".thread-view article[data-message-id]"),
      (node) => node.dataset.messageId
    );
    await expect(shown).toEqual(["tree-root", "tree-selected"]);
    await expect(canvasElement.querySelector(".thread-view .thread-scope")).toHaveTextContent(
      "2 observed messages"
    );
    await expect(pane.getByText("The readable root.")).toBeVisible();
    // The reply's target is in the tree but withheld, not missing from the ledger.
    await expect(
      pane.getByText("Target is in the reply tree at commit 3 but not shown")
    ).toBeVisible();
    await expect(pane.queryByText(/Target is not an entry/)).toBeNull();
    await expect(pane.getByText("1 record omitted")).toBeVisible();
  },
};

/** A tree read at an earlier commit than the one shown never replaces it. */
export const EarlierCommitFreezesConversation: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer, followUp], { t: 5 });
    script.peers = peersOf(["agent/lead"]);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = readingPane(canvasElement);
    const state = () =>
      canvasElement.querySelector(".reading-observation-state")?.textContent?.trim();
    await userEvent.click(
      await canvas.findByRole("button", { name: /Review request.*3 observed messages/ })
    );
    await expect(await pane.findByText("Whole reply tree at commit 5")).toBeVisible();
    // The next observation is at an earlier commit, and the tree reads there successfully.
    script.history = historyOf([request, answer, followUp], {
      t: 3,
      observedAt: "2026-01-01T12:08:00Z",
    });
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(state()).toBe("Outside current observation"));
    await expect(
      pane.getByText(/^Not in the current observation · frozen at commit 5 · last observed/)
    ).toBeVisible();
    await expect(pane.getByText("Whole reply tree at commit 5")).toBeVisible();
    await expect(pane.queryByText("Whole reply tree at commit 3")).toBeNull();
  },
};

/**
 * A tree larger than the viewer reads, with the selected message after its first entries: a
 * final state, never loading, from which the message opens as history holds it.
 */
export const SelectedBeyondTheTreeRead: Story = {
  beforeEach: () => {
    script.history = historyOf([request, answer, followUp]);
    script.peers = peersOf(["agent/lead"]);
    script.thread = (input) => threadOf(input, 2);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = readingPane(canvasElement);
    // Chronology selects one message, not its group's first.
    await userEvent.click(await canvas.findByRole("button", { name: "Chronology" }));
    await userEvent.click(await canvas.findByRole("button", { name: /Follow-up/ }));
    const notice = await pane.findByText(
      "Conversation larger than 2 entries; the selected message is beyond what was read at commit 1."
    );
    await expect(notice).toHaveAttribute("data-t", "1");
    await expect(pane.queryByText("Loading conversation…")).toBeNull();
    await expect(pane.queryByText("Thanks for the note.")).toBeNull();
    await userEvent.click(pane.getByRole("button", { name: "Open it in history" }));
    await expect(pane.getByText("As the history observation at commit 1 holds it")).toBeVisible();
    await expect(pane.getByText("Thanks for the note.")).toBeVisible();
  },
};
