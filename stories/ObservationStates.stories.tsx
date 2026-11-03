import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ViewerClient } from "../viewer/shared/client-types";
import type {
  HistoryObservation,
  PeersObservation,
  PublicMessage,
  PublicPeer,
} from "../viewer/shared/public";
import { App } from "../viewer/src/App";
import { formatTime } from "../viewer/src/Text";

/** A rejection shaped like the oRPC client's: only the HTTP status is read. */
class StatusError extends Error {
  constructor(readonly status: number) {
    super(`Synthetic ${status}`);
  }
}
type Reply<T> = T | StatusError;

// Each story sets the replies before it renders; a play changes them before a manual refresh.
// Replies stay until changed, so a repeated or automatic read observes the same state.
const script: {
  history: Reply<HistoryObservation>;
  peers: Reply<PeersObservation>;
  historyCalls: number;
} = { history: new StatusError(503), peers: new StatusError(503), historyCalls: 0 };
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
const historyOf = (
  messages: PublicMessage[],
  observedAt = "2026-01-01T12:00:00Z",
  omitted = 0
): HistoryObservation => ({ observedAt, criteria: { limit: 200 }, omitted, messages });
const peersOf = (addresses: string[], omitted = 0): PeersObservation => ({
  observedAt: "2026-01-01T12:00:01Z",
  omitted,
  peers: addresses.map((address): PublicPeer => ({ address, runtime: "other", topics: [] })),
});

const meta = {
  title: "Viewer/Observation states",
  component: App,
  args: { client },
  beforeEach: () => {
    history.replaceState(null, "", location.pathname + location.search);
    script.historyCalls = 0;
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
    script.history = historyOf([], "2026-01-01T12:01:00Z", 2);
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await expect(
      await canvas.findByText("No displayable messages in this observation.")
    ).toBeVisible();
    await expect(canvas.getAllByText("2 records omitted")[0]).toBeVisible();
    // The displayed records are unchanged, but the omitted count changed: that is announced.
    await waitFor(() => expect(live.history).toHaveTextContent("History: 2 records omitted."));
    // A refresh that observes the same records and omissions stays quiet.
    const spoken = live.history.firstElementChild;
    script.history = historyOf([], "2026-01-01T12:02:00Z", 2);
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
    script.history = historyOf([request, answer, followUp], "2026-01-01T12:01:00Z");
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
    await userEvent.click(
      await canvas.findByRole("button", { name: /Review request.*3 observed messages/ })
    );
    await expect(canvas.getByRole("heading", { name: /^Conversation$/ })).toBeVisible();
    await expect(state()).toBe("");
    script.history = historyOf([unrelated], "2026-01-01T12:05:00Z");
    await userEvent.click(canvas.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(state()).toBe("Outside current observation"));
    await expect(live.history).toHaveTextContent("History: 1 new message.");
    await expect(canvas.getByText(/^Not in the current observation · limit 200/)).toBeVisible();
    await expect(canvas.getByText("Confirmed with one note.")).toBeVisible();
    const status = canvas.getByRole("button", { name: /Status update/ });
    await userEvent.click(status);
    await waitFor(() => expect(state()).toBe(""));
    await expect(status).toHaveAttribute("aria-current", "true");
    await expect(canvas.getByText("Deployment window moved.")).toBeVisible();
    await expect(canvas.queryByText("Confirmed with one note.")).toBeNull();
  },
};
