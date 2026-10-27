# Codex hosting: app-servers, threads and the writer lock

How Codex runs threads, and what agent-bus does on top of that to wake them. The first half describes Codex's own behaviour; the second, agent-bus's decisions. Unless a statement names another version, the Codex findings were made on Codex 0.164.0-alpha.11.1 and desktop 26.1021.31345. Each is marked with its basis, as [platforms](platforms.md#how-claims-are-marked) defines.

For the processes and transports on each machine, see [topology](topology.md); for the Codex nudge step by step, [delivery](delivery.md#codex-threads).

## The short answers

| Question | Answer |
| --- | --- |
| How many Codex app-servers run on a machine? | Two long-lived ones: the desktop app's own, and the daemon. Short-lived ones come and go: `serve`'s, one per nudge; one inside each `codex exec`; and others ([below](#the-app-servers-on-a-machine)) |
| Why does the bus use a short-lived app-server of its own? | It only needs the thread's queue, which any app-server can reach without loading the thread, so the bus never becomes a thread's writer ([below](#why-serve-uses-a-short-lived-app-server-of-its-own)) |
| Can several app-servers drive one thread? | No. One app-server at a time holds a thread's writer lock; the others can only read it from disk ([below](#one-writer-per-thread)) |
| How long does an app-server keep a thread? | The daemon, for `thread_unload_delay_secs` after its last client and activity: 1800 s by default, 300 s as the owner has set it. The desktop, while the thread is on screen, then for up to about 3 h ([below](#how-long-a-thread-stays-loaded)) |
| What is "desktop-capable"? | A thread whose app tools the desktop app itself answers, which needs the desktop's own app-server. Daemon threads lack it, and SSH-project threads have only part of it. Full access is a separate, per-thread setting ([below](#what-desktop-capable-means)) |
| Which threads can the bus wake? | [Delivery](delivery.md#how-each-kind-of-session-receives-mail) has the one table, per kind of session |

## How Codex runs threads

### The app-servers on a machine

A Codex thread runs in an app-server: the process that holds its state, runs its turns and serves clients over JSON-RPC. A machine can run several at once, all sharing `~/.codex`.

| App-server | Started by | Clients reach it over | Runs |
| --- | --- | --- | --- |
| **The desktop app's own** | The ChatGPT desktop app, as a child process: the bundled CLI's `codex app-server`, with the desktop's `-c` overrides | stdio, from the app only | Local-project threads. The only app-server with the desktop's features |
| **The daemon** | The first `codex` TUI or `codex app-server proxy` to need it (`codex app-server --listen unix:// --managed-daemon`); nothing starts it at boot | The control socket `~/.codex/app-server-control/app-server-control.sock` | `codex` TUI threads, threads started on the control socket, and desktop SSH-project threads arriving through `codex app-server proxy` |
| **`serve`'s** | agent-bus `serve`, once per nudge | stdio, from `serve` only | Nothing: it lists and adds to queues, which loads no thread |
| **`codex exec`'s** | Each `codex exec` run, in its own process | In-process | That run's thread, until the run exits |
| Others | A private `codex app-server` on stdio; the OpenAI tunnel client (on demand) | stdio | Whatever their client starts |

Verified live from the process lists on both machines, except the tunnel client's, which comes from the earlier [codex-wake](../frames/codex-wake.md) investigation and wasn't rechecked. `codex queue` is a client, not a server of its own: it adds through the running daemon, refuses `--no-daemon`, and starts an embedded server only when no daemon is running (read in `tui/src/session_queue_commands.rs`). The daemon may run a different version from the CLI: on the other machine it is 0.165.0 beside 0.164 CLIs, and a running daemon never updates itself.

### What Codex keeps where

Read in the Codex source at tag `rust-v0.164.0-alpha.11.1`; the writer lock was also seen live.

| Shared through `~/.codex`, on disk | Per app-server, in memory |
| --- | --- |
| Rollouts (`sessions/…/rollout-*.jsonl`): each thread's history | Which threads are loaded |
| `state_5.sqlite`: the thread index the lists read | Subscribers (connected clients) |
| `queue_1.sqlite`: every thread's queued input | The rollout recorder, turn state and pending approvals |
| `thread-writer-locks/<id>.lock`: an `flock` held while a thread is loaded | |
| `config.toml`: settings, including `thread_unload_delay_secs` | |

So any app-server on the machine can list a thread, read its history or add to its queue, but only the one that has the thread loaded can run it.

### One writer per thread

A thread has one writer: the app-server holding its lock (verified live with two stdio app-servers, and read in `rollout/src/writer_lock.rs`; 0.165.0 has the same code).
- A second app-server's `thread/resume` is refused: "thread … already has an active writer" (JSON-RPC error -32600). Its `turn/start` returns "thread not found".
- It can still `thread/read` the thread from disk, including turns the writer ran.
- When the writer unloads the thread, the lock is released and another app-server can resume it and become the writer. The first gets no notifications of the second's turns, though its reads from disk show them.
- Two turns never run at once: the rollout is one clean sequence.
- After a crash, the lock file stays but nothing holds it, and another app-server can resume the thread at once. Each app-server's first acquisition sweeps such stale files (verified live).

What a person sees (read in code): the TUI shows a read-only view, "This thread is open elsewhere". The desktop shows "This is open in another app", with **Retry** and **Fork chat**.

This is why the bus must never load a thread. [codex-wake](../frames/codex-wake.md) records the incident: the bus's resume made the daemon a desktop thread's writer, and the owner's window locked.

### How long a thread stays loaded

A thread's lock lasts as long as some app-server keeps it loaded. Read in Codex 0.164.0-alpha.11.1, with the same default, rule and lock code in 0.165.0; verified live where marked.

**The setting.** `thread_unload_delay_secs`, at the top level of `config.toml` (not in profiles), in whole seconds: 1800 by default, and 0 unloads at once. An app-server unloads a thread at whichever is later of "no subscribers since" and "idle since", plus the delay. Closing a connection drops its subscriptions, so a TUI or SSH proxy exiting starts the clock.
- **Per thread:** `thread/start` and `thread/resume` accept it in their `config`. Verified live: a thread started with 5 s on a 20 s server was released after 5.1 s, and a resume with 2 s after 2.0 s.
- **Per server:** `-c` sets it for a whole app-server. But the daemon ignores `-c` for it: `daemon start` drops `-c`, and `daemon restart -c` keeps only boolean `features.*` (read in `cli/src/main.rs`, `backend/pid.rs`). So the daemon takes it only from `config.toml`, or per request.
- **When an edit applies:** config is rebuilt from disk at each thread load, so an edit should apply to the next load without a restart (read in code, not tested).
- **No release on demand:** `thread/unsubscribe` still waits for the delay, and 0.164 has no `thread/close` or `thread/unload`.

**The desktop's own hold.** The desktop app never unsubscribes a thread that any view shows. Once it is off screen, it unsubscribes it after 3 h inactive, or when it falls out of the 10 most recently used inactive threads; a running turn or a pending request keeps it (read in `app.asar`, `inactiveThreadUnsubscriber`). The server's delay then runs on top, so a desktop thread is held while on screen, and for up to about 3 h plus the delay after. Quitting the app frees its locks (verified live).

**Edge cases** (verified live, on a server with a 20 s delay):
- A turn running when the delay expires keeps the thread; it was released 20.1 s after the turn ended.
- A queued item that runs during the window extends the lock: added 3 s after the client left, it ran headless, and the lock went 20.1 s after its turn.
- A queued item on an unloaded thread waits, and runs within 0.2 s of the next resume.

**Is the lock a limit today?** Separately for any Codex user and for agent-bus:
- **Any Codex user** meets it when opening a TUI or SSH-project thread in the desktop within the delay of leaving it, when the TUI opens a Local thread the desktop holds (for hours), and when opening an SSH-project thread in that machine's own desktop.
- **agent-bus** never takes a lock: a queue add loads nothing. But a nudge that runs as a turn on a loaded thread restarts the idle clock, so each message can prolong an existing lock by up to the delay.
- Observed 2026-10-27: on the bus host, three locks, all held by the desktop, and none by the daemon; on the other machine, none.

### The shared queue

Each thread has a queue of input in `queue_1.sqlite`, reached through the experimental `thread/queue/*` methods (`list`, `add`, `update`, `delete`, `reorder`, `start`), which need `experimentalApi` at `initialize`.
- **Any app-server can add,** without loading the thread (verified live).
- **The writer runs it.** Each app-server polls the queue database every 10 s (SQLite `data_version`, read in `ext/queue/src/service.rs`) and runs queued items for threads it has loaded and idle: as a turn, at once when idle, after the current turn when busy, never steered into a running turn (verified live on the daemon and the desktop).
- **`thread/queue/start`** runs an item only in an app-server that already has the thread loaded and idle (read in code).
- **A thread loaded nowhere keeps its items.** The first app-server to resume it runs them at once (verified live).
- **Items don't coalesce,** and adding twice with the same `clientUserMessageId` queues two (verified live).
- **An unknown thread,** or a new one with no rollout yet, fails with "no rollout found"; an archived one with "session is archived" (verified live).
- **A spawned subagent's queue refuses the add:** "direct app-server input is not allowed for unloaded spawned sub-agents" (verified live on the daemon; for desktop subagents, inferred from the same check).

**How fast a queued item runs** (verified live, healthy path; this is the one place these numbers are kept):

| Where the thread is loaded | From add to turn start |
| --- | --- |
| The desktop, open and idle | 2–6 s ([queue-wake](../frames/queue-wake.md#what-it-rests-on)) |
| The daemon, with a client attached | 5.8 s ([one-codex-route](../frames/one-codex-route.md#what-it-rests-on)) |
| The daemon, with no client | Within 15 s, the first check made |
| Another server holding the lock | 6.9 s, on its own poll |
| Loaded nowhere | Not until an app-server resumes the thread; then within 0.2 s |

End to end from a send, add the ledger's change detection (Fluree's event stream, with a 15-second poll behind it) and any back-off. In qualification, threads read their mail 4.6–13 s after the send ([one-codex-route results](../frames/one-codex-route.md#qualification-2026-10-27)).

### Across machines: SSH projects

A desktop SSH project runs `codex app-server proxy` on the SSH host, which pipes stdio to that host's daemon control socket (read in `cli/src/main.rs`). The thread is stored in the SSH host's `~/.codex` and run by the SSH host's daemon. That holds for SSH to the same machine too.

The SSH host's own desktop app lists such a thread, since it reads the same index. While the daemon holds the thread, opening it there shows the conflict view; once the daemon unloads it, that desktop can take it as a Local thread, and the SSH side is then refused (inferred from code, not tried in the UI).

### What desktop-capable means

Read in the desktop bundle (`app.asar`, desktop 26.1021.31345), with the live checks marked.

A thread is desktop-capable when **the desktop app itself answers the thread's app tools**, and, for browser and computer use, when the thread can reach **local pipes that only processes descended from the desktop app may use**.
- **`codex_app`** is a bundled MCP server with no tools of its own. It forwards `tools/list` and `tools/call` over the unix socket named in `CODEX_APP_TOOLS_PIPE_PATH`, to the desktop's main process, which answers from the renderer's tool catalog.
- **The socket** (`/tmp/codex-app-tools/<id>.sock`, mode 0600) is set in the desktop's own environment, so only its app-server inherits it. Its peer check refuses processes that the desktop didn't start; the desktop's logs show such refusals (`untrusted-process-ancestry`, verified).
- **The desktop enables `codex_app` only for its local host.** Started without that override, our own app-server shows `codex_app` disabled; with it, "Codex did not provide CODEX_APP_TOOLS_PIPE_PATH" (verified live).

| Feature | Local thread (desktop app-server) | SSH-project thread (daemon, desktop as client) | Daemon thread with no desktop (TUI) |
| --- | --- | --- | --- |
| List, read, wait, pin, archive and rename threads; worktrees; panels and terminal | Yes | Yes, as tools the connected desktop answers (read in code) | No |
| Create, send, fork and handoff thread tools | Yes | No on these macOS hosts (inferred). They need an SSH reverse-forwarded bridge whose pre-check reads `/proc/net/tcp`, which both Macs lack, and both desktops log `desktop_mcp_unavailable` "socket hang up" (both verified). What the SSH threads actually registered couldn't be read (inconclusive) | No |
| Automations | Yes | No: "Automations are only supported for local threads." (read in code) | No |
| Pages and Artifact Session | Yes | No: local stdio host only (read in code) | No |
| Browser and computer use | Yes | No: not configured for non-local hosts (read in code) | In-app browser: no (inferred). Chrome and computer use: unknown |
| Handoff from the UI (not the model's tool) | Yes | Yes (read in code) | — |

**Why the daemon and SSH projects lack these:** the tools are answered by the desktop's renderer, through a pipe only the desktop's own descendants can use, and the desktop wires that pipe only into its local app-server. No inspected setting gives the daemon the full set:
- `CODEX_APP_SERVER_WS_URL` makes the desktop use another server, but bypasses the desktop's overrides, so it loses at least `codex_app`, whose enable flag is one of them (read in code). Whether it loses more is unproven.
- `CODEX_APP_SERVER_USE_LOCAL_DAEMON` needs a launch with no config overrides, which the desktop always passes, so it looks unreachable through the normal launch (inferred from code).
- `CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES` works only in development builds (read in code).

**Full access is a different thing.** The sandbox and approval mode are parameters of each thread's `thread/start`, on any host, and grant no desktop features. For the bus, they decide only whether `bus_join` needs approval ([connections](../connections.md#approval-in-codex)).

### Routes that create a thread

How each way of starting a thread decides where it runs and whether it is listed. Read in code and the Codex source, except where marked verified live. Whether the bus wakes each kind is in [delivery's table](delivery.md#how-each-kind-of-session-receives-mail).

| Started from | Runs on | Listed in the desktop and `codex resume` |
| --- | --- | --- |
| The desktop app, Local project | The desktop's own app-server | Yes |
| The desktop app, SSH project (including SSH to the same machine) | The SSH host's daemon, through `codex app-server proxy` | Yes |
| `codex` TUI | The daemon (`--no-daemon` runs it in-process) | Yes |
| `thread/start` on the daemon's control socket | The daemon | Yes |
| `codex exec`, and `codex exec resume` | Its own process while running, then nowhere. `exec resume` is refused while another app-server holds the thread (verified live). Opened later by id, the opener's app-server becomes its writer | No: its source is `exec`, listed only when non-interactive sources are asked for (verified live) |
| A private `codex app-server` on stdio | That process, until it exits | Yes (verified live) |
| A native subagent | Its parent's app-server | Only under its parent |
| The `codex://threads/new?path=&prompt=` link | The desktop's own app-server, once the user sends (the link only fills the composer; inferred) | Yes |

### The `threads/wake` link

The desktop handles `codex://threads/wake/<id>`: it runs whatever is already in a thread's queue, by resuming the thread in its own app-server. Read in `app.asar` (desktop 26.1021.31345, `wakeQueuedThread`) and the Codex source, and probed live on throwaway threads (Codex 0.164.0-alpha.11.1) with nine link openings.

**What it does** (read in code; consistent with the live runs):
1. It accepts exactly `wake/<UUID>`, with no query or fragment.
2. Once the app is ready, it uses the desktop's Local connection only, never an SSH host.
3. It checks that the app-server has the `threadQueue` capability (Codex 0.148.0-alpha.14 or later), lists the thread's queue with limit 1, and resumes the thread only if the queue isn't empty. The resume runs the queued items.
4. It doesn't navigate or open a window.

**Preconditions:**
- The thread is known and not archived. Unknown and archived threads fail ("no rollout found", "session is archived"; verified live).
- The queue is not empty. With an empty queue, nothing happens: no lock, no turn (verified live).
- No other app-server holds the thread. Otherwise the resume is refused as "already has an active writer", and the holder's own poll runs the item anyway (verified live: 6.9 s).
- There is no source allowlist, so `codex exec` threads qualify (read in code, verified live).

**Measured pickup** (verified live, from the link to the desktop taking the lock): 0.53–1.47 s for threads loaded nowhere, with the turn complete 2.5–2.9 s after the link. Two links 0.2 s apart caused one resume and one turn. Woken turns kept the thread's own model and effort.

**Visible effects** (verified live):
- `open -g` changes nothing on screen: the frontmost app and window order stayed the same in every case.
- Plain `open` raises the app to the front, even when the wake does nothing.
- Each woken turn posts a macOS turn-complete notification while the desktop's window is unfocused (seen in the desktop's log).
- Woken `codex exec` threads run, and notify, while staying hidden from the desktop's thread list; their source stays `exec`.
- The woken thread starts the desktop's MCP servers, so it runs with desktop features.

**The sticky retry set** (verified live, explained by the code): a wake that fails is tried 3 times, 1 s apart, and the id is then kept in an in-memory set. Every later wake link retries it 3 more times, for any thread, until the app restarts or the thread's queue is found empty.

**Holding the lock.** The resume subscribes and never unsubscribes (read in code), so the desktop keeps the woken thread under its own rules ([above](#how-long-a-thread-stays-loaded)): up to about 3 h, or until it leaves the 10 most recently used, plus the server's delay. That it can hold longer is inferred. The live measurement of how long the desktop held a woken thread is pending.

**What it costs:**
- The desktop takes and keeps the writer lock, so the daemon, the TUI and another machine's SSH project get refused or read-only for that thread meanwhile.
- Every woken turn notifies, and woken `exec` threads run unseen in the list.
- Failed ids keep being retried until the app restarts.
- It works only for the local desktop, depends on the private link route and the experimental queue, and could change with any app update.
- Any local process can open the link, without authentication (read in code). That adds little, since writing the queue already needs access to `~/.codex` (inferred).

**What it means for agent-bus.** It can't replace the queue add: the link carries no message, only "run what's queued". It can't replace the poll either: for a thread another app-server has loaded, the link fails and that server's poll runs the item. At most it complements them, for threads loaded nowhere, which today wait until someone opens them: `serve` would add the nudge as now, then `open -g` the link. agent-bus doesn't do this; adopting it is an open decision for the owner, and it bears on the open `codex exec` question ([codex-wake](../frames/codex-wake.md), item 7).

## What agent-bus runs, and why

Everything in this half is agent-bus's own design, read in `src/codex.ts` and the frames it cites, apart from the owner's Codex setting below.

### Why `serve` uses a short-lived app-server of its own

To wake a thread, the bus adds one nudge to the thread's queue and lets the thread's writer run it ([delivery](delivery.md#codex-threads)). For that, `serve` needs only `thread/queue/list` and `thread/queue/add`, and any app-server on the machine serves those without loading the thread. So `serve` starts one of its own:
- **It is never a writer.** Its app-server loads no thread, so whichever app-server runs the thread stays its only writer. No thread can have a second writer because of the bus, by construction ([one-codex-route](../frames/one-codex-route.md)).
- **The alternatives each cost more.** The daemon's socket would give `serve` full control of every thread the daemon can load, and the daemon doesn't run Local threads anyway. The desktop's app-server has no entrance for other processes: its stdio belongs to the app, and driving its windows through the app's coordination socket was dropped untested ([desktop-wake-spike](../frames/desktop-wake-spike.md)). `thread/queue/start` runs an item only where the thread is already loaded, so `serve`'s app-server would first have to resume the thread and become its writer.
- **Short-lived bounds it.** It is started for each nudge and ended, killed if need be, and reaped before the address's lock is released, so an add that timed out can't land after a takeover. Each request gets 2 s and a whole nudge 6 s.
- **It is the desktop's bundled CLI** (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, or `serve --codex <path>`). The queue methods are experimental, and the bundled CLI is the same build as the desktop that reads the queue. There is no `PATH` fallback: `serve` runs under launchd's `PATH`, and another CLI's protocol could differ. For daemon threads, the daemon must accept the same protocol; on the other machine the daemon is 0.165.0 and the bundled CLI 0.164.0-alpha.11.1, and a daemon-thread nudge there hasn't been checked on that pair (unverified).

### Which threads `serve` wakes

`serve` nudges a Codex peer only when it joined from this machine with its own thread id, since each machine's queues are in that machine's `~/.codex`. It doesn't care which app-server runs the thread: the desktop's or the daemon's, whichever is the writer, runs the nudge. A thread loaded nowhere keeps its nudge until it is opened; whether a running `codex exec` runs one isn't established. [Delivery](delivery.md#how-each-kind-of-session-receives-mail) gives the outcome for each kind of thread.

### The unload delay the owner chose

On 2026-10-27 the owner set `thread_unload_delay_secs = 300` in `~/.codex/config.toml` on both machines (Codex 0.164 on the bus host; the other machine's daemon is 0.165). It is a deliberate configuration, chosen so threads left on the daemon are freed in 5 minutes rather than 30.

The trade-off for the bus:
- **A shorter delay** frees threads sooner for the desktop or another client. A nudge runs at once only while the thread is still loaded, so mail for a thread that has unloaded waits until the thread is reopened. None is lost.
- **A longer delay** keeps nudges running headlessly for longer, but each nudge restarts the clock, so a thread mailed more often than the delay stays loaded, and locked, indefinitely.
- The desktop's hold is driven by its UI, not by this setting, so the setting matters mainly for the daemon. A thread meant to keep waking headlessly could get a longer delay per thread, through the request `config`.

That the setting takes effect without a restart was read in code, not tested.

### Why the owner works in Local threads

The first fix for the incident in [codex-wake](../frames/codex-wake.md) was to move the owner's threads onto the daemon, through an SSH project to the same machine or the `CODEX_APP_SERVER_WS_URL` override. An SSH project loses desktop features, and the override loses at least `codex_app` ([above](#what-desktop-capable-means)), so the owner stays in Local threads, and the bus reaches them through their queue instead.

### When a queued nudge doesn't run

A nudge runs only where the thread is loaded, so for TUI and SSH-project threads it depends on the daemon:
- **`serve` has to reach the thread's queue.** It needs a queue-capable Codex CLI (`serve --codex`, by default the desktop's bundled one), run as the same user with the same Codex home, on the machine that owns the thread. For a desktop SSH project, that is the SSH host. The CLI's protocol has to match the daemon's.
- **An unloaded thread waits.** After the unload delay with no client, or a daemon stopped with a signal, its nudge waits, and its mail stays unread, until the thread is reopened, which runs the nudge. A graceful `codex app-server daemon restart` or update resumes the loaded root threads and retakes their locks (read in `daemon_snapshot.rs`), but the CLI refuses that command for a daemon auto-started on first use, which then has to be stopped with a signal.
- **Nothing starts the daemon at boot;** the CLI and SSH proxies start it on first use. It inherits the open-file limit of whatever started it. When it reports `Too many open files` (in `~/.codex/app-server-control/app-server.log`), restart it from a shell with `ulimit -S -n 10240`, remembering that a stop by signal unloads its threads.
