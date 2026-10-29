# Operate

Use this to check that the bus is healthy, read its logs and what the lines mean, restart or stop `serve` and Fluree, look after the Codex daemon, and run an isolated bus for checks. Where each process runs is in [topology](../architecture/topology.md); when something is wrong, go to [recover](recover.md).

## Before you start

The commands use the default labels, ports and state directory, and run on the machine whose processes you are operating.

| Process | LaunchAgent label | Runs on | Port | Log |
| --- | --- | --- | --- | --- |
| Fluree server | `ai.rawr.agent-bus.fluree` | Bus host | 8095 | `~/.agent-bus/fluree.log` |
| SSH tunnel | `ai.rawr.agent-bus.tunnel` | Other machines | 8095 | `~/.agent-bus/tunnel.log` |
| `agent-bus serve` | `ai.rawr.agent-bus` | Every machine | 8096 | `~/.agent-bus/agent-bus.log` |
| Codex daemon (not a LaunchAgent: Codex starts it) | none | Any machine with Codex | none (a Unix socket) | `~/.codex/app-server-control/app-server.log` |

- **The plists** are in `~/Library/LaunchAgents/<label>.plist`. Each has `KeepAlive`, so launchd restarts a process that exits, at most every 10 s. `gui/$(id -u)` in the commands is your user's launchd domain.
- **`serve` is the process sessions depend on.** A restart of it costs at most one extra wake per address, and it forgets which Claude hooks have called until they call again ([topology](../architecture/topology.md#where-state-lives)). Restarting Fluree leaves `serve` running ([Restart `serve`, Fluree or the tunnel](#restart-serve-fluree-or-the-tunnel)).
- **Every step's expected result ends with its mark** ([runbook shape](../../AGENTS.md#page-shapes)): *Rehearsed* on a disposable instance, *Checked read-only* on the running bus, or *Unverified*.
- **Don't try changes out on the running bus.** Use [an isolated bus](#run-an-isolated-bus-for-checks).

## Check that the bus is healthy

1. Ask both servers whether they answer. Fluree runs on the bus host only; on another machine its port is the tunnel to it.

   ```sh
   curl -fsS http://127.0.0.1:8096/health
   curl -fsS http://127.0.0.1:8095/health
   ```

   Expect `ok` from `serve` and `{"status":"ok","version":"…"}` from Fluree. `serve`'s answer says only that the process is up: it stays `ok` while Fluree is down. *Checked read-only 2026-10-28.* *Rehearsed 2026-10-28* for `ok` from `serve` with its Fluree stopped.

2. Read each job's state and last exit from launchd.

   ```sh
   launchctl print gui/$(id -u)/ai.rawr.agent-bus | grep -E '^[[:space:]](state|pid|runs|last (exit|terminating))'
   launchctl print gui/$(id -u)/ai.rawr.agent-bus.fluree | grep -E '^[[:space:]](state|pid|runs|last (exit|terminating))'
   ```

   Healthy is `state = running` with a `pid`. `last exit code = (never exited)` is a job that has not stopped since it was loaded. After a restart you will see `last exit code = 130` (a stop by signal) or `last terminating signal = Killed: 9`, and `runs` counts the starts. `state = spawn scheduled` with a non-zero exit code is a crash loop: see [recover](recover.md#serve-wont-start). *Checked read-only 2026-10-28.*

3. Check the whole path, from the CLI through `serve` to Fluree.

   ```sh
   agent-bus peers
   ```

   Expect one line per joined address, and exit status 0. With `serve` down it prints `MCP HTTP request failed`; with Fluree down, `serve` is up and it prints `Transport error (POST …/v1/fluree/query)`. *Checked read-only 2026-10-28* for the peers; *Rehearsed 2026-10-28* for both messages.

## Read the logs

1. Read the end of the log of the process you suspect.

   ```sh
   tail -n 50 ~/.agent-bus/agent-bus.log
   tail -n 20 ~/.agent-bus/fluree.log
   ```

   *Checked read-only 2026-10-28.*

2. Find when `serve` last started, then its warnings and errors. A warning's stack trace continues on indented lines, so the second command keeps only the lines that start with a timestamp.

   ```sh
   grep -n 'Listening on' ~/.agent-bus/agent-bus.log | tail -n 3
   grep -E '^\[[0-9:.]+\] (WARN|ERROR)' ~/.agent-bus/agent-bus.log | tail -n 20
   ```

   *Checked read-only 2026-10-28.*

3. Match what you see against the tables below.

How to read a log:
- **Timestamps.** `serve`'s are local time with no date (`[HH:MM:SS.mmm] LEVEL (#n): message`; `#n` is an internal fibre number), so date a line from the nearest `Listening on` line or the file's modification time. Fluree's and the Codex daemon's are UTC, with colour codes.
- **No rotation.** The files only grow, so an old log holds lines from earlier releases, such as `Delivery to … failed; will retry`, `Holding messages for …` and `Queued a nudge for …`. They are not in the tables.
- **Emptying a log** while its process runs is safe: `: > ~/.agent-bus/agent-bus.log`; the next line starts the file. *Rehearsed 2026-10-28.*
- **Debug lines are off.** The LaunchAgent starts `serve` at the default level, which hides the debug lines in the table (the running bus's log has none). `agent-bus serve --log-level debug` shows them: run it in the foreground on an [isolated bus](#run-an-isolated-bus-for-checks), not by editing the live plist. *Rehearsed 2026-10-28* for the flag; *Unverified* for the debug lines, which need a Codex peer.
- **Nothing else logs.** The `claude-wake` hook writes no log, and `serve`'s own Codex app-server writes into `serve`'s log only when it fails.

### What the lines of `serve` mean

"Basis" uses the marks' words: **Rehearsed** (produced on a disposable instance), **Checked read-only** (seen in the running bus's log) or **Unverified** (read in `src/serve.ts`, `src/Bus.ts`, `src/Fluree.ts`, `src/codex.ts` and `src/rollout.ts`, not seen).

| Line | Means | Needs action? | Basis |
| --- | --- | --- | --- |
| `INFO Listening on http://127.0.0.1:<port>` | `serve` started and is serving. One per start | No | Rehearsed, Checked read-only |
| `ERROR Error: Failed to start server. Is port <port> in use?` | Another process holds the port. launchd tries again every 10 s | Yes: [port held](recover.md#the-port-is-held) | Rehearsed |
| `<dir>/config.json has no Fluree ledger. Give it a "fluree" entry …` (no timestamp) | `config.json` is missing, or has no `fluree` entry | Yes: [config file](recover.md#the-config-file-is-bad) | Rehearsed |
| `ERROR SchemaError: Expected a valid JSON string` | `config.json` isn't valid JSON | Yes: [config file](recover.md#the-config-file-is-bad) | Rehearsed |
| `ERROR LedgerError: Transport error (GET <fluree url>/…)` at start | Nothing answers at the Fluree URL in `config.json` | Yes: [Fluree unreachable](recover.md#fluree-is-down-or-unreachable) | Rehearsed |
| `ERROR LedgerError: Fluree 401: {"error":"Bearer token required" …}` at start | `fluree-token` is missing or isn't accepted | Yes: [token](recover.md#fluree-wont-start-or-the-token-isnt-enforced) | Rehearsed |
| `WARN Fluree events disconnected, reconnecting: … Decode error (200 GET …/events…)`, once | The event stream closed, as when Fluree restarts, and `serve` reconnected | No | Rehearsed, Checked read-only |
| `WARN Fluree events disconnected, reconnecting: … Transport error (GET …/events…)`, every 5 s | Fluree, or the tunnel to it, is unreachable | Yes: [Fluree unreachable](recover.md#fluree-is-down-or-unreachable) | Rehearsed, Checked read-only |
| `WARN Delivery cycle failed LedgerError: …` with a stack trace | A delivery cycle (at every ledger change and every 15 s) couldn't read the peers from Fluree: `Transport error (POST …/v1/fluree/query)` is Fluree down, `Fluree 401` is the token. It stops when Fluree answers again | Yes, if it continues: [Fluree unreachable](recover.md#fluree-is-down-or-unreachable) | Rehearsed, Checked read-only |
| `WARN Skipping undecodable message in the Fluree ledger` | A ledger entry doesn't decode, and is skipped | Watch: after an upgrade it can mean a version mismatch | Unverified |
| `WARN Not waking <address> this pass: Cursor t=<n> is ahead of …` | A Claude address's cursor is beyond the ledger's end, so its hook isn't woken for it | Yes: [cursor ahead](recover.md#a-cursor-is-ahead-of-the-ledger) | Rehearsed |
| `WARN Not waking <address> this pass: <address> has not joined the bus …` | The address has no cursor on this machine | Yes: it must rejoin | Unverified |
| `INFO Waking <address>: queued a nudge, and the Codex daemon loaded its thread to run it` | A Codex thread was woken: the daemon borrowed it | No | Checked read-only |
| `INFO Waking <address>: queued a nudge; another Codex process holds its thread` (or `a nudge was already waiting; …`) | The desktop, or another app-server, has the thread loaded and runs the nudge itself | No | Checked read-only |
| `INFO Waking <address>: queued a nudge` and nothing more | The thread can't be borrowed, so its nudge waits to be loaded. A `Not borrowing` warning says why | See the next lines | Unverified |
| `INFO Still waking <address>: …` | The same mail is still unread at a reconcile: 5 minutes after the first attempt, then 15 and 60 after each next one, then hourly | Watch: the thread isn't reading | Checked read-only |
| `WARN Not borrowing <address>'s Codex thread: <reason>. Its nudge stays queued.` | The thread isn't eligible to borrow ([delivery rule 9](../architecture/delivery.md#rules)). Logged once per run of joins, and again when the reason changes | Only if you want it woken unloaded: [reasons](recover.md#a-codex-thread-isnt-woken) | Checked read-only |
| `WARN Could not wake <address>: <method>: <reason>. Next attempt in <delay>.` | A Codex step failed. The delay starts at 30 s and doubles to 5 minutes | Yes, if it repeats: [failures](recover.md#a-codex-thread-isnt-woken) | Unverified |
| `WARN Not waking <address>: its Codex thread takes no direct input (…). Its messages stay unread for bus_read until it rejoins.` | The address was joined by a Codex subagent, whose queue refuses nudges | Yes: [launch agents](launch-agents.md#delegates-subagents-and-one-shot-runs) | Unverified |
| `WARN <address> hasn't read its mail after 3 attempts to wake it since the first; trying hourly until it does.` | Three reconciles passed with the mail unread | Yes: [not woken](recover.md#a-codex-thread-isnt-woken) | Checked read-only |
| `WARN <address> hasn't read its mail after 3 checks that its nudge still waits; its thread can't be borrowed (<reason>) …` | The same, for a thread that can't be borrowed | Yes: [not woken](recover.md#a-codex-thread-isnt-woken) | Checked read-only |
| `WARN Could not nudge <address>: <message>` | A wake failed in a way that isn't a Codex error, such as a ledger error. There is no back-off | Watch | Unverified |
| Debug: `<address> read its mail while our nudge waited: removed it` (or `it had already run`, or `it was edited, so it was left`) | `serve` took its own waiting nudge back out after a read ([delivery rule 7](../architecture/delivery.md#rules)) | No | Unverified |
| Debug: `Could not remove <address>'s nudge: <method>: <message>` | The removal failed. It isn't tried again | No | Unverified |

### What the other logs say

| Log and line | Means | Needs action? | Basis |
| --- | --- | --- | --- |
| Fluree: `WARN … data auth is required but events auth is off …`, at every start | The installer starts Fluree with data and admin authentication required and events authentication left at its default ([platforms: Fluree](../platforms/fluree.md#the-event-stream)) | No | Rehearsed, Checked read-only |
| Fluree: `error: server error: Address already in use (os error 48)` | Another process holds Fluree's port | Yes: [Fluree won't start](recover.md#fluree-wont-start-or-the-token-isnt-enforced) | Rehearsed |
| Fluree: `ERROR … query execution failed … Query cancelled: client_disconnected` | A client dropped a query before it finished. It showed 7 times in two days on the running bus, with no symptom | No (the cause is inferred from the message) | Checked read-only |
| Codex daemon: `ERROR … Failed to create session: thread-store conflict: thread <id> already has an active writer` | `serve`'s borrow was refused because another process holds the thread. It happens together with `another Codex process holds its thread` in `serve`'s log | No | Checked read-only |
| Tunnel: the output of `ssh -N` | The tunnel's own errors (host key, refused key, a port already in use) | Yes, if the tunnel is down: [the tunnel](recover.md#the-tunnel-is-down) | Unverified (needs the other machine) |

## Restart `serve`, Fluree or the tunnel

`kickstart -k` restarts a process with the plist it already has. launchd sends `SIGTERM`, then `SIGKILL` after 5 s, and starts it again.

1. Restart `serve`, then check that it has a new `pid`, that `runs` has gone up by one, and that it answers.

   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus
   launchctl print gui/$(id -u)/ai.rawr.agent-bus | grep -E '^[[:space:]](state|pid|runs|last (exit|terminating))'
   curl -fsS http://127.0.0.1:8096/health
   ```

   Expect a new pid, `runs` up by one, `last exit code = 130` and `ok`, and a second `Listening on` line in the log. *Rehearsed 2026-10-28.*

2. Restart Fluree, on the bus host.

   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus.fluree
   curl -fsS http://127.0.0.1:8095/health
   ```

   Expect Fluree to answer again. `serve` keeps running and finds Fluree by itself; its log gets one `Fluree events disconnected … Decode error` warning, and the peers are still listed, since the ledger is on disk. *Rehearsed 2026-10-28.*

3. Restart the tunnel, on another machine.

   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus.tunnel
   ```

   *Unverified: needs the other machine.*

4. Kill a process by its pid, if `launchctl` can't reach it.

   ```sh
   kill -TERM <pid from launchctl print>
   ```

   Expect a new pid within the 10 s throttle, and `ok`. *Rehearsed 2026-10-28* (a new pid after 1 s).

## Stop and start `serve`, Fluree or the tunnel

`bootout` stops a job and unloads it, so it stays stopped; `bootstrap` loads it again. Start Fluree before `serve`: a `serve` that starts without Fluree exits and is retried every 10 s until Fluree answers.

1. Stop `serve`, and wait until launchd has finished with it. `bootout` returns before the old job is gone; the installer waits up to about ten seconds for the same.

   ```sh
   launchctl bootout gui/$(id -u)/ai.rawr.agent-bus
   while launchctl print gui/$(id -u)/ai.rawr.agent-bus >/dev/null 2>&1; do sleep 0.2; done
   ```

   Expect the health check to be refused (`Couldn't connect to server`). *Rehearsed 2026-10-28.*

2. Start it, and check that it answers.

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.rawr.agent-bus.plist
   curl -fsS http://127.0.0.1:8096/health
   ```

   Expect `ok`. Bootstrapping straight after `bootout`, without the wait in step 1, often fails with `Bootstrap failed: 5: Input/output error` and leaves the job unloaded: wait as in step 1 and run `bootstrap` again. *Rehearsed 2026-10-28* (the error on 3 of 5 tries without the wait, none of 5 with it).

3. Stop or start Fluree (bus host) or the tunnel (other machines) the same way, with their labels and plists. While Fluree is stopped, `serve` stays up and warns every 5 s; it recovers once Fluree is loaded.

   *Rehearsed 2026-10-28* for Fluree; *Unverified* for the tunnel: needs the other machine.

A job stopped with `bootout` should load again at your next login, since its plist has `RunAtLoad`. *Unverified: needs a login.*

## Rerun the installer instead

Use the installer, rather than `kickstart` or `bootstrap`, when the plist itself must change: `bun` or `fluree` has moved, the checkout `serve` runs from has moved, a port or flag has changed, or `bootstrap` keeps failing. It rewrites the plists from the current `PATH`, restarts both LaunchAgents, and keeps `config.json`, the key, the token and the ledger. Run it from the checkout that `serve` should run: the primary checkout ([deploy](deploy.md)).

1. Rerun it. On another machine, add `-- --remote <ssh host of the bus host>`; [install](install.md) has the prerequisites.

   ```sh
   bun run install:launch-agents
   ```

   Expect both jobs loaded, whatever state `serve` was in (it was in `spawn scheduled` with a missing `bun`). *Rehearsed 2026-10-28.* The `--remote` form is *Unverified*: needs the other machine.

2. Check that both jobs have new pids, `serve` answers, and the peers are still there.

   ```sh
   curl -fsS http://127.0.0.1:8096/health
   agent-bus peers
   ```

   *Rehearsed 2026-10-28.*

## Read or change the Codex unload setting

`thread_unload_delay_secs` in `~/.codex/config.toml` is how long a Codex app-server keeps a thread loaded after it is idle and nobody is subscribed. The owner set it to 300 on both machines (Codex's default is 1800). How it applies, and what it does and doesn't govern, is in [platforms: Codex](../platforms/codex.md#how-long-a-thread-stays-loaded); why waking doesn't depend on it is in [delivery's rules](../architecture/delivery.md#rules) and [limits](../architecture/delivery.md#for-codex-threads).

1. Read it. This is the only step to run.

   ```sh
   grep -n thread_unload_delay_secs ~/.codex/config.toml
   ```

   Expect `thread_unload_delay_secs = 300`. *Checked read-only 2026-10-28.*

2. To change it, the owner edits that line: a top-level key (not in a profile), in whole seconds. It is the owner's setting, so it is described here and not run. Whether an edit applies without a daemon restart is read in code, not tested. *Unverified: not run.*

## The Codex daemon: file limit and restarts

The facts are in [platforms: Codex](../platforms/codex.md#the-daemon): the daemon inherits the open-file limit of whatever started it, so it can fail with `Too many open files` as threads load; `daemon restart` refuses a daemon Codex didn't start itself; and a desktop SSH project starts an unmanaged daemon of its own. Restart it when it hits the limit, after a Codex login change, or when it is [wedged](recover.md#the-codex-daemon-is-wedged).

**A restart can lose work.** `serve`, the desktop's SSH projects and the TUI all share the daemon, and a stop unloads every thread on it. What survives depends on where the work is:
- **A pending queue item** (a nudge or the owner's own) is in `~/.codex/queue_1.sqlite`, so it survives. It runs when a thread is next loaded, unless the thread's last turn was interrupted: then it waits for new input ([platforms: Codex](../platforms/codex.md#an-interrupted-thread-runs-no-queued-input)).
- **A turn that has started is lost.** Codex deletes a queue item when its turn starts, so nothing remains to run again; and a turn that has already read its mail leaves no unread mail, so `serve`'s reconciles don't retry it. A stop and start may not resume the turn at all (unverified).

So for a routine restart, drain first (step 3). A wedged or failing daemon can't be drained: accept the interruption, and reopen its threads afterwards (step 7).

1. See which daemon runs, and how it was started.

   ```sh
   ps -axo pid,lstart,command | grep '[a]pp-server'
   codex app-server daemon version
   ```

   A daemon started with `--managed-daemon` is managed. One started as `app-server --listen unix://` was started by a desktop SSH project. Expect the daemon beside the desktop's own app-server. *Checked read-only 2026-10-28.*

2. See which threads the daemon holds, so you know what a restart drops.

   ```sh
   lsof +D ~/.codex/thread-writer-locks
   ```

   Each thread an app-server has loaded holds a lock file there; the lines with the daemon's pid are its threads. Expect lock files held by the desktop's app-server and the daemon. *Checked read-only 2026-10-28.*

3. Drain it. For each of those threads, ask whoever works in it whether a turn is running, and wait until it has ended. List any pending queue items of the thread with the read-only listing in [recover](recover.md#a-codex-thread-isnt-woken), step 2, so you know what will wait. *Unverified: no way was found to read a turn's state from outside; the running daemon was not touched.*

4. Stop competing starters first. A desktop SSH project that reconnects starts an unmanaged daemon within about 5 s of a stop, with that connection's limit ([platforms: Codex](../platforms/codex.md#the-daemon)). List the proxies that reach this daemon, ask whoever owns each SSH project to close it, and wait for them to go.

   ```sh
   ps -axo pid,ppid,command | grep '[a]pp-server proxy'
   ```

   Expect one line per SSH project or terminal client connected. *Checked read-only 2026-10-28* (the listing); *Unverified* that closing the projects prevents the restart.

5. Stop the daemon, and wait, with a deadline, until the old process and its socket listener have gone. A daemon that is still answering makes the next `daemon start` report that one is already running, and the old process can then exit with no replacement (read in Codex's pinned source). If it is managed, stop it with `codex app-server daemon stop`; otherwise:

   ```sh
   old=<daemon pid>
   sock=$(readlink ~/.codex/app-server-control/app-server-control.sock)
   kill -TERM $old
   for i in $(seq 1 30); do kill -0 $old 2>/dev/null || break; sleep 1; done
   kill -0 $old 2>/dev/null && echo "still running"
   lsof -nU 2>/dev/null | grep "$sock"
   ```

   Expect no "still running" and no output from `lsof`. `daemon stop` leaves an SSH-started daemon running, so use `kill`. If it is still running after 30 s, escalate with `kill -KILL $old`. That ends it without letting it finish: whatever it had not yet written is lost, such as the last events of running turns, and its socket file is left behind (a stale socket refuses connections, which `serve` reads as "no daemon"). *Unverified* for the stop: the running daemon is in use. The `readlink` and `lsof` forms ran read-only on it (*Checked read-only 2026-10-28*).

6. Start it from a shell with the limit raised. The subshell keeps the raised limit to itself. If it reports a daemon already running, the old one has not gone: go back to step 5.

   ```sh
   (ulimit -S -n 10240 && codex app-server daemon start)
   ```

   Expect a child shell's soft limit to go from 2048 to 10240 (*Rehearsed 2026-10-28* for the limit). The daemon start is *Unverified*: the running daemon is in use.

7. Verify that a new daemon is running, and that you started it. The pid must differ from `$old`. A daemon you started with `daemon start` has `--managed-daemon` in its command line; one without it is an SSH project's, with a low limit, which won the race: stop it and repeat from step 4. The daemon runs in a session of its own, so its parent is `launchd` and says nothing about who launched it; the command line does.

   ```sh
   ps -axo pid,lstart,command | grep '[a]pp-server'
   codex app-server daemon version
   ```

   *Checked read-only 2026-10-28* for the listing and the parent being `launchd`; *Unverified* for the result of a restart.

8. Check the limit. No unprivileged command shows another process's open-file limit on macOS: `launchctl procinfo <pid>` refuses without root (*Checked 2026-10-28*), and what it prints with root is *Unverified*. So the limit itself is *Unverified*. A count of the daemon's open descriptors is only utilisation, how close it is to the limit, and a low count proves nothing. Watch for the failure itself.

   ```sh
   lsof -p <daemon pid> | wc -l
   grep -c 'Too many open files' ~/.codex/app-server-control/app-server.log
   ```

   *Unverified: the running daemon was not touched.*

9. Verify and reopen. Send a message to a Codex test address, or wait for the next reconcile, and look for `Waking <address>` in `serve`'s log. Then open each thread that was mid-turn: look at its last turn, and give it new input if it was cut off, since an interrupted thread runs no queued input. *Unverified: needs a Codex session.*

What not to do:
- **Don't add a launchd job for the daemon.** Keep Codex's own `start` and `stop`. `daemon bootstrap` installs no login item and hasn't been qualified for restarts after a reboot. Nothing starts the daemon at boot: the CLI, SSH proxies and `serve` start it on first use.
- **Don't archive or delete a thread to release it.** To reach a thread the daemon holds, see [recover](recover.md#a-codex-thread-isnt-woken).

## Run an isolated bus for checks

A bus of your own lets you call tools, join addresses and break things without touching the running one. Calls write the ledger and consume messages, so never point a check at port 8096. There are two ways.

**A throwaway bus in the foreground**, for trying tools with the MCP Inspector. Its Fluree is in memory with no authentication, so it exists only while the commands run.

1. Start a throwaway Fluree and a `serve` against it, from the checkout.

   ```sh
   fluree server run --memory --listen-addr 127.0.0.1:18095 &
   fluree_pid=$!
   dir=$(mktemp -d)
   echo '{ "fluree": { "url": "http://127.0.0.1:18095", "ledger": "check:main" } }' > "$dir/config.json"
   AGENT_BUS_DIR=$dir AGENT_BUS_PORT=8196 bun src/bin.ts serve &
   serve_pid=$!
   curl -fsS http://127.0.0.1:8196/health
   ```

   Expect `ok`. *Rehearsed 2026-10-28.*

2. List the tools and call one with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector). Its CLI mode prints each result as JSON.

   ```sh
   npx @modelcontextprotocol/inspector@2.12.0 --cli http://127.0.0.1:8196/mcp --method tools/list
   npx @modelcontextprotocol/inspector@2.12.0 --cli http://127.0.0.1:8196/mcp --method tools/call \
     --tool-name bus_join --tool-arg address=claude/check runtime=claude session=check cwd=$PWD
   ```

   Expect the ten tools, then a join result with a `cursor`. The Inspector exits with status 5 when a tool returns `isError`. `test/mcp-official.test.ts` makes the same kind of calls with the official TypeScript SDK on every `bun run check`. *Rehearsed 2026-10-28*, with the package from the local `npx` cache (`--offline`); a first run downloads it.

3. Stop both by pid, and move the directory to the Trash.

   ```sh
   kill $serve_pid $fluree_pid
   mv "$dir" ~/.Trash/
   ```

   *Rehearsed 2026-10-28.*

**A LaunchAgent instance**, for rehearsing restarts, installs and failures. The installer takes five overrides, so an instance runs beside the real bus. Check that the label ends in `-rehearsal-<x>` before every `launchctl` command, and use only `rehearsal/…` addresses.

Do the whole rehearsal in a separate shell session, or in a subshell, so the five variables don't outlive it: left exported, they would point later CLI calls at a dead port, and a later installer run would recreate the rehearsal install. If you set them in your own shell, run `unset AGENT_BUS_DIR AGENT_BUS_FLUREE_PORT AGENT_BUS_PORT AGENT_BUS_LABEL AGENT_BUS_LAUNCHER` at cleanup.

1. Install it. The label is a prefix: the instance has `<label>` and `<label>.fluree`. It runs the code of the checkout you ran the installer from.

   ```sh
   export AGENT_BUS_DIR=/tmp/bus-check/bus AGENT_BUS_FLUREE_PORT=18295 AGENT_BUS_PORT=18296 \
     AGENT_BUS_LABEL=ai.rawr.agent-bus-rehearsal-x AGENT_BUS_LAUNCHER=/tmp/bus-check/bin/agent-bus
   ./scripts/install-launch-agents.sh
   ```

   Expect both jobs running, both ports answering and the running bus untouched. *Rehearsed 2026-10-28.*

2. Use its own `agent-bus` link, in the same session, for every other command in this runbook, with the label and ports changed.

   ```sh
   /tmp/bus-check/bin/agent-bus join --address rehearsal/one --runtime other --session one
   /tmp/bus-check/bin/agent-bus peers
   ```

   Expect the join and the peer line. *Rehearsed 2026-10-28.*

3. Remove it when you are done: unload both jobs and move their files to the Trash.

   ```sh
   launchctl bootout gui/$(id -u)/ai.rawr.agent-bus-rehearsal-x
   launchctl bootout gui/$(id -u)/ai.rawr.agent-bus-rehearsal-x.fluree
   mv ~/Library/LaunchAgents/ai.rawr.agent-bus-rehearsal-x*.plist /tmp/bus-check ~/.Trash/
   ```

   Expect both ports to stop answering and the files gone. Then end the session, or unset the five variables as above. *Rehearsed 2026-10-28* (the rehearsal ran in a session of its own).

An isolated `serve` still reads your real `~/.codex`. Don't join a Codex address on it: it would post nudges into your real threads.

## If it fails

- A process won't start, or keeps restarting: [serve won't start](recover.md#serve-wont-start) and [Fluree won't start](recover.md#fluree-wont-start-or-the-token-isnt-enforced).
- `serve` is up but Fluree isn't answering: [Fluree is down or unreachable](recover.md#fluree-is-down-or-unreachable).
- The tunnel is down: [the tunnel](recover.md#the-tunnel-is-down).
- A session or thread isn't woken: [Claude](recover.md#a-claude-session-isnt-woken) and [Codex](recover.md#a-codex-thread-isnt-woken).
- Borrows time out: [the wedged daemon](recover.md#the-codex-daemon-is-wedged).
