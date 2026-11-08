import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Launchd,
  parseViewerJob,
  rebindViewer,
  removeOwned,
  restoreViewer,
} from "../scripts/release.ts";

const LABEL = "test.agent-bus.viewer";
let root: string;
let plist: string;
let bindings: string;
let releases: string;
let source: Record<string, unknown>;

/** The job the viewer runbook writes, bound to a source worktree. */
const sourceJob = (worktree: string) => ({
  Label: LABEL,
  ProgramArguments: [
    "/usr/bin/env",
    "-i",
    `HOME=${root}/home`,
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    "AGENT_BUS_VIEWER_PORT=4999",
    "AGENT_BUS_PORT=48096",
    "/approved/bun-1.4.4/bun",
    "--no-env-file",
    `${worktree}/dist/viewer/main.js`,
  ],
  WorkingDirectory: worktree,
  RunAtLoad: true,
  KeepAlive: true,
  ThrottleInterval: 10,
  Umask: 63,
  StandardOutPath: `${root}/viewer.stdout.log`,
  StandardErrorPath: `${root}/viewer.stderr.log`,
});

function writeJob(path: string, job: unknown) {
  writeFileSync(path, JSON.stringify(job));
  expect(spawnSync("/usr/bin/plutil", ["-convert", "xml1", path]).status).toBe(0);
}
const readJob = (path: string) =>
  JSON.parse(spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]).stdout.toString());

/** A launchd stand-in: records calls and tracks whether the one job is loaded. */
function fakeLaunchd(loaded: boolean, bootstrapFails = false) {
  const calls: string[] = [];
  const state = { loaded };
  const launchd: Launchd = (args) => {
    calls.push(args[0]!);
    if (args[0] === "print") return { status: state.loaded ? 0 : 113 };
    if (args[0] === "bootout") state.loaded = false;
    if (args[0] === "bootstrap") {
      if (bootstrapFails) return { status: 5 };
      state.loaded = true;
    }
    return { status: 0 };
  };
  return { launchd, calls, state };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-release-viewer-")));
  plist = join(root, `${LABEL}.plist`);
  bindings = join(root, "data/bindings");
  releases = join(root, "data/releases");
  mkdirSync(join(releases, "1.0.0-aaaaaaaaaaaa"), { recursive: true });
  mkdirSync(join(releases, "1.0.0-bbbbbbbbbbbb"), { recursive: true });
  source = sourceJob(join(root, "worktree"));
});
afterEach(() => removeOwned(root));

const release = (id: string) => join(releases, id);
const bound = (id: string) => ({
  ...source,
  ProgramArguments: [
    ...(source.ProgramArguments as string[]).slice(0, 6),
    join(release(id), "runtime/bun"),
    "--no-env-file",
    join(release(id), "app/dist/viewer/main.js"),
  ],
  WorkingDirectory: join(release(id), "app"),
});

test("an absent viewer stays absent and nothing is written", () => {
  const { launchd, calls } = fakeLaunchd(false);
  const result = rebindViewer({
    plist,
    label: LABEL,
    release: release("1.0.0-aaaaaaaaaaaa"),
    bindings,
    launchd,
  });
  expect(result).toEqual({ viewer: "absent" });
  expect(existsSync(plist)).toBe(false);
  expect(existsSync(bindings)).toBe(false);
  expect(calls).toEqual([]);
});

