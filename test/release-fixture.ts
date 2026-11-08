/**
 * A small, real release for tests: the actual plugin tree, the real release
 * tool and installer, a stand-in CLI and a Bun wrapper, sealed by the release
 * tool itself. Building the real CLI bundle is the job of `qualify:release`,
 * not of every test.
 */
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundle, fileSha256, seal } from "../scripts/release.ts";

const repo = resolve(import.meta.dir, "..");

/** The release tool, bundled as a build bundles it, once per test process. */
const scratch = mkdtempSync(join(tmpdir(), "agent-bus-release-tool-"));
bundle({
  src: repo,
  entry: "scripts/release.ts",
  outfile: join(scratch, "release.js"),
  bun: process.execPath,
});
const tool = readFileSync(join(scratch, "release.js"));
rmSync(scratch, { recursive: true });

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
  writeFileSync(join(stage, "app/release.js"), tool);
  writeFileSync(
    join(stage, "app/install-launch-agents.sh"),
    readFileSync(join(repo, "scripts/install-launch-agents.sh"))
  );
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

type ManifestEdit = (manifest: {
  files: Array<Record<string, string>>;
  [key: string]: unknown;
}) => void;

/** Rewrites a release's manifest consistently, as a tamperer would, and returns its new digest. */
export function reseal(dir: string, edit: ManifestEdit) {
  const path = join(dir, "manifest.json");
  mutate(dir, 0o555, () =>
    mutate(path, 0o444, () => {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      edit(manifest);
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    })
  );
  return fileSha256(path);
}

/** Replaces one sealed file's bytes and records its new hash, as a tamperer would. */
export function replaceSealed(dir: string, path: string, content: string, mode = 0o444) {
  const file = join(dir, path);
  mutate(join(file, ".."), 0o555, () => mutate(file, mode, () => writeFileSync(file, content)));
  return reseal(dir, (manifest) => {
    for (const entry of manifest.files) if (entry.path === path) entry.sha256 = fileSha256(file);
  });
}
