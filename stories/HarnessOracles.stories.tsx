import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Internal/Harness oracles",
  component: () => <p>Harness qualification only</p>,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Deliberately fails; never include this story in the positive play suite. */
export const IntentionallyFailing: Story = {
  play: async () => {
    throw new Error("Synthetic harness failure");
  },
};
/** Render-only: a correct interaction checker must not call this a passed play. */
export const NoPlay: Story = {};
