/**
 * Qualifies the release build of the current commit (docs/frames/release-packaging.md).
 * Never cached: it builds twice from the commit and runs the result.
 *
 * - Reproducible: two builds of one commit seal the same manifest digest.
 * - Lockfile, not worktree: a marker patched into this worktree's installed
 *   dependency reaches a worktree bundle (positive control) but not the release.
 * - Self-contained: no bundle loads a module from outside itself, and no file
 *   names the build root, this checkout or the home directory.
 * - Relocatable: a copy elsewhere, with the original gone, verifies against the
 *   original digest and reports its id under an empty environment from a decoy
 *   directory; the relocated viewer serves every asset byte for byte.
 * - Isolated from the caller: a bunfig.toml whose preload a bare release run
 *   would load (positive control) does not reach a run through the launcher.
 *
 * Prints identities and booleans only. Exits non-zero when any check fails.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
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
import { join, resolve } from "node:path";
import {
  build,
  bundle,
  externalImports,
  fileSha256,
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

/**
 * Replaces one installed dependency file with a marked copy by rename, never in
 * place: the installed file may share its inode with Bun's cache. Returns the
 * restore step, which renames the untouched original back.
 */
function patchInstalled(path: string, marker: string) {
  const before = fileSha256(path);
  const aside = `${path}.qualify-original`;
  const marked = `${path}.qualify-marked`;
  if (existsSync(aside) || existsSync(marked)) throw new Error(`${path} has a leftover patch`);
  writeFileSync(
    marked,
    `${readFileSync(path, "utf8")}\n;globalThis.__agentBusQualify=${JSON.stringify(marker)};\n`
  );
  linkSync(path, aside);
  renameSync(marked, path);
  return () => {
    renameSync(aside, path);
    return fileSha256(path) === before;
  };
}

const commit = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
const dirty = spawnSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"], {
  encoding: "utf8",
}).stdout.trim();
facts.commit = commit;
facts.worktreeClean = dirty === "";

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-qualify-release-")));
let viewer: ReturnType<typeof Bun.spawn> | null = null;
let restore: (() => boolean) | null = null;
try {
  // 1. Build A while this worktree's installed sparqljs carries a marker.
  const marker = `agent-bus-qualify-${crypto.randomUUID()}`;
  const installed = join(repo, "node_modules/sparqljs/sparql.js");
  restore = patchInstalled(installed, marker);
  let restored = false;
  let a: ReturnType<typeof build>;
  try {
    const probe = join(root, "worktree-bundle.js");
    bundle({ src: repo, entry: "src/bin.ts", outfile: probe, bun });
    check("patchedWorktreeBundleCarriesMarker", readFileSync(probe, "utf8").includes(marker));
    a = build({ repo, commit, bun, out: join(root, "out-a") });
  } finally {
    restored = restore();
    restore = null;
  }
  check("installedDependencyRestored", restored);
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

  // 5. The relocated viewer, from its own app directory, serves every asset as shipped.
  const viewerPort = freePort();
  viewer = Bun.spawn(
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
  if (restore !== null) check("installedDependencyRestored", restore());
  if (viewer !== null) {
    viewer.kill();
    await viewer.exited;
  }
  removeOwned(root);
}

const ok = Object.values(checks).every(Boolean) && checks.completed !== false;
console.log(JSON.stringify({ ok, ...facts, checks }, null, 2));
process.exit(ok ? 0 : 1);
