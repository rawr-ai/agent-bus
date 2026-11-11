/**
 * The release bundle behaves as the source does (docs/frames/release-packaging.md):
 * a bundled `serve` beside a source `serve` on one throwaway authenticated ledger,
 * both run under a clean environment in a decoy directory, and the bundled CLI
 * and hooks used end to end. The bundle runs from a relocated copy with its
 * staging directory gone.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
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
import { bundle, externalImports, removeOwned } from "../scripts/release.ts";
import { VERSION } from "../src/version.ts";
import { flureeServer, ledgerOn } from "./fluree-server.ts";
import { type Supervised, spawnSupervised } from "./supervised.ts";

const repo = resolve(import.meta.dir, "..");
const ID = "0.0.0-releasebundle";
let root: string;
let cliJs: string;
let decoy: string;
let poisonMark: string;
type Server = { port: number; dir: string; process: Supervised; client: Client };
const servers: Partial<Record<"source" | "bundle", Server>> = {};
/** What each build's initialize-installation printed, both streams together. */
const initialized: Partial<Record<"source" | "bundle", string>> = {};

const freePort = () => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

/** The clean environment the managed launcher gives every run: nothing inherited. */
const cleanEnv = (server: Server) => ({
  HOME: join(root, "home"),
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  AGENT_BUS_DIR: server.dir,
  AGENT_BUS_PORT: String(server.port),
});

const entryOf = (kind: "source" | "bundle") =>
  kind === "source" ? join(repo, "src/bin.ts") : cliJs;

async function run(
  kind: "source" | "bundle",
  args: ReadonlyArray<string>,
  stdin = ""
): Promise<{ code: number; stdout: string; stderr: string }> {
  const server = servers[kind]!;
  const child = Bun.spawn([process.execPath, "--no-env-file", entryOf(kind), ...args], {
    cwd: decoy,
    env: cleanEnv(server),
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function start(kind: "source" | "bundle", ledger: ReturnType<typeof ledgerOn>) {
  const dir = join(root, `bus-${kind}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ fluree: { url: ledger.url, ledger: ledger.ledger } })
  );
  writeFileSync(join(dir, "fluree-token"), `${ledger.token}\n`, { mode: 0o600 });
  const port = freePort();
  const server = { port, dir } as Server;
  // Each installation's delivery identity, initialized by that build's own command, as a
  // first install does; serve refuses to start without it.
  const init = Bun.spawnSync(
    [process.execPath, "--no-env-file", entryOf(kind), "initialize-installation"],
    { cwd: decoy, env: cleanEnv(server), stdout: "pipe", stderr: "pipe" }
  );
  if (init.exitCode !== 0) throw new Error(`${kind} could not initialize its installation`);
  initialized[kind] = `${init.stdout}${init.stderr}`;
  // A Codex that always fails, so no real Codex delivery is attempted.
  server.process = spawnSupervised(
    [process.execPath, "--no-env-file", entryOf(kind), "serve", "--codex", "/usr/bin/false"],
    { cwd: decoy, env: cleanEnv(server), stdout: "ignore", stderr: "ignore" }
  );
  servers[kind] = server;
  for (let attempt = 0; ; attempt++) {
    const healthy = await fetch(`http://127.0.0.1:${port}/health`).then(
      (response) => response.ok,
      () => false
    );
    if (healthy) break;
    if (attempt > 150) throw new Error(`${kind} serve did not become healthy`);
    await Bun.sleep(100);
  }
  server.client = new Client({ name: `release-bundle-${kind}`, version: "1" });
  await server.client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
  );
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-release-bundle-")));
  // Bundle into a staging directory, relocate, then remove the stage.
  const stage = join(root, "stage");
  mkdirSync(stage);
  bundle({
    src: repo,
    entry: "src/bin.ts",
    outfile: join(stage, "cli.js"),
    bun: process.execPath,
    id: ID,
  });
  mkdirSync(join(root, "relocated/app"), { recursive: true });
  cliJs = join(root, "relocated/app/cli.js");
  cpSync(join(stage, "cli.js"), cliJs);
  removeOwned(stage);
  // A decoy working directory: a dotenv that would break the run, and a poisoned module
  // that marks the disk if anything resolves it.
  decoy = join(root, "decoy");
  poisonMark = join(root, "poison-loaded");
  mkdirSync(join(decoy, "node_modules/effect"), { recursive: true });
  writeFileSync(join(decoy, ".env"), "AGENT_BUS_PORT=9\nAGENT_BUS_DIR=/nonexistent\n");
  writeFileSync(
    join(decoy, "node_modules/effect/package.json"),
    JSON.stringify({ name: "effect", main: "index.js" })
  );
  writeFileSync(
    join(decoy, "node_modules/effect/index.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(poisonMark)}, "loaded");\n`
  );
  mkdirSync(join(root, "home"));
  const ledger = ledgerOn(await flureeServer(), "release-bundle");
  await Promise.all([start("source", ledger), start("bundle", ledger)]);
}, 60_000);

afterAll(async () => {
  for (const server of Object.values(servers)) {
    await server?.client?.close().catch(() => undefined);
    server?.process.kill();
    await server?.process.exited;
  }
  removeOwned(root);
});

test("each serve runs on its own installation identity, initialized by its own build", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/;
  const ids = (["source", "bundle"] as const).map((kind) => {
    const file = join(servers[kind]!.dir, "installation-id");
    const id = readFileSync(file, "utf8");
    expect({ kind, id }).toEqual({ kind, id: expect.stringMatching(uuid) });
    expect({ kind, mode: statSync(file).mode & 0o777 }).toEqual({ kind, mode: 0o600 });
    // Initialization prints nothing, so the identity never reaches a log.
    expect({ kind, printed: initialized[kind] }).toEqual({ kind, printed: "" });
    return id;
  });
  expect(ids[0]).not.toBe(ids[1]);
});

