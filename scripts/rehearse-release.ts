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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { flureeServer, ledgerOn, stopFlureeServer } from "../test/fluree-server.ts";
import { build, fileSha256, releaseCommands, removeOwned, sha256 } from "./release.ts";

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
/** The command line alone, to compare with the exact command a binding runs. */
const commandOf = (pid: string | null) =>
  pid === null || pid === "loaded"
    ? null
    : spawnSync("/bin/ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).stdout.trim();
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
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
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
  join(realHome, ".claude/plugins/installed_plugins.json"),
  join(realHome, ".claude/plugins/known_marketplaces.json"),
  join(realHome, ".codex/config.toml"),
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

/**
 * The real Claude and Codex plugin commands, in this home's own client
 * directories (decision 6, step 5). Skipped, and reported, when either client
 * is not installed. No step here needs a signed-in client.
 */
const claudeBin = Bun.which("claude");
const codexBin =
  Bun.which("codex") ??
  ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"].find(
    (path) => existsSync(path)
  ) ??
  null;
const clients = claudeBin !== null && codexBin !== null;
const claude = (...args: string[]) => run([claudeBin!, "plugin", ...args]).status === 0;
const codex = (...args: string[]) => run([codexBin!, "plugin", ...args, "--json"]).status === 0;
/** Adds the marketplace at `from` to both clients and installs the plugin. */
const addClients = (from: string) =>
  claude("marketplace", "add", from) &&
  claude("install", "agent-bus@agent-bus") &&
  codex("marketplace", "add", from) &&
  codex("add", "agent-bus@agent-bus");
/** Refreshes both clients after the marketplace link moved. */
const refreshClients = () =>
  claude("marketplace", "update", "agent-bus") &&
  claude("update", "agent-bus@agent-bus") &&
  codex("add", "agent-bus@agent-bus");
const removeClients = () =>
  claude("uninstall", "agent-bus@agent-bus") &&
  claude("marketplace", "remove", "agent-bus") &&
  codex("remove", "agent-bus@agent-bus") &&
  codex("marketplace", "remove", "agent-bus");

/**
 * Runs the Stop hook exactly as the Claude plugin installed in this home holds
 * it, for an address with unread mail: it must exit 2 and name the address.
 */
function installedClaudeHookWakes(who: { address: string; session: string }) {
  const installed = JSON.parse(
    readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8")
  ).plugins["agent-bus@agent-bus"][0];
  const manifest = JSON.parse(
    readFileSync(join(installed.installPath, ".claude-plugin/plugin.json"), "utf8")
  );
  const command: string = manifest.hooks.Stop[0].hooks[0].command;
  // A session's hooks inherit its environment. This one names the rehearsal bus: with
  // no port, the CLI's default is the production serve, which must never be reached.
  const ran = spawnSync("/bin/sh", ["-c", command], {
    cwd: root,
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      AGENT_BUS_DIR: busDir,
      AGENT_BUS_PORT: String(busPort),
    },
    input: JSON.stringify({ session_id: who.session, hook_event_name: "Stop" }),
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    version: String(installed.version),
    woke: ran.status === 2 && ran.stderr.includes(who.address),
  };
}
/**
 * A release's installer is run only as known code: its manifest is the recorded one and
 * the installer the regular file that manifest lists, checked here before it runs. Its
 * own `--expect` stays whatever the step passes, so a refusal is still the installer's.
 */
function knownInstaller(target: Built) {
  const manifest = join(target.dir, "manifest.json");
  if (fileSha256(manifest) !== target.digest)
    throw new Error(`${target.id}: its manifest is not the recorded one`);
  const listed = (
    JSON.parse(readFileSync(manifest, "utf8")).files as Array<{ path: string; sha256: string }>
  ).find((file) => file.path === "app/install-launch-agents.sh");
  const installer = join(target.dir, "app/install-launch-agents.sh");
  if (
    listed === undefined ||
    !lstatSync(installer).isFile() ||
    fileSha256(installer) !== listed.sha256
  )
    throw new Error(`${target.id}: its installer is not the one its manifest lists`);
  return installer;
}
const installRelease = (target: Built, expect = target.digest) =>
  run(["/bin/sh", knownInstaller(target), "--release", target.dir, "--expect", expect]);
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
    VIEWER,
    "--bindings",
    join(data, "bindings")
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
      viewerPlist,
      "--bindings",
      join(data, "bindings"),
      // The clients this rehearsal drives, or both excluded on purpose without them.
      ...(clients
        ? ["--claude", claudeBin!, "--codex", codexBin!]
        : ["--claude", "none", "--codex", "none"])
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

/**
 * Configuration, token and delivery identity as one digest: the store binding. Each file's own
 * entry (not a link's target), its inode, modification time and mode are in it with its bytes,
 * so a file replaced or rewritten with the same contents also counts as a change.
 */
