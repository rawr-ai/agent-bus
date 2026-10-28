# Codex

How Codex runs threads: the facts agent-bus rests on. What agent-bus does with them is in [Codex hosting](../architecture/codex-hosting.md) and [delivery](../architecture/delivery.md#codex-threads). Unless a statement names another version, these findings were made on Codex 0.164.0-alpha.11.1 and desktop 26.1021.31345. Each is marked with its basis, as [platforms](README.md#how-claims-are-marked) defines, and the [findings table](README.md#version-sensitive-findings) lists them with their versions.

## The app-servers on a machine

A Codex thread runs in an app-server: the process that holds its state, runs its turns and serves clients over JSON-RPC. A machine can run several at once, all sharing `~/.codex`.

| App-server | Started by | Clients reach it over | Runs |
| --- | --- | --- | --- |
| **The desktop app's own** | The ChatGPT desktop app, as a child process: the bundled CLI's `codex app-server`, with the desktop's `-c` overrides | stdio, from the app only | Local-project threads. The only app-server with the desktop's features |
| **The daemon** | `codex app-server daemon start`, from the first `codex` TUI or other client to need it; or, unmanaged, a desktop SSH project's connection to the SSH host; nothing starts it at boot ([below](#the-daemon)) | The control socket `~/.codex/app-server-control/app-server-control.sock` | `codex` TUI threads, threads started on the control socket, and desktop SSH-project threads arriving through `codex app-server proxy` |
| **`codex exec`'s** | Each `codex exec` run, in its own process | In-process | That run's thread, until the run exits |
| Others | A private `codex app-server` on stdio; the OpenAI tunnel client (on demand) | stdio | Whatever their client starts |

Verified live from the process lists on both machines, except the tunnel client's, which comes from the earlier [codex-wake](../frames/codex-wake.md) investigation and wasn't rechecked. `codex queue` is a client, not a server of its own: it adds through the running daemon, refuses `--no-daemon`, and starts an embedded server only when no daemon is running (read in `tui/src/session_queue_commands.rs`). The daemon may run a different version from the CLI: on the other machine it is 0.165.0 beside 0.164 CLIs, since the managed daemon updates itself ([below](#the-daemon)).

## What Codex keeps where

Read in the Codex source at tag `rust-v0.164.0-alpha.11.1`; the writer lock was also seen live.

| Shared through `~/.codex`, on disk | Per app-server, in memory |
| --- | --- |
| Rollouts (`sessions/…/rollout-*.jsonl`): each thread's history | Which threads are loaded |
| `state_5.sqlite`: the thread index the lists read | Subscribers (connected clients) |
| `queue_1.sqlite`: every thread's queued input | The rollout recorder, turn state and pending approvals |
| `thread-writer-locks/<id>.lock`: an `flock` held while a thread is loaded | |
| `config.toml`: settings, including `thread_unload_delay_secs` | |

So any app-server on the machine can list a thread, read its history or add to its queue, but only the one that has the thread loaded can run it.

## One writer per thread

A thread has one writer: the app-server holding its lock (verified live with two stdio app-servers, and read in `rollout/src/writer_lock.rs`; 0.165.0 has the same code).
- A second app-server's `thread/resume` is refused: "thread … already has an active writer" (JSON-RPC error -32600). Its `turn/start` returns "thread not found".
- It can still `thread/read` the thread from disk, including turns the writer ran.
- When the writer unloads the thread, the lock is released and another app-server can resume it and become the writer. The first gets no notifications of the second's turns, though its reads from disk show them.
- Two turns never run at once: the rollout is one clean sequence.
- After a crash, the lock file stays but nothing holds it, and another app-server can resume the thread at once. Each app-server's first acquisition sweeps such stale files (verified live).

What a person sees (read in code): the TUI shows a read-only view, "This thread is open elsewhere". The desktop shows "This is open in another app", with **Retry** and **Fork chat**.


## How long a thread stays loaded

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

**Who meets the lock:**
- **Any Codex user** meets it when opening a TUI or SSH-project thread in the desktop within the delay of leaving it, when the TUI opens a Local thread the desktop holds (for hours), and when opening an SSH-project thread in that machine's own desktop.
- Seen 2026-10-27 (verified live): on the bus host, three locks, all held by the desktop, and none by the daemon; on the other machine, none.

## The shared queue

Each thread has a queue of input in `queue_1.sqlite`, reached through the experimental `thread/queue/*` methods (`list`, `add`, `update`, `delete`, `reorder`, `start`), which need `experimentalApi` at `initialize`.
- **Any app-server can add,** without loading the thread (verified live).
- **The writer runs it.** Each app-server polls the queue database every 10 s (SQLite `data_version`, read in `ext/queue/src/service.rs`) and runs queued items for threads it has loaded and idle: as a turn, at once when idle, after the current turn when busy, never steered into a running turn (verified live on the daemon and the desktop).
- **`thread/queue/start`** runs an item only in an app-server that already has the thread loaded and idle (read in code).
- **A thread loaded nowhere keeps its items.** The first app-server to resume it runs them at once (verified live).
- **Items don't coalesce,** and adding twice with the same `clientUserMessageId` queues two (verified live).
- **Each item has two ids.** `add` answers with the item (`queuedSubmission`: `id`, `input`, `clientUserMessageId`), and `list` returns the same fields (read in `app-server-protocol/src/protocol/v2/thread.rs`, 0.164.0-alpha.11.1).
- **An owner's edit keeps the ids.** `update` replaces an item's input under the same `id` and `clientUserMessageId` (read in code).
- **`delete {threadId, queuedSubmissionId}` answers `{deleted}`,** with no condition on the item's content, and like `add` needs no loaded thread (read in code). The writer's dispatch reads an item, starts its turn, then deletes the row, under a lock local to its own app-server, so a delete from another server can land after the turn started and still answer `deleted: true`; `deleted: false` means the row was already gone (read in `ext/queue/src/service.rs`, inferred for the race).
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

## Across machines: SSH projects

A desktop SSH project runs `codex app-server proxy` on the SSH host, which pipes stdio to that host's daemon control socket (read in `cli/src/main.rs`). The thread is stored in the SSH host's `~/.codex` and run by the SSH host's daemon. That holds for SSH to the same machine too.

The SSH host's own desktop app lists such a thread, since it reads the same index. While the daemon holds the thread, opening it there shows the conflict view; once the daemon unloads it, that desktop can take it as a Local thread, and the SSH side is then refused (inferred from code, not tried in the UI).

## What desktop-capable means

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

**Full access is a different thing.** The sandbox and approval mode are parameters of each thread's `thread/start`, on any host, and grant no desktop features ([approvals for MCP tools](#approvals-for-mcp-tools)).

## Routes that create a thread

How each way of starting a thread decides where it runs and whether it is listed. Read in code and the Codex source, except where marked verified live. Whether the bus wakes each kind is in [delivery's table](../architecture/delivery.md#how-each-kind-of-session-receives-mail).

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

## The `threads/wake` link

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

**Holding the lock.** The resume subscribes and never unsubscribes (read in code). Three woken threads were still held by the desktop 34 minutes after their last turn, past the server's 1800 s delay, and while it held them another server's `thread/archive` was refused (verified live, desktop 26.1021.31345, Codex 0.164.0-alpha.11.1). The desktop's release rule ([above](#how-long-a-thread-stays-loaded)) applies only to threads its UI has opened, which a woken thread never was. So the desktop likely holds it until the app restarts, or until the owner opens the thread and leaves it (inferred).

**What it costs:**
- The desktop takes and keeps the writer lock, so the daemon, the TUI and another machine's SSH project get refused or read-only for that thread meanwhile.
- Every woken turn notifies, and woken `exec` threads run unseen in the list.
- Failed ids keep being retried until the app restarts.
- It works only for the local desktop, depends on the private link route and the experimental queue, and could change with any app update.
- Any local process can open the link, without authentication (read in code). That adds little, since writing the queue already needs access to `~/.codex` (inferred).

## What a resume restores

What `thread/resume` takes from a thread's stored state, for a server that didn't have it loaded. Read in Codex 0.164.0-alpha.11.1 (`thread_processor.rs`, `persisted_resume_settings.rs`, `config/mod.rs`, `session/session.rs`, `session/mod.rs`, `thread-store/src/local/model_context.rs`), and verified live where marked.
- **Nothing reports these settings without loading the thread.** `thread/read` has no permissions or approval field (read in code; verified live 2026-10-27). They are in the rollout.
- **The approval policy** comes from the latest `turn_context` or `thread_settings_applied` record, whichever thread wrote it.
- **Permissions, a named profile and collaboration mode** are taken first from the latest `thread_settings_applied` record the thread wrote itself (its `thread_id` is the thread's); a fork's copied history holds another thread's. Without such a record, each falls back differently (`thread_processor.rs`, `persisted_resume_settings.rs`, `core/src/session/mod.rs`):
  - unnamed permissions fall back to the resuming server's defaults;
  - a named profile is still selected from the latest record of either kind, a `turn_context` included;
  - collaboration mode comes from the latest `turn_context`.
- **A named permission profile is compiled again by name.** A user-defined one that no longer compiles falls back to the server's default without an error. Switching a thread to a built-in profile (`:read-only`, `:workspace`, `:danger-full-access`) keeps the earlier profile's denials in the saved form (`preserve_deny_read_restrictions_from`), and compiling it again by name drops them.
- **An unnamed profile** is kept only if it lists no readable specific paths. The older `workspace-write` setting lists the workspace, so a resume replaces it with the server's default; verified live, where a daemon resume widened such a thread to full access ([load-on-mail](../frames/load-on-mail.md)).
- **The resume persists what it applied at once,** before any turn (verified live).
- **Dynamic tools** that a client registered for the thread are stored in its first record, `session_meta`, and restored. A call to one is sent to that client and waits with no deadline (`tools/handlers/dynamic.rs`); with no client subscribed, nothing answers. On the bus host, 1 of 502 rollouts from the last 30 days carried them, a desktop thread with the `codex_app` namespace (verified live, counted 2026-10-28).
- **Paginated history** (the desktop's default) resumes from the latest compaction onwards, across a fork's lineage of rollouts. Each ancestor segment is read only up to its own `session_meta`, and the thread's own `session_meta` is put first. A settings snapshot is written after every compaction (`session/mod.rs`), so the thread's latest one is in that span.
- **Plan mode's `request_user_input`** waits on the user whatever the approval policy. Under any approval policy but `never`, a turn with no client can wait on an approval indefinitely, holding the lock; under `never`, approvals fail at once (read in code).
- **Administrators can override `never`:** a `requirements.toml` that disallows an explicit approval policy replaces it with a warning, not an error (`config/mod.rs`). Neither machine has one (checked 2026-10-27).
- **Compressed rollouts:** with rollout compression on (off by default), rollouts older than 7 days become `.jsonl.zst`, while `thread/read` still reports the plain path (read in code).

## A resume with no client

What happens when a client resumes a thread loaded nowhere, unsubscribes and disconnects, as agent-bus's borrow does ([delivery](../architecture/delivery.md#codex-threads)): `thread/resume` with `excludeTurns` and `config: {thread_unload_delay_secs: 5}`, then `thread/unsubscribe`. Verified live on 2026-10-28 on throwaway threads, on the bus host (daemon 0.164.0-alpha.11.1) and the other machine (daemon 0.165.0, CLI 0.164.0):
- **The daemon runs what is queued,** and lets the thread go 5.0–5.5 s after it is idle, in every case. From the mail to the thread's reply took 8.5–12 s for a cold `codex exec`, private-server or daemon thread. Three messages 5 s apart were all read, and the thread was let go once the run ended.
- **The stored settings were unchanged** for the cold `exec`, private-server and daemon threads and the desktop thread: the approval policy, the profile id or type, and the collaboration mode in the thread's latest own snapshot (the compiled permissions weren't compared).
- **A thread another app-server holds is refused** ("already has an active writer"). The holder's own poll runs the item: a desktop Local thread replied after 21 s.
- **A daemon thread with a client attached** resumes at once, since it is already loaded. The client stays subscribed and sees the turn, and the thread stays loaded until the client leaves.
- **The turn may call any tool the thread has.** Some turns called `bus_join` before reading their mail, though the queued item didn't ask them to.

## The daemon

- **Starting.** `codex app-server daemon start` runs the managed package in `~/.codex/packages/app-server-daemon/`, installing it from the invoking CLI only if none is present. The daemon runs in a session of its own, so it outlives whatever started it, and it raises its own soft open-file limit to 4096 (read in code, 0.164). `codex app-server daemon version` reports the managed path and versions (verified live).
- **Updating.** A started daemon runs an update loop, on by default, but only for a stable standalone release, or while an installer's latest-release marker is pending (`app-server-daemon/src/lib.rs`). The bus host's managed package is a `local-…` build, so it likely never updates (inferred). A new version restarts it, which reloads its threads under the global unload delay, so a daemon can be ahead of the CLI that started it (read in code, 0.164; seen on the other machine).
- **SSH projects start one too.** On the bus host, after the daemon was stopped, a new one was running within 5 s, twice, under an incoming SSH session from another machine's desktop SSH project: the desktop's bundled CLI as `codex -c features.code_mode_host=true app-server --listen unix://` (verified live 2026-10-28). `codex app-server proxy` itself only connects to the socket and fails if nothing listens (`cli/src/main.rs`, `stdio-to-uds/src/lib.rs`), so the desktop's SSH connection must start the server before running it (inferred).
- **That one isn't the managed daemon.** It runs without `--managed-daemon`, so it neither raises its file limit nor runs the update loop (inferred from `app-server/src/lib.rs`).
- **Stopping.** `codex app-server daemon stop` stops a daemon the managed lifecycle started. It left the SSH-started one running (verified live).
- **The daemon keeps the login it started with.** After `~/.codex/auth.json` changed to another user of the same workspace, the running daemon still reported the earlier user and that user's exhausted weekly limit, and the turns it ran failed with "Your workspace is out of credits", while a new process's turns succeeded. A restarted daemon used the current login (verified live 2026-10-28, bus host, 0.164.0-alpha.11.1).

## `codex exec`

- **One run, one process.** `codex exec` runs its thread in-process and holds the writer lock while it runs (verified live). Afterwards the thread is loaded nowhere.
- **It can start a queued item, and may cut it off.** In one run, `codex exec resume` took a nudge queued during its turn as soon as that turn ended (`turn_trigger: queue`), then exited 2 s later, recording the queued turn as interrupted (verified live 2026-10-28, 0.164.0-alpha.11.1). So an item queued while it runs can be consumed without completing.
- **That leaves the thread's queue stalled** ([below](#an-interrupted-thread-runs-no-queued-input)).
- **It reads stdin when stdin isn't a terminal** and no prompt replaces it, waiting for input ("Reading additional input from stdin…"), so unattended runs with a prompt argument still need `< /dev/null` (verified live with `codex exec <prompt>`).

## An interrupted thread runs no queued input

The queue service's automatic dispatch runs nothing while a thread's status is `Interrupted`, and ignores the idle event an interrupt causes (read in `ext/queue/src/service.rs`, 0.164.0-alpha.11.1). The status comes back with the thread: after a turn was interrupted (by the user's Stop, or by a `codex exec` run exiting mid-turn), a later resume loaded the thread, wrote its settings record and ran nothing, while the queued item kept waiting (verified live 2026-10-28, bus host daemon). Automatic delivery resumes only after new input starts a turn. An explicit `thread/queue/start` on a server that has the thread loaded isn't subject to this check (read in code), so it would start the item.

## Approvals for MCP tools

Codex asks approval for an MCP call, or refuses it under approval policy `never`, unless the thread has full access or the tool says it is safe: read-only, or neither destructive nor open-world, with an unset hint counting as destructive and open-world (verified live and read in `core/src/mcp_tool_call.rs`, `requires_mcp_tool_approval`, Codex 0.164).
- **This is the default, `auto`, approval mode.** A server's `default_tools_approval_mode`, or a tool's `approval_mode`, in `[mcp_servers.<name>]` can be `prompt`, which asks for every call, `writes`, which asks for every call not marked read-only, or `approve`, which allows every call, destructive or not (read in `codex-mcp/src/mcp/mod.rs` and `server.rs`).
- **Strict auto-review** skips the annotation exemption (read in `maybe_request_mcp_tool_approval`).
