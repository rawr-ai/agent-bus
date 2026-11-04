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
let firstPlays = 0;
/** Fails on load and passes when replayed: the checker must still report the first failure. */
export const FailsOnlyFirstPlay: Story = {
  play: async () => {
    firstPlays += 1;
    if (firstPlays === 1) throw new Error("Synthetic first-play failure");
  },
};
/** Render-only: a correct interaction checker must not call this a passed play. */
export const NoPlay: Story = {};
