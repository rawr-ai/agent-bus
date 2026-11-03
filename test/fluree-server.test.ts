// The shared Fluree server's lifecycle, observed from outside a `bun test` process: two files
// share one server, it serves both, and it has exited by the time that process has, even when
// that process is killed outright. Its stop resolves only once the server process has exited.
// The server is identified from `ps` as its supervisor's one child, not from the code under test.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alive,
  childrenOf,
  exitsWithin,
  firstLine,
  type Identity,
  identify,
  killOwned,
  signalable,
} from "./processes.ts";

const root = join(import.meta.dir, "..");
const files = ["./test/fluree-lifecycle/first-file.ts", "./test/fluree-lifecycle/second-file.ts"];
const owned: Identity[] = [];
const scratch: string[] = [];

interface Recorded {
  readonly supervisor: number;
  readonly children: ReadonlyArray<Identity>;
}

/** The server a fixture recorded: its supervisor's only child. A missing or second one fails. */
const serverOf = (recorded: Recorded | undefined): Identity => {
  const children = recorded?.children ?? [];
  if (children.length !== 1) throw new Error(`expected one server, found ${children.length}`);
  return children[0] as Identity;
};

/** Every process a record names, so a failing check can stop what this file's child left. */
const own = (recorded: Recorded) => {
  const supervisor = identify(recorded.supervisor);
  if (supervisor !== undefined) owned.push(supervisor);
  owned.push(...recorded.children);
};

/** One `bun test` child over both files, in the repository so its bunfig preload applies. */
const run = async (env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-fluree-lifecycle-"));
  scratch.push(dir);
  const pidFile = join(dir, "pids");
  const child = Bun.spawn([process.execPath, "test", ...files], {
    cwd: root,
    env: { ...process.env, FLUREE_PID_FILE: pidFile, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  const records = new Map(
    readFileSync(pidFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Recorded & { file: string })
      .map((record) => [record.file, record])
  );
  for (const record of records.values()) own(record);
  // Checked once the child has exited, before anything here could stop the server.
  const server = serverOf(records.get("first"));
  return { code, output, records, server, survived: alive(server) };
};

afterEach(() => {
  // A failing check must not leave its own server behind: stop only what this test started.
  for (const target of owned.splice(0)) killOwned(target);
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("two files share one server, which has exited when their test process has", async () => {
  const result = await run();
  expect(result.output).toContain("2 pass");
  expect(result.code).toBe(0);
  // Both files used the same server: it was not stopped after the first.
  expect(serverOf(result.records.get("second"))).toEqual(result.server);
  expect(result.survived).toBe(false);
}, 60_000);

test("a failing test still leaves no server behind", async () => {
  const result = await run({ FLUREE_FIXTURE_THROW: "1" });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("a test that throws");
  expect(serverOf(result.records.get("second"))).toEqual(result.server);
  expect(result.survived).toBe(false);
}, 60_000);

test("the stop resolves only once the server process has exited", async () => {
  const child = Bun.spawn([process.execPath, "./test/fluree-lifecycle/stop-awaits-exit.ts"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Recorded & {
    running: ReadonlyArray<Identity>;
  };
  own(report);
  expect(code).toBe(0);
  serverOf(report);
  // Checked inside the child the moment the stop resolved: an unawaited exit leaves it running.
  expect(report.running).toEqual([]);
}, 60_000);

test("a process killed with SIGKILL leaves no server behind", async () => {
  const child = Bun.spawn([process.execPath, "./test/fluree-lifecycle/killed-with-server.ts"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  const report = JSON.parse(await firstLine(child.stdout)) as Recorded;
  own(report);
  const server = serverOf(report);
  const supervisor = identify(report.supervisor);
  expect(supervisor).toBeDefined();
  // No stop, afterAll or finally runs: only the supervisor can end the server.
  child.kill("SIGKILL");
  await child.exited;
  expect(await exitsWithin(server)).toBe(true);
  expect(await exitsWithin(supervisor as Identity)).toBe(true);
}, 60_000);

test("a pid that is not one process above init is refused without any signal", () => {
  // Never calls through, so even a broken guard sends no real signal here.
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  try {
    for (const pid of [Number.NaN, 0, 1, -5, 1.5, "4242"]) {
      expect(() => signalable(pid)).toThrow("refusing to signal");
      expect(() => identify(pid)).toThrow("refusing to signal");
      expect(() => childrenOf(pid)).toThrow("refusing to signal");
    }
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});
