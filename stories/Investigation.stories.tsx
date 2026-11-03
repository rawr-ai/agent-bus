import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_PARTICIPANT_LENGTH,
  MAX_QUERY_LENGTH,
} from "../viewer/shared/limits";
import type { HistoryInput } from "../viewer/shared/public";
import { InvestigationControls } from "../viewer/src/features/investigation/InvestigationControls";
import { enterValue } from "./enter-value";

function Controlled({
  criteria: initial,
  onApply,
}: {
  criteria: HistoryInput;
  onApply: (input: HistoryInput) => void;
}) {
  const [criteria, setCriteria] = useState(initial);
  return (
    <InvestigationControls
      criteria={criteria}
      onApply={(input) => {
        onApply(input);
        setCriteria(input);
      }}
    />
  );
}
const meta = {
  title: "Viewer/Investigation",
  component: InvestigationControls,
  args: { criteria: { limit: DEFAULT_HISTORY_LIMIT }, onApply: fn() },
  render: (args) => <Controlled {...args} />,
  decorators: [
    (Story) => (
      <main style={{ width: 225, background: "var(--canvas)" }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof InvestigationControls>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ExactSearchAndClear: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const query = canvas.getByRole("textbox", { name: "Search messages" });
    const participant = canvas.getByRole("textbox", { name: "Exact participant/address" });
    await expect(query).toHaveAttribute("maxlength", String(MAX_QUERY_LENGTH));
    await expect(participant).toHaveAttribute("maxlength", String(MAX_PARTICIPANT_LENGTH));
    await expect(canvas.getByRole("button", { name: "Clear search" })).toBeDisabled();
    await userEvent.click(query);
    enterValue(query, "Deploy Adapter");
    await waitFor(() => expect(canvas.getByRole("button", { name: "Clear search" })).toBeEnabled());
    await userEvent.tab();
    await expect(participant).toHaveFocus();
    enterValue(participant, " #Case Sensitive ");
    await expect(participant).toHaveValue(" #Case Sensitive ");
    await userEvent.keyboard("{Enter}");
    await expect(args.onApply).toHaveBeenCalledWith({
      limit: DEFAULT_HISTORY_LIMIT,
      query: "Deploy Adapter",
      participant: " #Case Sensitive ",
    });
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }));
    await expect(args.onApply).toHaveBeenLastCalledWith({ limit: DEFAULT_HISTORY_LIMIT });
    await expect(query).toHaveValue("");
    await expect(participant).toHaveValue("");
    await expect(canvas.getByRole("button", { name: "Clear search" })).toBeDisabled();
  },
};
export const DarkNarrow: Story = {
  globals: { theme: "dark", viewport: { value: "narrow", isRotated: false } },
  args: { criteria: { limit: DEFAULT_HISTORY_LIMIT, query: "Incident", participant: "#Ops" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(document.documentElement.dataset.theme).toBe("dark");
    await expect(window.innerWidth).toBe(320);
    await expect(canvas.getByRole("textbox", { name: "Exact participant/address" })).toHaveValue(
      "#Ops"
    );
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
