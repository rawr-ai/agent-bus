/**
 * `release status` agrees only on exact live bindings of the launcher's release
 * (docs/frames/release-packaging.md): one agreeing baseline, then one change per
 * row. Launchd, processes and the clients' own listings are injected; their real
 * output is exercised by `rehearse:release`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindingsOf,
  type ClientList,
  clientBin,
  clientPlugin,
  type Launchd,
  nativeClientList,
  pendingStart,
  releaseLauncher,
  removeOwned,
  status,
} from "../scripts/release.ts";

const SERVE = "test.agent-bus-status";
const VIEWER = `${SERVE}.viewer`;
const ID = "1.0.0-aaaaaaaaaaaa";
let root: string;
let R: string;
let world: World;

type World = {
  serve: "running" | "stopped" | "absent" | "error";
  serveCommand: string;
  viewer: "running" | "absent";
  viewerCommand: string;
  claude: { status: number; stdout: string } | null;
  codex: { status: number; stdout: string } | null;
};

const claudeList = (...versions: string[]) =>
  claudeEntries(versions.map((version) => ({ version })));
const claudeEntries = (entries: Array<Record<string, unknown>>) => ({
  status: 0,
  stdout: JSON.stringify(
    entries.map((entry) => ({ id: "agent-bus@agent-bus", enabled: true, ...entry }))
  ),
});
const codexList = (...versions: string[]) => codexEntries(versions.map((version) => ({ version })));
const codexEntries = (entries: Array<Record<string, unknown>>) => ({
  status: 0,
  stdout: JSON.stringify({
    installed: entries.map((entry) => ({
      pluginId: "agent-bus@agent-bus",
      installed: true,
      enabled: true,
      ...entry,
    })),
    available: [],
  }),
});

const paths = () => ({
  launcher: join(root, "bin/agent-bus"),
  marketplace: join(root, "data/marketplace"),
  viewerPlist: join(root, `${VIEWER}.plist`),
  bindings: join(root, "data/bindings"),
});

function writeViewerJob(release: string) {
  const job = {
    Label: VIEWER,
    ProgramArguments: [
      "/usr/bin/env",
      "-i",
      "AGENT_BUS_VIEWER_PORT=4999",
      `${release}/runtime/bun`,
      "--no-env-file",
      `${release}/app/dist/viewer/main.js`,
    ],
    WorkingDirectory: `${release}/app`,
  };
  writeFileSync(paths().viewerPlist, JSON.stringify(job));
  expect(spawnSync("/usr/bin/plutil", ["-convert", "xml1", paths().viewerPlist]).status).toBe(0);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-release-status-")));
  R = join(root, "data/releases", ID);
  mkdirSync(R, { recursive: true });
  mkdirSync(join(root, "bin"));
  mkdirSync(paths().marketplace, { recursive: true });
  writeFileSync(paths().launcher, releaseLauncher(R));
  symlinkSync(join(R, "plugin"), join(paths().marketplace, "plugin"));
  writeViewerJob(R);
  world = {
    serve: "running",
    serveCommand: `${R}/runtime/bun --no-env-file --config=${R}/app/bunfig.toml ${R}/app/cli.js serve`,
    viewer: "running",
    viewerCommand: `${R}/runtime/bun --no-env-file ${R}/app/dist/viewer/main.js`,
    claude: claudeList(ID),
    codex: codexList(ID),
  };
});
afterEach(() => removeOwned(root));

const launchd: Launchd = (args) => {
  const label = args[1]!.split("/").at(-1);
  const state = label === SERVE ? world.serve : label === VIEWER ? world.viewer : "absent";
  if (state === "error") return { status: 5 };
  if (state === "absent") return { status: 113 };
  const pid = state === "running" ? `\tpid = ${label === SERVE ? 100 : 200}\n` : "";
  return { status: 0, stdout: `gui/501/${label} = {\n\tstate = ${state}\n${pid}}\n` };
};
const processOf = (pid: string) =>
  pid === "100" ? world.serveCommand : pid === "200" ? world.viewerCommand : null;
const clients: ClientList = (client) => world[client];

const report = () =>
  status({ ...paths(), label: SERVE, viewerLabel: VIEWER, clients, launchd, processOf });

test("every surface exactly on the launcher's release agrees", () => {
  expect(report()).toMatchObject({
    launcher: "release",
    launcherRelease: ID,
    pluginRelease: ID,
    serve: "running",
    serveRelease: ID,
    viewer: "release",
    viewerJob: "running",
    viewerRunningRelease: ID,
    viewerStartPending: false,
    claudePlugin: { state: "installed", versions: [ID], enabled: true },
    codexPlugin: { state: "installed", versions: [ID], enabled: true },
    agree: true,
  });
});

const other = (path: string) => path.replace(`${root}/data/`, `${root}/other/`);
const disagreements: Array<[string, () => void]> = [
  ["serve loaded but not running", () => (world.serve = "stopped")],
  ["serve not loaded", () => (world.serve = "absent")],
  ["serve that launchd cannot report", () => (world.serve = "error")],
  [
    "serve from a same-named release elsewhere",
    () => (world.serveCommand = other(world.serveCommand)),
  ],
  [
    "serve on another Bun",
    () => (world.serveCommand = world.serveCommand.replace(`${R}/runtime/bun`, "/opt/bun/bin/bun")),
  ],
  [
    "serve without the release's config",
    () => (world.serveCommand = world.serveCommand.replace(/ --config=\S+/, "")),
  ],
  [
    "a viewer running a same-named release elsewhere",
    () => (world.viewerCommand = other(world.viewerCommand)),
  ],
  ["a configured viewer not running", () => (world.viewer = "absent")],
  ["a viewer job bound to another root", () => writeViewerJob(other(R))],
  [
    "a plugin link to a same-named release elsewhere",
    () => {
      rmSync(join(paths().marketplace, "plugin"));
      symlinkSync(join(other(R), "plugin"), join(paths().marketplace, "plugin"));
    },
  ],
  ["Claude without the plugin", () => (world.claude = claudeList())],
  ["Claude on another release", () => (world.claude = claudeList("1.0.0-bbbbbbbbbbbb"))],
  [
    "Codex holding an old version beside this one",
    () => (world.codex = codexList("1.0.0-bbbbbbbbbbbb", ID)),
  ],
  ["a client that cannot answer", () => (world.codex = { status: 1, stdout: "" })],
  [
    "Claude holding the plugin disabled",
    () => (world.claude = claudeEntries([{ version: ID, enabled: false }])),
  ],
  [
    "Codex holding the plugin disabled",
    () => (world.codex = codexEntries([{ version: ID, enabled: false }])),
  ],
  [
    "Claude enabled in one scope and disabled in another",
    () => (world.claude = claudeEntries([{ version: ID }, { version: ID, enabled: false }])),
  ],
  [
    "a client listing without an enabled state",
    () => (world.claude = claudeEntries([{ version: ID, enabled: undefined }])),
  ],
  ["a client that answers nonsense", () => (world.claude = { status: 0, stdout: "{}" })],
  [
    "an unfinished viewer start",
    () => {
      mkdirSync(paths().bindings, { recursive: true });
      writeFileSync(pendingStart(paths().bindings, VIEWER), `${VIEWER}\n`);
    },
  ],
];

for (const [name, change] of disagreements)
  test(`does not agree with ${name}`, () => {
    change();
    expect(report().agree).toBe(false);
  });

test("unknown is reported as unknown, never as absent or empty", () => {
  world.serve = "error";
  world.codex = { status: 1, stdout: "" };
  const result = report();
  expect(result.serve).toBe("unknown");
  expect(result.codexPlugin).toEqual({ state: "unknown" });
});

test("a client excluded on purpose is reported and does not block agreement", () => {
  world.codex = null;
  const result = report();
  expect(result.codexPlugin).toEqual({ state: "excluded" });
  expect(result.agree).toBe(true);
});

test("a client that cannot be found is unknown, never absent or excluded", () => {
  // Neither named nor on PATH, or named at a path that does not exist.
  for (const bin of [clientBin(undefined, null), join(root, "missing-claude")]) {
    const list = nativeClientList({ claude: bin, codex: null });
    expect(clientPlugin(list, "claude")).toEqual({ state: "unknown" });
  }
  expect(clientBin("none", "/usr/bin/claude")).toBeNull();
  expect(clientBin(undefined, "/usr/bin/claude")).toBe("/usr/bin/claude");
  expect(clientBin("/opt/claude", null)).toBe("/opt/claude");
  // An unknown client in the report does not agree.
  world.codex = { status: 127, stdout: "" };
  expect(report()).toMatchObject({ codexPlugin: { state: "unknown" }, agree: false });
});

test("an absent viewer agrees only while nothing runs under its label", () => {
  rmSync(paths().viewerPlist);
  world.viewer = "absent";
  expect(report()).toMatchObject({ viewer: "absent", viewerJob: "absent", agree: true });
  world.viewer = "running";
  expect(report().agree).toBe(false);
});

test("an unfinished viewer start is found beside the release without naming a directory", () => {
  expect(bindingsOf(R)).toBe(paths().bindings);
  mkdirSync(paths().bindings, { recursive: true });
  writeFileSync(pendingStart(paths().bindings, VIEWER), `${VIEWER}\n`);
  const unnamed = () =>
    status({
      ...paths(),
      bindings: join(root, "elsewhere"),
      label: SERVE,
      viewerLabel: VIEWER,
      clients,
      launchd,
      processOf,
    });
  expect(unnamed()).toMatchObject({ viewerStartPending: true, agree: false });
  // Beside the viewer's release when the launcher names none.
  rmSync(pendingStart(paths().bindings, VIEWER));
  writeFileSync(paths().launcher, '#!/bin/sh\nexec /somewhere/else "$@"\n');
  writeViewerJob(other(R));
  mkdirSync(bindingsOf(other(R)), { recursive: true });
  writeFileSync(pendingStart(bindingsOf(other(R)), VIEWER), `${VIEWER}\n`);
  expect(unnamed().viewerStartPending).toBe(true);
});
