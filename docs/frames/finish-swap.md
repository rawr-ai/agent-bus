# Finish the swap: the plugin runs the checkout, and no legacy path is left

Status: framed 2026-10-27, after the Claude wake's deploy ([claude-wake](claude-wake.md)).

## The problem

**The plugin isn't served in place.** At the Claude wake's deploy, `claude plugin install agent-bus@agent-bus` copied the whole checkout into `~/.claude/plugins/cache/agent-bus/agent-bus/<commit>`, on both machines. The copy was 238 MB, `node_modules` and untracked local folders included. `${CLAUDE_PLUGIN_ROOT}` is that copy, so the hook runs the code as it was at install. A later deploy wouldn't reach the hook until someone ran `claude plugin update`. Decision 9 of the Claude wake assumed in-place loading. That held for `--plugin-dir`, which the pre-release check used, but not for a marketplace install.

**Old paths are still in use.** The owner wants every consumer on the new paths, and nothing legacy left in code or on either machine.
- **Claude sessions** that started before the plugin still wake by a background `agent-bus wait`.
- **Codex threads** loaded before the `Stop` hook's removal still call the no-op `codex-stop-hook`.
- **On disk:**
  - the old JSONL store (`ledger.jsonl`, `cursors/`);
  - an empty `~/.codex/hooks.json` on the bus host, and the retired hook's trust record in its `config.toml`;
  - stale peers and worktrees.

## Decisions

**1. The plugin is one file, and its hook runs the checkout through a launcher.**
- **The plugin.** `plugin/.claude-plugin/plugin.json` holds the hooks. The marketplace (`.claude-plugin/marketplace.json`) points at `./plugin`, so the cached copy is that one file.
- **The hook command:** `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" exec "$HOME/.local/bin/agent-bus" claude-wake`. It names the launcher, so no other `agent-bus` on Claude Code's `PATH` can win. It prefers the user's own `bun`, from `~/.local/bin` and then `~/.bun/bin`, over one earlier on that `PATH`.
- **The launcher.** `agent-bus` is `~/.local/bin/agent-bus`, a symlink to the checkout's `src/bin.ts`. That file becomes executable, with its existing `#!/usr/bin/env bun` line. The installer creates the link and checks that it runs. A missing link fails before the hook's retry loop, so each deploy checks it too.
  - Bun resolves modules from the link's target, so the hook runs the checkout's code against its own dependencies. A deploy reaches the hook with no plugin step.
  - Checked: with a launchd-style `PATH`, a home whose only `bun` is in `~/.bun/bin`, and another working directory, the link runs.
- **When the plugin changes.** It changes only when its hooks do. Then run `claude plugin marketplace update agent-bus` and `claude plugin update agent-bus@agent-bus`, and restart sessions to take it.
- **`agent-bus` on `PATH`.** The README's `agent-bus …` commands become literal.

Rejected:
- **Keep the full copy and update it at each deploy:** an extra step per deploy, a stale hook until it runs, and a 238 MB copy per version.
- **An absolute path in the manifest:** the repo is public, and the path differs per machine.
- **An environment variable set in each machine's Claude settings:** a hand edit per machine.
- **`--plugin-dir`:** a per-session flag that the desktop app can't pass.

**2. Retire `agent-bus wait`.** Do this once every Claude session on both machines has restarted with the plugin and rejoined with `hooked: true`.
- **What goes:**
  - the `wait` command;
  - the "otherwise run `wait`" fallback in `bus_join`'s description, the server instructions, the README and the overview.
- **Without the plugin,** a Claude session reads by calling `bus_read`, or `bus_wait` within a turn. The instructions tell it to install the plugin.
- **`bus_wait` stays.** It is the in-turn wait for a reply, as in `claude -p`, not a wake.

**3. Retire `codex-stop-hook`.** Do this once every Codex app-server on both machines (desktop and daemon) has started since the hook's removal (02:35 EDT, 2026-10-27), as `ps -o lstart` shows. The command, the README's transition note and the overview's transition row all go.

**4. Clean up each machine,** after the release that retires them:
- **Plugin copies:** every full-checkout copy under `~/.claude/plugins/cache/agent-bus/`, moved to the Trash. Only after the step 3 check, because a session still running holds its hooks from the copy it loaded.
- **Bus host, old store:** `~/.agent-bus/ledger.jsonl` and `~/.agent-bus/cursors/`, moved to the Trash. First, every JSONL entry must decode, and match the decoded Fluree record with its id field for field, presence included. The comparison reads every page of the query, at one ledger head.
- **The other machine:** the empty `~/.agent-bus/cursors/`, removed.
- **Bus host, Codex hooks:**
  - `~/.codex/hooks.json`, which holds no hooks, moved to the Trash;
  - the `[hooks.state."…/.codex/hooks.json:stop:0:0"]` table removed from `~/.codex/config.toml`. The edit removes that exact table and nothing else. It keeps a backup, checks that the result parses as TOML, and diffs it against the original.
  - The other machine has no such record (checked live), and its `hooks.json` keeps its other hook.
