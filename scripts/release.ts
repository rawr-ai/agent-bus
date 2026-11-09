#!/usr/bin/env bun
/**
 * Builds, verifies and inspects versioned release directories
 * (docs/frames/release-packaging.md). Prints identities and booleans only,
 * never file contents.
 *
 *   release.ts build --bun /abs/bun --out /abs/releases [--commit REV]
 *   release.ts verify /abs/releases/<id> --expect <manifest sha256> [--bun /abs/approved-bun]
 *   release.ts plugin /abs/releases/<id> --expect <sha256> --marketplace /abs/dir
 *   release.ts viewer /abs/releases/<id> --expect <sha256> [--plist PATH] [--viewer-label LABEL]
 *   release.ts viewer-restore --from /abs/recorded.plist [--plist PATH] [--viewer-label LABEL]
 *   release.ts status [--launcher PATH] [--marketplace DIR] [--label LABEL] [--viewer-label LABEL]
 *     [--plist PATH]
 *
 * A built release carries this tool as app/release.js and the installer as
 * app/install-launch-agents.sh, so activating it needs no source checkout.
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
import { builtinModules } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, posix } from "node:path";

export const SCHEMA = "agent-bus-release-v1";
/**
 * Every run of release code names this sealed, empty Bun config. Without an
 * explicit one, Bun reads bunfig.toml from the caller's directory, and its
 * `preload` would run that directory's code inside the release.
 */
export const RELEASE_BUNFIG = "app/bunfig.toml";
const BUNFIG_TEXT =
  "# Empty on purpose: release runs name this file so that no caller's bunfig.toml applies.\n";
export const LAUNCHER_HEADER = "#!/bin/sh\n# agent-bus managed release launcher v2\nexec ";

