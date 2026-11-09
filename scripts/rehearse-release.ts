/**
 * Rehearses activation and rollback of real releases under real launchd
 * (docs/frames/release-packaging.md, qualification): source → A → B → A → source,
 * with a disposable `serve` and viewer job, an authenticated throwaway Fluree,
 * mail sentinels, a refused tampered release, both split-binding injections with
 * their recovery, and a guarded stop.
 *
 *   bun run rehearse:release [--a <commit>] [--b <commit>] [--list]
 *
 * A defaults to HEAD~1 and B to HEAD; both must contain the release mechanism.
 * Everything lives under one temporary home: the launcher, data home, releases,
 * bus directory, LaunchAgent plists and marketplace. Jobs use fixed disposable
 * labels (so launchd's per-label override record never accumulates) and free
 * ports. A preflight before every step refuses default or production labels,
 * ports, launcher and data paths. It prints identities and booleans only, and
 * exits non-zero when any check fails. Never cached and not part of `bun test`.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { flureeServer, ledgerOn, stopFlureeServer } from "../test/fluree-server.ts";
import { build, fileSha256, removeOwned, sha256 } from "./release.ts";

const repo = resolve(import.meta.dir, "..");
const bun = realpathSync(process.execPath);
const LABEL = "test.agent-bus-rehearsal";
const VIEWER = `${LABEL}.viewer`;
const domain = `gui/${process.getuid?.() ?? 0}`;
const checks: Array<[string, boolean]> = [];
const facts: Record<string, unknown> = {};
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  return ok;
};

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const git = (...args: string[]) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout.trim();
const commitA = git("rev-parse", "--verify", `${arg("--a") ?? "HEAD~1"}^{commit}`);
const commitB = git("rev-parse", "--verify", `${arg("--b") ?? "HEAD"}^{commit}`);

const freePort = () => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};
const launchctl = (...args: string[]) =>
  spawnSync("/bin/launchctl", args, { encoding: "utf8" }).status ?? -1;
const loadedPid = (label: string) => {
  const printed = spawnSync("/bin/launchctl", ["print", `${domain}/${label}`], {
    encoding: "utf8",
  });
  if (printed.status !== 0) return null;
  return /^\s*pid = (\d+)$/m.exec(printed.stdout)?.[1] ?? "loaded";
};
const processOf = (pid: string | null) =>
  pid === null || pid === "loaded"
    ? null
    : spawnSync("/bin/ps", ["-o", "lstart=,command=", "-p", pid], {
        encoding: "utf8",
      }).stdout.trim();

// ---------------------------------------------------------------------------
// the disposable world

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-rehearsal-")));
const home = join(root, "home");
const data = join(home, ".local/share/agent-bus");
const releases = join(data, "releases");
const marketplace = join(data, "marketplace");
const launcher = join(home, ".local/bin/agent-bus");
const agents = join(home, "Library/LaunchAgents");
const busDir = join(home, ".agent-bus");
const servePlist = join(agents, `${LABEL}.plist`);
const viewerPlist = join(agents, `${VIEWER}.plist`);
const source = join(root, "source");
const busPort = freePort();
const viewerPort = freePort();
const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const env = {
  HOME: home,
  PATH,
  AGENT_BUS_DIR: busDir,
  AGENT_BUS_PORT: String(busPort),
  AGENT_BUS_LABEL: LABEL,
  AGENT_BUS_LAUNCHER: launcher,
  AGENT_BUS_RELEASES: releases,
};

/** The live surfaces the rehearsal must never name or change. */
const realHome = homedir();
const productionPorts = new Set([8095, 8096, 4317, 48_096]);
try {
  const plist = join(realHome, "Library/LaunchAgents/ai.rawr.agent-bus.plist");
  const port = /<key>AGENT_BUS_PORT<\/key>\s*<string>(\d+)<\/string>/.exec(
    readFileSync(plist, "utf8")
  )?.[1];
  if (port !== undefined) productionPorts.add(Number(port));
} catch {}
const liveFiles = [
  join(realHome, ".local/bin/agent-bus"),
  join(realHome, "Library/LaunchAgents/ai.rawr.agent-bus.plist"),
  join(realHome, "Library/LaunchAgents/ai.rawr.agent-bus.viewer.plist"),
];
const liveDigest = () =>
  liveFiles.map((path) => (existsSync(path) ? fileSha256(path) : "absent")).join(",");
