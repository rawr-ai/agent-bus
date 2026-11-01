import type { Preview } from "@storybook/react-vite";
import "../viewer/src/style.css";
import "../viewer/src/conversation.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Viewer theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        dynamicTitle: true,
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story, context) => {
      document.documentElement.dataset.theme = context.globals.theme === "dark" ? "dark" : "light";
      return <Story />;
    },
  ],
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        narrow: { name: "Narrow · 320px", styles: { width: "320px", height: "640px" } },
        mobile: { name: "Mobile · 390px", styles: { width: "390px", height: "844px" } },
        desktop: { name: "Desktop · 1280px", styles: { width: "1280px", height: "800px" } },
      },
    },
  },
};
export default preview;