/** The files every release must hold, beyond what its manifest lists. */
export const REQUIRED = [
  "runtime/bun",
  "app/cli.js",
  "app/release.js",
  "app/install-launch-agents.sh",
  "app/bunfig.toml",
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
  const config = `--config=${join(dir, RELEASE_BUNFIG)}`;
  const cliVersion = run([bun, "--no-env-file", config, cli, "--version"]);
  if (cliVersion.status !== 0 || cliVersion.stdout.trim() !== `agent-bus v${id}`)
    problems.push("app/cli.js does not report this release");
  for (const client of [".claude-plugin", ".codex-plugin"]) {
    const plugin = JSON.parse(readFileSync(join(dir, "plugin", client, "plugin.json"), "utf8"));
    if (plugin.version !== id) problems.push(`plugin ${client} version is not the release id`);
    for (const sub of hookSubcommands(plugin))
      if (run([bun, "--no-env-file", config, cli, sub, "--help"]).status !== 0)
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

/**
 * Bundles one entry of a source tree for Bun, as a release ships it: no
 * environment inlined, and with `id` the release identity the CLI reports.
 */
export function bundle(options: {
  readonly src: string;
  readonly entry: string;
  readonly outfile: string;
  readonly bun: string;
  readonly env?: Record<string, string>;
  readonly id?: string;
}) {
  must(
    [
      options.bun,
      "build",
      options.entry,
      "--target=bun",
      "--env=disable",
      "--minify-syntax",
      "--minify-whitespace",
      ...(options.id === undefined
        ? []
        : [`--define=AGENT_BUS_RELEASE=${JSON.stringify(options.id)}`]),
      `--outfile=${options.outfile}`,
    ],
    `bundling ${options.entry}`,
    {
      cwd: options.src,
      env: options.env ?? {
        ...cleanEnv(homedir()),
        PATH: `${dirname(options.bun)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    }
  );
}

const BUILTIN = new Set(builtinModules);

/**
 * Module specifiers a bundle still loads from outside itself, as Bun's own
 * parser finds them. A release bundle may name only Bun and Node builtins;
 * anything else would be resolved from wherever it happens to run.
 */
export function externalImports(code: string): ReadonlyArray<string> {
  const body = code.startsWith("#!") ? code.slice(code.indexOf("\n") + 1) : code;
  const found = new Set<string>();
  for (const { path } of new Bun.Transpiler({ loader: "js" }).scanImports(body))
    if (
      !(path === "bun" || path.startsWith("bun:") || path.startsWith("node:") || BUILTIN.has(path))
    )
      found.add(path);
  return [...found].sort();
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
    bundle({ src, entry: "src/bin.ts", outfile: join(stage, "app/cli.js"), bun, env, id });
    // The release's own activation tools: this script bundled, and the installer.
    bundle({ src, entry: "scripts/release.ts", outfile: join(stage, "app/release.js"), bun, env });
    writeFileSync(
      join(stage, "app/install-launch-agents.sh"),
      readFileSync(join(src, "scripts/install-launch-agents.sh"))
    );
    writeFileSync(join(stage, RELEASE_BUNFIG), BUNFIG_TEXT);
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
// viewer LaunchAgent

/** Launchd, injectable so tests never touch the real GUI domain. */
export type Launchd = (args: ReadonlyArray<string>) => { readonly status: number };
const launchctl: Launchd = (args) => run(["/bin/launchctl", ...args]);
const uid = () => process.getuid?.() ?? 0;

const VIEWER_MAIN = "/dist/viewer/main.js";
export const VIEWER_LABEL = "ai.rawr.agent-bus.viewer";

/**
 * The viewer job's binding, recognised only in the owned shape the viewer
 * runbook writes: `/usr/bin/env -i NAME=value... <bun> --no-env-file
 * <root>/dist/viewer/main.js`, run in `<root>`.
 */
export function parseViewerJob(
  job: unknown,
  label: string
): { readonly env: ReadonlyArray<string>; readonly bun: string; readonly root: string } | null {
  if (job === null || typeof job !== "object") return null;
  const { Label, ProgramArguments: args, WorkingDirectory } = job as Record<string, unknown>;
  if (Label !== label || !Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    return null;
  if (args[0] !== "/usr/bin/env" || args[1] !== "-i") return null;
  let at = 2;
  while (at < args.length && /^[A-Z_][A-Z0-9_]*=/.test(args[at])) at++;
  if (args.length !== at + 3 || args[at + 1] !== "--no-env-file") return null;
  const bun: string = args[at];
  const main: string = args[at + 2];
  if (!isAbsolute(bun) || !isAbsolute(main) || !main.endsWith(VIEWER_MAIN)) return null;
  const root = main.slice(0, -VIEWER_MAIN.length);
  if (WorkingDirectory !== root) return null;
  return { env: args.slice(2, at), bun, root };
}

const readPlist = (path: string): unknown =>
  JSON.parse(must(["/usr/bin/plutil", "-convert", "json", "-o", "-", path], "reading the plist"));

/** Writes a plist beside its final path and renames it into place, private like the runbook's. */
function writePlist(path: string, job: unknown) {
  const staged = `${path}.tmp-${process.pid}`;
  writeFileSync(staged, JSON.stringify(job), { mode: 0o600 });
  try {
    must(["/usr/bin/plutil", "-convert", "xml1", staged], "converting the plist");
    must(["/usr/bin/plutil", "-lint", "-s", staged], "checking the plist");
    renameSync(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Restarts a job only if it was loaded; an unloaded job stays unloaded. */
function restartIfLoaded(launchd: Launchd, label: string, plist: string) {
  const target = `gui/${uid()}/${label}`;
  if (launchd(["print", target]).status !== 0) return false;
  launchd(["bootout", target]);
  // bootout returns before the job is gone; bootstrapping over it fails.
  for (let attempt = 0; attempt < 50 && launchd(["print", target]).status === 0; attempt++)
    Bun.sleepSync(200);
  if (launchd(["bootstrap", `gui/${uid()}`, plist]).status !== 0)
    throw new Error(`launchd did not start ${label}; it is stopped`);
  return true;
}

const stamp = () =>
  new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/** The release a viewer root (`<releases>/<id>/app`) belongs to, or null for a source worktree. */
const releaseOfRoot = (root: string) =>
  basename(root) === "app" && basename(dirname(dirname(root))) === "releases"
    ? basename(dirname(root))
    : null;

/**
 * Moves an installed viewer job onto a verified release's Bun and viewer,
 * keeping its label, environment assignments (ports) and every other setting.
 * The previous plist is recorded first, for rollback. An absent viewer stays
 * absent; a job not in the owned shape is refused unchanged.
 */
export function rebindViewer(options: {
  readonly plist: string;
  readonly label: string;
  readonly release: string;
  readonly bindings: string;
  readonly launchd?: Launchd;
}) {
  if (!existsSync(options.plist)) return { viewer: "absent" as const };
  const job = readPlist(options.plist) as Record<string, unknown>;
  const bound = parseViewerJob(job, options.label);
  if (bound === null) throw new Error("the viewer job is not in the owned shape; refusing");
  const root = join(options.release, "app");
  mkdirSync(options.bindings, { recursive: true });
  const record = join(
    options.bindings,
    `viewer.${stamp()}.before-${basename(options.release)}.plist`
  );
  if (existsSync(record)) throw new Error("a binding record with this name exists; retry");
  writeFileSync(record, readFileSync(options.plist), { mode: 0o600 });
  writePlist(options.plist, {
    ...job,
    ProgramArguments: [
      "/usr/bin/env",
      "-i",
      ...bound.env,
      join(options.release, "runtime/bun"),
      "--no-env-file",
      `${root}${VIEWER_MAIN}`,
    ],
    WorkingDirectory: root,
  });
  const restarted = restartIfLoaded(options.launchd ?? launchctl, options.label, options.plist);
  return {
    viewer: "rebound" as const,
    previousRelease: releaseOfRoot(bound.root),
    restarted,
    record: basename(record),
  };
}

/** Puts back a recorded viewer plist (for example the source binding) and restarts a loaded job. */
export function restoreViewer(options: {
  readonly plist: string;
  readonly label: string;
  readonly from: string;
  readonly launchd?: Launchd;
}) {
  const job = readPlist(options.from);
  const bound = parseViewerJob(job, options.label);
  if (bound === null) throw new Error("the recorded plist is not an owned viewer job; refusing");
  if (existsSync(options.plist) && parseViewerJob(readPlist(options.plist), options.label) === null)
    throw new Error("the installed viewer job is not in the owned shape; refusing");
  writePlist(options.plist, job);
  const restarted = restartIfLoaded(options.launchd ?? launchctl, options.label, options.plist);
  return { viewer: "restored" as const, release: releaseOfRoot(bound.root), restarted };
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
  `${LAUNCHER_HEADER}${quote(join(release, "runtime/bun"))} --no-env-file --config=${quote(join(release, RELEASE_BUNFIG))} ${quote(join(release, "app/cli.js"))} "$@"\n`;

export function parseReleaseLauncher(text: string): string | null {
  if (!text.startsWith(LAUNCHER_HEADER)) return null;
  const match =
    /^'((?:[^']|'\\'')*)\/runtime\/bun' --no-env-file --config='((?:[^']|'\\'')*)\/app\/bunfig\.toml' '((?:[^']|'\\'')*)\/app\/cli\.js' "\$@"\n$/.exec(
      text.slice(LAUNCHER_HEADER.length)
    );
  if (match === null || match[1] !== match[2] || match[1] !== match[3]) return null;
  const release = match[1]!.replaceAll("'\\''", "'");
  return isAbsolute(release) && normalize(release) === release && releaseLauncher(release) === text
    ? release
    : null;
}

/** The running process of a loaded job, by its PID's own arguments. */
function jobProcess(label: string): string | null {
  const printed = run(["/bin/launchctl", "print", `gui/${uid()}/${label}`]);
  const pid = /^\s*pid = (\d+)$/m.exec(printed.stdout)?.[1];
  return pid === undefined ? null : run(["/bin/ps", "-o", "command=", "-p", pid]).stdout.trim();
}

/** Plugin versions each client has installed, read from their own records. */
export function clientPlugins(options: {
  readonly claudeHome: string;
  readonly codexHome: string;
}) {
  let claude: string[] | null = null;
  try {
    const installed = JSON.parse(
      readFileSync(join(options.claudeHome, "plugins/installed_plugins.json"), "utf8")
    );
    const entries = installed?.plugins?.["agent-bus@agent-bus"];
    claude = Array.isArray(entries)
      ? entries.map((entry: { version?: unknown }) => String(entry?.version))
      : [];
  } catch {
    claude = null;
  }
  let codex: string[] | null = null;
  try {
    codex = readdirSync(join(options.codexHome, "plugins/cache/agent-bus/agent-bus")).sort();
  } catch {
    codex = null;
  }
  return { claude, codex };
}

/**
 * The release each surface names, and whether they all agree. Configured
 * agreement says nothing about what already running sessions loaded.
 */
export function status(options: {
  readonly launcher: string;
  readonly marketplace: string;
  readonly label: string;
  readonly viewerLabel: string;
  readonly viewerPlist: string;
  readonly claudeHome: string;
  readonly codexHome: string;
}) {
  const launcher = readLauncher(options.launcher);
  let plugin: string | null = null;
  try {
    plugin = readlinkSync(join(options.marketplace, "plugin"));
  } catch {
    plugin = null;
  }
  const launcherRelease = launcher.kind === "release" ? basename(launcher.release) : null;
  const pluginRelease = plugin === null ? null : basename(dirname(plugin));
  const serve = jobProcess(options.label);
  const serveRelease =
    serve === null ? null : (/\/releases\/([^/ ]+)\/app\/cli\.js serve$/.exec(serve)?.[1] ?? null);
  let viewer: "absent" | "foreign" | "source" | "release" = "absent";
  let viewerRelease: string | null = null;
  if (existsSync(options.viewerPlist)) {
    const bound = parseViewerJob(readPlist(options.viewerPlist), options.viewerLabel);
    viewerRelease = bound === null ? null : releaseOfRoot(bound.root);
    viewer = bound === null ? "foreign" : viewerRelease === null ? "source" : "release";
  }
  const viewerProcess = viewer === "absent" ? null : jobProcess(options.viewerLabel);
  const viewerRunningRelease =
    viewerProcess === null
      ? null
      : (/\/releases\/([^/ ]+)\/app\/dist\/viewer\/main\.js$/.exec(viewerProcess)?.[1] ?? null);
  const clients = clientPlugins(options);
  const same = (value: string | null) => value === launcherRelease;
  return {
    launcher: launcher.kind,
    launcherRelease,
    pluginRelease,
    serveRunning: serve !== null,
    serveRelease,
    viewer,
    viewerRelease,
    viewerRunning: viewerProcess !== null,
    viewerRunningRelease,
    claudePlugin: clients.claude,
    codexPlugin: clients.codex,
    agree:
      launcherRelease !== null &&
      same(pluginRelease) &&
      (serve === null || same(serveRelease)) &&
      (viewer === "absent" || same(viewerRelease)) &&
      (viewerProcess === null || same(viewerRunningRelease)) &&
      (clients.claude === null || clients.claude.every(same)) &&
      (clients.codex === null || clients.codex.every(same)),
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
  const viewerLabel = () => named.get("--viewer-label") ?? VIEWER_LABEL;
  const viewerPlist = () =>
    named.get("--plist") ?? join(homedir(), "Library/LaunchAgents", `${viewerLabel()}.plist`);
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
    case "viewer": {
      const dir = positional[0];
      if (dir === undefined) throw new Error("viewer needs a release directory");
      const verdict = verify(dir, { expect: required("--expect"), bun: named.get("--bun") });
      if (!verdict.ok) {
        console.log(JSON.stringify({ viewer: "unchanged", problems: verdict.problems }));
        return 1;
      }
      console.log(
        JSON.stringify(
          rebindViewer({
            plist: viewerPlist(),
            label: viewerLabel(),
            release: dir,
            bindings: join(dirname(dirname(dir)), "bindings"),
          })
        )
      );
      return 0;
    }
    case "viewer-restore": {
      console.log(
        JSON.stringify(
          restoreViewer({ plist: viewerPlist(), label: viewerLabel(), from: required("--from") })
        )
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
            viewerLabel: viewerLabel(),
            viewerPlist: viewerPlist(),
            claudeHome: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
            codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          })
        )
      );
      return 0;
    }
    default:
      console.error(
        "usage: release.ts build|verify|plugin|viewer|viewer-restore|status (see the header of this file)"
      );
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