const liveBefore = liveDigest();

function preflight(step: string) {
  const problems = [
    !LABEL.startsWith("test.") && "label",
    (productionPorts.has(busPort) || productionPorts.has(viewerPort)) && "port",
    !launcher.startsWith(`${root}/`) && "launcher",
    !data.startsWith(`${root}/`) && "data home",
    !busDir.startsWith(`${root}/`) && "bus directory",
    home === realHome && "home",
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`preflight refused ${step}: ${problems.join(", ")}`);
}

function run(args: string[], extra: Record<string, string> = {}, cwd = root) {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The release tool of one release, run as an operator runs it. */
const tool = (release: string, ...args: string[]) =>
  run([
    join(release, "runtime/bun"),
    "--no-env-file",
    `--config=${join(release, "app/bunfig.toml")}`,
    join(release, "app/release.js"),
    ...args,
  ]);

type Built = { id: string; dir: string; digest: string };
const installRelease = (target: Built, expect = target.digest) =>
  run([
    "/bin/sh",
    join(target.dir, "app/install-launch-agents.sh"),
    "--release",
    target.dir,
    "--expect",
    expect,
  ]);
const selectPlugin = (target: Built) =>
  tool(target.dir, "plugin", target.dir, "--expect", target.digest, "--marketplace", marketplace);
const moveViewer = (target: Built) =>
  tool(
    target.dir,
    "viewer",
    target.dir,
    "--expect",
    target.digest,
    "--plist",
    viewerPlist,
    "--viewer-label",
    VIEWER
  );
const status = (via: Built) =>
  JSON.parse(
    tool(
      via.dir,
      "status",
      "--launcher",
      launcher,
      "--marketplace",
      marketplace,
      "--label",
      LABEL,
      "--viewer-label",
      VIEWER,
      "--plist",
      viewerPlist
    ).stdout
  ) as Record<string, unknown>;

async function healthy(url: string, tries = 150) {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (
      await fetch(url).then(
        (response) => response.ok,
        () => false
      )
    )
      return true;
    await Bun.sleep(200);
  }
  return false;
}

