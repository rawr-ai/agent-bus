# Frame: waking Codex threads without locking the owner out

**Superseded (2026-10-27).** `serve` no longer connects to the daemon: every Codex thread is woken by a nudge in its own queue ([one-codex-route](one-codex-route.md)). The reasoning below is kept as a record, and its daemon facts still hold for the Codex daemon itself.

## Outcome

Agents wake each other through the bus, and the owner can always see, and type into, every Codex thread they work in.

## Problem

A Mac can run two Codex app-servers: the desktop app's embedded one, used for local threads, and the background daemon that `agent-bus serve` uses to wake threads. A thread has one writer, so a second app-server is refused ("thread … already has an active writer").

`serve` used to call `thread/resume` on any thread the daemon hadn't loaded. Once a desktop-held thread was released (the owner stepped away and the app let go of it), a retry made the daemon its writer. The desktop window then reported the thread "open in another app" and refused input while the bus-started turn ran.

This was latent before the switch to one `serve` per machine: the sessions involved exchanged messages through a store no deliverer watched, so the bus never actually woke them.

In the incident, the desktop app's own app-server shut down at 15:36:32 (the app restarted). A bus retry started a turn in the daemon four seconds later. The restarted app's new app-server was then refused, and its window locked.

## Where Codex threads run (investigated on codex-cli 0.164.0-alpha.11.1, desktop Codex Framework 156)

| Thread started from | Runs on | Can the bus wake it? |
| --- | --- | --- |
| The desktop app, "Local" project | The app's own app-server, a child process on stdio | No; waking it takes it from the owner |
| The desktop app, SSH project (including SSH to the same machine) | The daemon, through `codex app-server proxy` | Yes |
| `codex` TUI | The daemon by default (`--no-daemon` opts out) | Yes, and the turn shows live in the TUI |
| `thread/start` on the control socket | The daemon | Yes |
| `codex exec` | Its own process while running | Only after it exits, by `thread/resume` on the daemon |
| A native subagent | Its parent's host | No: "direct app-server input is not allowed for multi-agent v2 sub-agents" |

- **No supported setting makes desktop Local threads run on the daemon.** An undocumented override does exist: launching the app with `CODEX_APP_SERVER_WS_URL=ws+unix://localhost/<home>/.codex/app-server-control/app-server-control.sock:/rpc` makes it connect to the daemon instead of starting its own server. Its handshake against the daemon was verified; full desktop behaviour (approvals, app tools) was not. It also bypasses the CLI overrides the desktop app would normally pass. `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` alone does nothing, because this build always passes a config override.
- **Remote-control pairing with the same machine is filtered out by the app.** The `tunnel-client` app-server is a private MCP bridge, not the remote-control relay.
- **The daemon may lag the CLI.** The daemon ran 0.163.0-alpha.10.2 while the CLI was 0.164.0-alpha.11.1.

## Decision

**Superseded (2026-10-26): keep working in Local threads.** The first decision was "desktop on the daemon": the owner would work through the desktop app's SSH connection to the same machine. Reading the app's code then showed that SSH projects and the `CODEX_APP_SERVER_WS_URL` override both lose desktop features the owner needs: browser and computer use, automations and the artifact viewer, and probably Handoff and the thread tools (see [connections](../architecture/connections.md)). So:

- **The guard is permanent** (shipped in b4aa1f5): the bus never takes a thread from another app-server.
- **A Codex `Stop` hook** (shipped in ba3ab5e) delivers to Local threads when a turn ends.
- **Waking idle Local threads** was first framed as [the desktop-wake spike](desktop-wake-spike.md), through the app's coordination socket. It shipped instead as a nudge in the thread's own queue (3d10fca, [queue-wake](queue-wake.md)): the desktop app stays the writer and runs the nudge as a turn.
- Daemon threads (the `codex` TUI, control-socket `thread/start`) keep live push.

Three reviews (GPT-6 Astra at max effort, GPT-6.1 Sol at extra-high, Claude Opus 5.5 at high) agreed on the guard. A per-session `wake` flag was rejected: it records permission, but doesn't reconcile two writers.

## Bus changes (`src/codex.ts`, `src/Bus.ts`, docs)

1. **Classify the host at join.** A Codex agent calls `bus_join` mid-turn, so at that moment its thread is loaded in whichever app-server runs it.
   - `serve` checks `thread/loaded/list` on its daemon.
   - It records `codexHost: "daemon"` in the presence entry if the thread is listed there, and `"other"` otherwise or when the daemon can't be reached.
   - In the presence entry, the classification survives `serve` restarts.
   - A join made from a shell outside a turn may not be loaded anywhere and will be classified `"other"`, which is the safe default.
