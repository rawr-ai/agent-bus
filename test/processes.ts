/**
 * Process checks for the lifecycle tests, which must prove a child has exited without trusting
 * the code under test. They only ever signal one pid above init: never a process group or a
 * pattern. A pid counts as the same process only while its start time matches, so a pid reused
 * by an unrelated process is not mistaken for a survivor.
 */
import { KILL_AFTER_MS } from "./supervised.ts";

/**
 * The pid itself, when it names one process a test may signal. Anything else is refused
 * before any signal: 0 and negative pids address process groups, 1 is init, and a value read
 * from malformed child output must fail the test rather than pass as a dead process.
 */
export const signalable = (pid: unknown): number => {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`refusing to signal pid ${String(pid)}`);
  }
  return pid;
};

/** Each process's pid, parent pid and start time, from one `ps` listing. */
const listing = () => {
  const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,lstart="], { stderr: "ignore" });
  const rows = result.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      return match === null
        ? []
        : [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3] as string }];
    });
  // An empty listing would make every process look dead and every check pass: `ps` always
  // lists at least itself.
  if (!result.success || rows.length === 0) throw new Error("ps failed to list processes");
  return rows;
};

/** One live process, identified by its pid and start time. */
export interface Identity {
  readonly pid: number;
  readonly started: string;
}

/** The identity of the running process with this pid, if there is one. */
export const identify = (pid: unknown): Identity | undefined => {
  const target = signalable(pid);
  const row = listing().find((entry) => entry.pid === target);
  return row === undefined ? undefined : { pid: row.pid, started: row.started };
};

/** The identities of the running processes whose parent is this pid. */
export const childrenOf = (pid: unknown): ReadonlyArray<Identity> => {
  const target = signalable(pid);
  return listing()
    .filter((entry) => entry.ppid === target)
    .map(({ pid: child, started }) => ({ pid: child, started }));
};

/** The command line of the process with this pid, or "" if there is none. */
export const commandOf = (pid: unknown) =>
  Bun.spawnSync(["ps", "-o", "command=", "-p", String(signalable(pid))], { stderr: "ignore" })
    .stdout.toString()
    .trim();

/** Whether this process still runs: its pid exists with the same start time. */
export const alive = (target: Identity) => identify(target.pid)?.started === target.started;

/** Whether the process exits within `ms`, polled. */
export const exitsWithin = async (target: Identity, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(target)) return true;
    await Bun.sleep(100);
  }
  return !alive(target);
};

/** Signals the process if it is still the same one; one that exits meanwhile is not an error. */
const signalOwned = (target: Identity, signal: NodeJS.Signals) => {
  if (!alive(target)) return;
  try {
    process.kill(target.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

/** Kills a process a test started and left behind, if it is still the same process. */
export const killOwned = (target: Identity) => signalOwned(target, "SIGKILL");

type Spawned = Pick<ReturnType<typeof Bun.spawn>, "kill" | "exited">;

/** How long a stopped supervisor may take: its command's grace period and some margin. */
const SUPERVISOR_STOP_MS = KILL_AFTER_MS + 5_000;

/** Stops a supervisor with SIGTERM and waits, so that it can stop its command first. */
const stopSupervisor = async (supervisor: Spawned | Identity) => {
  if ("exited" in supervisor) {
    supervisor.kill("SIGTERM");
    const exited = await Promise.race([
      supervisor.exited.then(() => true),
      Bun.sleep(SUPERVISOR_STOP_MS).then(() => false),
    ]);
    if (!exited) supervisor.kill("SIGKILL");
    return;
  }
  signalOwned(supervisor, "SIGTERM");
  if (!(await exitsWithin(supervisor, SUPERVISOR_STOP_MS))) killOwned(supervisor);
};

/**
 * What one test started, stopped so that nothing is left however the test failed. Register each
 * process as soon as it exists, before awaiting anything it reports. `stop` first kills the
 * test's own parents, whose end stops their supervised commands; then stops each supervisor with
 * SIGTERM and waits for it, since SIGKILL would orphan a command not yet registered; and only
 * then kills any other registered process still running. A step that fails does not skip the
 * rest: its error is thrown once every step has run.
 */
export const ownership = () => {
  const parents: Spawned[] = [];
  const supervisors: Array<Spawned | Identity> = [];
  const others: Identity[] = [];
  return {
    parent: <T extends Spawned>(spawned: T) => {
      parents.push(spawned);
      return spawned;
    },
    /** Accepts a supervisor already gone, as `identify` reports it, and skips it. */
    supervisor: <T extends Spawned | Identity | undefined>(supervisor: T) => {
      if (supervisor !== undefined) supervisors.push(supervisor);
      return supervisor;
    },
    process: (target: Identity) => {
      others.push(target);
    },
    stop: async () => {
      const errors: unknown[] = [];
      const attempt = async (step: () => unknown) => {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      };
      for (const parent of parents.splice(0)) {
        await attempt(async () => {
          parent.kill("SIGKILL");
          await parent.exited;
        });
      }
      // Together, so that several stuck supervisors still fit within STOP_TIMEOUT_MS.
      await Promise.all(supervisors.splice(0).map((each) => attempt(() => stopSupervisor(each))));
      for (const target of others.splice(0)) await attempt(() => killOwned(target));
      if (errors.length > 0) throw new AggregateError(errors, "cleanup failed");
    },
  };
};

/** How long a test's cleanup may take: supervisors stop together within SUPERVISOR_STOP_MS. */
export const STOP_TIMEOUT_MS = SUPERVISOR_STOP_MS + 10_000;

/**
 * Keeps a fixture that never exits on its own running only while its parent does: polled, so
 * that a test runner killed outright cannot leave it, or what it started, behind.
 */
export const exitWithParent = () => {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 100);
};

/** The first line a child writes to its piped stdout; fails if it ends without one. */
export const firstLine = async (stdout: ReadableStream<Uint8Array>) => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the child ended before writing a line: ${JSON.stringify(text)}`);
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text.slice(0, text.indexOf("\n"));
};
