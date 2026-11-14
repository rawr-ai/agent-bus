/**
 * Qualifies the release build of the current commit (docs/frames/release-packaging.md).
 * Never cached: it builds twice from the commit and runs the result.
 *
 * - Reproducible: two builds of one commit seal the same manifest digest.
 * - Lockfile, not worktree: a marker patched into the installed dependency of a
 *   disposable clone reaches a bundle of that clone (positive control) but not the
 *   release built from it. This checkout is only read: its installed dependency
 *   and status are the same afterwards.
 * - The runtime itself: the release's Bun is the builder's executable, byte for
 *   byte, and a relocated copy reports its own path as its executable.
 * - Self-contained: no bundle loads a module from outside itself, and no file
 *   names the build root, this checkout or the home directory.
 * - Native-only: the production install needs no private-host archive; neither
 *   release contains its package, metadata, entry or dependency files.
 * - Relocatable: a copy elsewhere, with the original gone, verifies against the
 *   original digest and reports its id under an empty environment from a decoy
 *   directory; the relocated viewer serves every asset byte for byte, and is gone
 *   once stopped.
 * - Isolated from the caller: a bunfig.toml whose preload a bare release run
 *   would load (positive control) does not reach a run through the launcher.
 *
 * Prints identities and booleans only. Exits non-zero when any check fails.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSupervised } from "../test/supervised.ts";
import {
  build,
  bundle,
  externalImports,
  fileSha256,
  type Manifest,
  releaseLauncher,
  removeOwned,
  sha256,
  verify,
} from "./release.ts";

const repo = resolve(import.meta.dir, "..");
const bun = realpathSync(process.execPath);
const checks: Record<string, boolean> = {};
const facts: Record<string, string | boolean> = {};
const check = (name: string, ok: boolean) => {
  checks[name] = ok;
};

const freePort = () => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

function filesUnder(root: string, at = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, at), { withFileTypes: true })) {
    const path = at === "" ? entry.name : `${at}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesUnder(root, path));
    else found.push(path);
  }
  return found.sort();
}

/** Runs a command to completion, or throws naming what it was for. */
function must(args: string[], what: string, cwd: string, env: Record<string, string>) {
  const result = spawnSync(args[0]!, args.slice(1), { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${what} failed`);
  return result.stdout;
}

/**
 * Replaces one installed dependency file with a marked copy by rename, never in place:
 * the installed file may share its inode or clone with Bun's cache.
 */
function markInstalled(path: string, marker: string) {
  const marked = `${path}.qualify-marked`;
  writeFileSync(
    marked,
    `${readFileSync(path, "utf8")}\n;globalThis.__agentBusQualify=${JSON.stringify(marker)};\n`
  );
  renameSync(marked, path);
}

const gitStatus = () =>
  spawnSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
  }).stdout;

const commit = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
const dirty = spawnSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"], {
  encoding: "utf8",
}).stdout.trim();
facts.commit = commit;
facts.worktreeClean = dirty === "";

// This checkout is only read; these are compared once the qualifier is done.
const realInstalled = join(repo, "node_modules/sparqljs/sparql.js");
const realBefore = {
  sha256: fileSha256(realInstalled),
  mtimeMs: statSync(realInstalled).mtimeMs,
  status: gitStatus(),
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-qualify-release-")));
let viewer: ReturnType<typeof spawnSupervised<"ignore", "ignore">> | null = null;
let viewerBase: string | null = null;
try {
  // 1. A disposable clone of the commit, with its own frozen install, whose installed
  //    sparqljs carries a marker. Build A from that clone.
  const clone = join(root, "clone");
  const cloneEnv = { HOME: join(root, "clone-home"), PATH: `${dirname(bun)}:/usr/bin:/bin` };
  mkdirSync(cloneEnv.HOME);
  must(
    ["git", "clone", "--quiet", "--local", "--no-checkout", repo, clone],
    "cloning",
    root,
    cloneEnv
  );
  must(
    ["git", "-C", clone, "checkout", "--quiet", "--detach", commit],
    "checking out",
    root,
    cloneEnv
  );
  const privateArchive = "dist/private-artifacts/mcp-openapi-1.2.0-events.2.tgz";
  check("cloneHasNoPrivateArchive", !existsSync(join(clone, privateArchive)));
  must(
    [bun, "install", "--production", "--frozen-lockfile", "--ignore-scripts"],
    "the clone's frozen install",
    clone,
    { ...cloneEnv, HOME: homedir() }
  );
  check("cloneHasNoPrivateHost", !existsSync(join(clone, "node_modules/mcp-openapi")));
  const marker = `agent-bus-qualify-${crypto.randomUUID()}`;
  markInstalled(join(clone, "node_modules/sparqljs/sparql.js"), marker);
  const probe = join(root, "clone-bundle.js");
  bundle({ src: clone, entry: "src/bin.ts", outfile: probe, bun });
  check("patchedCloneBundleCarriesMarker", readFileSync(probe, "utf8").includes(marker));
  const a = build({ repo: clone, commit, bun, out: join(root, "out-a") });
  check(
    "releaseIgnoresWorktreeDependencies",
    !readFileSync(join(a.dir, "app/cli.js"), "utf8").includes(marker)
  );

  // 2. Build B from the same commit, unpatched: the same seal.
  const b = build({ repo, commit, bun, out: join(root, "out-b") });
  facts.id = a.id;
  facts.manifestSha256 = a.manifestSha256;
  check("twoBuildsSealOneDigest", a.id === b.id && a.manifestSha256 === b.manifestSha256);
  check(
    "bothBuildsVerify",
    verify(a.dir, { expect: a.manifestSha256, bun }).ok &&
      verify(b.dir, { expect: b.manifestSha256, bun }).ok
  );

  // The private peer is a separate review artifact, not a native release dependency or payload.
  const privateMarkers = [
    privateArchive,
    "mcp-openapi-1.2.0-events.2.tgz",
    "mcp-openapi",
    "agent-bus-private-peer-review-v1",
    "agent-bus-mail-wake-v1",
    "6c6091e6a97d0e75ecf0ec9e03fa4901cc985b2e0d76c6aab52ed3ca1ac82c25",
    "d7fdd22e950dfc1c43a5e756692d4306910711a9f3a6187b56fcbcc2fda7041b",
  ];
  const privatePath = (path: string) =>
    path
      .split("/")
      .some(
        (part) =>
          [
            "node_modules",
            "private-artifacts",
            "package.json",
            "package-lock.json",
            "bun.lock",
            "bun.lockb",
            "yarn.lock",
            "mcp-host.mjs",
            "release-manifest.json",
          ].includes(part) ||
          part.includes("mcp-openapi") ||
          part.endsWith(".tgz")
      );
  for (const [label, built] of [
    ["A", a],
    ["B", b],
  ] as const) {
    const inventory = filesUnder(built.dir);
    const manifest = JSON.parse(readFileSync(join(built.dir, "manifest.json"), "utf8")) as Manifest;
    check(
      `noPrivatePathsInManifest:${label}`,
      manifest.files.every(({ path }) => !privatePath(path))
    );
    check(
      `noPrivatePathsInInventory:${label}`,
      inventory.every((path) => !privatePath(path))
    );
    check(
      `noPrivateHostMetadata:${label}`,
      inventory
        .filter((path) => path !== "runtime/bun")
        .every((path) => {
          const body = readFileSync(join(built.dir, path), "latin1");
          return privateMarkers.every((marker) => !body.includes(marker));
        })
    );
  }

  // 3. Static scans of what a release runs and ships.
  for (const bundled of ["app/cli.js", "app/release.js", "app/dist/viewer/main.js"])
    check(
      `noExternalImports:${bundled}`,
      externalImports(readFileSync(join(a.dir, bundled), "utf8")).length === 0
    );
  const forbidden = [repo, homedir(), realpathSync(tmpdir()), root].filter(
    (path) => path.length > 1
  );
  const leaks = filesUnder(a.dir)
    .filter((path) => path !== "runtime/bun")
    .filter((path) => {
      const text = readFileSync(join(a.dir, path), "latin1");
      return forbidden.some((needle) => text.includes(needle));
    });
  check("namesNoBuildCheckoutOrHomePath", leaks.length === 0);
  if (leaks.length > 0) facts.leakingFiles = leaks.join(",");

  // 4. Relocate A by an operator's copy, then remove every original.
  const moved = join(root, "elsewhere/releases");
  mkdirSync(moved, { recursive: true });
  check("copied", spawnSync("/bin/cp", ["-Rp", a.dir, moved]).status === 0);
  removeOwned(join(root, "out-a"));
  removeOwned(join(root, "out-b"));
  const rel = join(moved, a.id);
  check("relocatedVerifies", verify(rel, { expect: a.manifestSha256, bun }).ok);
  check("releaseBunIsTheBuilderBun", fileSha256(join(rel, "runtime/bun")) === fileSha256(bun));

  // A decoy caller directory: a dotenv, and a bunfig that preloads a marker writer.
  const decoy = join(root, "decoy");
  const home = join(root, "home");
  mkdirSync(decoy);
  mkdirSync(home);
  const preloadMark = join(root, "bunfig-preloaded");
  writeFileSync(join(decoy, ".env"), "AGENT_BUS_RELEASE_PROBE=dotenv\n");
  writeFileSync(join(decoy, "bunfig.toml"), 'preload = ["./preload.js"]\n');
  writeFileSync(
    join(decoy, "preload.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(preloadMark)}, "1");\n`
  );
  const empty = { HOME: home, PATH: "/usr/bin:/bin" };
  const ownPath = spawnSync(
    join(rel, "runtime/bun"),
    ["--no-env-file", "--config=/dev/null", "-e", "process.stdout.write(process.execPath)"],
    { cwd: decoy, env: empty, encoding: "utf8", timeout: 20_000 }
  );
  check(
    "relocatedRuntimeReportsItsOwnPath",
    ownPath.status === 0 && ownPath.stdout === join(rel, "runtime/bun")
  );
  const runIn = (args: string[]) =>
    spawnSync(args[0]!, args.slice(1), {
      cwd: decoy,
      env: empty,
      encoding: "utf8",
      timeout: 20_000,
    });

  // Control: without an explicit config, the release's Bun loads the decoy's preload.
  runIn([join(rel, "runtime/bun"), "--no-env-file", join(rel, "app/cli.js"), "--version"]);
  check("bareRunLoadsCallerBunfig", existsSync(preloadMark));
  if (existsSync(preloadMark)) unlinkSync(preloadMark);

  // The launcher activation writes for this release, run from the decoy.
  const launcher = join(root, "agent-bus");
  writeFileSync(launcher, releaseLauncher(rel), { mode: 0o755 });
  const version = runIn([launcher, "--version"]);
  check(
    "relocatedLauncherReportsItsId",
    version.status === 0 && version.stdout.trim() === `agent-bus v${a.id}`
  );
  check("launcherIgnoresCallerBunfig", !existsSync(preloadMark));

  // A first install or upgrade initializes the identity a release's serve routes delivery by,
  // from the release alone: created once, private, never printed, and kept by a rerun.
  const state = join(root, "state");
  const identity = join(state, "installation-id");
  const initialize = () =>
    spawnSync(launcher, ["initialize-installation"], {
      cwd: decoy,
      env: { ...empty, AGENT_BUS_DIR: state },
      encoding: "utf8",
      timeout: 20_000,
    });
  const first = initialize();
  const created = existsSync(identity) ? readFileSync(identity, "utf8") : "";
  const rerun = initialize();
  check(
    "relocatedLauncherInitializesInstallation",
    first.status === 0 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/.test(created) &&
      (statSync(identity).mode & 0o777) === 0o600 &&
      !`${first.stdout}${first.stderr}`.includes(created.trim()) &&
      rerun.status === 0 &&
      readFileSync(identity, "utf8") === created
  );

  // 5. The relocated viewer, from its own app directory, serves every asset as shipped.
  const viewerPort = freePort();
  viewer = spawnSupervised(
    [join(rel, "runtime/bun"), "--no-env-file", join(rel, "app/dist/viewer/main.js")],
    {
      cwd: join(rel, "app"),
      env: {
        ...empty,
        AGENT_BUS_VIEWER_PORT: String(viewerPort),
        AGENT_BUS_PORT: String(freePort()),
      },
      stdout: "ignore",
      stderr: "ignore",
    }
  );
  const base = `http://127.0.0.1:${viewerPort}`;
  viewerBase = base;
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt++) {
    up = await fetch(`${base}/`).then(
      (response) => response.ok,
      () => false
    );
    if (!up) await Bun.sleep(100);
  }
  check("relocatedViewerServesRoot", up);
  const publicDir = join(rel, "app/dist/viewer/public");
  const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.json"), "utf8")) as Array<{
    path: string;
    file: string;
  }>;
  let assetsEqual = manifest.length > 0;
  for (const entry of manifest) {
    const served = await fetch(`${base}${entry.path}`).then(
      async (response) => (response.ok ? new Uint8Array(await response.arrayBuffer()) : null),
      () => null
    );
    if (served === null || sha256(served) !== fileSha256(join(publicDir, entry.file)))
      assetsEqual = false;
  }
  facts.viewerAssets = String(manifest.length);
  check("relocatedViewerServesEveryAssetByteEqual", assetsEqual);
  check("releaseStillReadOnly", (statSync(join(rel, "app")).mode & 0o777) === 0o555);
} catch (error) {
  check("completed", false);
  // The first line only, with local paths named rather than printed.
  let message = error instanceof Error ? error.message.split("\n")[0]! : "unknown";
  for (const [path, name] of [
    [root, "<scratch>"],
    [repo, "<checkout>"],
    [homedir(), "<home>"],
  ] as const)
    message = message.replaceAll(path, name);
  facts.error = message;
} finally {
  if (viewer !== null) {
    viewer.kill();
    await viewer.exited;
    const answers = await fetch(`${viewerBase}/`).then(
      () => true,
      () => false
    );
    check("noViewerLeftAfterStop", !answers);
  }
  removeOwned(root);
}
check(
  "thisCheckoutUntouched",
  fileSha256(realInstalled) === realBefore.sha256 &&
    statSync(realInstalled).mtimeMs === realBefore.mtimeMs &&
    gitStatus() === realBefore.status
);

const ok = Object.values(checks).every(Boolean) && checks.completed !== false;
console.log(JSON.stringify({ ok, ...facts, checks }, null, 2));
process.exit(ok ? 0 : 1);
