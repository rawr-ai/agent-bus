/**
 * Runs a long-lived child of a test or qualifier so that it cannot outlive the process that
 * started it. Without this, a parent killed outright (SIGKILL, a harness timeout) skips its
 * afterAll and finally blocks and orphans the child, such as `fluree server run`; macOS has no
 * parent-death signal to stop it.
 *
 * `spawnSupervised` starts this file as a supervisor, and the supervisor starts the command.
 * The supervisor's stdin is a pipe whose write end only the parent holds and never writes or
 * closes. When it reaches end of file, because the parent exited however it died, the
 * supervisor ends the command with SIGTERM. SIGTERM or SIGINT sent to the supervisor is passed
 * on to the command instead, and SIGHUP counts as SIGTERM. Either way, a command still running
 * after KILL_AFTER_MS gets SIGKILL, and SIGTERM or SIGHUP to a supervisor already ending kills
 * it at once: a caller that cannot wait sends one rather than SIGKILL, which would orphan the
 * command. A repeated SIGINT does not escalate, since a terminal's Ctrl-C reaches the whole
 * process group and the caller's own SIGINT may follow it. The
 * supervisor exits only once the command has, with the command's status, so a caller that
 * stops the supervisor and awaits its exit has also waited for the command.
 *
 * Limits: a supervisor killed alone with SIGKILL orphans its command, and the command's own
 * children are not tracked.
 */
import { constants } from "node:os";

/** How long a signalled command has to exit before it is killed. */
export const KILL_AFTER_MS = 5_000;

/** Exit status as a shell reports it: the code, or 128 plus the number of the fatal signal. */
const status = (child: Pick<ReturnType<typeof Bun.spawn>, "exitCode" | "signalCode">) =>
  child.exitCode ??
  128 + (constants.signals[child.signalCode as keyof typeof constants.signals] ?? 0);

const supervise = async (command: ReadonlyArray<string>) => {
  if (command.length === 0) {
    console.error("usage: supervised.ts <command> [args...]");
    process.exit(2);
  }
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let ending = false;
  const end = (signal: "SIGTERM" | "SIGINT") => {
    if (ending) {
      if (signal === "SIGTERM") child?.kill("SIGKILL");
      return;
    }
    ending = true;
    child?.kill(signal);
    setTimeout(() => child?.kill("SIGKILL"), KILL_AFTER_MS);
  };
  // Installed before the spawn: a signal delivered from here on is handled once the spawn
  // below has returned, so it always finds the command. One that arrives earlier still has its
  // default action and kills the supervisor before there is a command to orphan.
  process.on("SIGTERM", () => end("SIGTERM"));
  process.on("SIGINT", () => end("SIGINT"));
  process.on("SIGHUP", () => end("SIGTERM"));
  child = Bun.spawn([...command], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  void (async () => {
    try {
      // Data is ignored: only end of file, the parent's write end closing, ends the command.
      for await (const _ of Bun.stdin.stream());
    } catch {
      // A failed read is treated as the parent being gone.
    } finally {
      // Not a second signal: a parent that ends after stopping the supervisor still allows the
      // command its grace period.
      if (!ending) end("SIGTERM");
    }
  })();
  await child.exited;
  process.exit(status(child));
};

if (import.meta.main) await supervise(Bun.argv.slice(2));

/**
 * Starts `command` under a supervisor: the returned process is the supervisor's, and its exit
 * implies the command's. Stop it with `kill()` and await `exited`. Keep the returned process
 * referenced while the command should run: its stdin is the pipe whose end stops the command.
 */
type Output = "ignore" | "inherit" | "pipe";

export const spawnSupervised = <Out extends Output = "pipe", Err extends Output = "inherit">(
  command: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    /** The environment of the supervisor, which the command inherits unchanged. */
    readonly env?: Record<string, string>;
    readonly stdout?: Out;
    readonly stderr?: Err;
  } = {}
) =>
  Bun.spawn<"pipe", Out, Err>([process.execPath, "--no-env-file", import.meta.path, ...command], {
    ...options,
    stdin: "pipe",
  });

/** A supervisor started by `spawnSupervised`. */
export type Supervised = ReturnType<typeof spawnSupervised>;
