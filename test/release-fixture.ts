/**
 * A small, real release for tests: the actual plugin tree, a stand-in CLI and a
 * Bun wrapper, sealed by the release tool itself. Building the real bundle is
 * the job of `qualify:release`, not of every test.
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { seal } from "../scripts/release.ts";

const repo = resolve(import.meta.dir, "..");

/** A Bun "executable" that runs the test's own Bun, optionally marked with an identity. */
export function bunWrapper(path: string, identity?: string) {
  const mark = identity === undefined ? "" : `export BINDING_RUNTIME=${identity}\n`;
  writeFileSync(path, `#!/bin/sh\n${mark}exec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  return path;
}

/** The stand-in CLI: reports the release as `--version`, otherwise echoes how it was run. */
const cli = (id: string) => `const args = process.argv.slice(2);
if (args[0] === "--version") console.log(${JSON.stringify(`agent-bus v${id}`)});
else console.log(JSON.stringify({ runtime: process.env.BINDING_RUNTIME ?? null, args, dotenv: process.env.BINDING_DOTENV ?? null, release: ${JSON.stringify(id)} }));
`;

export function fakeRelease(releases: string, id: string, bun: string) {
  const stage = join(releases, `.tmp-${id}`);
  mkdirSync(join(stage, "app/dist/viewer/public"), { recursive: true });
  mkdirSync(join(stage, "runtime"));
  writeFileSync(join(stage, "app/cli.js"), cli(id));
  writeFileSync(join(stage, "app/dist/viewer/main.js"), "console.log('viewer');\n");
  writeFileSync(join(stage, "app/dist/viewer/public/manifest.json"), "[]\n");
  cpSync(join(repo, "plugin"), join(stage, "plugin"), { recursive: true });
  for (const client of [".claude-plugin", ".codex-plugin"]) {
    const path = join(stage, "plugin", client, "plugin.json");
    const plugin = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, `${JSON.stringify({ ...plugin, version: id }, null, 2)}\n`);
  }
  writeFileSync(join(stage, "runtime/bun"), readFileSync(bun));
  const digest = seal(stage, {
    id,
    version: "0.0.0",
    commit: "0".repeat(40),
    tree: "1".repeat(40),
    lock: "2".repeat(64),
    bunVersion: Bun.version,
  });
  const dir = join(releases, id);
  renameSync(stage, dir);
  return { dir, digest };
}

/** Makes a sealed path writable for a deliberate mutation, then restores its mode. */
export function mutate(path: string, mode: number, change: () => void) {
  chmodSync(path, 0o755);
  try {
    change();
  } finally {
    chmodSync(path, mode);
  }
}