test("each build's serve refuses a store without an identity and creates none", async () => {
  for (const kind of ["source", "bundle"] as const) {
    // A configured store whose identity was never initialized: serve's own loader, bundled
    // or not, must refuse rather than seed one.
    const dir = join(root, `unidentified-${kind}`);
    mkdirSync(dir);
    for (const name of ["config.json", "fluree-token"])
      cpSync(join(servers[kind]!.dir, name), join(dir, name));
    const before = readdirSync(dir).sort();
    const port = freePort();
    // Supervised, so a regression that serves instead of refusing cannot outlive this run,
    // even if the test process is killed; a bounded wait then stops it and awaits its exit.
    const child = spawnSupervised(
      [process.execPath, "--no-env-file", entryOf(kind), "serve", "--codex", "/usr/bin/false"],
      {
        cwd: decoy,
        env: { ...cleanEnv(servers[kind]!), AGENT_BUS_DIR: dir, AGENT_BUS_PORT: String(port) },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: [number, string, string] | "still running";
    try {
      outcome = await Promise.race([
        Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
        new Promise<"still running">((settle) => {
          timer = setTimeout(() => settle("still running"), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await child.exited;
      }
    }
    if (outcome === "still running")
      throw new Error(
        `${kind} serve neither exited nor closed its output within 10 s (exit ${child.exitCode ?? "none"})`
      );
    const [code, stdout, stderr] = outcome;
    expect({ kind, code, stdout }).toEqual({ kind, code: 1, stdout: "" });
    expect(stderr).toContain("Missing installation-id");
    expect({ kind, files: readdirSync(dir).sort() }).toEqual({ kind, files: before });
  }
}, 30_000);

test("the bundle reports its release and the source reports itself as source", async () => {
  expect((await run("bundle", ["--version"])).stdout).toBe(`agent-bus v${ID}`);
  expect((await run("source", ["--version"])).stdout).toBe(`agent-bus v${VERSION}+source`);
  expect(servers.bundle!.client.getServerVersion()?.version).toBe(ID);
  expect(servers.source!.client.getServerVersion()?.version).toBe(`${VERSION}+source`);
});

test("bundled and source serve present the same MCP surface", async () => {
  const [bundled, source] = [servers.bundle!.client, servers.source!.client];
  expect(bundled.getServerVersion()?.name).toBe(source.getServerVersion()?.name);
  expect(bundled.getInstructions()).toBe(source.getInstructions());
  expect(bundled.getInstructions()?.length ?? 0).toBeGreaterThan(0);
  const [bundledTools, sourceTools] = await Promise.all([bundled.listTools(), source.listTools()]);
  expect(bundledTools.tools.length).toBeGreaterThan(10);
  expect(bundledTools).toEqual(sourceTools);
});

test("bundled and source serve refuse alike, and the bundle answers a pinned query", async () => {
  const both = async (name: string, args: Record<string, unknown>) =>
    Promise.all(
      [servers.bundle!, servers.source!].map((server) =>
        server.client.callTool({ name, arguments: args })
      )
    );
  for (const [name, args] of [
    ["bus_read", { address: "claude/nobody", session: "s-nobody" }],
    ["bus_publish", { from: "claude/nobody", session: "s-nobody", to: ["*"], body: "x" }],
    ["bus_query", { query: "SELECT * WHERE { SERVICE <urn:example> { ?s ?p ?o } }" }],
  ] as const) {
    const [bundled, source] = await both(name, args);
    expect(bundled?.isError).toBe(true);
    expect(bundled?.content).toEqual(source?.content);
  }
  const listing = await servers.bundle!.client.callTool({ name: "bus_queries", arguments: {} });
  const head = (listing.structuredContent as { headT?: unknown } | undefined)?.headT;
  expect(Number.isInteger(head)).toBe(true);
  const pinned = await servers.bundle!.client.callTool({
    name: "bus_query",
    arguments: { query: "SELECT ?id WHERE { ?m a bus:Message ; bus:id ?id } LIMIT 1", t: head },
  });
  expect(pinned.isError).not.toBe(true);
  expect((pinned.structuredContent as { t?: unknown } | undefined)?.t).toBe(head);
});

test("the bundled CLI joins and publishes, its hooks wake and recover, and source reads the mail", async () => {
  const join1 = await run("bundle", [
    "join",
    "--address",
    "claude/release-a",
    "--runtime",
    "claude",
    "--session",
    "s-release-a",
  ]);
  expect(join1).toMatchObject({ code: 0, stdout: "joined as claude/release-a; topics: []" });
  const join2 = await run("bundle", [
    "join",
    "--address",
    "codex/release-b",
    "--runtime",
    "codex",
    "--session",
    "s-release-b",
  ]);
  expect(join2.code).toBe(0);
  const published = await run("bundle", [
    "publish",
    "--from",
    "codex/release-b",
    "--to",
    "claude/release-a",
    "--body",
    "release wake",
    "--session",
    "s-release-b",
  ]);
  expect(published.code).toBe(0);
  const id = published.stdout;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  const wake = await run(
    "bundle",
    ["claude-wake"],
    JSON.stringify({ session_id: "s-release-a", hook_event_name: "Stop" })
  );
  expect(wake.code).toBe(2);
  expect(wake.stderr).toContain("claude/release-a");
  const compact = await run(
    "bundle",
    ["compact-context", "--runtime", "claude"],
    JSON.stringify({
      session_id: "s-release-a",
      hook_event_name: "SessionStart",
      source: "compact",
      cwd: decoy,
    })
  );
  expect(compact.code).toBe(0);
  expect(compact.stdout).toContain('"claude/release-a"');

  // The wake marked nothing read: the address's own server delivers the mail once.
  const read = await servers.bundle!.client.callTool({
    name: "bus_read",
    arguments: { address: "claude/release-a", session: "s-release-a" },
  });
  const delivered = (read.structuredContent as { messages: Array<{ id: string; body: string }> })
    .messages;
  expect(delivered.map((message) => [message.id, message.body])).toEqual([[id, "release wake"]]);
  // What the bundle wrote, the source server decodes alike: one ledger, one law.
  const histories = await Promise.all(
    [servers.bundle!, servers.source!].map((server) =>
      server.client.callTool({
        name: "bus_history",
        arguments: { participant: "claude/release-a" },
      })
    )
  );
  expect(histories[1]!.isError).not.toBe(true);
  expect(histories[1]!.structuredContent).toEqual(histories[0]!.structuredContent);
  expect(
    (histories[1]!.structuredContent as { messages: Array<{ id: string }> }).messages.map(
      (message) => message.id
    )
  ).toEqual([id]);
});

test("neither run loaded the decoy directory's modules or dotenv", () => {
  // A loaded .env would have moved both servers to port 9 and nothing would have answered.
  expect(existsSync(poisonMark)).toBe(false);
});

test("the bundle is self-contained and names no build or home path", () => {
  const code = readFileSync(cliJs, "utf8");
  expect(externalImports(code)).toEqual([]);
  expect(code.includes(repo)).toBe(false);
  expect(code.includes(homedir())).toBe(false);
  // The scanner itself sees an external import in each form a bundle could keep.
  for (const form of [
    'import{x}from"sparqljs";',
    'const m=await import("effect");',
    'const r=require("@effect/platform");',
    'import "left-pad";',
  ])
    expect(externalImports(`${form}import{y}from"node:fs";require("path");`)).toHaveLength(1);
});
