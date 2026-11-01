import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { MessageBody } from "../viewer/src/MessageBody";

const rich = `## Review notes\n\n- [x] First item\n- [ ] Second item\n\n> A quoted reply\n\n| Name | Result |\n| --- | --- |\n| status | ready |\n\n\`\`\`ts\nconst value = "plain text";\n\`\`\`\n\n[Safe link](https://example.com/path) [Unsafe](javascript:alert(1))\n\n![Remote image](https://example.com/image.png)\n\n<script>not executable</script>\n\nDirection: \u202e end`;
const meta = {
  title: "Reader/Message body",
  component: MessageBody,
  decorators: [
    (Story) => (
      <main style={{ maxWidth: 720, padding: 24, background: "var(--paper)" }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof MessageBody>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RichAndHostile: Story = {
  args: { body: rich },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Review notes" })).toBeVisible();
    await expect(canvas.getByRole("table")).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Safe link" })).toHaveAttribute(
      "href",
      "https://example.com/path"
    );
    await expect(canvas.queryByRole("link", { name: "Unsafe" })).toBeNull();
    await expect(canvasElement.querySelector("img, script, iframe")).toBeNull();
    await expect(canvas.getByText(/\\u202e/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Source" }));
    await expect(canvas.getByText(/## Review notes/)).toBeVisible();
    await expect(canvas.queryByRole("table")).toBeNull();
  },
};
export const DarkMobile: Story = {
  args: { body: rich },
  globals: { theme: "dark", viewport: { value: "mobile", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(document.documentElement.dataset.theme).toBe("dark");
    await expect(window.innerWidth).toBe(390);
    await expect(canvas.getByRole("table")).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
export const LargeSource: Story = {
  args: { body: `LARGE_BEGIN\n${"x".repeat(100_001)}\nLARGE_END` },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Rendered view unavailable/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Rendered" })).toBeDisabled();
    const source = canvasElement.querySelector(".message-source");
    await expect(source?.textContent?.startsWith("LARGE_BEGIN")).toBe(true);
    await expect(source?.textContent?.endsWith("LARGE_END")).toBe(true);
  },
};
