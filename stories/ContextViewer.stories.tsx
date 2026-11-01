import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ViewerClient } from "../viewer/shared/client-types";
import type { HistoryObservation, PeersObservation } from "../viewer/shared/public";
import { App } from "../viewer/src/App";

const observation: HistoryObservation = {
  observedAt: "2026-01-01T12:00:00Z",
  criteria: { limit: 200 },
  omitted: 0,
  messages: [
    {
      id: "a",
      ts: "2026-01-01T10:00:00Z",
      from: "agent/lead",
      to: ["#alpha"],
      kind: "message",
      subject: "Review request",
      body: "Please review **the proposal**.",
    },
    {
      id: "b",
      ts: "2026-01-01T10:01:00Z",
      from: "agent/reviewer",
      to: ["agent/lead"],
      kind: "message",
      subject: "Review reply",
      body: "Confirmed with one note.",
      replyTo: "a",
    },
    {
      id: "c",
      ts: "2026-01-01T10:02:00Z",
      from: "agent/lead",
      to: ["#beta"],
      kind: "message",
      subject: "Follow-up",
      body: "Thanks for the note.",
      replyTo: "b",
    },
  ],
};
const peers: PeersObservation = {
  observedAt: "2026-01-01T12:00:01Z",
  omitted: 0,
  peers: [{ address: "agent/lead", runtime: "other", topics: ["alpha"] }],
};
const client: ViewerClient = { history: async () => observation, peers: async () => peers };
const meta = {
  title: "Viewer/Context journey",
  component: App,
  args: { client },
  beforeEach: () => {
    history.replaceState(null, "", location.pathname + location.search);
  },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CrossAudience: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "#alpha" }));
    await expect(canvas.getByText("Includes other audiences")).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Context flow" })).toBeVisible();
    await expect(canvas.getByText("Confirmed with one note.")).toBeVisible();
    await expect(canvas.getByText("Thanks for the note.")).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: /Review request.*3 observed messages/ })
    );
    await expect(canvas.getByRole("heading", { name: /^Conversation$/ })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Review reply" }));
    await expect(canvas.getByRole("button", { name: "Return to reply" })).toBeVisible();
  },
};
export const MobileContext: Story = {
  globals: { viewport: { value: "mobile", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alpha = await canvas.findByRole("button", { name: "#alpha" });
    for (let i = 0; i < 5; i++) await userEvent.tab();
    await expect(alpha).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(canvas.getByRole("heading", { name: "#alpha" })).toHaveFocus());
    await userEvent.tab();
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "Read context" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(canvas.getByRole("heading", { name: "Context flow" })).toHaveFocus()
    );
    await userEvent.tab({ shift: true });
    await expect(canvas.getByRole("button", { name: "Back to conversations" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(canvas.getByRole("heading", { name: "#alpha" })).toHaveFocus());
  },
};
