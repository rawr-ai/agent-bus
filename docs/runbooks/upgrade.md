# Upgrade

Use this after upgrading Codex, Claude Code, Fluree or the agent-bus plugin: what to recheck, and how running sessions pick up new guidance. Installed versions and the findings to recheck are in [platforms](../platforms/README.md). Putting a new agent-bus version into service is in [deploy](deploy.md).

Each step ends with how it was checked. The upgrade itself is the owner's act: nothing here installs a new Codex, Claude Code or Fluree, and no real upgrade was run to write this page. Commands that only read were run on the bus host on 2026-10-28; what an upgrade changes is marked unverified until one has been followed through, and the guidance section is to be qualified.

## Before you start

The findings register in [platforms](../platforms/README.md#version-sensitive-findings) names, for each finding, what could make it stale in its "Recheck when" column. After an upgrade, recheck the rows that name what you upgraded. This lists them (the pattern is the part to change):

```sh
rows() { sed -n '/^## Version-sensitive findings/,/^## How claims/p' docs/platforms/README.md |
  awk -F'|' -v w="$1" '/^\| / && NR>4 && $(NF-1) ~ w {print "-" substr($2,1,60) " => " substr($(NF-1),1,70)}'; }
rows 'Codex|daemon|desktop app is|bundled CLI'
rows 'Claude Code'
rows 'Fluree'
```

Run it from the repo root. Expected: the rows for each platform, 19 for Codex, 8 for Claude Code and 3 for Fluree at the time of writing. *Checked read-only on the running bus (2026-10-28).*

When a recheck changes a finding, edit the platform page that owns it (its claim, its basis and the version it was observed on), the findings row, and the installed-versions table; this page doesn't change.

## After upgrading Codex (CLI or desktop app)

`serve` uses the desktop app's bundled CLI, so a desktop update changes the Codex that `serve` talks to. The daemon is a separate process that can run a different version. Check all of them.

1. **Read what is installed now:**

   ```sh
   codex --version
   /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version
   defaults read /Applications/ChatGPT.app/Contents/Info.plist CFBundleShortVersionString
   codex app-server daemon version
   ps -axo pid,lstart,command | grep -E 'app-server( .*)? --listen unix://' | grep -v grep | cut -c1-120
   ```

   Expected: the CLI on `PATH`; the bundled CLI (what `serve` runs); the desktop app's version; JSON whose `cliVersion`, `managedCodexVersion` and `appServerVersion` say which versions the CLI, the managed package and the running daemon are; and the daemon's process with its start time. Compare each with the installed-versions table. The daemon's version may lag the CLI's: a managed daemon updates itself ([platforms: Codex](../platforms/codex.md#the-daemon)), and an SSH-started one never does (inferred). *Checked read-only on the running bus (2026-10-28): the CLI and the bundled CLI were a release past the register's, the desktop app a build past it, and the daemon was still on the register's version.*

2. **List the findings to recheck** with the command in [Before you start](#before-you-start), pattern `Codex|daemon|desktop app is|bundled CLI`. Rerun each experiment its row names or links, on throwaway threads. The queue methods are experimental and the register says to retest them after every Codex upgrade, but no script does it: a retest is a nudge round trip to a throwaway Codex thread, watching `serve`'s log for `Waking <address>: …` and for the thread running the nudge ([delivery](../architecture/delivery.md#codex-threads)). *Unverified: it needs a Codex thread, which this page's author didn't start. No smoke test script exists.*

3. **Let `serve` meet the new bundled CLI.** `serve` starts a fresh Codex app-server for every post and removal, so the next attempt after the desktop update already runs the new CLI, and `serve` needs no restart for it (read from [topology](../architecture/topology.md#processes)). Watch its log for new warnings:

   ```sh
   tail -n 50 ~/.agent-bus/agent-bus.log
   ```

   Expected: `Waking …` lines, no run of `Could not wake …` or `Could not nudge …`. Their meanings are in [operate](operate.md). *Unverified: no desktop upgrade was followed through.*

4. **Restart the daemon when you must.** A managed daemon restarts itself on an update: it reloads its threads under the global unload delay, not a borrow's 5 s ([platforms: Codex](../platforms/codex.md#how-long-a-thread-stays-loaded)). Restart it yourself after the owner changes the Codex login, because a daemon keeps the login it started with, and when it has wedged ([recover](recover.md)). The procedure, with the open-file limit raised, is in [operate](operate.md#the-codex-daemon-file-limit-and-restarts). Remember what a restart does: it unloads every daemon-hosted thread, and their nudges wait in the queue until `serve` borrows the thread again or it is reopened. `codex app-server daemon update` also exists (`--help` says it may interrupt running work); it wasn't tried. *Unverified: the restart procedure is rehearsed only in operate's draft.*

5. **Check the open-file limit after every daemon start.** The daemon inherits the limit of whatever started it. A daemon that runs out of descriptors fails with `Too many open files`. Check as [operate](operate.md#the-codex-daemon-file-limit-and-restarts) says, after each start, however the daemon started. *Unverified: macOS shows another process's limit only to root; the check is the one in operate.*

## After upgrading Claude Code

The terminal CLI and the desktop app's bundled copy are separate installs.

1. **Read what is installed now:**

   ```sh
   claude --version
   defaults read /Applications/Claude.app/Contents/Info.plist CFBundleShortVersionString
   ls ~/Library/Application\ Support/Claude/claude-code/
   claude plugin list
   ```

   Expected: the terminal version; the desktop app's version; one directory per bundled Claude Code version the app keeps (the running sessions use one: see `ps` in [platforms](../platforms/README.md#installed-versions)); and the agent-bus plugin enabled, with the commit its cache copy was made from. Compare with the installed-versions table. *Checked read-only on the running bus (2026-10-28).*

2. **List the findings to recheck** with the command in [Before you start](#before-you-start), pattern `Claude Code`. The hook rows (`asyncRewake`, `timeout`, `claude -p`) are what the wake depends on, so recheck those first. Each was verified live on a throwaway session, so a recheck starts one. *Unverified: it needs Claude sessions, which this page's author didn't start. No recheck script exists.*

3. **Let sessions load the hook again.** Claude Code loads a session's hooks when the session starts ([platforms: Claude Code](../platforms/claude-code.md#plugins)), so a session started before the upgrade keeps the hook it began with. Restart long-running sessions you rely on being woken. *Unverified for an upgrade; the load-at-start rule is verified live at deploy in the platform page.*

4. **Check the plugin cache.** Claude Code keeps a copy of the plugin under `~/.claude/plugins/cache/agent-bus/agent-bus/<commit>`. After an upgrade, `claude plugin list` should still show `agent-bus@agent-bus` enabled. If the manifest changed, update it as [After a change to the plugin](#after-a-change-to-the-plugin) says. *Checked read-only on the running bus: the cache holds one directory, named for the installed commit (2026-10-28). Unverified after an upgrade.*

## After upgrading Fluree

Follow the new version's own documentation first: it is installed with the CLI, pinned to its version.

1. **Read the docs for what changed,** at least on indexing, tokens and authentication, and the event stream:

   ```sh
   fluree --version
   fluree docs search "data-auth-mode"
   fluree docs search "events-auth-mode"
   fluree docs get indexing-and-search/fulltext.md
   ```

   Expected: the new version in each result's header (`docs v…`) and the pages the platform page cites ([platforms: Fluree](../platforms/fluree.md)). Look for changed defaults for authentication, CORS and indexing, because the installer's flags and the findings depend on them. *Checked read-only on the running bus: the commands run and answer with the installed version's docs (2026-10-28).*

2. **Run the qualification.** It starts its own durable Fluree on a random port in a temporary directory, so it is safe to run beside the live bus:

   ```sh
   bun run qualify:fluree
   ```

   Expected: six `PASS` lines (corpus indexed; canary is unindexed novelty; search spans indexed and novelty; cursor catches up across restart; waiting reader woken after restart; same matches once indexed), exit status 0, in about 20 seconds. One `Fluree events disconnected, reconnecting` warning in the middle is the server restart it performs. A `FAIL` line means a claim in [platforms: Fluree](../platforms/fluree.md) no longer holds. *Rehearsed: expected six PASS, observed six PASS in 17 s with that one warning (2026-10-28).*

3. **Recheck by hand what the qualification doesn't:** the delay before a new ledger's first text search finds anything. `bun run qualify:fluree` doesn't recheck it ([platforms: Fluree](../platforms/fluree.md#full-text-search)). On an isolated bus ([operate](operate.md#run-an-isolated-bus-for-checks)), publish one message and search for a word in it with `bus_history` straight away and again five seconds later; the platform page says what to expect. Then send a few more and search for the first message's word: it must be found. A search that misses messages from the ledger's first minute while finding later ones was seen once, on the installer's durable settings, and is unexplained. If you see it, record it in the platform page. *Unverified for an upgrade; the check itself ran on a default server and on the installer's settings (2026-10-28).*

4. **Restart the live server on the new binary.** If the `fluree` on `PATH` is the same file as before, restart just Fluree ([operate](operate.md#restart-one-process), step 2). If the binary moved, or the installer's flags changed, rerun the installer, which rewrites the Fluree plist from the `fluree` on `PATH` and restarts both servers ([operate](operate.md#rerun-the-installer-instead)). The key, token and messages survive either way, and the installer re-applies the authentication flags. Then repeat the health and token checks of [install](install.md#install-on-the-bus-host) (steps 4 to 6). *Rehearsed: the Fluree restart and the installer rerun, with the key, token and messages kept and the token check passing ([operate](operate.md#restart-one-process), [install](install.md#rerun-the-installer)) (2026-10-28). Unverified with a new binary.*

## After a change to the plugin

The agent-bus plugin is a manifest that Claude Code copies into its cache, so a change under `plugin/` or `.claude-plugin/` reaches sessions only through an update and a restart of each session. Deploy `serve` first ([deploy](deploy.md)), so the hook finds `bus_wake`.

```sh
claude plugin marketplace update agent-bus
claude plugin update agent-bus@agent-bus
claude plugin list
```

Expected: `agent-bus@agent-bus` enabled, at a new version. Then restart the sessions that need the change, or run `/reload-plugins` in them. The hook runs the checkout's code through `~/.local/bin/agent-bus`, so a change to `src/` reaches it at once without any of this. *Unverified by run: it would change the owner's installed plugin. `claude plugin update --help` says a restart is required to apply it. That `/reload-plugins` does the second step wasn't probed ([platforms: Claude Code](../platforms/claude-code.md#plugins)).*

## Refreshing guidance in running sessions

Changing what agents are told doesn't change what a running session already holds. This is the state of knowledge today; the checks below are to be qualified.

| Guidance | Where it lives | Reaches a running session | To get it into one |
| --- | --- | --- | --- |
| The MCP instructions | `src/mcp.ts`, sent when a client connects | Not until the session reconnects: a long-running session kept the instructions it connected with, and still showed retired ones after a deploy (observed, [platforms: Claude Code](../platforms/claude-code.md#plugins)) | Deploy `serve`, then reconnect the MCP server, or restart the session (inferred to reconnect) |
| Tool descriptions and parameters | `src/mcp.ts`, listed when a client connects | The same: when the session reconnects (inferred; `serve` advertises tool-list changes, and whether a restart of `serve` reaches a client's list is unverified) | As above |
| A plugin's skill | The plugin's `skills/` folder, in the plugin's cache | Only after the plugin updates, then at a session's start (unverified; the platform page says it isn't known whether it reaches a running session) | [After a change to the plugin](#after-a-change-to-the-plugin), then restart the session |
| The Claude wake text | `src/claude.ts`, written at each wake by the hook | At the next wake after a deploy, since the hook runs the checkout (inferred) | Deploy `serve` and the checkout ([deploy](deploy.md)) |
| A Codex nudge's text | `src/codex.ts`, posted into a thread's queue | Not for a nudge already waiting: it is reused unchanged, so a change reaches a thread with its next new nudge ([delivery](../architecture/delivery.md#codex-threads)) | Nothing: it runs, or is removed, with its old text. The text's first sentence must stay the same, because the deliverer recognises waiting nudges by it |
| CLI help | `src/bin.ts` | At once, in the next command | Deploy |

To see what a freshly connecting client gets, ask `serve` for its instructions. This is a new connection, which is what a restarted session makes:

```sh
curl -s -X POST http://127.0.0.1:8096/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' |
  grep -o '"instructions":"[^"]\{0,120\}'
```

Expected: the start of the current instructions, `agent-bus lets Claude and Codex sessions message each other.` What a running session holds is what it was shown when it connected: ask the session to quote its instructions, and compare. *Rehearsed: expected the current instructions from an isolated `serve`, observed them (2026-10-28). Unverified: that a session shows the old text until it reconnects, and how each client reconnects without a restart.*

## If it fails

| Symptom | Fix |
| --- | --- |
| A recheck no longer holds | Don't change this runbook. Update the platform page's claim and register row, then decide whether the architecture page that rests on it changes (the register's "Described in" column names it) |
| `bun run qualify:fluree` prints a `FAIL` | The new Fluree breaks a claim the bus relies on. Don't rerun the installer on it; reinstall the previous binary, or stay on it and record the finding in [platforms: Fluree](../platforms/fluree.md) |
| `Could not wake …` after a Codex or desktop update | [Operate](operate.md) for the log's meaning, [recover](recover.md) for a wedged daemon or a stuck thread |
| Borrowed turns run as an earlier user | Restart the daemon: [recover](recover.md) |
| Sessions aren't woken after a Claude Code upgrade | Restart them so the hook loads again, check `claude plugin list`, then [recover](recover.md) |
