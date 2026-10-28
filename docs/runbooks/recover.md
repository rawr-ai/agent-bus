# Recover

Use this when the bus misbehaves: each symptom, how to check it, the fix and how to verify it. Routine operation, health checks and the meaning of log lines are in [operate](operate.md).

## Before you start

- **Look before you fix.** Run the three health checks in [operate](operate.md#check-that-the-bus-is-healthy) and read the end of `~/.agent-bus/agent-bus.log`. Most symptoms below name a log line.
- **Nothing here deletes ledger data.** The fixes restart processes, rewrite a file the installer wrote, or move a cursor file aside. A mail that wasn't woken for stays in the ledger and in `bus_history`.
- **Two fixes are the human's call, not the agent's:** taking over an address held by another session, and moving a cursor.
- **Never archive or delete a Codex thread to release it.**
- **Each step ends with how it was checked:** *Rehearsed* (run on a disposable instance, with the result expected and observed), *Checked read-only* (a read-only command run against the running bus) or *Unverified* (with why). All dates are 2026-10-28. Commands use the default labels, ports and `~/.agent-bus`; `<address>` and `<thread id>` are yours.

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

Check what launchd and the log say, then follow the row that matches.

1. Read the job and the log.

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

   While the cause stands, the job stays in `state = spawn scheduled` and launchd tries again every 10 s. *Rehearsed: expected each of those five states and log lines; observed all five.*

### The port is held

1. Find the process on the port.

   ```sh
   lsof -nP -iTCP:8096 -sTCP:LISTEN
   ```

   *Rehearsed: expected the holder's command and pid; observed them.*

2. Stop it by its pid, unless it is something you need. A `serve` started by hand is one example. If you need the other program, stop it or give `serve` another port by rerunning the installer with `AGENT_BUS_PORT` set (not rehearsed): sessions' MCP registration and the Claude hook must then use the same port ([interfaces](../architecture/interfaces.md#configuration-and-environment)).

   ```sh
   kill <pid>
   ```

   *Rehearsed: expected `serve` to start within the 10 s throttle once the holder ended; observed `ok` after 1 s.*

3. Verify.

   ```sh
   curl -fsS http://127.0.0.1:8096/health
   ```

   *Rehearsed: expected `ok`; observed `ok`, with `state = running`.*

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

   *Rehearsed: expected the three bad forms (missing `fluree` entry, invalid JSON, a URL nothing listens on) to each exit `serve` with status 1 and a log line; observed that.*

2. Fix it by hand to the form above, or move it aside and let the installer write it again. The installer writes it only when it is absent and keeps everything else.

   ```sh
   mv ~/.agent-bus/config.json ~/.agent-bus/config.json.bad
   bun run install:launch-agents
   ```

   *Rehearsed: expected the installer to write the file and `serve` to start; observed both.*

3. Verify.

   ```sh
   curl -fsS http://127.0.0.1:8096/health
   ```

   *Rehearsed: expected `ok`; observed `ok`.*

### bun is missing from the plist

The plist holds the absolute path of the `bun` that was found when the installer ran (`command -v bun`, else `~/.bun/bin/bun`). If that file has moved or been removed, launchd can't start the job, and there is nothing in the log. The hook is different: it runs `~/.local/bin/agent-bus`, whose first line needs `bun` on the `PATH` that Claude Code gives it, and the plugin puts `~/.local/bin` and `~/.bun/bin` first.

1. Check the plist's `bun` and the hook's launcher.

   ```sh
   launchctl print gui/$(id -u)/ai.rawr.agent-bus | grep program
   ls -l "$(launchctl print gui/$(id -u)/ai.rawr.agent-bus | awk '/program =/{print $3}')"
   cd / && env -i HOME="$HOME" PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin" ~/.local/bin/agent-bus --help >/dev/null; echo "launcher exit $?"
   ```

   Exit 0 means the hook finds `bun`. With `bun` missing from the `PATH` it prints `env: bun: No such file or directory`. *Rehearsed: expected `EX_CONFIG` for a plist naming a missing `bun`, and that message for a launcher without `bun` on its `PATH`; observed both.* *Checked read-only on the running bus: expected exit 0; observed 0.*

2. Rerun the installer from a shell where `command -v bun` finds the real `bun`. It rewrites the plists and restarts both jobs.

   ```sh
   command -v bun
   bun run install:launch-agents
   ```

   If `bun` lives somewhere the hook can't see, link it into `~/.local/bin` first: `ln -s "$(command -v bun)" ~/.local/bin/bun`. *Rehearsed for the installer: expected `serve` running with the right `program`; observed that. Unverified for the link.*

3. Verify.

   ```sh
   curl -fsS http://127.0.0.1:8096/health
   ```

   *Rehearsed: expected `ok`; observed `ok`.*

## Fluree is down or unreachable

`serve` stays up when Fluree doesn't answer, and its `/health` stays `ok`. Calls fail with `Transport error (POST …/v1/fluree/query)`, and the log warns every few seconds. Nothing is lost: the ledger is on disk, and a mail that arrives later is read after Fluree is back.

1. Check Fluree, and the log.

   ```sh
   curl -fsS http://127.0.0.1:8095/health
   launchctl print gui/$(id -u)/ai.rawr.agent-bus.fluree | grep -E '^[[:space:]](state|pid|runs|last (exit|terminating))'
   grep -E '^\[[0-9:.]+\] (WARN|ERROR)' ~/.agent-bus/agent-bus.log | tail -n 5
   ```

   *Rehearsed: expected a refused connection, then `Delivery cycle failed … Transport error` and `Fluree events disconnected … Transport error` about every 5 s; observed both.*

2. Start Fluree. On the bus host, if its job is unloaded or stopped:

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.rawr.agent-bus.fluree.plist
   ```

   If it is loaded but not running, or crash-looping, read its log and go to [Fluree won't start](#fluree-wont-start-or-the-token-isnt-enforced). On another machine, the tunnel is the cause: [the tunnel is down](#the-tunnel-is-down). `serve` needs no restart. *Rehearsed: expected `serve` to recover by itself; observed that, with the peers intact.*

3. Verify.

   ```sh
   curl -fsS http://127.0.0.1:8095/health
   agent-bus peers
   ```

   *Rehearsed: expected the health answer, the peers and no new warnings; observed all three.*

After an outage longer than 10 minutes, Claude hooks that kept retrying have given up: a Claude session wakes again only after its next arming point ([a Claude session isn't woken](#a-claude-session-isnt-woken)).

## Fluree won't start, or the token isn't enforced

The installer starts Fluree with data and admin authentication required, and checks that the server on the port answers 401 without the token and 200 with it. If another server holds the port, the installer stops with "does not enforce the bus token", and `serve` would talk to the wrong server.

1. Read the job and its log.

   ```sh
   launchctl print gui/$(id -u)/ai.rawr.agent-bus.fluree | grep -E '^[[:space:]](state|pid|runs|program|last (exit|terminating))'
   tail -n 5 ~/.agent-bus/fluree.log
   ```

   `Address already in use (os error 48)` means the port is held. `EX_CONFIG` with an empty log means the `fluree` named in the plist has gone (the same as [bun](#bun-is-missing-from-the-plist)). *Rehearsed for the held port: expected the error and `spawn scheduled`; observed both. Unverified for a missing `fluree`.*

2. Test whether the server on the port enforces the token. The token goes to `curl` through its standard input, so it isn't in the process list.

   ```sh
   url=http://127.0.0.1:8095/v1/fluree/exists/agent-bus%3Amain
   curl -s -o /dev/null -w '%{http_code}\n' "$url"
   printf 'Authorization: Bearer %s\n' "$(cat ~/.agent-bus/fluree-token)" | curl -s -o /dev/null -w '%{http_code}\n' -H @- "$url"
   ```

   Expect `401`, then `200`. Two `200`s mean the server isn't the bus's. `401` twice means the token isn't accepted. *Rehearsed: expected 401 then 200 on the bus's Fluree, and 200 twice on an unauthenticated server holding the port; observed all three.* *Checked read-only on the running bus: expected 401 then 200; observed that.*

3. Fix by cause.
   - **The port is held:** find the process (`lsof -nP -iTCP:8095 -sTCP:LISTEN`), stop it by pid, and rerun the installer.
   - **The token is missing or invalid:** rerun the installer. It creates a new token with the existing key, restarts both jobs, and `serve` picks it up.
   - **The key is gone:** rerun the installer. It creates a new key and a new token, and starts Fluree trusting the new key. The old tokens stop working, including the copy on another machine: rerun the installer there with `--remote <ssh host of the bus host>` to copy the new one. The ledger isn't affected.

   ```sh
   bun run install:launch-agents
   ```

   *Rehearsed: expected the installer to refuse while a server without authentication held the port, and, once it was stopped, to finish; observed that. For a lost token and for a lost key: expected 401 then 200 with the new token, the old token refused where the key changed, and the peers kept; observed all of it. Unverified for `--remote`: it needs the other machine.*

4. Verify with the test in step 2, then `agent-bus peers`.

   *Rehearsed: expected 401, 200 and the peers; observed all three.*

## The tunnel is down

This is on another machine. Its `serve` needs the bus host's Fluree on `127.0.0.1:8095`, which an SSH tunnel provides. The installer runs the tunnel with `ExitOnForwardFailure` and a 15 s keep-alive that drops a dead connection after about 45 s, and launchd restarts it. Every step here is unverified, because it needs the other machine and no SSH was made to it. The commands are the installer's own, read in `scripts/install-launch-agents.sh`.

1. Check the tunnel job and its log, and whether the port answers.

   ```sh
   launchctl print gui/$(id -u)/ai.rawr.agent-bus.tunnel | grep -E '^[[:space:]](state|pid|runs|last (exit|terminating))'
   tail -n 20 ~/.agent-bus/tunnel.log
   curl -fsS http://127.0.0.1:8095/health
   ```

   *Unverified: needs the other machine.*

2. Check that SSH works as the tunnel runs it: with no prompts. A changed host key, a refused key and an unreachable host all show here.

   ```sh
   ssh -o BatchMode=yes <ssh host of the bus host> true
   ```

   *Unverified: needs the other machine.*

3. Check that nothing else holds the local port, since the tunnel exits if it can't bind it.

   ```sh
   lsof -nP -iTCP:8095 -sTCP:LISTEN
   ```

   *Unverified: needs the other machine.*

4. Restart the tunnel, or rerun the installer with `--remote` if the plist is wrong.

   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus.tunnel
   ```

   *Unverified: needs the other machine.*

5. Verify. The port answers with Fluree's health, and `serve`'s warnings stop.

   ```sh
   curl -fsS http://127.0.0.1:8095/health
   agent-bus peers
   ```

   *Unverified: needs the other machine.*

## A Claude session isn't woken

A Claude session is woken by the plugin's hook, which waits in `bus_wake` and exits 2 with a line when mail arrives. [Delivery](../architecture/delivery.md#when-a-claude-session-isnt-armed) lists every way a session can be unarmed. Mail that wasn't woken for stays unread and readable with `bus_read`.

1. Check that the plugin is installed and enabled, and that the session is one that can be woken: a desktop or terminal session, not `claude -p`.

   ```sh
   claude plugin list
   ```

   Expect `agent-bus@agent-bus` with `Status: ✔ enabled`. *Checked read-only on this machine: expected it enabled; observed that.*

2. Check that its hook has called `serve`. Ask the session to call `bus_join` again with the same address: a rejoin by its owner keeps its unread mail. The result carries `hooked: true` once `serve` has seen the session's hook since `serve` started; without it, the hook isn't waiting.

   *Rehearsed on an isolated bus with a simulated hook: expected a join before any hook had called to return no `hooked`, and a join while the hook waited to return `hooked: true`; observed both. Unverified with a real session, which needs one.*

3. Check that the hook can run at all.

   ```sh
   cd / && env -i HOME="$HOME" PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin" ~/.local/bin/agent-bus --help >/dev/null; echo "launcher exit $?"
   ```

   *Checked read-only on the running bus (2026-10-28): expected exit 0; observed 0.*

4. To see what the hook does, run it by hand on an isolated bus ([operate](operate.md#run-an-isolated-bus-for-checks)) with a made-up session id. **Never run it with a real session's id on the running bus:** its call replaces that session's own waiting hook.

   ```sh
   agent-bus join --address rehearsal/hook --runtime claude --session check-1
   agent-bus join --address rehearsal/sender --runtime other --session sender-1
   echo '{"session_id":"check-1"}' | agent-bus claude-wake & hook=$!
   agent-bus publish --from rehearsal/sender --runtime other --session sender-1 --to rehearsal/hook --body ping
   wait $hook; echo "hook exit $?"
   ```

   Expect the line `[agent-bus] New messages for "rehearsal/hook". Read them with …` on stderr and exit 2. A hook for a session that owns no address returns at once with exit 0. *Rehearsed: expected exit 2 with that line, and exit 0 and no output for an id that owns nothing; observed both.*

5. Fix by cause.
   - **No plugin, or an old one:** install or update it, then start the session again or run `/reload-plugins` ([install](install.md)).

     ```sh
     claude plugin marketplace update agent-bus
     claude plugin update agent-bus@agent-bus
     ```

   - **An interrupted turn, an outage over 10 minutes, 30 days idle, or `/clear`:** the hook is gone or waits under the old id. Give the session any prompt: its turn's end arms a new hook. After `/clear` the new id holds nothing until it joins again.
   - **`serve` restarted:** it forgot which hooks had called and what it woke for. The session may get one extra wake, and `hooked` returns when the hook calls again.
   - **A different port:** the hook inherits Claude Code's environment, so `AGENT_BUS_PORT` must be the same as `serve`'s, or neither set.
   - **`serve` older than the hook:** the hook's calls fail with "The bus has no bus_wake tool". Deploy `serve` ([deploy](deploy.md)).
   - **The address isn't the session's:** a refusal that says "belongs to another session" means it was taken over, or its id changed after `/clear` or a fork. Join an address of its own.

   *Unverified: each needs a real Claude session. The causes are from delivery's limits and the platform page; the hook's checks above were rehearsed.*

6. Verify. Send the session a message from another address and watch for the wake.

   *Unverified: needs a real session.*

## A Codex thread isn't woken

`serve` wakes a Codex thread in two acts: it puts a nudge in the thread's queue, then asks the daemon to borrow the thread so that something runs it ([delivery](../architecture/delivery.md#codex-threads)). The log says which act stopped.

1. Read the log lines for the address.

   ```sh
   grep '<address>' ~/.agent-bus/agent-bus.log | tail -n 20
   ```

   Choose the row that matches; [operate](operate.md#what-the-lines-of-serve-mean) explains every line.

   | You see | Means | Do |
   | --- | --- | --- |
   | Nothing for the address, though mail arrived | It isn't a delivery target: not joined as `codex` with its own `codexThreadId`, or joined from another machine | Rejoin ([launch agents](launch-agents.md#start-a-codex-thread-the-bus-can-wake)). `agent-bus peers` shows the runtime and machine |
   | `Waking …: another Codex process holds its thread` | The desktop or another app-server has the thread loaded and runs the nudge on its own poll, within about 10 s when idle, after the current turn when busy | Wait. If it never runs, step 3 |
   | `Not borrowing …: <reason>` | The thread can't be borrowed, so its nudge waits until the thread is next loaded | The [reasons](#why-a-thread-isnt-borrowed) below |
   | `Could not wake …: <method>: <reason>. Next attempt in …` | A Codex step failed | The [failures](#why-a-wake-fails) below |
   | `hasn't read its mail after 3 attempts …` | The nudge was run or is waiting, and the thread still hasn't read | Open the thread and look: step 4 |
   | `Not waking …: its Codex thread takes no direct input` | A subagent joined | [Launch agents](launch-agents.md#delegates-subagents-and-one-shot-runs) |

   *Checked read-only on the running bus: expected the first three kinds of line for the running threads; observed them (the wording of older lines differs). The other rows are read in code.*

2. See what waits in the thread's queue, without changing anything. This asks a short-lived Codex app-server of your own to list the queue, as `serve` does; it loads no thread.

   ```sh
   codex_cli=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
   ( printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"check","title":"check","version":"0"},"capabilities":{"experimentalApi":true}}}' \
     '{"jsonrpc":"2.0","method":"initialized"}' \
     '{"jsonrpc":"2.0","id":2,"method":"thread/queue/list","params":{"threadId":"<thread id>","limit":100}}'
     sleep 3 ) | "$codex_cli" app-server | grep '"id":2'
   ```

   Each item's text starts `[agent-bus] New messages for "<address>"` when it is a bus nudge. No items means no nudge is waiting. A thread that doesn't exist answers with an error, "no rollout found". The queue lives in `~/.codex/queue_1.sqlite`; reading that file with `sqlite3 -readonly` also works, but its layout is Codex's own. *Checked read-only on this machine (2026-10-28): expected the queue's items for a thread with a nudge waiting, and "no rollout found" for an unknown id; observed both, and the queue files unchanged.*

3. If a nudge waits and nothing runs it, the thread is loaded nowhere or its last turn was interrupted.
   - **Loaded nowhere.** A queued item on an unloaded thread runs within a second of the next load by any app-server. Open the thread: in the desktop for a Local thread, or `codex resume <thread id>` in a terminal. *Unverified: it needs a real thread.*
   - **Interrupted** (`its last turn was interrupted`). Codex runs no queued input after an interrupted turn until new input starts a turn ([platforms: Codex](../platforms/codex.md#an-interrupted-thread-runs-no-queued-input)). Type anything in the thread. *Unverified: it needs a real thread.*
   - **Held by the desktop** (the thread shows "open in another app" in a second window). Open each thread from one place: the desktop and the daemon both read `~/.codex`, but only one can be a thread's writer.
   - **Held by the daemon, and you want to see it.** Attach to it from a terminal: `codex resume --remote unix:// <thread id>`. It needs no restart. In the desktop, use Retry once the run ends, not Fork, which splits the thread. *Unverified: the flag is accepted by `codex resume --help` but was not run on a real thread.*

4. If the thread's turns run but it doesn't read, open it and look at the turn. A turn that fails with "Your workspace is out of credits" is [the earlier login](#borrowed-turns-run-as-an-earlier-user).

5. Verify. The queue no longer holds the nudge, `Waking …` lines for the address stop, and the thread has read its mail.

   *Unverified: needs a real thread.*

### Why a thread isn't borrowed

`Not borrowing …: <reason>` is logged once per run of joins, and again when the reason changes. The reasons are read in `src/rollout.ts`; [delivery rule 9](../architecture/delivery.md#rules) says why each exists. An ineligible thread still gets its nudge, and runs it when it is next loaded. It is a choice about waking an unloaded thread, not an error.

| Reason (start of the text) | What to do |
| --- | --- |
| `its approval policy is "<policy>"` | Start the thread with approval policy `never` ([launch agents](launch-agents.md#start-a-codex-thread-the-bus-can-wake)) |
| `its collaboration mode is …` | Switch the thread back to Default mode: Plan mode can wait for an answer |
| `a client registered tools for it` | None: the thread is run by its client |
| `its permission profile "<id>" comes from the owner's config`, `it denies paths that …`, or `its sandbox lists specific paths (the older workspace-write setting)` | Start the thread with full access or a built-in profile with no denials |
| `its rollout has no settings snapshot of its own`, `its rollout has no settings record`, or `it hasn't run a turn since it was forked` | Run a turn in the thread |
| `its last turn was interrupted` | Give the thread new input |
| `its rollout doesn't start with a session record`, `its permission profile is of a kind this version doesn't know`, or `its history is kept as …` | Codex's format has changed: see [upgrade](upgrade.md) |
| `Codex reports no rollout file for it` | The thread has not been saved: it is new, or ran with `--ephemeral` |
| `its rollout can't be read (…)` or `took longer than 5s to read` | Check the file under `~/.codex/sessions/`. The text names only the kind of error |

### Why a wake fails

`Could not wake <address>: <method>: <reason>. Next attempt in <delay>.` The delay starts at 30 s and doubles to 5 minutes; mail stays unread meanwhile. The reasons are read in `src/codex.ts`.

| Method and reason | Means | What to do |
| --- | --- | --- |
| `thread/resume: no answer within 15s`, or `borrow: no answer within 25s` | The daemon accepted the connection and didn't answer | [The Codex daemon is wedged](#the-codex-daemon-is-wedged) |
| `borrow: not tried, since an earlier borrow this cycle got …` | Another peer's borrow timed out first, so this cycle skipped the rest | The same |
| `connect: the daemon refused the connection`, or `the control socket refused a connection (<code>)` | Something listens on the daemon's socket and refuses | Read the daemon's log, and restart it ([operate](operate.md#the-codex-daemon-file-limit-and-restarts)) |
| `app-server daemon start: exited with <n>: …`, or `no answer within 10s` | `serve` found no daemon and couldn't start one | Run `codex app-server daemon start` yourself and read its error |
| `app-server: …`, or `initialize: …` | The Codex CLI named by `serve --codex` (by default the desktop's bundled one) won't start | Check that the file exists and runs ([install](install.md)) |
| `thread/queue/list: …` or `thread/queue/add: …` with "no rollout found" or "session is archived" | The thread id is unknown on this machine, or the thread is archived | Check the id; a thread belongs to the machine whose `~/.codex` holds it |
| `queue nudge: no answer within 6s`, or `the listing didn't end after … pages` | `serve`'s own app-server was slow, or the queue is unusually long | Watch whether it repeats |

## The Codex daemon is wedged

A wedged daemon's socket still accepts a connection, but its requests get no answer. Every borrow waits for its deadline and backs off, and the other threads are skipped for that cycle. It is a known limit of the daemon ([delivery](../architecture/delivery.md#for-codex-threads)), seen in operation with no recorded cause.

1. Confirm it from the log: several addresses with `no answer within 15s` or `borrow: not tried`.

   ```sh
   grep -E 'no answer within|not tried' ~/.agent-bus/agent-bus.log | tail -n 10
   ```

   *Checked read-only on the running bus (2026-10-28): expected no such lines, as the daemon is not wedged; observed none. The wording is read in code, not seen.*

2. Check that the daemon process is alive and what it last logged.

   ```sh
   ps -axo pid,lstart,command | grep '[a]pp-server'
   tail -n 20 ~/.codex/app-server-control/app-server.log
   ```

   *Checked read-only on this machine (2026-10-28): expected the daemon's process and recent log lines; observed both.*

3. Restart it by hand, with the open-file limit raised ([operate](operate.md#the-codex-daemon-file-limit-and-restarts)). That drops every thread it holds; their nudges wait until `serve` borrows them again. *Unverified: there was no wedged daemon to test on, and the running one is in use.*

4. Verify. The next cycle logs `Waking <address>` and no `no answer`. *Unverified: the same reason.*

### Borrowed turns run as an earlier user

The daemon keeps the Codex login it started with ([platforms: Codex](../platforms/codex.md#the-daemon)). After the owner changes the login, borrowed turns run as the earlier user, and fail if that user's limit is used up: the turns saw "Your workspace is out of credits". Restart the daemon ([operate](operate.md#the-codex-daemon-file-limit-and-restarts)). After the restart in the source's test, every check passed. *Unverified: it needs a login change.*

## Held by another session

The refusal reads `<address> is held by another session (runtime …; on …; joined …; note …; last call …; a wait open now / no wait open on this machine) …` and ends with the holder's join id. An address is one session's inbox ([messaging](../architecture/messaging.md#rules), rules 3 and 4).

1. Read the facts in the refusal. A recent `last call`, or a wait open now, means the holder is alive. Don't take it over.

2. The usual fix is another address, specific to the new session.

   ```sh
   agent-bus join --address <a new address> --runtime <claude|codex|other>
   ```

   A Codex thread also passes `--codex-thread "$CODEX_THREAD_ID"` ([launch agents](launch-agents.md#start-a-codex-thread-the-bus-can-wake)).

   *Rehearsed: expected a second session joining the held address to be refused with those facts and its join id; observed that.*

3. Take the address over only if the holder has ended **and the human says to**. Use the join id from the latest refusal: it changes each time the holder joins.

   ```sh
   agent-bus join --address <address> --runtime <runtime> --takeover <holder's join id>
   ```

   Unread mail carries over. The former holder is refused from then on. A takeover from another machine uses that machine's cursor ([messaging limits](../architecture/messaging.md#limits)). *Rehearsed: expected the takeover to join, and the former holder's next send to be refused with "belongs to another session"; observed both.*

4. After `/clear` or a fork, Claude Code has a new session id, and the old address is still held by the old one. Join a new address; don't take over. A message "belongs to another session; nothing was changed" is this case, or a takeover.

5. Verify.

   ```sh
   agent-bus peers
   ```

   *Rehearsed: expected the address listed once; observed that.*

## A cursor is ahead of the ledger

A read fails with `Cursor t=<n> is ahead of agent-bus:main (t=<m>); the ledger was replaced. Rejoin to reset the cursor.`, and `serve`'s log has `Not waking <address> this pass: Cursor …` for a Claude address. A cursor is the last commit `t` an address has read. Cursors are kept per incarnation of the ledger, so a plain replacement of the ledger starts every address over in a directory of its own, and this error shows only when the ledger went back in its own history (restored from an earlier copy) or a cursor file was edited.

1. Look at the cursor and the ledger's end.

   ```sh
   ls ~/.agent-bus/fluree-cursors/*/*/
   cat ~/.agent-bus/fluree-cursors/*/*/<address, with / written as %2F>.json
   ```

   The message names both numbers. *Rehearsed: expected `{"cursor":9999}` and the error; observed both.*

2. Choose with the human what the address should see.
   - **Start at the present** (mail since the ledger's end isn't delivered): move the cursor file aside, then have the owner rejoin. *Rehearsed: expected the read to say the address "has not joined the bus", and the rejoin to set the cursor to the ledger's end; observed both.*

     ```sh
     mv ~/.agent-bus/fluree-cursors/*/*/<address, with / written as %2F>.json ~/.Trash/
     ```

   - **Read everything again** (every message ever sent to the address, including mail already read): the owner rejoins with `replay`. *Rehearsed: expected the cursor to go to 0; observed that.*

     ```sh
     agent-bus join --address <address> --runtime <runtime> --replay
     ```

   A plain rejoin does not reset it, though the message says so. *Rehearsed: expected a plain rejoin to leave the cursor at 9999; observed that.*

3. Verify. The owner's `bus_read` returns, and the `Not waking` warnings stop.

   *Rehearsed: expected the read to return and the warning to stop; observed both.*

## `bun` not found over SSH on the other machine

The other machine's non-interactive SSH `PATH` lacks `bun`, so a remote command that needs it can fail to find it. The source records this as a limit, not as an observed error message.

1. Check how `bun` is found over SSH.

   ```sh
   ssh <ssh host of the other machine> 'command -v bun'
   ```

2. Call it by its path (`~/.bun/bin/bun`), or put `~/.bun/bin` on the `PATH` of its non-interactive shell.

3. Verify with the command that failed.

*Unverified: it needs the other machine, and no SSH was made to it.*

## If it fails

- **Collect the read-only facts first:** the health checks, the `launchctl print` lines for the job, and the last 50 lines of the log. Logs hold addresses and thread ids: read them before you share them.
- **The last resort for `serve` and Fluree is the installer** ([operate](operate.md#rerun-the-installer-instead)): it rewrites the plists and keeps the ledger, the credentials and `config.json`.
- **A symptom not listed here** is a gap in this page: note what you saw and the log line, and tell the owner.
