import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function requirePinnedBun(root: string): Promise<void> {
  const manifest = await Bun.file(join(root, "package.json")).json();
  if (Bun.version !== manifest.engines.bun) {
    throw new Error(
      `Tool requires Bun ${manifest.engines.bun}; running ${Bun.version}. Put the pinned Bun first on PATH before running package scripts.`
    );
  }
}

// Nx loads root dotenv before interpreting its task-level dotenv switch.
export async function refuseDotEnv(root: string): Promise<void> {
  const names = await readdir(root);
  if (names.some((name) => name === ".local.env" || name === ".env" || name.startsWith(".env."))) {
    throw new Error(
      "Tool refused: use a separate credential-free development checkout without root dotenv files."
    );
  }
}

export function localToolEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {
    CI: "true",
    FORCE_COLOR: "0",
    TZ: "UTC",
    LANG: "C",
    LC_ALL: "C",
    NX_DAEMON: "false",
    NX_NO_CLOUD: "true",
    NX_INTERACTIVE: "false",
    NX_LOAD_DOT_ENV_FILES: "false",
    NX_ISOLATE_PLUGINS: "false",
    STORYBOOK_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT", "WINDIR", "COMSPEC"]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
