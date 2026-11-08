#!/usr/bin/env bun
/**
 * Builds, verifies and inspects versioned release directories
 * (docs/frames/release-packaging.md). Prints identities and booleans only,
 * never file contents.
 *
 *   release.ts build --bun /abs/bun --out /abs/releases [--commit REV]
 *   release.ts verify /abs/releases/<id> --expect <manifest sha256> [--bun /abs/approved-bun]
 *   release.ts plugin /abs/releases/<id> --expect <sha256> --marketplace /abs/dir [--bun ...]
 *   release.ts status [--launcher PATH] [--marketplace DIR] [--label LABEL]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, posix } from "node:path";

export const SCHEMA = "agent-bus-release-v1";
export const LAUNCHER_HEADER = "#!/bin/sh\n# agent-bus managed release launcher v2\nexec ";

/** The files every release must hold, beyond what its manifest lists. */
export const REQUIRED = [
  "runtime/bun",
  "app/cli.js",
  "app/dist/viewer/main.js",
  "app/dist/viewer/public/manifest.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
] as const;

const EXECUTABLE = new Set(["runtime/bun"]);
const FILE_MODE = 0o444;
const EXEC_MODE = 0o555;
const DIR_MODE = 0o555;

export type FileEntry = { readonly path: string; readonly sha256: string; readonly mode: string };
export type Manifest = {
  readonly schema: typeof SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly commit: string;
  readonly tree: string;
  readonly lock: string;
  readonly bun: { readonly version: string; readonly sha256: string };
  readonly files: ReadonlyArray<FileEntry>;
};

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const fileSha256 = (path: string) => sha256(readFileSync(path));
const octal = (mode: number) => `0${(mode & 0o7777).toString(8)}`;

/** A clean environment for running release code: nothing inherited but a fixed PATH and HOME. */
const cleanEnv = (home = tmpdir()) => ({
  HOME: home,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  // Running release code to check it writes nothing, not even Bun's transpiler cache.
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
});

function run(
  args: ReadonlyArray<string>,
  options: { cwd?: string; env?: Record<string, string>; input?: string } = {}
) {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd: options.cwd ?? "/",
    env: options.env ?? cleanEnv(),
    input: options.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function must(args: ReadonlyArray<string>, what: string, options?: Parameters<typeof run>[1]) {
  const result = run(args, options);
  if (result.status !== 0) throw new Error(`${what} failed (exit ${result.status})`);
  return result.stdout;
}

/** The hook subcommands a plugin manifest runs through the managed launcher. */
export function hookSubcommands(manifestJson: unknown): ReadonlyArray<string> {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object")
      for (const [key, inner] of Object.entries(value)) {
        if (key === "command" && typeof inner === "string") {
          const match = /\/\.local\/bin\/agent-bus"\s+([a-z][a-z-]*)/.exec(inner);
          if (match) found.add(match[1]!);
        } else visit(inner);
      }
  };
  visit(manifestJson);
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// verify

export type Verdict = {
  readonly ok: boolean;
  readonly id: string | null;
  readonly manifestSha256: string | null;
  readonly problems: ReadonlyArray<string>;
};

/** Walks a release, returning every entry's kind; refuses anything but plain files and directories. */
function walk(root: string, problems: string[]): Map<string, { mode: number }> {
  const files = new Map<string, { mode: number }>();
  const visit = (relativePath: string) => {
    const path = relativePath === "" ? root : join(root, relativePath);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      if ((stat.mode & 0o7777) !== DIR_MODE)
        problems.push(`directory mode is not ${octal(DIR_MODE)}: ${relativePath || "."}`);
      for (const name of readdirSync(path).sort())
        visit(relativePath === "" ? name : posix.join(relativePath, name));
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) problems.push(`file has other hard links: ${relativePath}`);
      files.set(relativePath, { mode: stat.mode & 0o7777 });
    } else {
      problems.push(`not a regular file or directory: ${relativePath}`);
    }
  };
  visit("");
  return files;
}