const stateDigest = () =>
  sha256(
    ["config.json", "fluree-token", "installation-id"]
      .map((name) => {
        const path = join(busDir, name);
        const entry = lstatSync(path, { bigint: true });
        const kind = entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other";
        const mode = (entry.mode & 0o777n).toString(8);
        return `${name}:${kind}:${entry.ino}:${entry.mtimeNs}:${mode}:${fileSha256(path)}`;
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
  const exact = expected === "source" ? null : releaseCommands(join(releases, expected));
  const serve = commandOf(loadedPid(LABEL)) ?? "";
  check(
    `${step}: running serve is the bound code`,
    exact === null ? serve.endsWith(`${source}/src/bin.ts serve`) : serve === exact.serve
  );
  check(`${step}: store binding unchanged`, stateDigest() === facts.stateDigest);
  check(`${step}: viewer serves`, await healthy(`http://127.0.0.1:${viewerPort}/`));
  const viewerProcess = commandOf(loadedPid(VIEWER)) ?? "";
  check(
    `${step}: running viewer is the bound code`,
    exact === null
      ? viewerProcess.endsWith(`${source}/dist/viewer/main.js`)
      : viewerProcess === exact.viewer
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
        report.viewerRunningRelease === expected &&
        report.viewerStartPending === false
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
  facts.clients = clients ? "claude and codex" : "skipped: a client is not installed";
  facts.commitA = commitA;
  facts.commitB = commitB;
  preflight("setup");
  // Each client keeps its state under this home; Codex refuses a CODEX_HOME that does not exist.
  for (const dir of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) mkdirSync(dir, { recursive: true });

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
  // The delivery identity, initialized once as the first upgrade to stable delivery does it,
  // with the source's own command; no activation or rollback below may create or change it.
  if (
    run([bun, "--no-env-file", join(source, "src/bin.ts"), "initialize-installation"], {}, source)
      .status !== 0 ||
    !existsSync(join(busDir, "installation-id"))
  )
    throw new Error("could not initialize the installation identity");
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
  if (clients) check("A: both clients install the release plugin", addClients(marketplace));
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
  if (clients) check("split(ii): clients refreshed onto B", refreshClients());
  const splitPlugin = status(A);
  // A's own tool reports here, and an older tool's report may lack fields a newer one adds:
  // the client must be installed only at B and not reported disabled.
  const onlyAtB = (reported: unknown) => {
    const client = reported as { state?: unknown; versions?: unknown; enabled?: unknown };
    return (
      client?.state === "installed" &&
      JSON.stringify(client.versions) === JSON.stringify([B.id]) &&
      client.enabled !== false
    );
  };
  check(
    "split(ii): status names the plugin",
    splitPlugin.agree === false &&
      splitPlugin.pluginRelease === B.id &&
      splitPlugin.launcherRelease === A.id &&
      (!clients || (onlyAtB(splitPlugin.claudePlugin) && onlyAtB(splitPlugin.codexPlugin)))
  );
  check("split(ii): plugin A recovers", selectPlugin(A).status === 0);
  if (clients) check("split(ii): clients refreshed", refreshClients());
  await bound("split(ii) recovered", A.id, A);

  // 5. A → B.
  preflight("A to B");
  check("B: installed", installRelease(B).status === 0);
  check("B: viewer moved", moveViewer(B).status === 0);
  check("B: plugin selected", selectPlugin(B).status === 0);
  if (clients) check("B: clients refreshed", refreshClients());
  await bound("B", B.id, B);
  const m3 = publish(X, Y, "m3");
  if (clients) {
    const hook = installedClaudeHookWakes(Y);
    check("B: installed Claude hook is B's and wakes Y", hook.version === B.id && hook.woke);
  }
  const m4 = publish(Y, X, "m4");
  check("B: X reads only m4", same(await read(X), [m4]));

  // 6. B → A, downgrade order (decisions 16 and 20): plugin, viewer, launcher.
  preflight("B to A");
  check("B→A: plugin selected", selectPlugin(A).status === 0);
  if (clients) check("B→A: clients refreshed", refreshClients());
  check("B→A: viewer moved", moveViewer(A).status === 0);
  check("B→A: installed", installRelease(A).status === 0);
  await bound("B→A", A.id, A);
  check("B→A: X gets no redelivery", same(await read(X), []));
  check("B→A: Y gets exactly m2 and m3", same(await read(Y), [m2, m3]));
  const m5 = publish(X, Y, "m5");
  const m6 = publish(Y, X, "m6");
  check("B→A: X reads m6", same(await read(X), [m6]));

  // 7. A → source (decision 17), guidance first: the clients' marketplace returns to the
  // checkout by remove-and-add, the viewer is restored from its first record, then
  // the runtime-only rollback with A's installer.
  preflight("A to source");
  if (clients)
    check("A→source: clients back on the checkout", removeClients() && addClients(source));
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
        VIEWER,
        "--bindings",
        join(data, "bindings")
      ).status === 0
  );
  check(
    "A→source: runtime-only rollback",
    run(["/bin/sh", knownInstaller(A), "--runtime-only", "--bun", bun], {
      AGENT_BUS_REPO: source,
    }).status === 0
  );
  const atSource = await bound("A→source", "source", A);
  check(
    "A→source: status reads source",
    atSource.launcher === "source" && atSource.viewer === "source"
  );
  if (clients) {
    const hook = installedClaudeHookWakes(Y);
    check(
      "A→source: installed Claude hook is the checkout's and wakes Y",
      hook.version !== A.id && hook.version !== B.id && hook.woke
    );
    facts.sourcePluginVersion = hook.version;
  }
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