test("source -> A -> B -> source moves the running viewer, keeping ports, settings and a record", () => {
  writeJob(plist, source);
  const original = readFileSync(plist);
  const { launchd, calls } = fakeLaunchd(true);

  const toA = rebindViewer({
    plist,
    label: LABEL,
    release: release("1.0.0-aaaaaaaaaaaa"),
    bindings,
    launchd,
  });
  expect(toA).toMatchObject({ viewer: "rebound", previousRelease: null, restarted: true });
  expect(readJob(plist)).toEqual(bound("1.0.0-aaaaaaaaaaaa"));
  expect(statSync(plist).mode & 0o777).toBe(0o600);
  // The source binding is recorded byte for byte before anything changed.
  const sourceRecord = join(bindings, toA.viewer === "rebound" ? toA.record : "");
  expect(readFileSync(sourceRecord)).toEqual(original);
  expect(statSync(sourceRecord).mode & 0o777).toBe(0o600);
  expect(calls).toEqual(["print", "bootout", "print", "bootstrap"]);

  calls.length = 0;
  const toB = rebindViewer({
    plist,
    label: LABEL,
    release: release("1.0.0-bbbbbbbbbbbb"),
    bindings,
    launchd,
  });
  expect(toB).toMatchObject({
    viewer: "rebound",
    previousRelease: "1.0.0-aaaaaaaaaaaa",
    restarted: true,
  });
  expect(readJob(plist)).toEqual(bound("1.0.0-bbbbbbbbbbbb"));
  expect(calls).toEqual(["print", "bootout", "print", "bootstrap"]);

  calls.length = 0;
  const back = restoreViewer({ plist, label: LABEL, from: sourceRecord, launchd });
  expect(back).toEqual({ viewer: "restored", release: null, restarted: true });
  expect(readJob(plist)).toEqual(source);
  expect(calls).toEqual(["print", "bootout", "print", "bootstrap"]);
  expect(readdirSync(bindings)).toHaveLength(2);
});

test("an installed but unloaded viewer is rebound without being started", () => {
  writeJob(plist, source);
  const { launchd, calls, state } = fakeLaunchd(false);
  const result = rebindViewer({
    plist,
    label: LABEL,
    release: release("1.0.0-aaaaaaaaaaaa"),
    bindings,
    launchd,
  });
  expect(result).toMatchObject({ viewer: "rebound", restarted: false });
  expect(readJob(plist)).toEqual(bound("1.0.0-aaaaaaaaaaaa"));
  expect(calls).toEqual(["print"]);
  expect(state.loaded).toBe(false);
});

test("a failed start is reported, not hidden", () => {
  writeJob(plist, source);
  const { launchd } = fakeLaunchd(true, true);
  expect(() =>
    rebindViewer({ plist, label: LABEL, release: release("1.0.0-aaaaaaaaaaaa"), bindings, launchd })
  ).toThrow("it is stopped");
});

const foreign: Array<[string, (job: Record<string, unknown>) => Record<string, unknown>]> = [
  ["another label", (job) => ({ ...job, Label: "someone.else" })],
  [
    "no env -i",
    (job) => ({ ...job, ProgramArguments: (job.ProgramArguments as string[]).slice(2) }),
  ],
  [
    "an extra argument",
    (job) => ({ ...job, ProgramArguments: [...(job.ProgramArguments as string[]), "--inspect"] }),
  ],
  [
    "a relative runtime",
    (job) => {
      const args = [...(job.ProgramArguments as string[])];
      args[6] = "bun";
      return { ...job, ProgramArguments: args };
    },
  ],
  ["another working directory", (job) => ({ ...job, WorkingDirectory: "/tmp" })],
  [
    "a different entry",
    (job) => {
      const args = [...(job.ProgramArguments as string[])];
      args[8] = `${root}/worktree/src/bin.ts`;
      return { ...job, ProgramArguments: args };
    },
  ],
];

for (const [name, change] of foreign)
  test(`refuses a viewer job with ${name}, unchanged and unrecorded`, () => {
    const job = change(source);
    expect(parseViewerJob(job, LABEL)).toBeNull();
    writeJob(plist, job);
    const before = readFileSync(plist);
    const { launchd, calls } = fakeLaunchd(true);
    expect(() =>
      rebindViewer({
        plist,
        label: LABEL,
        release: release("1.0.0-aaaaaaaaaaaa"),
        bindings,
        launchd,
      })
    ).toThrow("not in the owned shape");
    expect(readFileSync(plist)).toEqual(before);
    expect(existsSync(bindings)).toBe(false);
    expect(calls).toEqual([]);
  });

test("restore refuses a record that is not an owned viewer job", () => {
  writeJob(plist, bound("1.0.0-aaaaaaaaaaaa"));
  const before = readFileSync(plist);
  const record = join(root, "record.plist");
  writeJob(record, { ...source, Label: "someone.else" });
  const { launchd, calls } = fakeLaunchd(true);
  expect(() => restoreViewer({ plist, label: LABEL, from: record, launchd })).toThrow(
    "not an owned viewer job"
  );
  expect(readFileSync(plist)).toEqual(before);
  expect(calls).toEqual([]);
});
