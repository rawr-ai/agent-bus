# Deploy

Use this to put a new version of agent-bus into service: the primary-checkout rule, fast-forward, restart, verify and roll back. Restarting alone is in [operate](operate.md); the first install is in [install](install.md).

## Before you start

**The rule: the primary checkout runs only a deployed `main`.** The primary checkout is the one the installer linked `~/.local/bin/agent-bus` to. Two things run from it:
- the `serve` LaunchAgent, which runs its `src/bin.ts` and picks up changes only when it restarts;
- every Claude session's wake hook, which runs the same file through the link and so picks up changes at its next run, at once.

A half-edited tree there breaks `serve` at its next restart and the hooks at their next run ([topology](../architecture/topology.md#rules), rule 7). So nothing is edited, branched or checked out in the primary checkout. Develop in a worktree (`git worktree add <path> -b <branch>`). The primary checkout changes only by fast-forwarding to `main`, which is a deploy.

What a deploy changes, and when:

| Changed | Reaches | When |
| --- | --- | --- |
| `src/` | The Claude hook | At once |
| `src/` | `serve` | At its restart (step 8) |
| `plugin/` or `.claude-plugin/` | Claude sessions | After `claude plugin update` and a session restart ([When the plugin changed](#when-the-plugin-changed)) |
| `scripts/install-launch-agents.sh` | The LaunchAgents' plists and Fluree's flags | When the installer is rerun (step 8) |

A restart of `serve` loses its memory, which costs at most one extra wake per address and leaves `hooked` unset until each Claude hook calls again, about five seconds later ([delivery](../architecture/delivery.md#claude-code-sessions)). The Codex daemon outlives `serve`'s restarts. The Fluree server isn't restarted unless you rerun the installer.

You need the change merged into `main` on the remote, a shell on the bus host, and a quiet moment. Use one shell for the whole procedure, because `previous` is set in step 1 and used in step 10.

The steps were *Rehearsed 2026-10-28* on a disposable instance: its own directory, ports and LaunchAgent labels, installed from a temporary clone that stood in for the primary checkout, with a second clone as its remote. It deployed three later commits: a version bump, a deliberately broken file, and its revert. A mark below says where a step differs.

## Deploy a new version

1. **Open the primary checkout and record what runs now:**

   ```sh
   cd "$(dirname "$(readlink ~/.local/bin/agent-bus)")/.."
   git status --short
   git branch --show-current
   previous=$(git rev-parse HEAD); echo "$previous"
   ```

   Expected: no output from `status`, then `main`, then a commit id. Write the id down: it is the commit to roll back to. If `status` prints anything, or the branch isn't `main`, stop: someone broke the rule ([If it fails](#if-it-fails)). *Rehearsed 2026-10-28, checked read-only 2026-10-28*

2. **Run [the end-to-end check](#check-the-bus-end-to-end) on the version that runs now,** so that a later failure is the deploy's.

3. **Merge the change into `main` on the remote,** by merging its pull request. Nothing is deployed yet.

4. **Fast-forward the primary checkout to `main`:**

   ```sh
   git fetch origin
   git log --oneline HEAD..origin/main
   git merge --ff-only origin/main
   ```

   Expected: the log lists exactly the commits you mean to deploy; the merge prints `Fast-forward` and the changed files. `--ff-only` refuses anything else with `Not possible to fast-forward` (exit status 128): the primary checkout holds a commit that isn't on `main` ([If it fails](#if-it-fails)).

5. **See what else the deploy changed:**

   ```sh
   git diff --name-only "$previous" HEAD -- package.json bun.lock scripts/install-launch-agents.sh plugin .claude-plugin
   ```

   Expected: usually nothing. If `scripts/install-launch-agents.sh` is listed, restart in step 8 with the installer. If `plugin/…` or `.claude-plugin/…` is listed, do [When the plugin changed](#when-the-plugin-changed) after step 9.

6. **Install the dependencies:**

   ```sh
   bun install
   ```

   Expected: `Checked … installs … (no changes)` unless `package.json` or `bun.lock` changed, in which case Bun installs the difference.

7. **Check the deployed tree,** which takes about 40 seconds (type check, lint, tests, docs check). It starts throwaway servers on random ports and doesn't touch the bus:

   ```sh
   bun run check
   ```

   Expected: `0 fail` and `check-docs: … ok` (180 tests passed in the rehearsal). If it fails, roll back (step 10) before restarting anything.

8. **Restart `serve`:**

   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus
   ```

   Expected: no output, and `serve` serving again within about a second. `kickstart -k` kills the running job and starts it at once, even inside the 10-second throttle ([operate](operate.md#restart-serve-fluree-or-the-tunnel)). If step 5 listed the installer, run `bun run install:launch-agents` instead: it also restarts Fluree and rewrites the plists, so the bus pauses a few seconds longer ([install](install.md#rerun-the-installer)).

9. **Check that `serve` restarted:** [the restart check](#check-that-serve-restarted), then [the end-to-end check](#check-the-bus-end-to-end). If either fails, go to step 10.

10. **If anything failed, roll back.** Reset the primary checkout to the commit you wrote down, put the old code into service the way step 8 did, and run both checks again, whole:

    ```sh
    git reset --hard "$previous"
    bun install
    launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus
    ```

    Expected: `HEAD is now at …` with the old commit; then the restart check and the end-to-end check pass, and `agent-bus --version` is the old version. `reset --hard` is safe here because the rule keeps the tree free of uncommitted work. The reset moves only this checkout: `main` still holds the change, and the next fast-forward would deploy it again, so fix it on `main`, by a fix or a revert merged through a pull request, before deploying again.

    - **If the deploy changed the installer,** use `bun run install:launch-agents` in place of the `kickstart`. After the reset the checkout holds the previous revision, so this runs the previous revision's installer, which wrote the plists now in place and rewrites them as they were. Don't run the new revision's installer from a reset tree.
    - **If the deploy changed the plugin,** run [the plugin commands](#when-the-plugin-changed) again so the cache follows the checkout.
    - **On a disposable instance,** rehearse an installer rollback only when both revisions support the installer's overrides (`AGENT_BUS_DIR`, the two ports, `AGENT_BUS_LABEL` and `AGENT_BUS_LAUNCHER`). An installer from before they existed ignores them and rewrites the real launcher and the real LaunchAgents. With such a revision, don't run it: restore the instance's saved plists and launcher by hand ([operate](operate.md#run-an-isolated-bus-for-checks)).

## Check that `serve` restarted

Run after every restart and rollback. It only reads.

```sh
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8096/health && break; sleep 1; done; echo
tail -n 2 ~/.agent-bus/agent-bus.log
launchctl print gui/$(id -u)/ai.rawr.agent-bus | grep -E 'state =|pid =|bin.ts'
ps -o lstart= -p "$(launchctl print gui/$(id -u)/ai.rawr.agent-bus | awk '/pid =/{print $3}')"; date
```

Expected: `ok`; a last log line `Listening on http://127.0.0.1:8096` stamped just now (the line above it is the previous start); `state = running`, a pid, and a `bin.ts` path inside the primary checkout; a process start time within a few seconds of `date`. *Rehearsed 2026-10-28*

## Check the bus end to end

Run before a deploy, after it and after a rollback. It is self-contained: every run uses its own test addresses and a fresh stand-in for a Claude hook, every wait ends after 30 seconds, and it leaves the bus and its temporary directory clean on every exit. It prints `PASS` and exits 0, or prints `FAIL:` with the reason and exits 1.

The stand-in is the plugin's hook command, `agent-bus claude-wake`, fed the input Claude Code gives a hook. It shows that a hook can reach `serve`, that `serve` marks it `hooked`, and that mail wakes it. The CLI can't read, so the read goes through the MCP endpoint with `curl`.

```sh
sh <<'EOF'
port=${AGENT_BUS_PORT:-8096}
url=http://127.0.0.1:$port/mcp
run=$(date +%s)$$
recv=deploy-check/r$run send=deploy-check/s$run
work=$(mktemp -d)
hook= sid=
rpc() { curl -s --max-time 10 -X POST "$url" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $sid" -d "$1"; }
call() { rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }
cleanup() {
  [ -n "$hook" ] && kill "$hook" 2>/dev/null
  if [ -n "$sid" ]; then
    call bus_leave "{\"address\":\"$send\",\"session\":\"$run-s\"}" >/dev/null
    call bus_leave "{\"address\":\"$recv\",\"session\":\"$run-r\"}" >/dev/null
  fi
  mv "$work" ~/.Trash/deploy-check-$run
}
trap cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }

i=0; until curl -fs --max-time 2 http://127.0.0.1:$port/health >/dev/null; do
  i=$((i+1)); [ $i -lt 30 ] || fail "serve does not answer on port $port"; sleep 1; done
echo "serve answers"
sid=$(curl -s --max-time 10 -i -X POST "$url" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-check","version":"1"}}}' | awk 'tolower($1)=="mcp-session-id:"{print $2}' | tr -d '\r')
[ -n "$sid" ] || fail "no MCP session"
rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
join="{\"address\":\"$recv\",\"runtime\":\"claude\",\"session\":\"$run-r\",\"cwd\":\"/tmp\"}"
call bus_join "$join" | grep -q cursor || fail "join was refused"
echo "{\"session_id\":\"$run-r\"}" | agent-bus claude-wake >"$work/hook.out" 2>"$work/hook.err" &
hook=$!
i=0; until call bus_join "$join" | grep -q '"hooked":true'; do
  i=$((i+1)); [ $i -lt 30 ] || fail "the hook never called serve (hooked stayed unset)"; sleep 1; done
echo "hooked: true"
agent-bus join --address $send --runtime other --session $run-s >/dev/null || fail "sender join failed"
agent-bus publish --from $send --session $run-s --to $recv --body "deploy check" >/dev/null || fail "publish failed"
i=0; while kill -0 "$hook" 2>/dev/null; do
  i=$((i+1)); [ $i -lt 30 ] || fail "the hook did not wake"; sleep 1; done
wait "$hook"; [ $? -eq 2 ] || fail "the hook exited with the wrong status"
echo "woken: $(cut -c1-60 "$work/hook.err")"
call bus_read "{\"address\":\"$recv\",\"session\":\"$run-r\"}" | grep -q '"body":"deploy check"' || fail "the message was not read"
echo "read: deploy check"
echo PASS
EOF
```

Expected: `serve answers`, `hooked: true`, `woken: [agent-bus] New messages for "deploy-check/r…`, `read: deploy check`, `PASS`, in a few seconds. Afterwards `agent-bus peers` lists neither test address. *Rehearsed 2026-10-28*, three runs in a row, and once with `serve` stopped (`FAIL: serve does not answer on port …` after 30 s, exit 1).

That a hook already waiting before the restart calls `serve` again by itself (it retries every five seconds) was seen once, with an earlier form of this check: `hooked` was true 6 s after the restart. *Unverified* in a real Claude session: from a joined session, call `bus_join` again with its own address and session after the restart, and expect `hooked: true` within about ten seconds.

## When the plugin changed

A change under `plugin/` or `.claude-plugin/` isn't deployed by the fast-forward. Claude Code copies the plugin into its cache, so the change reaches sessions only after `claude plugin update` and a restart of each session ([platforms: Claude Code](../platforms/claude-code.md#plugins)). Run this after step 9, so `serve` already has `bus_wake` for the new hook to find:

```sh
claude plugin marketplace update agent-bus
claude plugin update agent-bus@agent-bus
claude plugin list
```

Expected: `claude plugin list` shows `agent-bus@agent-bus` enabled at a new version. Sessions get the change when they next start, or with `/reload-plugins`. A change to `src/` alone needs none of this. *Unverified*: it would change the owner's installed plugin.

## If it fails

| Symptom | Check | Fix |
| --- | --- | --- |
| Step 1: `status` prints files, or the branch isn't `main` | `git status`, `git log origin/main..HEAD` | The rule was broken. Move the work to a worktree branch, restore the primary checkout to `main`, and start again. Don't deploy over uncommitted work |
| Step 4: `Not possible to fast-forward` | `git log --oneline origin/main..HEAD` | The primary checkout has a commit that isn't on `main`. Same fix: put it in a worktree branch, then `git reset --hard "$previous"` and retry |
| `serve` doesn't come back after step 8: the restart check prints nothing | `launchctl print gui/$(id -u)/ai.rawr.agent-bus \| grep -E 'state =\|last exit'` and `tail -n 20 ~/.agent-bus/agent-bus.log` | With a syntax error in `src/`: health refused the connection; `state = spawn scheduled`, `last exit code = 1`; the log ended in the Bun error with the file and line; `agent-bus --version` printed the same error, so the hooks failed too. Roll back (step 10). Hooks that fail retry for ten minutes, then wait for their next arming point. *Rehearsed 2026-10-28* |
| The restart check's log line is old, or the pid and start time are old | `ps -o lstart= -p <pid>` | The restart didn't happen. Repeat step 8 |
| The end-to-end check prints `FAIL: the hook never called serve` | `tail -n 30 ~/.agent-bus/agent-bus.log` | A `serve` older than `bus_wake` makes hooks retry until a deploy replaces it. Check that step 4 deployed what you meant, restart, and rerun. See [recover](recover.md) |
| Any other `FAIL:` | The reason it prints | Roll back (step 10); then [operate](operate.md) and [recover](recover.md) |
