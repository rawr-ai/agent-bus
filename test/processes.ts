/**
 * Process checks for the lifecycle tests, which must prove a child has exited without trusting
 * the code under test. They only ever signal one pid above init: never a process group or a
 * pattern. A pid counts as the same process only while its start time matches, so a pid reused
 * by an unrelated process is not mistaken for a survivor.
 */

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

/** Kills a process a test started and left behind, if it is still the same process. */
export const killOwned = (target: Identity) => {
  if (alive(target)) process.kill(target.pid, "SIGKILL");
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
