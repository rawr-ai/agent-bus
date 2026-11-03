// The shared Fluree server's lifecycle, observed from outside a `bun test` process: two files
// share one server, it serves both, and it has exited by the time that process has. Its stop
// resolves only once the server process has exited.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const files = ["./test/fluree-lifecycle/first-file.ts", "./test/fluree-lifecycle/second-file.ts"];
const owned: number[] = [];
const scratch: string[] = [];

/**
 * The pid itself, when it names one process this file may signal. Anything else is refused
 * before any signal: 0 and negative pids address process groups, 1 is init, and a value read
 * from malformed child output must fail the test rather than pass as a dead process.
 */
const signalable = (pid: unknown): number => {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`refusing to signal pid ${String(pid)}`);
  }
  return pid;
};

/** Whether a process with this pid exists: signal 0 checks without signalling. */
const alive = (pid: unknown) => {
  const target = signalable(pid);
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

/** Kills a server this file's own child left behind, if it is still running. */
const killOwned = (pid: unknown) => {
  const target = signalable(pid);
  if (alive(target)) process.kill(target, "SIGKILL");
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
  const recorded = readFileSync(pidFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(" "));
  const pids = new Map(recorded.map(([file, pid]) => [file, Number(pid)]));
  // Checked once the child has exited, before anything here could stop the server.
  const server = pids.get("first") ?? Number.NaN;
  const survived = alive(server);
  if (survived) owned.push(server);
  return { code, output, pids, server, survived };
};

afterEach(() => {
  // A failing check must not leave its own server behind: stop only what this test started.
  for (const pid of owned.splice(0)) killOwned(pid);
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("two files share one server, which has exited when their test process has", async () => {
  const result = await run();
  expect(result.output).toContain("2 pass");
  expect(result.code).toBe(0);
  // Both files used the same server: it was not stopped after the first.
  expect(result.pids.get("second")).toBe(result.server);
  expect(Number.isSafeInteger(result.server)).toBe(true);
  expect(result.survived).toBe(false);
}, 60_000);

test("a failing test still leaves no server behind", async () => {
  const result = await run({ FLUREE_FIXTURE_THROW: "1" });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("a test that throws");
  expect(result.pids.get("second")).toBe(result.server);
  expect(result.survived).toBe(false);
}, 60_000);

test("the stop resolves only once the server process has exited", async () => {
  const child = Bun.spawn([process.execPath, "./test/fluree-lifecycle/stop-awaits-exit.ts"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const { pid, exists } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
    pid: number;
    exists: boolean;
  };
  if (alive(pid)) owned.push(pid);
  expect(code).toBe(0);
  expect(Number.isSafeInteger(pid)).toBe(true);
  // Checked inside the child the moment the stop resolved: an unawaited exit leaves it present.
  expect(exists).toBe(false);
}, 60_000);

test("a pid that is not one process above init is refused without any signal", () => {
  // Never calls through, so even a broken guard sends no real signal here.
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  try {
    for (const pid of [Number.NaN, 0, 1, -5, 1.5, "4242"]) {
      expect(() => alive(pid)).toThrow("refusing to signal");
      expect(() => killOwned(pid)).toThrow("refusing to signal");
    }
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});