async function mcp<T>(use: (client: Client) => Promise<T>) {
  const client = new Client({ name: "release-rehearsal", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${busPort}/mcp`))
  );
  try {
    return await use(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const X = { address: "claude/rehearsal-x", session: "s-rehearsal-x" };
const Y = { address: "claude/rehearsal-y", session: "s-rehearsal-y" };
const cli = (...args: string[]) => run([launcher, ...args], {}, busDir);
function publish(from: typeof X, to: typeof X, body: string) {
  const sent = cli(
    "publish",
    "--from",
    from.address,
    "--to",
    to.address,
    "--body",
    body,
    "--session",
    from.session
  );
  if (sent.status !== 0) throw new Error(`publish ${body} failed`);
  return sent.stdout.trim();
}
const read = (who: typeof X) =>
  mcp(async (client) => {
    const result = await client.callTool({ name: "bus_read", arguments: { ...who } });
    return ((result.structuredContent as { messages?: Array<{ id: string }> })?.messages ?? [])
      .map((message) => message.id)
      .sort();
  });
const same = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Configuration, token and their modes, as one digest: the store binding. */
const stateDigest = () =>
  sha256(
    ["config.json", "fluree-token"]
      .map((name) => {
        const path = join(busDir, name);
        return `${name}:${fileSha256(path)}:${(statSync(path).mode & 0o777).toString(8)}`;
      })
      .join("\n")
  );

/** The checks every bound state must pass. `expected` is a release id or "source". */
async function bound(step: string, expected: string, viaTool: Built) {
  check(`${step}: serve healthy`, await healthy(`http://127.0.0.1:${busPort}/health`));
  const version = cli("--version").stdout.trim();
  check(
    `${step}: launcher reports ${expected === "source" ? "source" : "release"}`,
    expected === "source" ? version.endsWith("+source") : version === `agent-bus v${expected}`
  );
  const serve = processOf(loadedPid(LABEL)) ?? "";
  check(
    `${step}: running serve is the bound code`,
    expected === "source"
      ? serve.includes(`${source}/src/bin.ts serve`)
      : serve.includes(`${releases}/${expected}/runtime/bun `) &&
          serve.endsWith(`${releases}/${expected}/app/cli.js serve`)
  );
  check(`${step}: store binding unchanged`, stateDigest() === facts.stateDigest);
  check(`${step}: viewer serves`, await healthy(`http://127.0.0.1:${viewerPort}/`));
  const viewerProcess = processOf(loadedPid(VIEWER)) ?? "";
  check(
    `${step}: running viewer is the bound code`,
    expected === "source"
      ? viewerProcess.endsWith(`${source}/dist/viewer/main.js`)
      : viewerProcess.endsWith(`${releases}/${expected}/app/dist/viewer/main.js`)
  );
  await mcp(async (client) => {
    const listing = await client.callTool({ name: "bus_queries", arguments: {} });
    const head = (listing.structuredContent as { headT?: unknown } | undefined)?.headT;
    const pinned = await client.callTool({
      name: "bus_query",
      arguments: { query: "SELECT ?id WHERE { ?m a bus:Message ; bus:id ?id } LIMIT 1", t: head },
    });
    check(
      `${step}: pinned query answers`,
      pinned.isError !== true && (pinned.structuredContent as { t?: unknown })?.t === head
    );
    const service = await client.callTool({
      name: "bus_query",
      arguments: { query: "SELECT * WHERE { SERVICE <urn:example> { ?s ?p ?o } }" },
    });
    check(`${step}: SERVICE refused`, service.isError === true);
  });
  const report = status(viaTool);
  if (expected !== "source")
    check(
      `${step}: status agrees on ${expected}`,
      report.agree === true &&
        report.launcherRelease === expected &&
        report.serveRelease === expected &&
        report.viewerRunningRelease === expected
    );
  return report;
}

/** Launcher, plists, marketplace link and the running serve, to compare across a refusal. */
const surfaces = () => {
  const linkTarget = spawnSync("/usr/bin/readlink", [join(marketplace, "plugin")], {
    encoding: "utf8",
  }).stdout;
  return JSON.stringify([
    fileSha256(launcher),
    fileSha256(servePlist),
    fileSha256(viewerPlist),
    linkTarget,
    processOf(loadedPid(LABEL)),
    processOf(loadedPid(VIEWER)),
  ]);
};

function writeViewerJob() {
  const job = {
    Label: VIEWER,
    ProgramArguments: [
      "/usr/bin/env",
      "-i",
      `HOME=${home}`,
      `PATH=${PATH}`,
      `AGENT_BUS_VIEWER_PORT=${viewerPort}`,
      `AGENT_BUS_PORT=${busPort}`,
      bun,
      "--no-env-file",
      `${source}/dist/viewer/main.js`,
    ],
    WorkingDirectory: source,
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    Umask: 63,
    StandardOutPath: join(root, "viewer.log"),
    StandardErrorPath: join(root, "viewer.log"),
  };
  writeFileSync(viewerPlist, JSON.stringify(job));
  if (spawnSync("/usr/bin/plutil", ["-convert", "xml1", viewerPlist]).status !== 0)
    throw new Error("could not write the viewer job");
  if (launchctl("bootstrap", domain, viewerPlist) !== 0) throw new Error("viewer did not load");
}

// ---------------------------------------------------------------------------

try {
  for (const label of [LABEL, VIEWER])
    if (loadedPid(label) !== null)
      throw new Error(`${label} is already loaded; finish or boot out the previous rehearsal`);
  facts.commitA = commitA;
  facts.commitB = commitB;
  preflight("setup");

  // The source binding: a checkout of B with a frozen install and a built viewer.
  mkdirSync(source);
  const archive = join(root, "source.tar");
  if (
    spawnSync("git", ["-C", repo, "archive", "--format=tar", "-o", archive, commitB]).status !== 0
  )
    throw new Error("could not export the source");
  spawnSync("/usr/bin/tar", ["-xf", archive, "-C", source]);
  // The real home only for Bun's package cache, as a build uses it.
  for (const step of [
    [bun, "install", "--frozen-lockfile", "--ignore-scripts"],
    [bun, "--no-env-file", "scripts/build-viewer.ts"],
  ])
    if (run(step, { HOME: realHome, PATH: `${resolve(bun, "..")}:${PATH}` }, source).status !== 0)
      throw new Error(`source setup failed: ${step[1]}`);

  // Two releases, built as an operator builds them.
  const built = (commit: string): Built => {
    const release = build({ repo, commit, bun, out: releases });
    return { id: release.id, dir: release.dir, digest: release.manifestSha256 };
  };
  const A = built(commitA);
  const B = built(commitB);
  facts.releaseA = A.id;
  facts.releaseB = B.id;

  // The bus store: an authenticated throwaway ledger.
  const ledger = ledgerOn(await flureeServer(), "rehearsal");
  mkdirSync(busDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(busDir, "config.json"),
    JSON.stringify({ fluree: { url: ledger.url, ledger: ledger.ledger } })
  );
  writeFileSync(join(busDir, "fluree-token"), `${ledger.token}\n`, { mode: 0o600 });
  facts.stateDigest = stateDigest();

  // 0. Source, as deployed today: launcher v1 and serve, and the viewer from the checkout.
  preflight("source install");
  check(
    "source: installed",
    run(
      ["/bin/sh", join(source, "scripts/install-launch-agents.sh"), "--runtime-only", "--bun", bun],
      {
        AGENT_BUS_REPO: source,
      }
    ).status === 0
  );
  mkdirSync(agents, { recursive: true });
  writeViewerJob();
  for (const who of [X, Y])
    check(
      `source: ${who.address} joined`,
      cli("join", "--address", who.address, "--runtime", "claude", "--session", who.session)
        .status === 0
    );
  await bound("source", "source", A);

  // 1. A refused before anything moves: an unanchored release, and a tampered one.
  preflight("refusals");
  const before = surfaces();
  check("refusal: unanchored A refused", installRelease(A, B.digest).status !== 0);
  // One appended byte in A's CLI, with every mode put back: only the content differs.
  const cliA = join(A.dir, "app/cli.js");
  const original = readFileSync(cliA);
  const rewrite = (bytes: Uint8Array) => {
    chmodSync(join(A.dir, "app"), 0o755);
    chmodSync(cliA, 0o644);
    writeFileSync(cliA, bytes);
    chmodSync(cliA, 0o444);
    chmodSync(join(A.dir, "app"), 0o555);
  };
  rewrite(Buffer.concat([original, Buffer.from("\n")]));
  check("refusal: tampered A refused", installRelease(A).status !== 0);
  rewrite(original);
  check("refusal: nothing moved", surfaces() === before);
  check(
    "refusal: A verifies again once restored",
    tool(A.dir, "verify", A.dir, "--expect", A.digest).status === 0
  );

  // 2. source → A (decision 6): launcher and serve, checks, viewer, plugin.
  preflight("source to A");
  check("A: installed", installRelease(A).status === 0);
  check("A: viewer moved", moveViewer(A).status === 0);
  check("A: plugin selected", selectPlugin(A).status === 0);
  await bound("A", A.id, A);
  const m1 = publish(Y, X, "m1");
  const m2 = publish(X, Y, "m2");
  check("A: X reads m1", same(await read(X), [m1]));

  // 3. Split binding (i): launcher at B, everything else at A, then recovery by
  // re-running --release for the previous release (decision 20).
  preflight("split launcher");
  check("split(i): launcher at B", installRelease(B).status === 0);
  const splitLauncher = status(B);
  check(
    "split(i): status names the launcher",
    splitLauncher.agree === false &&
      splitLauncher.launcherRelease === B.id &&
      splitLauncher.pluginRelease === A.id
  );
  check("split(i): --release A recovers", installRelease(A).status === 0);
  await bound("split(i) recovered", A.id, A);

  // 4. Split binding (ii): marketplace at B, the rest at A, recovered by re-running the step.
  preflight("split marketplace");
  check("split(ii): plugin at B", selectPlugin(B).status === 0);
  const splitPlugin = status(A);
  check(
    "split(ii): status names the plugin",
    splitPlugin.agree === false &&
      splitPlugin.pluginRelease === B.id &&
      splitPlugin.launcherRelease === A.id
  );
  check("split(ii): plugin A recovers", selectPlugin(A).status === 0);
  await bound("split(ii) recovered", A.id, A);

  // 5. A → B.
  preflight("A to B");
  check("B: installed", installRelease(B).status === 0);
  check("B: viewer moved", moveViewer(B).status === 0);
  check("B: plugin selected", selectPlugin(B).status === 0);
  await bound("B", B.id, B);
  const m3 = publish(X, Y, "m3");
  const m4 = publish(Y, X, "m4");
  check("B: X reads only m4", same(await read(X), [m4]));

  // 6. B → A, downgrade order (decisions 16 and 20): plugin, viewer, launcher.
  preflight("B to A");
  check("B→A: plugin selected", selectPlugin(A).status === 0);
  check("B→A: viewer moved", moveViewer(A).status === 0);
  check("B→A: installed", installRelease(A).status === 0);
  await bound("B→A", A.id, A);
  check("B→A: X gets no redelivery", same(await read(X), []));
  check("B→A: Y gets exactly m2 and m3", same(await read(Y), [m2, m3]));
  const m5 = publish(X, Y, "m5");
  const m6 = publish(Y, X, "m6");
  check("B→A: X reads m6", same(await read(X), [m6]));

  // 7. A → source (decision 17): viewer restored from its first record, then the
  // runtime-only rollback with A's installer. The marketplace returns through the
  // clients' own remove-and-add, which the real-client rehearsal covers.
  preflight("A to source");
  const records = readdirSync(join(data, "bindings"))
    .filter((name) => name.startsWith("viewer."))
    .sort();
  check(
    "A→source: viewer restored",
    records.length > 0 &&
      tool(
        A.dir,
        "viewer-restore",
        "--from",
        join(data, "bindings", records[0]!),
        "--plist",
        viewerPlist,
        "--viewer-label",
        VIEWER
      ).status === 0
  );
  check(
    "A→source: runtime-only rollback",
    run(["/bin/sh", join(A.dir, "app/install-launch-agents.sh"), "--runtime-only", "--bun", bun], {
      AGENT_BUS_REPO: source,
    }).status === 0
  );
  const atSource = await bound("A→source", "source", A);
  check(
    "A→source: status reads source",
    atSource.launcher === "source" && atSource.viewer === "source"
  );
  check("A→source: X gets no redelivery", same(await read(X), []));
  check("A→source: Y gets exactly m5", same(await read(Y), [m5]));

  // 8. Guarded stop (decision 20): disabled and booted out, it stays down, refuses a
  // bootstrap while disabled, and returns only after enable then bootstrap.
  preflight("guarded stop");
  for (const [label, plist] of [
    [LABEL, servePlist],
    [VIEWER, viewerPlist],
  ] as const) {
    check(`stop ${label}: disabled`, launchctl("disable", `${domain}/${label}`) === 0);
    check(`stop ${label}: booted out`, launchctl("bootout", `${domain}/${label}`) === 0);
    await Bun.sleep(1_500);
    check(`stop ${label}: not running`, loadedPid(label) === null);
    check(
      `stop ${label}: bootstrap refused while disabled`,
      launchctl("bootstrap", domain, plist) !== 0
    );
    check(`stop ${label}: still not running`, loadedPid(label) === null);
  }
  check("stop: serve does not answer", !(await healthy(`http://127.0.0.1:${busPort}/health`, 5)));
  for (const [label, plist] of [
    [LABEL, servePlist],
    [VIEWER, viewerPlist],
  ] as const) {
    check(`resume ${label}: enabled`, launchctl("enable", `${domain}/${label}`) === 0);
    check(`resume ${label}: bootstrapped`, launchctl("bootstrap", domain, plist) === 0);
  }
  await bound("resumed", "source", A);
} catch (error) {
  let message = error instanceof Error ? error.message.split("\n")[0]! : "unknown";
  for (const [path, name] of [
    [root, "<rehearsal>"],
    [repo, "<checkout>"],
    [realHome, "<home>"],
  ] as const)
    message = message.replaceAll(path, name);
  check("completed", false);
  facts.error = message;
} finally {
  for (const label of [LABEL, VIEWER]) {
    launchctl("enable", `${domain}/${label}`);
    launchctl("bootout", `${domain}/${label}`);
  }
  for (
    let attempt = 0;
    attempt < 50 && [LABEL, VIEWER].some((label) => loadedPid(label) !== null);
    attempt++
  )
    await Bun.sleep(200);
  check(
    "cleanup: disposable jobs gone",
    [LABEL, VIEWER].every((label) => loadedPid(label) === null)
  );
  await stopFlureeServer();
  removeOwned(root);
  check("cleanup: rehearsal home removed", !existsSync(root));
  check("live launcher and LaunchAgents untouched", liveDigest() === liveBefore);
}

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
const { stateDigest: _, ...shown } = facts;
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0,
      ...shown,
      checks: process.argv.includes("--list") ? Object.fromEntries(checks) : checks.length,
      failed,
    },
    null,
    2
  )
);
process.exit(failed.length === 0 ? 0 : 1);
