import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { AutoRefreshToggle } from "../viewer/src/features/investigation/AutoRefreshToggle";

function Controlled({ enabled: initial, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const [enabled, setEnabled] = useState(initial);
  return (
    <AutoRefreshToggle
      enabled={enabled}
      onToggle={() => {
        onToggle();
        setEnabled((value) => !value);
      }}
    />
  );
}
const meta = {
  title: "Viewer/Automatic refresh",
  component: AutoRefreshToggle,
  args: { enabled: true, onToggle: fn() },
  render: (args) => <Controlled {...args} />,
  decorators: [
    (Story) => (
      <main tabIndex={-1} style={{ width: 225, padding: 12, background: "var(--canvas)" }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof AutoRefreshToggle>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PauseAndResume: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Automatic refresh on")).toBeVisible();
    canvas.getByRole("main").focus();
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "Pause automatic refresh" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onToggle).toHaveBeenCalledTimes(1);
    await expect(canvas.getByText("Automatic refresh paused")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect(args.onToggle).toHaveBeenCalledTimes(2);
    await expect(canvas.getByText("Automatic refresh on")).toBeVisible();
  },
};