const safePath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length > 0 &&
  !isAbsolute(path) &&
  posix.normalize(path) === path &&
  !path.split("/").some((part) => part === ".." || part === "." || part === "");

/**
 * Checks a release directory against its manifest and an external anchor:
 * the manifest's own digest, recorded outside the release. Static checks come
 * first; release code runs only once they pass.
 */
export function verify(
  dir: string,
  options: { readonly expect: string; readonly bun?: string | undefined }
): Verdict {
  const problems: string[] = [];
  const done = (id: string | null, digest: string | null): Verdict => ({
    ok: problems.length === 0,
    id,
    manifestSha256: digest,
    problems,
  });
  if (!isAbsolute(dir)) problems.push("release path must be absolute");
  if (!/^[0-9a-f]{64}$/.test(options.expect)) problems.push("--expect must be a sha256 digest");
  if (problems.length > 0) return done(null, null);
  let top: ReturnType<typeof lstatSync>;
  try {
    top = lstatSync(dir);
  } catch {
    problems.push("release directory does not exist");
    return done(null, null);
  }
  if (!top.isDirectory()) {
    problems.push("release path is not a real directory");
    return done(null, null);
  }
  const entries = walk(dir, problems);
  const manifestEntry = entries.get("manifest.json");
  if (manifestEntry === undefined) {
    problems.push("manifest.json is missing");
    return done(null, null);
  }
  const manifestBytes = readFileSync(join(dir, "manifest.json"));
  const digest = sha256(manifestBytes);
  if (digest !== options.expect) {
    problems.push("manifest digest does not match the expected anchor");
    return done(null, digest);
  }
  if (manifestEntry.mode !== FILE_MODE)
    problems.push(`manifest.json mode is not ${octal(FILE_MODE)}`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    problems.push("manifest.json is not JSON");
    return done(null, digest);
  }
  if (manifest.schema !== SCHEMA) problems.push("manifest schema is not recognised");
  const id = typeof manifest.id === "string" ? manifest.id : null;
  if (id === null || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(id))
    problems.push("manifest id is not valid");
  else if (basename(dir) !== id) problems.push("directory name differs from the release id");
  if (!Array.isArray(manifest.files)) {
    problems.push("manifest has no file list");
    return done(id, digest);
  }
  const listed = new Map<string, FileEntry>();
  for (const entry of manifest.files) {
    if (!safePath(entry?.path) || entry.path === "manifest.json") {
      problems.push("manifest lists an unsafe path");
      continue;
    }
    if (listed.has(entry.path)) problems.push(`manifest lists a path twice: ${entry.path}`);
    listed.set(entry.path, entry);
  }
  for (const path of REQUIRED)
    if (!listed.has(path)) problems.push(`required file not listed: ${path}`);
  for (const path of entries.keys())
    if (path !== "manifest.json" && !listed.has(path)) problems.push(`unlisted file: ${path}`);
  for (const [path, entry] of listed) {
    const actual = entries.get(path);
    if (actual === undefined) {
      problems.push(`missing file: ${path}`);
      continue;
    }
    const expectedMode = EXECUTABLE.has(path) ? EXEC_MODE : FILE_MODE;
    if (entry.mode !== octal(expectedMode)) problems.push(`manifest mode is wrong: ${path}`);
    if (actual.mode !== expectedMode) problems.push(`file mode differs: ${path}`);
    if (fileSha256(join(dir, path)) !== entry.sha256) problems.push(`content differs: ${path}`);
  }
  const runtime = listed.get("runtime/bun");
  if (runtime !== undefined && manifest.bun?.sha256 !== runtime.sha256)
    problems.push("manifest Bun hash differs from runtime/bun");
  if (options.bun !== undefined) {
    if (!isAbsolute(options.bun)) problems.push("--bun must be absolute");
    else if (!existsSync(options.bun)) problems.push("approved Bun does not exist");
    else if (fileSha256(realpathSync(options.bun)) !== manifest.bun?.sha256)
      problems.push("runtime/bun is not the approved Bun");
  }
  if (problems.length > 0) return done(id, digest);

  // Static checks passed: the code is the anchored code, so it may run.
  const bun = join(dir, "runtime/bun");
  const cli = join(dir, "app/cli.js");
  const bunVersion = run([bun, "--version"]);
  if (bunVersion.status !== 0 || bunVersion.stdout.trim() !== manifest.bun.version)
    problems.push("runtime/bun does not report the manifest's Bun version");
  const cliVersion = run([bun, "--no-env-file", cli, "--version"]);
  if (cliVersion.status !== 0 || cliVersion.stdout.trim() !== `agent-bus v${id}`)
    problems.push("app/cli.js does not report this release");
  for (const client of [".claude-plugin", ".codex-plugin"]) {
    const plugin = JSON.parse(readFileSync(join(dir, "plugin", client, "plugin.json"), "utf8"));
    if (plugin.version !== id) problems.push(`plugin ${client} version is not the release id`);
    for (const sub of hookSubcommands(plugin))
      if (run([bun, "--no-env-file", cli, sub, "--help"]).status !== 0)
        problems.push(`hook subcommand missing from this release's CLI: ${sub}`);
  }
  return done(id, digest);
}

