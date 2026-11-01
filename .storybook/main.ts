import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: {
    name: "@storybook/react-vite",
    options: { builder: { viteConfigPath: ".storybook/vite.config.ts" } },
  },
  stories: ["../stories/**/*.stories.tsx"],
  core: { disableTelemetry: true },
  viteFinal: (config) => ({
    ...config,
    envDir: false,
    esbuild: { ...(config.esbuild || {}), jsx: "automatic" },
    server: { ...config.server, host: "127.0.0.1" },
  }),
};
export default config;
