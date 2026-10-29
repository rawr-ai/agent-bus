# Recover

Use this when the bus misbehaves: each symptom, how to check it, the fix and how to verify it. Routine operation, health checks and the meaning of log lines are in [operate](operate.md).

## Before you start

- **Look before you fix.** Run the three health checks in [operate](operate.md#check-that-the-bus-is-healthy) and read the end of `~/.agent-bus/agent-bus.log`. Most symptoms below name a log line.
- **Nothing here deletes ledger data.** The fixes restart processes, rewrite a file the installer wrote, or move a cursor file aside. Mail that wasn't woken for stays in the ledger and in `bus_history`.
- **Two fixes are the human's call, not the agent's:** taking over an address held by another session, and moving a cursor.
- **Never archive or delete a Codex thread to release it.**
- **Each step's expected result ends with its mark** ([runbook shape](../../AGENTS.md#page-shapes)): *Rehearsed 2026-10-28* on a disposable instance, *Checked read-only 2026-10-28* on the running bus, or *Unverified*. Commands use the default labels, ports and `~/.agent-bus`; `<address>` and `<thread id>` are yours.

## Find your symptom

| Symptom | Check | Fix | Verify |
| --- | --- | --- | --- |
| `agent-bus peers` says `MCP HTTP request failed`; `serve`'s job is `spawn scheduled`, or its log repeats an error | `launchctl print` for the job, and the end of the log | By the log line: [port held](#the-port-is-held), [config file](#the-config-file-is-bad), [bun missing](#bun-is-missing-from-the-plist) | `curl http://127.0.0.1:8096/health` answers `ok` |
| `serve` answers, but calls fail with `Transport error` or `Fluree 401`, or its log warns every 5 s | `curl http://127.0.0.1:8095/health` | [Fluree is down or unreachable](#fluree-is-down-or-unreachable) | The warnings stop and `agent-bus peers` lists the peers |
| Fluree's job is `spawn scheduled`, or an unauthenticated request to it isn't refused | Its log, and the 401/200 test | [Fluree won't start, or the token isn't enforced](#fluree-wont-start-or-the-token-isnt-enforced) | 401 without the token, 200 with it |
| On another machine, Fluree's port doesn't answer, but the bus host's does | The tunnel job and its log | [The tunnel is down](#the-tunnel-is-down) | The port answers; `serve`'s warnings stop |
| A Claude session isn't woken for mail | The plugin, then `hooked` in its join result | [A Claude session isn't woken](#a-claude-session-isnt-woken) | The next message wakes it in seconds |
| A Codex thread doesn't act on its mail | The log lines for its address, and its queue | [A Codex thread isn't woken](#a-codex-thread-isnt-woken) | The queue no longer holds the nudge |
| `Could not wake …: … no answer within 15s` for several threads | The daemon's process and log | [The Codex daemon is wedged](#the-codex-daemon-is-wedged) | The next cycle logs `Waking <address>` |
| Borrowed turns fail with "out of credits", or run as the earlier user | Whether the Codex login changed since the daemon started | [Borrowed turns run as an earlier user](#borrowed-turns-run-as-an-earlier-user) | A borrowed turn succeeds |
| A join is refused with "held by another session" | The refusal's facts about the holder | [Held by another session](#held-by-another-session) | `agent-bus peers` shows the address with the right owner |
| A read fails with "Cursor t=… is ahead of …" | The address's cursor file | [A cursor is ahead of the ledger](#a-cursor-is-ahead-of-the-ledger) | The read returns, and the warnings stop |
| A command run over SSH on the other machine can't find `bun` | `command -v bun` over SSH | [`bun` not found over SSH](#bun-not-found-over-ssh-on-the-other-machine) | The command runs |

## serve won't start

Read what launchd and the log say, then follow the row that matches.

```sh
launchctl print gui/$(id -u)/ai.rawr.agent-bus | grep -E '^[[:space:]](state|pid|runs|program|last (exit|terminating))'
tail -n 20 ~/.agent-bus/agent-bus.log
```

| You see | Cause |
| --- | --- |
| `last exit code = 1` and `Failed to start server. Is port 8096 in use?` | [The port is held](#the-port-is-held) |
| `last exit code = 1` and `has no Fluree ledger`, or `SchemaError` | [The config file is bad](#the-config-file-is-bad) |
| `last exit code = 1` and `Transport error (GET …/exists/…)` | [Fluree is down or unreachable](#fluree-is-down-or-unreachable) |
| `last exit code = 1` and `Fluree 401` | [Fluree won't start, or the token isn't enforced](#fluree-wont-start-or-the-token-isnt-enforced) (a missing token) |
| `last exit code = 78: EX_CONFIG`, a `program` that doesn't exist, and nothing in the log | [bun is missing from the plist](#bun-is-missing-from-the-plist) |

While the cause stands, the job stays in `state = spawn scheduled` and launchd tries again every 10 s. Each of these five states was produced on a disposable instance: *Rehearsed 2026-10-28.*

### The port is held

1. Find the process on the port.

   ```sh
   lsof -nP -iTCP:8096 -sTCP:LISTEN
   ```

   Expect the holder's command and pid. *Rehearsed 2026-10-28.*

2. Stop it by its pid, unless you need it. A `serve` started by hand is one example. If you need the other program, give `serve` another port by rerunning the installer with `AGENT_BUS_PORT` set: sessions' MCP registration and the Claude hook must then use the same port ([interfaces](../architecture/interfaces.md#configuration-and-environment)).

   ```sh
   kill <pid>
   curl -fsS http://127.0.0.1:8096/health
   ```

   Expect `serve` to start within the 10 s throttle, and `ok`. *Rehearsed 2026-10-28* (healed in 1 s). The other port is *Unverified*.

### The config file is bad

`~/.agent-bus/config.json` must name the Fluree ledger. `serve` won't start without it.

1. Read it. It should be:

   ```json
   { "fluree": { "url": "http://127.0.0.1:8095", "ledger": "agent-bus:main" } }
   ```

   The same URL is right on another machine: the tunnel gives it the bus host's Fluree on the same port.

   ```sh
   cat ~/.agent-bus/config.json
   ```

   Three bad forms (no `fluree` entry, invalid JSON, a URL nothing listens on) each exit `serve` with status 1 and a log line. *Rehearsed 2026-10-28.*

2. Fix it by hand to the form above, or move it aside and let the installer write it again. The installer writes it only when it is absent and keeps everything else.

   ```sh
   mv ~/.agent-bus/config.json ~/.agent-bus/config.json.bad
   bun run install:launch-agents
   curl -fsS http://127.0.0.1:8096/health
   ```

   Expect the file rewritten and `ok`. *Rehearsed 2026-10-28.*

### bun is missing from the plist

The plist holds the absolute path of the `bun` found when the installer ran. If that file has gone, launchd can't start the job, and the log stays empty. The hook is different: it runs `~/.local/bin/agent-bus`, which needs `bun` on the `PATH` Claude Code gives it, and the plugin puts `~/.local/bin` and `~/.bun/bin` first.

1. Check the plist's `bun` and the hook's launcher.

   ```sh
   ls -l "$(launchctl print gui/$(id -u)/ai.rawr.agent-bus | awk '/program =/{print $3}')"
   cd / && env -i HOME="$HOME" PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin" ~/.local/bin/agent-bus --help >/dev/null; echo "launcher exit $?"
   ```

   Expect the `ls` to find the file, and exit 0 from the launcher. With `bun` missing from the plist, `serve` shows `EX_CONFIG`; with `bun` missing from the launcher's `PATH`, it prints `env: bun: No such file or directory`. *Rehearsed 2026-10-28* for both failures; *Checked read-only 2026-10-28* for exit 0.

2. Rerun the installer from a shell where `command -v bun` finds the real `bun`. It rewrites the plists and restarts both jobs. If `bun` lives somewhere the hook can't see, link it first: `ln -s "$(command -v bun)" ~/.local/bin/bun`.

   ```sh
   command -v bun
   bun run install:launch-agents
   curl -fsS http://127.0.0.1:8096/health
   ```

   Expect `ok`. *Rehearsed 2026-10-28*; the link is *Unverified*.

## Fluree is down or unreachable

`serve` stays up when Fluree doesn't answer, and its `/health` stays `ok`. Calls fail with `Transport error (POST …/v1/fluree/query)`, and the log warns every few seconds. Nothing is lost: the ledger is on disk.

1. Check Fluree, its job and the log.

   ```sh
   curl -fsS http://127.0.0.1:8095/health
   launchctl print gui/$(id -u)/ai.rawr.agent-bus.fluree | grep -E '^[[:space:]](state|pid|runs|last (exit|terminating))'
   grep -E '^\[[0-9:.]+\] (WARN|ERROR)' ~/.agent-bus/agent-bus.log | tail -n 5
   ```

   Expect a refused connection, then `Delivery cycle failed … Transport error` and `Fluree events disconnected … Transport error` about every 5 s. *Rehearsed 2026-10-28.*

2. Start Fluree. On the bus host, if its job is unloaded or stopped:

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.rawr.agent-bus.fluree.plist
   ```

   If it is loaded but not running, or crash-looping, go to [Fluree won't start](#fluree-wont-start-or-the-token-isnt-enforced). On another machine the tunnel is the cause: [the tunnel is down](#the-tunnel-is-down). `serve` needs no restart. *Rehearsed 2026-10-28.*

3. Verify.

   ```sh
   curl -fsS http://127.0.0.1:8095/health
   agent-bus peers
   ```

   Expect the health answer, the peers and no new warnings. *Rehearsed 2026-10-28.*

After an outage longer than 10 minutes, Claude hooks that kept retrying have given up: those sessions wake again only after their next arming point ([a Claude session isn't woken](#a-claude-session-isnt-woken)).

## Fluree won't start, or the token isn't enforced

The installer starts Fluree with data and admin authentication required, and checks that the server on the port answers 401 without the token and 200 with it. If another server holds the port, it stops with "does not enforce the bus token".

1. Read the job and its log.

   ```sh
   launchctl print gui/$(id -u)/ai.rawr.agent-bus.fluree | grep -E '^[[:space:]](state|pid|runs|program|last (exit|terminating))'
   tail -n 5 ~/.agent-bus/fluree.log
   ```

   `Address already in use (os error 48)` means the port is held (*Rehearsed 2026-10-28*). `EX_CONFIG` with an empty log means the `fluree` named in the plist has gone, as with [bun](#bun-is-missing-from-the-plist) (*Unverified*).

2. Test whether the server on the port enforces the token. The token goes to `curl` through its standard input, so it isn't in the process list.

   ```sh
   url=http://127.0.0.1:8095/v1/fluree/exists/agent-bus%3Amain
   curl -s -o /dev/null -w '%{http_code}\n' "$url"
   printf 'Authorization: Bearer %s\n' "$(cat ~/.agent-bus/fluree-token)" | curl -s -o /dev/null -w '%{http_code}\n' -H @- "$url"
   ```

   Expect `401`, then `200`. Two `200`s mean the server isn't the bus's; two `401`s mean the token isn't accepted. *Rehearsed 2026-10-28* for all three outcomes; *Checked read-only 2026-10-28* for 401 then 200.

3. Fix by cause, then rerun the installer.
   - **The port is held:** find the process (`lsof -nP -iTCP:8095 -sTCP:LISTEN`) and stop it by pid.
   - **The token is missing or invalid:** the installer creates a new one with the existing key.
   - **The key is gone:** the installer creates a new key and token and starts Fluree trusting the new key. Old tokens stop working, including the copy on another machine: rerun the installer there with `--remote <ssh host of the bus host>`. The ledger isn't affected.

   ```sh
   bun run install:launch-agents
   ```

   Expect the installer to refuse while an unauthenticated server holds the port, and to finish once it is stopped. *Rehearsed 2026-10-28* for the held port, a lost token and a lost key (the new token accepted, the old one refused, the peers kept); `--remote` is *Unverified*: needs the other machine.

4. Verify with the test in step 2, then `agent-bus peers`. *Rehearsed 2026-10-28.*

## The tunnel is down

On another machine, `serve` reaches the bus host's Fluree on `127.0.0.1:8095` through an SSH tunnel. The installer runs it with `ExitOnForwardFailure` and a 15 s keep-alive that drops a dead connection after about 45 s, and launchd restarts it. *Unverified, every step: it needs the other machine, and no SSH was made to it. The commands are the installer's own.*

1. Check the tunnel job, its log, and whether the port answers.

   ```sh
   launchctl print gui/$(id -u)/ai.rawr.agent-bus.tunnel | grep -E '^[[:space:]](state|pid|runs|last (exit|terminating))'
   tail -n 20 ~/.agent-bus/tunnel.log
   curl -fsS http://127.0.0.1:8095/health
   ```

2. Check that SSH works as the tunnel runs it, with no prompts. A changed host key, a refused key and an unreachable host all show here. Then check that nothing else holds the local port, since the tunnel exits if it can't bind it.

   ```sh
   ssh -o BatchMode=yes <ssh host of the bus host> true
   lsof -nP -iTCP:8095 -sTCP:LISTEN
   ```

3. Restart the tunnel, or rerun the installer with `--remote` if the plist is wrong, and verify: the port answers with Fluree's health and `serve`'s warnings stop.

   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus.tunnel
   curl -fsS http://127.0.0.1:8095/health
   agent-bus peers
   ```

## A Claude session isn't woken

The plugin's hook waits in `bus_wake` and exits 2 with a line when mail arrives. [Delivery](../architecture/delivery.md#when-a-claude-session-isnt-armed) lists every way a session can be unarmed. Mail that wasn't woken for stays unread and readable with `bus_read`.

1. Check that the plugin is installed and enabled, and that the session is one that can be woken: a desktop or terminal session, not `claude -p`.

   ```sh
   claude plugin list
   ```

   Expect `agent-bus@agent-bus` with `Status: ✔ enabled`. *Checked read-only 2026-10-28.*

2. Check that its hook has called `serve`. Ask the session to call `bus_join` again with the same address: a rejoin by its owner keeps its unread mail. The result carries `hooked: true` once `serve` has seen the session's hook since `serve` started; without it, the hook isn't waiting. *Rehearsed 2026-10-28* with a simulated hook (no `hooked` before the hook called, `hooked: true` while it waited); *Unverified* with a real session.

3. Check that the hook can run at all.

   ```sh
   cd / && env -i HOME="$HOME" PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin" ~/.local/bin/agent-bus --help >/dev/null; echo "launcher exit $?"
   ```

   Expect exit 0. *Checked read-only 2026-10-28.*

4. To see what the hook does, run it by hand on an isolated bus ([operate](operate.md#run-an-isolated-bus-for-checks)) with a made-up session id. **Never run it with a real session's id on the running bus:** its call replaces that session's own waiting hook.

   ```sh
   agent-bus join --address rehearsal/hook --runtime claude --session check-1
   agent-bus join --address rehearsal/sender --runtime other --session sender-1
   echo '{"session_id":"check-1"}' | agent-bus claude-wake & hook=$!
   agent-bus publish --from rehearsal/sender --runtime other --session sender-1 --to rehearsal/hook --body ping
   wait $hook; echo "hook exit $?"
   ```

   Expect the line `[agent-bus] New messages for "rehearsal/hook". Read them with …` on stderr and exit 2. A hook for a session that owns no address returns at once with exit 0. *Rehearsed 2026-10-28.*

5. Fix by cause.
   - **No plugin, or an old one:** install or update it ([install](install.md)): `claude plugin marketplace update agent-bus`, then `claude plugin update agent-bus@agent-bus`. Start the session again or run `/reload-plugins`.
   - **Unarmed** (an interrupted turn, an outage over 10 minutes, 30 days idle, `/clear`): give the session any prompt. Its turn's end arms a new hook. After `/clear` the new id holds nothing until it joins again.
   - **A different port:** the hook inherits Claude Code's environment, so `AGENT_BUS_PORT` must equal `serve`'s, or neither be set.
   - **`serve` older than the hook:** the hook's calls fail with "The bus has no bus_wake tool". Deploy `serve` ([deploy](deploy.md)).
   - **Not the session's address:** "belongs to another session" means it was taken over, or its id changed after `/clear` or a fork. Join an address of its own.

   *Unverified: each needs a real Claude session. The causes are from delivery's limits and the platform page.*

6. Verify: send the session a message from another address and watch for the wake. *Unverified: needs a real session.*

## A Codex thread isn't woken

`serve` wakes a Codex thread in two acts: it puts a nudge in the thread's queue, then asks the daemon to borrow the thread so that something runs it ([delivery](../architecture/delivery.md#codex-threads)). The log says which act stopped.

1. Read the log lines for the address, and pick the row.

   ```sh
   grep '<address>' ~/.agent-bus/agent-bus.log | tail -n 20
   ```

   | You see | Means | Do |
   | --- | --- | --- |
   | Nothing for the address, though mail arrived | It isn't a delivery target: not joined as `codex` with its own `codexThreadId`, or joined from another machine | Rejoin ([launch agents](launch-agents.md#start-a-codex-thread-the-bus-can-wake)). `agent-bus peers` shows the runtime and machine |
   | `Waking …: another Codex process holds its thread` | An app-server holds the thread and should run the nudge on its own poll (within about 10 s when idle, after the current turn when busy) | Wait, then step 3 |
   | `Not borrowing …: <reason>` | The thread can't be borrowed, so its nudge waits until the thread is next loaded | The [reasons](#why-a-thread-isnt-borrowed) |
   | `Could not wake …: <method>: <reason>. Next attempt in …` | A Codex step failed | The [failures](#why-a-wake-fails) |
   | `hasn't read its mail after 3 attempts …` | The nudge ran or waits, and the thread still hasn't read | Step 4 |
   | `Not waking …: its Codex thread takes no direct input` | A subagent joined | [Launch agents](launch-agents.md#delegates-subagents-and-one-shot-runs) |

   *Checked read-only 2026-10-28* for the first three kinds of line (older lines are worded differently); *Unverified* for the rest, which are read in code.

2. See what waits in the thread's queue, without changing anything. This asks a short-lived Codex app-server of your own to list the queue, as `serve` does; it loads no thread.

   ```sh
   codex_cli=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
   ( printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"check","title":"check","version":"0"},"capabilities":{"experimentalApi":true}}}' \
     '{"jsonrpc":"2.0","method":"initialized"}' \
     '{"jsonrpc":"2.0","id":2,"method":"thread/queue/list","params":{"threadId":"<thread id>","limit":100}}'
     sleep 3 ) | "$codex_cli" app-server | grep '"id":2'
   ```

   Expect each waiting item, whose text starts `[agent-bus] New messages for "<address>"` when it is a bus nudge; no items means nothing waits. An unknown thread answers "no rollout found". Reading `~/.codex/queue_1.sqlite` with `sqlite3 -readonly` also works, but its layout is Codex's own. *Checked read-only 2026-10-28* (the queue files were unchanged).

3. If a nudge waits and nothing runs it, find who holds the thread, or whether it is interrupted.
   - **A running `codex exec` holds it.** An `exec` run holds the thread's writer lock but doesn't dispatch queued input, so a borrow answers "held" and nobody runs the nudge. It is neither unloaded nor necessarily interrupted. Wait for the run to finish; the next borrow or reconcile after that handles it (5 minutes after the last attempt, then 15 and 60). Look for the run with `ps -axo pid,command | grep '[c]odex exec'`. If it exits mid-turn, the thread is left interrupted: the next case. *Unverified: no `exec` run was started. The case is read in `src/codex.ts` and the platform page.*
   - **Interrupted** (`its last turn was interrupted`). Codex runs no queued input after an interrupted turn until new input starts a turn ([platforms: Codex](../platforms/codex.md#an-interrupted-thread-runs-no-queued-input)). Type anything in the thread. *Unverified: needs a real thread.*
   - **Loaded nowhere, and not interrupted.** A queued item runs within a second of the next load by any app-server. Open the thread: in the desktop for a Local thread, or `codex resume <thread id>` in a terminal. *Unverified: needs a real thread.*
   - **Held by the desktop** (the thread shows "open in another app" in a second window). Open each thread from one place: the desktop and the daemon both read `~/.codex`, but only one can be a thread's writer.
   - **Held by the daemon, and you want to see it.** Attach from a terminal, with no restart: `codex resume --remote unix:// <thread id>`. In the desktop, use Retry once the run ends, not Fork, which splits the thread. *Unverified: `codex resume --help` accepts the flag, but it wasn't run on a real thread.*

4. If the thread's turns run but it doesn't read, open it and look at the turn. A turn that fails with "Your workspace is out of credits" is [the earlier login](#borrowed-turns-run-as-an-earlier-user).

5. Verify: the queue no longer holds the nudge, the `Waking …` lines for the address stop, and the thread has read its mail. *Unverified: needs a real thread.*

### Why a thread isn't borrowed

`Not borrowing …: <reason>` is logged once per run of joins, and again when the reason changes. [Delivery rule 9](../architecture/delivery.md#rules) says why each exists. An ineligible thread still gets its nudge and runs it when it is next loaded: this is a choice about waking an unloaded thread, not an error. *Unverified, this table: the reasons are read in `src/rollout.ts`.*

| Reason (start of the text) | What to do |
| --- | --- |
| `its approval policy is "<policy>"` | Start the thread with approval policy `never` ([launch agents](launch-agents.md#start-a-codex-thread-the-bus-can-wake)) |
| `its collaboration mode is …` | Switch the thread back to Default mode |
| `a client registered tools for it` | None: the thread is run by its client |
| `its permission profile "<id>" comes from the owner's config`, `it denies paths that …`, or `its sandbox lists specific paths (the older workspace-write setting)` | Start the thread with full access or a built-in profile with no denials |
| `its rollout has no settings snapshot of its own`, `its rollout has no settings record`, or `it hasn't run a turn since it was forked` | Run a turn in the thread |
| `its last turn was interrupted` | Give the thread new input |
| `its rollout doesn't start with a session record`, `its permission profile is of a kind this version doesn't know`, or `its history is kept as …` | Codex's format has changed: see [upgrade](upgrade.md) |
| `Codex reports no rollout file for it` | The thread has not been saved: it is new, or ran with `--ephemeral` |
| `its rollout can't be read (…)` or `took longer than 5s to read` | Check the file under `~/.codex/sessions/`. The text names only the kind of error |

### Why a wake fails

`Could not wake <address>: <method>: <reason>. Next attempt in <delay>.` The delay starts at 30 s and doubles to 5 minutes; mail stays unread meanwhile. *Unverified, this table: the reasons are read in `src/codex.ts`.*

| Method and reason | Means | What to do |
| --- | --- | --- |
| `thread/resume: no answer within 15s`, `borrow: no answer within 25s`, or `borrow: not tried, since an earlier borrow this cycle got …` | The daemon accepted the connection and didn't answer, and the cycle skipped the rest | [The Codex daemon is wedged](#the-codex-daemon-is-wedged) |
| `connect: the daemon refused the connection`, or `the control socket refused a connection (<code>)` | Something listens on the daemon's socket and refuses | Read the daemon's log, and restart it ([operate](operate.md#the-codex-daemon-file-limit-and-restarts)) |
| `app-server daemon start: exited with <n>: …`, or `no answer within 10s` | `serve` found no daemon and couldn't start one | Run `codex app-server daemon start` yourself and read its error |
| `app-server: …`, or `initialize: …` | The Codex CLI named by `serve --codex` (by default the desktop's bundled one) won't start | Check that the file exists and runs ([install](install.md)) |
| `thread/queue/list: …` or `thread/queue/add: …` with "no rollout found" or "session is archived" | The thread id is unknown on this machine, or the thread is archived | Check the id; a thread belongs to the machine whose `~/.codex` holds it |
| `queue nudge: no answer within 6s`, or `the listing didn't end after … pages` | `serve`'s own app-server was slow, or the queue is unusually long | Watch whether it repeats |

## The Codex daemon is wedged

A wedged daemon's socket still accepts a connection, but its requests get no answer. Every borrow waits for its deadline and backs off, and the other threads are skipped for that cycle. It is a known limit ([delivery](../architecture/delivery.md#for-codex-threads)), seen in operation with no recorded cause.

1. Confirm it from the log: several addresses with `no answer within 15s` or `borrow: not tried`.

   ```sh
   grep -E 'no answer within|not tried' ~/.agent-bus/agent-bus.log | tail -n 10
   ```

   Expect none while the daemon is healthy. *Checked read-only 2026-10-28* for that; the wording during a wedge is *Unverified* (read in code).

2. Check that the daemon process is alive and what it last logged.

   ```sh
   ps -axo pid,lstart,command | grep '[a]pp-server'
   tail -n 20 ~/.codex/app-server-control/app-server.log
   ```

   *Checked read-only 2026-10-28.*

3. Restart it by hand, with the open-file limit raised ([operate](operate.md#the-codex-daemon-file-limit-and-restarts)). A wedged daemon can't be drained, so the restart interrupts whatever it is running: turns that have started are lost, and pending nudges wait. Follow operate's last step to reopen the affected threads. *Unverified: there was no wedged daemon, and the running one is in use.*

4. Verify: the next cycle logs `Waking <address>` and no `no answer`. *Unverified, for the same reason.*

### Borrowed turns run as an earlier user

The daemon keeps the Codex login it started with ([platforms: Codex](../platforms/codex.md#the-daemon)). After the owner changes the login, borrowed turns run as the earlier user, and fail if that user's limit is used up: the turns saw "Your workspace is out of credits". Restart the daemon, draining it first ([operate](operate.md#the-codex-daemon-file-limit-and-restarts)); in the source's test every check then passed. *Unverified: needs a login change.*

## Held by another session

The refusal reads `<address> is held by another session (runtime …; on …; joined …; note …; last call …; …) …` and ends with the holder's join id ([messaging](../architecture/messaging.md#rules), rules 3 and 4).

1. Read the facts. A recent `last call`, or a wait open now, means the holder is alive: don't take it over.

2. The usual fix is another address, specific to the new session. A Codex thread also passes `--codex-thread "$CODEX_THREAD_ID"` ([launch agents](launch-agents.md#start-a-codex-thread-the-bus-can-wake)).

   ```sh
   agent-bus join --address <a new address> --runtime <claude|codex|other>
   ```

   *Rehearsed 2026-10-28* for the refusal with those facts and the join id.

3. Take the address over only if the holder has ended **and the human says to**. Use the join id from the latest refusal: it changes each time the holder joins.

   ```sh
   agent-bus join --address <address> --runtime <runtime> --takeover <holder's join id>
   ```

   Unread mail carries over, and the former holder is refused from then on ("belongs to another session"). A takeover from another machine uses that machine's cursor ([messaging limits](../architecture/messaging.md#limits)). *Rehearsed 2026-10-28.*

4. After `/clear` or a fork, Claude Code has a new session id and the old address is still held by the old one. Join a new address; don't take over.

5. Verify.

   ```sh
   agent-bus peers
   ```

   Expect the address listed once. *Rehearsed 2026-10-28.*

## A cursor is ahead of the ledger

A read fails with `Cursor t=<n> is ahead of agent-bus:main (t=<m>); the ledger was replaced. Rejoin to reset the cursor.`, and `serve`'s log has `Not waking <address> this pass: Cursor …` for a Claude address. Cursors are kept per incarnation of the ledger ([messaging](../architecture/messaging.md#rules), rule 11), so a plain replacement starts every address over, and this error shows only when the ledger went back in its own history (restored from an earlier copy) or a cursor file was edited.

1. Look at the cursor.

   ```sh
   cat ~/.agent-bus/fluree-cursors/*/*/<address, with / written as %2F>.json
   ```

   Expect `{"cursor":<n>}` with the `n` in the message. *Rehearsed 2026-10-28.*

2. Choose with the human what the address should see.
   - **Start at the present** (mail since the ledger's end isn't delivered): move the cursor file aside, then have the owner rejoin. The read says the address "has not joined the bus" until the rejoin, which sets the cursor to the ledger's end. *Rehearsed 2026-10-28.*

     ```sh
     mv ~/.agent-bus/fluree-cursors/*/*/<address, with / written as %2F>.json ~/.Trash/
     ```

   - **Read everything again** (every message ever sent to the address, including mail already read): the owner rejoins with `replay`, which sets the cursor to 0. *Rehearsed 2026-10-28.*

     ```sh
     agent-bus join --address <address> --runtime <runtime> --replay
     ```

   A plain rejoin does not reset the cursor, though the message says so. *Rehearsed 2026-10-28.*

3. Verify: the owner's `bus_read` returns and the `Not waking` warnings stop. *Rehearsed 2026-10-28.*

## `bun` not found over SSH on the other machine

The other machine's non-interactive SSH `PATH` lacks `bun`, so a remote command that needs it can fail to find it. The source records this as a limit, not as an observed error message. *Unverified, every step: it needs the other machine, and no SSH was made to it.*

1. Check how `bun` is found over SSH.

   ```sh
   ssh <ssh host of the other machine> 'command -v bun'
   ```

2. Call it by its path (`~/.bun/bin/bun`), or put `~/.bun/bin` on the `PATH` of its non-interactive shell, and run the command that failed.

## If it fails

- **Collect the read-only facts first:** the health checks, the `launchctl print` lines for the job, and the last 50 lines of the log. Logs hold addresses and thread ids: read them before you share them.
- **The last resort for `serve` and Fluree is the installer** ([operate](operate.md#rerun-the-installer-instead)): it rewrites the plists and keeps the ledger, the credentials and `config.json`.
- **A symptom not listed here** is a gap in this page: note what you saw and the log line, and tell the owner.