// ---------------------------------------------------------------------------
// build

/** Copies `from` to `to`, keeping regular files and directories only. */
function copyTree(from: string, to: string) {
  cpSync(from, to, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error(`refusing symlink in release input: ${source}`);
      return stat.isDirectory() || stat.isFile();
    },
  });
}

function listFiles(root: string, at = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, at)).sort()) {
    const path = at === "" ? name : posix.join(at, name);
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) out.push(...listFiles(root, path));
    else if (stat.isFile()) out.push(path);
    else throw new Error(`not a regular file: ${path}`);
  }
  return out;
}

function setModes(root: string, at = "") {
  const path = at === "" ? root : join(root, at);
  for (const name of readdirSync(path)) {
    const child = at === "" ? name : posix.join(at, name);
    const stat = lstatSync(join(root, child));
    if (stat.isDirectory()) setModes(root, child);
    else chmodSync(join(root, child), EXECUTABLE.has(child) ? EXEC_MODE : FILE_MODE);
  }
  chmodSync(path, DIR_MODE);
}

/**
 * Finishes a staged release in place: hashes every file, writes the manifest,
 * and makes everything read-only. Returns the manifest's digest, the anchor an
 * activation decision records.
 */
export function seal(
  stage: string,
  meta: {
    readonly id: string;
    readonly version: string;
    readonly commit: string;
    readonly tree: string;
    readonly lock: string;
    readonly bunVersion: string;
  }
): string {
  const files = listFiles(stage).map((path) => ({
    path,
    sha256: fileSha256(join(stage, path)),
    mode: octal(EXECUTABLE.has(path) ? EXEC_MODE : FILE_MODE),
  }));
  const manifest: Manifest = {
    schema: SCHEMA,
    id: meta.id,
    version: meta.version,
    commit: meta.commit,
    tree: meta.tree,
    lock: meta.lock,
    bun: { version: meta.bunVersion, sha256: fileSha256(join(stage, "runtime/bun")) },
    files,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(stage, "manifest.json"), text);
  setModes(stage);
  return sha256(text);
}

/** Removes a directory this build created, first making read-only parts writable. */
export function removeOwned(path: string) {
  if (!existsSync(path)) return;
  const writable = (at: string) => {
    const stat = lstatSync(at);
    if (!stat.isDirectory()) return;
    chmodSync(at, 0o755);
    for (const name of readdirSync(at)) writable(join(at, name));
  };
  writable(path);
  rmSync(path, { recursive: true, force: true });
}

