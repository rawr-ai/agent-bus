import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localToolEnvironment,
  refuseDotEnv,
  requirePinnedBun,
} from "../scripts/tool-environment.ts";

test("tool entrypoints require the pinned Bun without selecting a fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bus-tool-runtime-"));
  try {
    await Bun.write(join(root, "package.json"), JSON.stringify({ engines: { bun: Bun.version } }));
    await requirePinnedBun(root);
    await Bun.write(join(root, "package.json"), JSON.stringify({ engines: { bun: "0.0.0" } }));
    await expect(requirePinnedBun(root)).rejects.toThrow(
      `Tool requires Bun 0.0.0; running ${Bun.version}`
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local tool environment does not inherit provider, Node options or cloud credentials", () => {
  const env = localToolEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    NODE_OPTIONS: "--require private",
    BROWSERBASE_API_KEY: "private",
    NX_CLOUD_ACCESS_TOKEN: "private",
    ANTHROPIC_API_KEY: "private",
  });
  expect(env.PATH).toBe("/bin");
  expect(env.NX_NO_CLOUD).toBe("true");
  expect(env.NX_LOAD_DOT_ENV_FILES).toBe("false");
  expect(env.STORYBOOK_DISABLE_TELEMETRY).toBe("1");
  for (const key of [
    "NODE_OPTIONS",
    "BROWSERBASE_API_KEY",
    "NX_CLOUD_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
  ])
    expect(env[key]).toBeUndefined();
});

test("dotenv preflight refuses all root dotenv forms without reading file contents or symlink target", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bus-tool-env-"));
  try {
    await refuseDotEnv(root);
    for (const name of [".env", ".env.local", ".local.env", ".env.viewer-build.local"]) {
      const path = join(root, name);
      await symlink(join(root, "missing-private-target"), path);
      await expect(refuseDotEnv(root)).rejects.toThrow("Tool refused");
      await rm(path);
    }
    await refuseDotEnv(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
