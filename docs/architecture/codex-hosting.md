# Codex hosting: what agent-bus runs, and why

agent-bus's decisions on top of Codex. Codex's own behaviour (its app-servers, the writer lock, how long a thread stays loaded, the queue, desktop features, the wake link, resuming, the daemon and `codex exec`) is in [platforms: Codex](../platforms/codex.md), with its versions and basis.

For the processes and transports on each machine, see [topology](topology.md); for the Codex nudge step by step, [delivery](delivery.md#codex-threads).

## The short answers

| Question | Answer |
| --- | --- |
| Why does the bus use a short-lived app-server of its own? | To post a nudge it needs only the thread's queue, which any app-server can reach without loading the thread, so posting works even with the daemon down. Loading a thread is left to the daemon's borrow ([below](#why-serve-uses-a-short-lived-app-server-of-its-own)) |
| When does the bus load a thread? | Only to run its own nudge, by a short borrow through the daemon, for a thread loaded nowhere that a resume can't widen or block ([delivery](delivery.md#codex-threads)) |
| Which threads can the bus wake? | [Delivery](delivery.md#how-each-kind-of-session-receives-mail) has the one table, per kind of session |
| How many app-servers run, how long they keep a thread, and what "desktop-capable" means | Codex facts, in [platforms: Codex](../platforms/codex.md) |

## The writer lock and the bus

A Codex thread has one writer at a time ([platforms: Codex](../platforms/codex.md#one-writer-per-thread)). [codex-wake](../frames/codex-wake.md) records what that cost when the bus resumed a thread: the daemon became a desktop thread's writer for the full unload delay, and the owner's window locked.

So agent-bus takes a lock only by borrowing a thread through the daemon ([load-on-mail](../frames/load-on-mail.md)). The lock refuses the borrow while another process holds the thread, and the daemon holds a borrowed thread only for the bus's turns, letting it go 5 s after it is idle and unsubscribed ([delivery](delivery.md#codex-threads)). A queue add loads nothing. A nudge that runs as a turn on a thread already loaded restarts its holder's idle clock, so each message can prolong that lock by up to the holder's delay.

## The wake link

The desktop's `threads/wake` link ([platforms: Codex](../platforms/codex.md#the-threadswake-link)) can't replace the queue add: the link carries no message, only "run what's queued". It can't replace the poll either: for a thread another app-server has loaded, the link fails and that server's poll runs the item. At most it could complement them, for threads loaded nowhere. agent-bus doesn't use it: it holds a thread until the app restarts, which shuts out the daemon and SSH projects, and it is private. Threads loaded nowhere are borrowed by the daemon instead ([load-on-mail](../frames/load-on-mail.md#rejected)).

## What agent-bus runs

Everything on this page is agent-bus's own design, read in `src/codex.ts` and the frames it cites, apart from the owner's Codex setting below.

### Why `serve` uses a short-lived app-server of its own

To wake a thread, the bus adds one nudge to the thread's queue and lets the thread's writer run it, then asks the daemon to borrow a thread loaded nowhere ([delivery](delivery.md#codex-threads)). For the post, `serve` needs only `thread/queue/list`, `thread/queue/add` and `thread/read`, and any app-server on the machine serves those without loading the thread. So `serve` starts one of its own:
- **It is never a writer.** Its app-server loads no thread. The only load the bus asks for is the daemon's borrow, which the writer lock refuses while another process holds the thread ([load-on-mail](../frames/load-on-mail.md)).
- **The post doesn't depend on the daemon.** Mail is posted even when the daemon is down or the thread can't be borrowed, and runs wherever the thread is next loaded.
- **The alternatives each cost more.** Posting through the daemon's socket would make every post depend on the daemon. The desktop's app-server has no entrance for other processes: its stdio belongs to the app, and driving its windows through the app's coordination socket was dropped untested ([desktop-wake-spike](../frames/desktop-wake-spike.md)). `thread/queue/start` runs an item only where the thread is already loaded, so `serve`'s app-server would first have to resume the thread and become its writer.
- **Short-lived bounds it.** It is started for each nudge and ended, killed if need be, and reaped before the address's lock is released, so an add that timed out can't land after a takeover. Each request gets 2 s and a whole nudge 6 s.
- **It is the desktop's bundled CLI** (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, or `serve --codex <path>`). The queue methods are experimental, and the bundled CLI is the same build as the desktop that reads the queue. There is no `PATH` fallback: `serve` runs under launchd's `PATH`, and another CLI's protocol could differ. For daemon threads, the daemon must accept the same protocol. On the other machine the daemon is 0.165.0 and the bundled CLI 0.164.0-alpha.11.1, and nudges and borrows worked on that pair ([platforms: Codex](../platforms/codex.md#a-resume-with-no-client), 2026-10-28).

### Which threads `serve` wakes

`serve` nudges a Codex peer only when it joined from this machine with its own thread id, since each machine's queues are in that machine's `~/.codex`. It doesn't care which app-server runs the thread: the desktop's or the daemon's, whichever is the writer, runs the nudge. A thread loaded nowhere is borrowed by the daemon, if it is eligible. A running `codex exec` holds the lock and takes a nudge queued during its turn, but may exit before that nudge's turn ends, which leaves the thread interrupted; Codex then runs no queued input for it, so `serve` doesn't borrow it until it has run a new turn ([platforms: Codex](../platforms/codex.md#an-interrupted-thread-runs-no-queued-input)). [Delivery](delivery.md#how-each-kind-of-session-receives-mail) gives the outcome for each kind of thread.

### The unload delay the owner chose

On 2026-10-27 the owner set `thread_unload_delay_secs = 300` in `~/.codex/config.toml` on both machines (Codex 0.164 on the bus host; the other machine's daemon is 0.165). It is a deliberate configuration, chosen so threads left on the daemon are freed in 5 minutes rather than 30.

The trade-off for the bus:
- **Waking doesn't depend on it.** A thread that has unloaded is borrowed again when mail comes, and each borrow carries its own 5 s release.
- **It governs threads a human loads** in the TUI or an SSH project: how long the daemon keeps them after the last client leaves. A borrow cuts that short for a thread already idle and left (to about 5 s after the borrowed turn), but not while a client is attached.
- **It applies after a daemon restart or update,** which reloads threads under the global delay, not a borrow's.
- The desktop's hold is driven by its UI, not by this setting.

That the setting takes effect without a restart was read in code, not tested.

### Why the owner works in Local threads

The first fix for the incident in [codex-wake](../frames/codex-wake.md) was to move the owner's threads onto the daemon, through an SSH project to the same machine or the `CODEX_APP_SERVER_WS_URL` override. An SSH project loses desktop features, and the override loses at least `codex_app` ([platforms: Codex](../platforms/codex.md#what-desktop-capable-means)), so the owner stays in Local threads, and the bus reaches them through their queue instead.

### What waking needs from each machine

- **`serve` has to reach the thread's queue.** It needs a queue-capable Codex CLI (`serve --codex`, by default the desktop's bundled one), run as the same user with the same Codex home, on the machine that owns the thread. For a desktop SSH project, that is the SSH host.
- **A daemon.** `serve` borrows through the daemon, and runs `codex app-server daemon start` when nothing listens on its socket, which needs a managed daemon package (or the invoking CLI to install one). [Platforms: Codex](../platforms/codex.md#the-daemon) has how the daemon starts, outlives its starter and updates itself. On the bus host, a desktop SSH project from another machine keeps a daemon running, though not the managed one, so `serve` rarely starts it there, and that daemon doesn't take the managed package's updates (inferred).
- **The daemon's login is the one its turns run under.** It keeps the login it started with, so after the owner changes the Codex login, borrowed turns run as the old user until the daemon restarts ([platforms: Codex](../platforms/codex.md#the-daemon)).
- **A wedged daemon,** whose socket answers but whose requests time out, makes borrows fail and back off with a warning. It needs restarting by hand.