export type Built = { readonly id: string; readonly dir: string; readonly manifestSha256: string };

/**
 * Builds a release from a commit (not the worktree): export, frozen install,
 * bundle, assemble, hash, make read-only, and rename into place. Refuses to
 * replace an existing release.
 */
export function build(options: {
  readonly repo: string;
  readonly commit: string;
  readonly bun: string;
  readonly out: string;
}): Built {
  for (const [name, value] of [
    ["--bun", options.bun],
    ["--out", options.out],
  ] as const)
    if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  const bun = realpathSync(options.bun);
  const commit = must(
    ["git", "-C", options.repo, "rev-parse", "--verify", `${options.commit}^{commit}`],
    "resolving the commit"
  ).trim();
  const tree = must(
    ["git", "-C", options.repo, "rev-parse", `${commit}^{tree}`],
    "resolving the tree"
  ).trim();
  const work = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-release-")));
  let staged: string | null = null;
  try {
    const src = join(work, "src");
    mkdirSync(src);
    const archive = join(work, "source.tar");
    must(
      ["git", "-C", options.repo, "archive", "--format=tar", "-o", archive, commit],
      "exporting the commit"
    );
    must(["/usr/bin/tar", "-xf", archive, "-C", src], "unpacking the export");
    const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
    const pin = pkg.engines?.bun;
    const bunVersion = must([bun, "--version"], "reading the Bun version").trim();
    if (pin !== bunVersion || pkg.packageManager !== `bun@${pin}`)
      throw new Error(`Bun ${bunVersion} does not match the commit's pin ${pin}`);
    const version = /export const VERSION = "([^"]+)"/.exec(
      readFileSync(join(src, "src/version.ts"), "utf8")
    )?.[1];
    if (version === undefined) throw new Error("the commit has no VERSION");
    const id = `${version}-${commit.slice(0, 12)}`;
    const final = join(options.out, id);
    if (existsSync(final)) throw new Error(`release ${id} already exists; it is never replaced`);
    // Dependencies come from the lockfile, not the developer's node_modules.
    const env = { ...cleanEnv(homedir()), PATH: `${dirname(bun)}:/usr/bin:/bin:/usr/sbin:/sbin` };
    must([bun, "install", "--frozen-lockfile", "--ignore-scripts"], "the frozen install", {
      cwd: src,
      env,
    });
    must([bun, "--no-env-file", "scripts/build-viewer.ts"], "the viewer build", { cwd: src, env });
    // Stage beside the final path, so the last step is one rename within one directory.
    mkdirSync(options.out, { recursive: true });
    const stage = join(options.out, `.tmp-${id}`);
    if (existsSync(stage)) throw new Error(`a partial build of ${id} exists; inspect it first`);
    staged = stage;
    mkdirSync(join(stage, "app/dist"), { recursive: true });
    mkdirSync(join(stage, "runtime"));
    must(
      [
        bun,
        "build",
        "src/bin.ts",
        "--target=bun",
        "--env=disable",
        "--minify-syntax",
        "--minify-whitespace",
        `--define=AGENT_BUS_RELEASE=${JSON.stringify(id)}`,
        `--outfile=${join(stage, "app/cli.js")}`,
      ],
      "the CLI bundle",
      { cwd: src, env }
    );
    copyTree(join(src, "dist/viewer"), join(stage, "app/dist/viewer"));
    copyTree(join(src, "plugin"), join(stage, "plugin"));
    for (const client of [".claude-plugin", ".codex-plugin"]) {
      const path = join(stage, "plugin", client, "plugin.json");
      const plugin = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, `${JSON.stringify({ ...plugin, version: id }, null, 2)}\n`);
    }
    writeFileSync(join(stage, "runtime/bun"), readFileSync(bun));
    const manifestSha256 = seal(stage, {
      id,
      version,
      commit,
      tree,
      lock: fileSha256(join(src, "bun.lock")),
      bunVersion,
    });
    if (existsSync(final)) throw new Error(`release ${id} already exists; it is never replaced`);
    renameSync(stage, final);
    staged = null;
    return { id, dir: final, manifestSha256 };
  } finally {
    // Both are this build's own: the export and install, and an unfinished stage.
    for (const path of [work, staged]) if (path !== null) removeOwned(path);
  }
}