2. **Deliver by state.**

   | The daemon has the thread loaded? | Classified at join as | Action |
   | --- | --- | --- |
   | Yes | either | `turn/start` (steers a running turn) |
   | No | `daemon` | `thread/resume`, then `turn/start` |
   | No | `other` | Nothing |

   For "nothing": `deliver` returns false, so the messages stay unread for `bus_read`. Don't retry or back off; check again on the next ledger change or poll, and log once per join that the thread is waiting until it is opened through the daemon.

   A thread the owner moves onto the daemon gets deliveries as soon as the daemon has it loaded. Rejoining from the daemon makes it wakeable after it unloads, too.
3. **Treat a refusal as a routing fact.** An "active writer" refusal means another app-server holds the thread. Treat that join as `other` until the daemon has the thread loaded or the peer rejoins; never retry until the thread happens to be free. Keep exponential back-off only for transport errors (timeouts, daemon unreachable), with the cap lowered to about 5 minutes.
4. **Unsubscribe after acceptance.** After `turn/start` is accepted, call `thread/unsubscribe`, then close the connection. `serve` can't answer approvals, and must not keep a thread loaded.
5. **Fix reply routing in `connect`.** The `Reply` schema ignores extra keys, so a daemon-to-client request (an approval, with its own numeric id) can resolve one of the bus's pending requests. Ignore every frame that carries a `method`.
6. **Never wake subagents.** Treat the daemon's refusal ("direct app-server input is not allowed for multi-agent v2 sub-agents") as permanent for that join, and log it once.
7. **Open: `codex exec` threads.** A thread joined from a running `codex exec` is classified `other`, so it isn't woken after the run exits, even though the daemon could resume it then. Decide whether a join should be able to declare itself headless, so the bus may resume it once the process exits.
8. **Optional:** defer delivery while `thread/read` reports `activeFlags` containing `waitingOnApproval` or `waitingOnUserInput`.
9. **Tests:** a fake daemon covering:
   - the three delivery states;
   - join classification;
   - a refusal leading to a wait, never a retry-and-take;
   - an unsubscribe after acceptance;
   - a server request whose id collides with a pending one.

   Update `README.md` (the wake model, and opening threads through the daemon).

## Operations (the owner's machines)

1. **Daemon open-file limit. Done 2026-10-26:** both daemons now run 0.164 with a soft limit of 10240. The CLI's `daemon restart` refuses daemons it auto-started; stop those with `kill -TERM`, then `daemon start` from a shell with the raised limit. Background: Restart it from a login shell (`ulimit -S -n 10240`), once its loaded threads are accounted for, because a restart drops them. Keep the daemon's own `start|restart` management; don't add a competing launchd job. Qualify `codex app-server daemon bootstrap` before relying on it for restarts after a reboot. After every start, check the limit: a child process's `getrlimit`, or `lsof -p <pid>` counts.
2. **SSH from each machine to itself: dropped**, with the launch override, because both lose desktop features. Both are described in [connections](../architecture/connections.md) for reference.
3. **Open each thread from one place.** Both app-servers read the same `~/.codex`, so a thread id opens under either, but only one can be its writer: a thread the daemon holds shows "open in another app" in a Local window until the daemon unloads it.
4. **Recovering a thread the daemon holds today:** `codex resume --remote unix:// <thread uuid>` attaches to it, with no restart needed. Never archive or delete a thread to release it.

## Verification (on a disposable thread first)

1. **Idle wake.** A publish starts a turn live in the daemon-connected window (a TUI), and the owner can type the next turn.
2. **Busy thread.** A publish during the owner's turn arrives as a steer without error; an unsent draft survives; interrupt and approvals still work.
3. **Approval with no window.** A bus-started turn needs an approval while no window is attached. When the window opens, the prompt is there and can be answered.
4. **Guard.** A thread joined from the embedded server is never loaded by the daemon, including after its window closes. Its messages stay unread.
5. **Unload timing.** Measure when a thread unloads after a delivery and unsubscribe, idle and after a bus-started turn. The docs say 30 minutes without subscribers or activity.
6. **File limit.** With ten or more threads loaded, there is no `Too many open files`.

## Unknowns

- Whether closing the socket counts as an unsubscribe.
- Whether the desktop app accepts an SSH connection to its own machine and keeps it distinct from Local.
- Whether a turn started by another client renders live in the window (likely, since remote use works; not verified).

## Out of scope

- Response-loss handling for `bus_read`/`bus_wait` (documented as a known gap).
- Commit-window views and Stop hooks.
