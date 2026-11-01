import { fileURLToPath } from "node:url";
import { localToolEnvironment } from "../../scripts/tool-environment";

// Stagehand 4 inherits the process environment when launching native Chrome.
// Re-exec once with the same explicit allowlist as the repository tool wrapper.
export async function isolatedTool(entry: string, run: () => Promise<void>): Promise<void> {
  const env = localToolEnvironment(process.env);
  const isolated =
    Object.keys(process.env).every((key) => process.env[key] === env[key]) &&
    Object.keys(env).every((key) => env[key] === process.env[key]);
  if (isolated) return run();
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", fileURLToPath(entry), ...process.argv.slice(2)],
    {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