// ---------------------------------------------------------------------------
// plugin marketplace

export const MARKETPLACE = {
  name: "agent-bus",
  owner: { name: "rawr-ai" },
  description: "agent-bus, from its active release",
  plugins: [
    {
      name: "agent-bus",
      source: "./plugin",
      description: "Wakes a Claude Code session when agent-bus mail arrives for an address it owns",
    },
  ],
};

/**
 * Points the stable marketplace's `plugin` link at a verified release's plugin,
 * by atomic rename. Creates the marketplace on first use; refuses one that is
 * not a real directory or whose `plugin` is not a link.
 */
export function selectPlugin(marketplace: string, release: string) {
  if (!isAbsolute(marketplace)) throw new Error("--marketplace must be absolute");
  if (existsSync(marketplace) && !lstatSync(marketplace).isDirectory())
    throw new Error("the marketplace is not a real directory");
  const link = join(marketplace, "plugin");
  let current: string | null = null;
  try {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) throw new Error("the marketplace's plugin is not a link; refusing");
    current = readlinkSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(join(marketplace, ".claude-plugin"), { recursive: true });
  const manifestPath = join(marketplace, ".claude-plugin/marketplace.json");
  const manifestText = `${JSON.stringify(MARKETPLACE, null, 2)}\n`;
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, manifestText);
  else if (readFileSync(manifestPath, "utf8") !== manifestText)
    throw new Error("the marketplace manifest is not the managed one; refusing");
  const target = join(release, "plugin");
  const staged = join(marketplace, `.plugin.tmp-${process.pid}`);
  symlinkSync(target, staged);
  renameSync(staged, link);
  return { previous: current, current: target };
}

// ---------------------------------------------------------------------------
// status

/** What a launcher binds: a source checkout (v1), a release (v2), or neither. */
export function readLauncher(
  path: string
):
  | { readonly kind: "absent" | "foreign" }
  | { readonly kind: "source"; readonly entry: string }
  | { readonly kind: "release"; readonly release: string } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: "absent" };
  }
  if (stat.isSymbolicLink()) return { kind: "source", entry: readlinkSync(path) };
  if (!stat.isFile()) return { kind: "foreign" };
  const text = readFileSync(path, "utf8");
  const release = parseReleaseLauncher(text);
  if (release !== null) return { kind: "release", release };
  const v1 =
    /^#!\/bin\/sh\n# agent-bus managed runtime launcher v1\nexec '[^\n]*' --no-env-file '([^\n]*)' "\$@"\n$/.exec(
      text
    );
  return v1 ? { kind: "source", entry: v1[1]!.replaceAll("'\\''", "'") } : { kind: "foreign" };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The exact v2 launcher text for a release directory. */
export const releaseLauncher = (release: string) =>
  `${LAUNCHER_HEADER}${quote(join(release, "runtime/bun"))} --no-env-file ${quote(join(release, "app/cli.js"))} "$@"\n`;

export function parseReleaseLauncher(text: string): string | null {
  if (!text.startsWith(LAUNCHER_HEADER)) return null;
  const match =
    /^'((?:[^']|'\\'')*)\/runtime\/bun' --no-env-file '((?:[^']|'\\'')*)\/app\/cli\.js' "\$@"\n$/.exec(
      text.slice(LAUNCHER_HEADER.length)
    );
  if (match === null || match[1] !== match[2]) return null;
  const release = match[1]!.replaceAll("'\\''", "'");
  return isAbsolute(release) && normalize(release) === release && releaseLauncher(release) === text
    ? release
    : null;
}

