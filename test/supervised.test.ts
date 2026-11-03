// The supervisor's contract, with stand-in children instead of Fluree: a supervised child ends
// when its parent is killed outright, when the parent's pipe closes, or when the supervisor is
// stopped; the supervisor exits only after the child, with the child's status. Each stand-in
// reports its own pid, and while its supervisor runs, `ps` must agree that it is that child.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
} from "./processes.ts";
import { KILL_AFTER_MS, spawnSupervised } from "./supervised.ts";

const standIn = join(import.meta.dir, "supervised", "stand-in.ts");
const owned: Identity[] = [];
const scratch: string[] = [];

afterEach(() => {
  for (const target of owned.splice(0)) killOwned(target);
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-supervised-"));
  scratch.push(dir);
  return dir;
};

/** The stand-in that wrote `pidFile`, once it has, confirmed by `ps` as the supervisor's child. */
const childOf = async (supervisor: number, pidFile: string): Promise<Identity> => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "") {
    if (Date.now() > deadline) throw new Error("the stand-in did not start");
    await Bun.sleep(20);
  }
  const reported = Number(readFileSync(pidFile, "utf8"));
  const child = childrenOf(supervisor).find((entry) => entry.pid === reported);
  if (child === undefined) throw new Error(`pid ${reported} is not the supervisor's child`);
  owned.push(child);
  return child;
};

const superviseStandIn = (pidFile: string, ...options: string[]) => {
  const supervisor = spawnSupervised([process.execPath, standIn, pidFile, ...options]);
  const identity = identify(supervisor.pid);
  if (identity !== undefined) owned.push(identity);
  return supervisor;
};

test("a parent killed with SIGKILL takes its supervised child with it", async () => {
  const dir = tempDir();
  const parent = Bun.spawn(
    [process.execPath, join(import.meta.dir, "supervised", "parent.ts"), dir],
    { stdout: "pipe", stderr: "ignore" }
  );
  const report = JSON.parse(await firstLine(parent.stdout)) as {
    supervisor: number;
    sibling: number;
  };
  const supervisor = identify(report.supervisor) as Identity;
  owned.push(supervisor);
  const child = await childOf(report.supervisor, join(dir, "supervised"));
  const sibling = await childOf(parent.pid, join(dir, "sibling"));
  parent.kill("SIGKILL");
  await parent.exited;
  // A sibling started after the supervisor still runs, so had it inherited the pipe's write
  // end, end of file could not arrive and the child would survive.
  expect(alive(sibling)).toBe(true);
  expect(await exitsWithin(child)).toBe(true);
  expect(await exitsWithin(supervisor)).toBe(true);
}, 30_000);

test("a parent killed before its supervisor starts the child still takes the child with it", async () => {
  const dir = tempDir();
  const parent = Bun.spawn(
    [process.execPath, join(import.meta.dir, "supervised", "parent.ts"), dir, "die-at-once"],
    { stdout: "ignore", stderr: "ignore" }
  );
  await parent.exited;
  // The stand-in starts after its parent is gone and may be ended before it can report. A
  // survivor would report within the wait, so no report means none survived. Its supervisor
  // has been reparented, so only the stand-in's own report names it.
  const pidFile = join(dir, "supervised");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "")) {
    await Bun.sleep(20);
  }
  if (!existsSync(pidFile)) return;
  const child = identify(Number(readFileSync(pidFile, "utf8")));
  if (child === undefined) return;
  owned.push(child);
  expect(await exitsWithin(child)).toBe(true);
}, 30_000);

test("data on the pipe is ignored; its end ends the child", async () => {
  const pidFile = join(tempDir(), "pid");
  const supervisor = superviseStandIn(pidFile);
  const child = await childOf(supervisor.pid, pidFile);
  supervisor.stdin.write("x");
  await supervisor.stdin.flush();
  await Bun.sleep(500);
  expect(alive(child)).toBe(true);
  await supervisor.stdin.end();
  expect(await exitsWithin(child)).toBe(true);
  expect(await supervisor.exited).toBe(128 + 15);
}, 30_000);

test("a stopped supervisor exits only after its child has", async () => {
  const pidFile = join(tempDir(), "pid");
  // A child that takes a second to exit: a supervisor that did not wait would exit first.
  const supervisor = superviseStandIn(pidFile, "slow-term");
  const child = await childOf(supervisor.pid, pidFile);
  supervisor.kill("SIGTERM");
  await supervisor.exited;
  expect(alive(child)).toBe(false);
}, 30_000);

test("a child that ignores SIGTERM is killed after the bound", async () => {
  const pidFile = join(tempDir(), "pid");
  const supervisor = superviseStandIn(pidFile, "ignore-term");
  const child = await childOf(supervisor.pid, pidFile);
  const started = Date.now();
  supervisor.kill("SIGTERM");
  await Bun.sleep(500);
  expect(alive(child)).toBe(true);
  expect(await supervisor.exited).toBe(128 + 9);
  expect(Date.now() - started).toBeGreaterThanOrEqual(KILL_AFTER_MS - 100);
  expect(alive(child)).toBe(false);
}, 30_000);

test("a child that exits on its own ends the supervisor with its status", async () => {
  for (const code of [0, 3]) {
    const pidFile = join(tempDir(), "pid");
    const supervisor = superviseStandIn(pidFile, `exit=${code}`);
    expect(await supervisor.exited).toBe(code);
  }
}, 30_000);