- **Leftovers:**
  - the wake session's address and every `qual/*` address, left;
  - finished worktrees, removed.

**5. Order.**
1. **Release A (decision 1),** on both machines:
   - fast-forward;
   - create the launcher link;
   - update the marketplace and the plugin;
   - check that the plugin's install path holds only the manifest;
   - qualify.
2. **The owner restarts:**
   - the Claude sessions; each rejoins and gets `hooked: true`;
   - the Codex desktop app, on both machines.

   The Director is told first, then the Codex daemons restart through a deploy agent. A daemon restart unloads its threads, and a nudge waits until a thread is opened again. So the owner reopens each previously active daemon thread, from the TUI or SSH project that ran it.
3. **Verify every consumer.** `hooked: true` only shows that a hook called at some point, and an old cached copy's hook counts too. So the gate is the processes, on both machines (`ps -axo pid,ppid,lstart,command`):
   - every Claude Code process started after Release A's plugin update;
   - every `claude-wake` process runs `~/.local/bin/agent-bus`, and none runs a path under `plugins/cache`;
   - no process runs `wait`;
   - every Codex app-server started after 02:35 EDT.

   Also check the bus:
   - each Claude peer rejoined from its new session;
   - one live wake and read per consumer:
     - throwaway sessions for Claude;
     - for the Director, an observed read of a real message;
     - for the other Codex peers, their next nudged read in `serve`'s log.
4. **Release B (decisions 2 and 3):** build, then deploy.
5. **Then:**
   - the cleanup (decision 4);
   - docs, repo memory;
   - a message to the Director.

## Known limits

- **A plugin change still needs a restart to take effect.** Claude Code loads a session's hooks at its start. With the plugin reduced to one stable manifest, this is rare.
- **The launcher is per user.** `~/.local/bin/agent-bus` serves one checkout. A second checkout on the same machine would need its own link name.

## Reviews

Astra (max) and Sol (xhigh) reviewed the frame read-only. Both found:

- **No auditable consumer gate.**
  - `bus_peers` has no hook state.
  - `hooked` records any past `bus_wake` call.
  - No `wait` process misses a session between waits.

  Accepted: step 3 now checks processes on both machines, and the cached copies stay until it passes.
- **Daemon restarts unload threads.** Accepted: the owner reopens each one.
- **`PATH` picks the launcher and `bun`.** An earlier `agent-bus` or `bun` would win. Accepted: the hook names the launcher and puts the user's `bun` directories first. The installer and each deploy check that the link runs. The test adds a decoy `bun` and `agent-bus` earlier on `PATH`, and fails with the old command.
- **Release B's scope.** Also remove:
  - `Client.waitFor`, `formatDelivery` and `describe`;
  - their tests, and the no-op hook's;
  - the README's and overview's claims about the CLI's retries.

  Accepted.
- **Ids don't prove the migration.** A record can exist with undecodable or different JSON. Accepted: compare whole decoded records.
- **The trust-table edit must be exact.** Accepted. Sol also expected a record on the other machine. It has none: checked live.

Both found the `./plugin` layout right, and the parent check intact through `sh` → `env` → `bun`. Both kept `bus_wait` as current function, and kept two releases for continuity. Neither found a simpler design than the link: without it, each machine needs its own path configuration.

## Code review (Release A)

Sol (xhigh) and Opus reviewed the diff. Accepted:

- **The installer's check ran in the installer's environment.** Under `bun run`, its `PATH` holds a temporary `bun`, so the check could pass where the hook fails (Opus, verified). It now runs from `/`, with `env -i` and a launchd-style `PATH` after the user's `bun` directories.
- **`ln -sfn` over a real directory** links inside it, and over a file it replaces the file (both). The installer now refuses anything but a link, and makes the link before it changes any service.
- **The hook loaded the session project's `.env`.** It runs in the session's working directory, so a project `.env` could set `AGENT_BUS_PORT` (Opus, verified; this predates the change). The shebang is now `#!/usr/bin/env -S bun --no-env-file`.
  - Checked by hand: from a folder whose `.env` sets port 9, the launcher reaches `serve` on 8096.
  - No unit test: the only way to show it would fall back to the machine's own bus.
- **The test's hook had no time limit** (Opus). It has one now.
- **Docs and the installer's output:**
  - the README and the overview say the installer makes the link;
  - three more lines of the Claude wake frame are corrected;
  - the installer quotes the checkout path and prints the `update` commands.

Verified by the reviewers:
- the parent check holds through `sh` → `env` → `bun`;
- Bun resolves the entry to the link's target;
- a `$HOME` with spaces works;
- a missing link exits 126 and a missing `bun` exits 127, so neither wakes the session falsely.