export function status(options: {
  readonly launcher: string;
  readonly marketplace: string;
  readonly label: string;
}) {
  const launcher = readLauncher(options.launcher);
  let plugin: string | null = null;
  try {
    plugin = readlinkSync(join(options.marketplace, "plugin"));
  } catch {
    plugin = null;
  }
  const domain = `gui/${process.getuid?.() ?? 0}/${options.label}`;
  const printed = run(["/bin/launchctl", "print", domain]);
  const pid = /^\s*pid = (\d+)$/m.exec(printed.stdout)?.[1];
  const args =
    pid === undefined ? null : run(["/bin/ps", "-o", "command=", "-p", pid]).stdout.trim();
  const releaseOf = (path: string | null) => (path === null ? null : basename(dirname(path)));
  const launcherRelease = launcher.kind === "release" ? basename(launcher.release) : null;
  const pluginRelease = plugin === null ? null : releaseOf(plugin);
  const serveRelease =
    args === null ? null : (/\/releases\/([^/ ]+)\/app\/cli\.js serve$/.exec(args)?.[1] ?? null);
  return {
    launcher: launcher.kind,
    launcherRelease,
    pluginRelease,
    serveRunning: pid !== undefined,
    serveRelease,
    agree:
      launcherRelease !== null &&
      launcherRelease === pluginRelease &&
      (pid === undefined || serveRelease === launcherRelease),
  };
}

// ---------------------------------------------------------------------------
// command line

function flags(argv: ReadonlyArray<string>) {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (named.has(arg)) throw new Error(`${arg} was supplied more than once`);
      named.set(arg, value);
      i++;
    } else positional.push(arg);
  }
  return { positional, named };
}

const dataHome = () => join(homedir(), ".local/share/agent-bus");

function main(argv: ReadonlyArray<string>): number {
  const [command, ...rest] = argv;
  const { positional, named } = flags(rest);
  const required = (name: string) => {
    const value = named.get(name);
    if (value === undefined) throw new Error(`${name} is required`);
    return value;
  };
  switch (command) {
    case "build": {
      const built = build({
        repo: positional[0] ?? process.cwd(),
        commit: named.get("--commit") ?? "HEAD",
        bun: required("--bun"),
        out: required("--out"),
      });
      const verdict = verify(built.dir, { expect: built.manifestSha256, bun: required("--bun") });
      console.log(
        JSON.stringify({
          id: built.id,
          manifestSha256: built.manifestSha256,
          verified: verdict.ok,
          problems: verdict.problems,
        })
      );
      return verdict.ok ? 0 : 1;
    }
    case "verify": {
      const dir = positional[0];
      if (dir === undefined) throw new Error("verify needs a release directory");
      const verdict = verify(dir, { expect: required("--expect"), bun: named.get("--bun") });
      console.log(JSON.stringify(verdict));
      return verdict.ok ? 0 : 1;
    }
    case "plugin": {
      const dir = positional[0];
      if (dir === undefined) throw new Error("plugin needs a release directory");
      const verdict = verify(dir, { expect: required("--expect"), bun: named.get("--bun") });
      if (!verdict.ok) {
        console.log(JSON.stringify({ selected: false, problems: verdict.problems }));
        return 1;
      }
      const moved = selectPlugin(required("--marketplace"), dir);
      console.log(
        JSON.stringify({
          selected: true,
          release: verdict.id,
          previousRelease: moved.previous === null ? null : basename(dirname(moved.previous)),
        })
      );
      return 0;
    }
    case "status": {
      console.log(
        JSON.stringify(
          status({
            launcher: named.get("--launcher") ?? join(homedir(), ".local/bin/agent-bus"),
            marketplace: named.get("--marketplace") ?? join(dataHome(), "marketplace"),
            label: named.get("--label") ?? "ai.rawr.agent-bus",
          })
        )
      );
      return 0;
    }
    default:
      console.error("usage: release.ts build|verify|plugin|status (see the header of this file)");
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
