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
  parsePrinted,
  parseViewerJob,
  pendingStart,
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

/** `launchctl print` for a loaded job, in launchd's own layout. */
const printed = (job: Record<string, unknown>, path: string) => {
  const args = job.ProgramArguments as string[];
  return [
    `gui/501/${LABEL} = {`,
    `\tpath = ${path}`,
    "\tstate = running",
    `\tprogram = ${(job.Program as string | undefined) ?? args[0]}`,
    "\targuments = {",
    ...args.map((arg) => `\t\t${arg}`),
    "\t}",
    `\tworking directory = ${job.WorkingDirectory}`,
    "\tpid = 4242",
    "}",
    "",
  ].join("\n");
};

/**
 * A launchd stand-in: records calls and tracks the one job. A loaded job is what
 * the plist held when it was loaded; `print` answers 113 when nothing is loaded.
 */
function fakeLaunchd(
  loaded: boolean,
  options: {
    readonly bootstrapFails?: number;
    readonly printFails?: (nth: number) => boolean;
    readonly loadedJob?: Record<string, unknown>;
    readonly loadedFrom?: string;
  } = {}
) {
  const calls: string[] = [];
  const state = {
    loaded,
    job: (options.loadedJob ?? null) as Record<string, unknown> | null,
    failures: options.bootstrapFails ?? 0,
    prints: 0,
  };
  const launchd: Launchd = (args) => {
    calls.push(args[0]!);
    if (args[0] === "print") {
      state.prints++;
      if (options.printFails?.(state.prints)) return { status: 5 };
      if (!state.loaded) return { status: 113 };
      state.job ??= readJob(plist);
      return { status: 0, stdout: printed(state.job!, options.loadedFrom ?? plist) };
    }
    if (args[0] === "bootout") state.loaded = false;
    if (args[0] === "bootstrap") {
      if (state.failures > 0) {
        state.failures--;
        return { status: 5 };
      }
      state.loaded = true;
      state.job = readJob(plist);
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
  expect(calls).toEqual(["print"]);
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
  const back = restoreViewer({ plist, label: LABEL, from: sourceRecord, bindings, launchd });
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
  const { launchd } = fakeLaunchd(true, { bootstrapFails: Number.POSITIVE_INFINITY });
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
  ["a Program override", (job) => ({ ...job, Program: "/bin/sh" })],
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
  expect(() => restoreViewer({ plist, label: LABEL, from: record, bindings, launchd })).toThrow(
    "not an owned viewer job"
  );
  expect(readFileSync(plist)).toEqual(before);
  expect(calls).toEqual([]);
});

// ---------------------------------------------------------------------------
// Launchd's answers: a failed start, inspection errors, and whose job is loaded.

const toA = (launchd: Launchd) =>
  rebindViewer({ plist, label: LABEL, release: release("1.0.0-aaaaaaaaaaaa"), bindings, launchd });
const marker = () => pendingStart(bindings, LABEL);

test("the print parser reads launchd's layout", () => {
  expect(parsePrinted(printed(source, plist))).toEqual({
    kind: "loaded",
    path: plist,
    program: "/usr/bin/env",
    args: source.ProgramArguments as string[],
    workingDirectory: source.WorkingDirectory as string,
    pid: "4242",
  });
});

test("a start that failed is finished by rerunning the step", () => {
  writeJob(plist, source);
  const fake = fakeLaunchd(true, { bootstrapFails: 1 });
  expect(() => toA(fake.launchd)).toThrow("it is stopped");
  expect(fake.state.loaded).toBe(false);
  expect(existsSync(marker())).toBe(true);
  fake.calls.length = 0;
  // Launchd now reports the job absent: without the record it would stay stopped.
  expect(toA(fake.launchd)).toMatchObject({ viewer: "rebound", restarted: true });
  expect(fake.calls).toEqual(["print", "bootstrap"]);
  expect(fake.state.loaded).toBe(true);
  expect(existsSync(marker())).toBe(false);
});

test("a start that failed is finished by viewer-restore, back on the recorded binding", () => {
  writeJob(plist, source);
  const fake = fakeLaunchd(true, { bootstrapFails: 1 });
  expect(() => toA(fake.launchd)).toThrow("it is stopped");
  const [record] = readdirSync(bindings).filter((name) => name.endsWith(".plist"));
  const back = restoreViewer({
    plist,
    label: LABEL,
    from: join(bindings, record!),
    bindings,
    launchd: fake.launchd,
  });
  expect(back).toEqual({ viewer: "restored", release: null, restarted: true });
  expect(fake.state.loaded).toBe(true);
  expect(fake.state.job).toEqual(source);
  expect(existsSync(marker())).toBe(false);
});

test("a start that keeps failing keeps its record", () => {
  writeJob(plist, source);
  const fake = fakeLaunchd(true, { bootstrapFails: 2 });
  expect(() => toA(fake.launchd)).toThrow("it is stopped");
  expect(() => toA(fake.launchd)).toThrow("it is stopped");
  expect(existsSync(marker())).toBe(true);
});

test("a record left by an earlier step does not stop a loaded job from restarting normally", () => {
  writeJob(plist, source);
  mkdirSync(bindings, { recursive: true });
  writeFileSync(marker(), `${LABEL}\n`);
  const fake = fakeLaunchd(true);
  expect(toA(fake.launchd)).toMatchObject({ restarted: true });
  expect(fake.calls).toEqual(["print", "bootout", "print", "bootstrap"]);
  expect(existsSync(marker())).toBe(false);
});

test("an inspection error is not absence: nothing is written or stopped", () => {
  writeJob(plist, source);
  const before = readFileSync(plist);
  const fake = fakeLaunchd(true, { printFails: (nth) => nth === 1 });
  expect(() => toA(fake.launchd)).toThrow("could not be asked");
  expect(readFileSync(plist)).toEqual(before);
  expect(existsSync(bindings)).toBe(false);
  expect(fake.calls).toEqual(["print"]);
  expect(fake.state.loaded).toBe(true);
});

test("an inspection error while stopping keeps the start record for the retry", () => {
  writeJob(plist, source);
  const fake = fakeLaunchd(true, { printFails: (nth) => nth === 2 });
  expect(() => toA(fake.launchd)).toThrow("could not be asked");
  expect(existsSync(marker())).toBe(true);
  expect(toA(fake.launchd)).toMatchObject({ restarted: true });
  expect(fake.state.loaded).toBe(true);
  expect(existsSync(marker())).toBe(false);
});

test("an interrupted step's previous binding, still loaded, is recognised and replaced", () => {
  // The plist already names A, but launchd still runs the source job it loaded.
  writeJob(plist, bound("1.0.0-aaaaaaaaaaaa"));
  const fake = fakeLaunchd(true, { loadedJob: source });
  expect(toA(fake.launchd)).toMatchObject({ restarted: true });
  expect(fake.state.job).toEqual(bound("1.0.0-aaaaaaaaaaaa"));
});

const notOwned: Array<[string, () => Parameters<typeof fakeLaunchd>[1]]> = [
  ["from another plist", () => ({ loadedFrom: "/Library/LaunchAgents/someone.plist" })],
  [
    "with other ports",
    () => ({
      loadedJob: {
        ...source,
        ProgramArguments: (source.ProgramArguments as string[]).map((arg) =>
          arg === "AGENT_BUS_VIEWER_PORT=4999" ? "AGENT_BUS_VIEWER_PORT=5999" : arg
        ),
      },
    }),
  ],
  ["with a program override", () => ({ loadedJob: { ...source, Program: "/bin/sh" } })],
  [
    "in another shape",
    () => ({ loadedJob: { ...source, ProgramArguments: ["/bin/sh", "-c", "anything"] } }),
  ],
];

for (const [name, options] of notOwned)
  test(`a loaded job ${name} is not stopped or rebound`, () => {
    writeJob(plist, source);
    const before = readFileSync(plist);
    const fake = fakeLaunchd(true, options());
    expect(() => toA(fake.launchd)).toThrow("is not the owned viewer");
    expect(readFileSync(plist)).toEqual(before);
    expect(existsSync(bindings)).toBe(false);
    expect(fake.calls).toEqual(["print"]);
  });

test("a job loaded without its plist is refused, by rebind and by restore", () => {
  const fake = fakeLaunchd(true, { loadedJob: source });
  expect(() => toA(fake.launchd)).toThrow("without its plist");
  const record = join(root, "record.plist");
  writeJob(record, source);
  expect(() =>
    restoreViewer({ plist, label: LABEL, from: record, bindings, launchd: fake.launchd })
  ).toThrow("without its plist");
  expect(existsSync(plist)).toBe(false);
  expect(fake.calls).not.toContain("bootout");
});
