import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localToolEnvironment, refuseDotEnv } from "./tool-environment.ts";

const root = resolve(import.meta.dir, "..");
await refuseDotEnv(root);
const [tool, ...args] = process.argv.slice(2);
let cmd: string[];
if (tool === "nx") {
  const node = Bun.which("node");
  if (!node) throw new Error("Nx requires a locally installed Node runtime");
  const pkg = dirname(fileURLToPath(import.meta.resolve("nx/package.json")));
  cmd = [node, resolve(pkg, "dist/bin/nx.js"), ...args];
} else if (tool === "storybook") {
  const pkg = dirname(fileURLToPath(import.meta.resolve("storybook/package.json")));
  cmd = [process.execPath, "--no-env-file", resolve(pkg, "dist/bin/dispatcher.js"), ...args];
} else if (
  tool === "browser" ||
  tool === "browser-live" ||
  tool === "browser-investigation" ||
  tool === "storybook-plays"
) {
  const entry =
    tool === "browser"
      ? "tests/browser/viewer.browser.ts"
      : tool === "browser-live"
        ? "tests/browser/live.browser.ts"
        : tool === "browser-investigation"
          ? "tests/browser/investigation.browser.ts"
          : "scripts/check-storybook-plays.ts";
  cmd = [process.execPath, "--no-env-file", resolve(root, entry), ...args];
} else {
  throw new Error("Select the local nx, storybook, browser or storybook-plays tool");
}
const child = Bun.spawn(cmd, {
  cwd: root,
  env: localToolEnvironment(process.env),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  process.exitCode = await child.exited;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
