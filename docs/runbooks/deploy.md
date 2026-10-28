# Deploy

Use this to put a new version of agent-bus into service: the primary-checkout rule, fast-forward, restart, verify and roll back. Restarting alone is in [operate](operate.md); the first install is in [install](install.md).

Each step ends with how it was checked. *Rehearsed* means run on a disposable instance: its own directory, ports and LaunchAgent labels, installed from a temporary clone that stood in for the primary checkout, with a second clone as its remote. The steps below use the real values. The rehearsal deployed three later commits: a version bump, a deliberately broken file, and its revert.

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
| `scripts/install-launch-agents.sh` | The LaunchAgents' plists and Fluree's flags | When the installer is rerun ([install](install.md#rerun-the-installer)) |

A restart of `serve` loses its memory, which costs at most one extra wake per address and leaves `hooked` unset until each Claude hook calls again, about five seconds later ([delivery](../architecture/delivery.md#claude-code-sessions)). The Codex daemon outlives `serve`'s restarts. The Fluree server isn't restarted unless you rerun the installer.

You need the change merged into `main` on the remote, a shell on the bus host, and a quiet moment. Use one shell for the whole procedure: step 1 sets `previous`, step 7 starts a background job, and both are used later.

## Deploy a new version

1. **Open the primary checkout and record what runs now:**

   ```sh
   cd "$(dirname "$(readlink ~/.local/bin/agent-bus)")/.."
   git status --short
   git branch --show-current
   previous=$(git rev-parse HEAD); echo "$previous"
   ```

   Expected: no output from `status`, then `main`, then a commit id. Write the id down: it is the commit to roll back to. If `status` prints anything, or the branch isn't `main`, stop: someone broke the rule ([If it fails](#if-it-fails)). *Rehearsed: expected a clean tree, `main` and an id, observed those (2026-10-28). Checked read-only on the running bus: clean, `main` (2026-10-28).*

2. **Merge the change into `main` on the remote,** by merging its pull request. Nothing is deployed yet. *Unverified: no real merge was made.*

3. **Fast-forward the primary checkout to `main`:**

   ```sh
   git fetch origin
   git log --oneline HEAD..origin/main
   git merge --ff-only origin/main
   ```

   Expected: the log lists exactly the commits you mean to deploy; the merge prints `Fast-forward` and the changed files. `--ff-only` refuses anything else with `Not possible to fast-forward`: the primary checkout holds a commit that isn't on `main` ([If it fails](#if-it-fails)). *Rehearsed: expected the commits and a fast-forward, observed both (2026-10-28). Rehearsed refusal: with a local commit, `fatal: Not possible to fast-forward, aborting`, exit 128.*

4. **See what else the deploy changed:**

   ```sh
   git diff --name-only "$previous" HEAD -- package.json bun.lock scripts/install-launch-agents.sh plugin .claude-plugin
   ```

   Expected: usually nothing. If `scripts/install-launch-agents.sh` is listed, restart in step 8 with the installer. If `plugin/…` or `.claude-plugin/…` is listed, do [When the plugin changed](#when-the-plugin-changed) after step 9. *Rehearsed: expected nothing for a change to `src/` alone, observed nothing (2026-10-28).*

5. **Install the dependencies:**

   ```sh
   bun install
   ```

   Expected: `Checked … installs … (no changes)` unless `package.json` or `bun.lock` changed, in which case Bun installs the difference. *Rehearsed: expected no changes, observed no changes (2026-10-28).*

6. **Check the deployed tree,** which takes about 40 seconds (type check, lint, tests, docs check). It starts throwaway servers on random ports and doesn't touch the bus:

   ```sh
   bun run check
   ```

   Expected: `0 fail` and `check-docs: … ok`. If it fails, roll back (step 10) before restarting anything. *Rehearsed: expected 180 passing tests and no failures, observed 180 pass, 0 fail (2026-10-28).*

7. **Start a stand-in for a Claude hook,** so the verification can show that hooks rearm by themselves. It is the plugin's hook command, fed the input Claude Code gives it, waiting on a test address:

   ```sh
   agent-bus join --address deploy-check/receiver --runtime claude --session deploy-check-receiver
   check=$(mktemp -d)
   echo '{"session_id":"deploy-check-receiver"}' | agent-bus claude-wake >"$check/hook.out" 2>"$check/hook.err" &
   hook=$!
   sleep 2
   ```

   Expected: `joined as deploy-check/receiver`. The hook waits in the background; it ends if this shell does. *Rehearsed: expected the join and a waiting hook, observed both (2026-10-28).*

8. **Restart `serve`:**

   ```sh
   launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus
   ```

   Expected: no output, and `serve` serving again within about a second. `kickstart -k` kills the running job and starts it at once, even inside the 10-second throttle ([operate](operate.md#restart-one-process)). If step 4 listed the installer, run `bun run install:launch-agents` instead: it also restarts Fluree and rewrites the plists, so the bus pauses for a few seconds longer. *Rehearsed: expected `serve` back in about a second, observed healthy within 1 s (2026-10-28). The installer rerun is rehearsed in [install](install.md#rerun-the-installer).*

9. **Verify.**

   a. **`serve` is healthy, new, and runs the primary checkout:**

   ```sh
   for i in $(seq 1 30); do curl -fs http://127.0.0.1:8096/health && break; sleep 1; done; echo
   tail -n 2 ~/.agent-bus/agent-bus.log
   launchctl print gui/$(id -u)/ai.rawr.agent-bus | grep -E 'state =|pid =|bin.ts'
   ps -o lstart= -p "$(launchctl print gui/$(id -u)/ai.rawr.agent-bus | awk '/pid =/{print $3}')"; date
   ```

   Expected: `ok`; a last log line `Listening on http://127.0.0.1:8096` stamped just now (the line above it is the previous start); `state = running`, a pid, and a `bin.ts` path inside the primary checkout; a process start time within a few seconds of `date`. *Rehearsed: expected all four, observed all four (2026-10-28).*

   b. **A Claude hook rearms by itself, and a message goes from one address to another.** Wait for the hooks' retry, then rejoin as the stand-in's session (a rejoin by the same session is harmless; the answer shows `hooked`), send, wait for the stand-in to wake, and read. The CLI can't read, so the read goes through the MCP endpoint with `curl`:

   ```sh
   sleep 8
   url=http://127.0.0.1:8096/mcp
   rpc() { curl -s -X POST "$url" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $sid" -d "$1"; }
   call() { rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }
   sid=$(curl -s -i -X POST "$url" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-check","version":"1"}}}' | awk 'tolower($1)=="mcp-session-id:"{print $2}' | tr -d '\r')
   rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
   call bus_join '{"address":"deploy-check/receiver","runtime":"claude","session":"deploy-check-receiver","cwd":"/tmp"}' | grep -o '"hooked":true'
   agent-bus join --address deploy-check/sender --runtime other --session deploy-check-sender
   agent-bus publish --from deploy-check/sender --session deploy-check-sender --to deploy-check/receiver --body "deploy check"
   wait "$hook"; echo "hook exit $?"; cut -c1-70 "$check/hook.err"
   call bus_read '{"address":"deploy-check/receiver","session":"deploy-check-receiver"}' | grep -o '"body":"[^"]*"'
   call bus_leave '{"address":"deploy-check/sender","session":"deploy-check-sender"}' >/dev/null
   call bus_leave '{"address":"deploy-check/receiver","session":"deploy-check-receiver"}' >/dev/null
   mv "$check" ~/.Trash/deploy-check-$$
   agent-bus peers
   ```

   Expected, in order: `"hooked":true`; `joined as deploy-check/sender`; a message id; `hook exit 2` and the line `[agent-bus] New messages for "deploy-check/receiver". …` (the wake the hook gives a session); `"body":"deploy check"`; then the peers list without either test address. `"hooked":true` is missing if the hook hasn't called `serve` again: wait and repeat the rejoin. *Rehearsed on a stand-in hook, not a Claude session: expected `hooked` true within 10 s of the restart, a wake with exit 2, the body read and both test addresses gone; observed all of them, `hooked` first true 6 s after the restart (2026-10-28). Unverified in a real Claude session: from a joined session, call `bus_join` again with its own address and session and expect `hooked: true` within the same time.*

10. **If anything in step 9 failed, roll back.** Reset the primary checkout to the commit you wrote down, then restart and verify again (steps 8 and 9):

    ```sh
    git reset --hard "$previous"
    bun install
    launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus
    ```

    Expected: `HEAD is now at …` with the old commit, and after step 9 a `serve` running the old code. `reset --hard` is safe here because the rule keeps the tree free of uncommitted work. The reset moves only this checkout: `main` still holds the change, and the next fast-forward would deploy it again. Fix it on `main`, by a fix or a revert merged through a pull request, before deploying again. If the deploy changed the installer, rerun it after the reset; if it changed the plugin, do [When the plugin changed](#when-the-plugin-changed) again. *Rehearsed: expected the old commit, a healthy `serve` on the old code and the same step 9 results, observed those, with `agent-bus --version` and `serve`'s reported version both back at the old value (2026-10-28).*

## When the plugin changed

A change under `plugin/` or `.claude-plugin/` isn't deployed by the fast-forward. Claude Code copies the plugin into its cache, so the change reaches sessions only after `claude plugin update` and a restart of each session ([platforms: Claude Code](../platforms/claude-code.md#plugins)). Run this after step 9, so `serve` already has `bus_wake` for the new hook to find:

```sh
claude plugin marketplace update agent-bus
claude plugin update agent-bus@agent-bus
claude plugin list
```

Expected: `claude plugin list` shows `agent-bus@agent-bus` enabled at a new version. Sessions get the change when they next start, or with `/reload-plugins`. After a rollback, run the same commands again so the cache follows the checkout. A change to `src/` alone needs none of this. *Unverified: it would change the owner's installed plugin. The commands and the restart requirement are in `claude plugin --help`; the cache behaviour is verified live in the platform page.*

## If it fails

| Symptom | Check | Fix |
| --- | --- | --- |
| Step 1: `status` prints files, or the branch isn't `main` | `git status`, `git log origin/main..HEAD` | The rule was broken. Move the work to a worktree (`git stash` or a branch there), restore the primary checkout to `main`, and start again. Don't deploy over uncommitted work |
| Step 3: `Not possible to fast-forward` | `git log --oneline origin/main..HEAD` | The primary checkout has a commit that isn't on `main`. Same fix: put it in a worktree branch, then `git reset --hard "$previous"` and retry |
| `serve` doesn't come back after step 8: the health loop prints nothing | `launchctl print gui/$(id -u)/ai.rawr.agent-bus \| grep -E 'state =|last exit'` and `tail -n 20 ~/.agent-bus/agent-bus.log` | *Rehearsed with a syntax error in `src/`:* health refused the connection; `state = spawn scheduled`, `last exit code = 1`; the log ended in the Bun error with the file and line; `agent-bus --version` printed the same error, so the hooks failed too. Roll back (step 10). Hooks that fail retry for ten minutes, then wait for their next arming point |
| The step 9a log line is old, or the pid and start time are old | `ps -o lstart= -p <pid>` | The restart didn't happen. Repeat step 8 |
| `hooked` never comes back, or the stand-in never wakes | `tail -n 30 ~/.agent-bus/agent-bus.log`, then rerun the rejoin | A `serve` older than `bus_wake` makes hooks retry until a deploy replaces it. Check step 3 deployed what you meant. See [recover](recover.md) |
| Anything else, or you need `serve` or Fluree restarted another way | | [Operate](operate.md) and [recover](recover.md) |
