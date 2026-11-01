import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ViewerErrorBoundary } from "../viewer/src/ViewerErrorBoundary";

function RejectedObservation(): never {
  throw new Error("Conversation observation rejected");
}
const meta = {
  title: "Viewer/Stopped",
  component: ViewerErrorBoundary,
  args: { children: <RejectedObservation /> },
} satisfies Meta<typeof ViewerErrorBoundary>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A render defect stops the viewer visibly instead of leaving a blank page. */
export const RenderDefect: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "The viewer stopped" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(canvas.queryByText("Conversation observation rejected")).toBeNull();
  },
};
