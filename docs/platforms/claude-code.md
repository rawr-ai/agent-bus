# Claude Code

What agent-bus rests on in Claude Code: how the desktop app runs it, and how hooks, session ids, plugins, the inbox socket and channels behave. What agent-bus does with it is in [delivery](../architecture/delivery.md). Each claim is marked with its basis, as [platforms](README.md#how-claims-are-marked) defines, and the [findings table](README.md#version-sensitive-findings) lists the version-sensitive ones with when to recheck them.

Unless a claim names another version, it was observed on Claude Code 2.1.310, in the terminal and in stream-json mode, on throwaway sessions on 2026-10-27 ([claude-wake](../frames/claude-wake.md#what-it-rests-on): scratch folders, a small model, no MCP servers, no bus). The desktop app's installed build is 2.1.308; that it behaves as 2.1.310 did in stream-json mode is extrapolated.

## How Claude Code runs

- **The desktop app runs Claude Code in stream-json mode,** as `claude --input-format stream-json --output-format stream-json`, with no terminal (verified live, from the process list). The terminal runs it interactively, and `claude -p` runs one prompt and exits. Several facts below differ between the three.

## Hooks

- **`asyncRewake` hooks work in both modes.** A hook marked `asyncRewake` runs in the background, and when it exits 2, its stderr wakes the session, even an idle one. Each run is its own background process. `Stop` hooks, from `--settings` or from a plugin, woke an idle stream-json session after its first turn (verified live). The hook docs agree: exit 2 "wakes Claude immediately even when the session is idle" (documented).
- **`SessionStart` can start a turn by itself.** An `asyncRewake` `SessionStart` hook woke a stream-json session that had been sent no input at all, and the session acted on the hook's line (verified live). A resumed idle session is therefore woken without a prompt.
- **The hook's `timeout` is a kill deadline.** `timeout: 5` on a hook that sleeps 15 s killed it at 5 s, and it woke nothing. A `timeout` of 30 days (2592000) is accepted, and that hook woke the session at 25 s (both verified live). A hook that outlasts its `timeout` is gone.
- **What the model sees.** The hook's stderr reaches the model under Claude Code's own label, "Stop hook blocking error from command …" (verified live: the woken sessions acted on it).
- **How fast a hook wakes an idle session.** Mail sent to an idle stream-json session woke it in 1.5–2.6 s across seven arrivals, including a resumed session and one after `/clear` (verified live, Claude Code 2.1.310, [claude-wake](../frames/claude-wake.md#results-2026-10-27)).
- **`StopFailure` with `asyncRewake`** is documented but wasn't probed.
- **The hook's input** carries the session's id, equal to its `CLAUDE_CODE_SESSION_ID` (verified live).
- **Hooks inherit Claude Code's environment,** not a shell's, so `PATH` may lack `bun` (documented; the hook was checked with the desktop app's `PATH` and with launchd's).
- **A hook runs in the session's working directory,** so a project's `.env` is visible to a Bun-based hook that loads it (verified by two reviewers, [finish-swap](../frames/finish-swap.md#code-review-release-a)).
- **`claude -p` ends async hooks** when the run ends (documented), so a `-p` run is never woken by a hook.

## Session ids

`CLAUDE_CODE_SESSION_ID` is the id an address belongs to. Verified in qualification on 2026-10-26 (Claude Code 2.1.310, [address-ownership](../frames/address-ownership.md#verified-and-unverified)), unless marked:
- **Where it is set:** in the desktop app, in interactive terminal sessions and in `claude -p`, each with its own value, even when started from another session's shell.
- **A child process inherits it.** Anything started from a Claude shell, a `codex exec` run say, carries the Claude id beside its own runtime's, and acts as the parent if it reads the wrong variable.
- **`--resume` keeps the id;** `--fork-session` and `/clear` change it.
- **Subagents share their parent's id** (a reviewer's own shell).
- **A plugin monitor keeps the old id after `/clear`:** it ran on with it, and its next line woke the cleared conversation (verified live in the terminal, 2026-10-27).

## Plugin monitors

A monitor is a long-running command a plugin declares, and a line it prints wakes an idle session.
- **In the terminal** it started about 1 s after the folder was trusted and woke idle sessions. It ran for the whole 39-minute session, so it has no 30-minute deadline. Its environment has the session's `CLAUDE_CODE_SESSION_ID` (verified live).
- **In stream-json mode no plugin monitor starts.** The plugin loaded (it is listed at init), but in two runs of more than 5 minutes, one with the desktop's environment and one clean, its monitor never ran (verified live). Plugin monitors don't start with `-p` either (documented).
- **A model-armed `Monitor` is different:** a line it printed in an idle desktop session started a turn on 2026-10-26, and such a monitor expires after at most 30 minutes (verified live, [research](../research/mcp-native-messaging.md#mechanisms-by-client-and-session-state)).
- **A background command's exit** wakes an idle session, in the desktop app and the terminal (verified live, with the retired `agent-bus wait`).

## The session inbox socket

Each Claude Code process binds an inbox socket, named by `$CLAUDE_CODE_MESSAGING_SOCKET`. It carries `SendMessage` (2.1.224 and later).
- **An outside process can wake a session through it.** An unrelated process posted a message frame to an idle stream-json session's socket, and the session started a turn (verified live). The socket and its inbound rules are documented; the frame format is not, and was read from Claude Code's bundle.
- **It is bound in desktop sessions** (verified live, [research](../research/mcp-native-messaging.md#mechanisms-by-client-and-session-state)).
- **Mail from outside the session is held by rule.** It is subject to `crossSessionInbound` and a permission-mode match, so a session that bypasses permissions holds it. The desktop can't show the hold dialog, so it drops held mail after `dialogExpiry`, 5 minutes (read in the 2.1.310 bundle; documented).
- **It is per process,** so a child process of the session posting to its own session's socket would be delivered under the default rules (inferred, not tried). A process that is not the session's child, such as `serve`, is not.

## Channels

A channel is Claude Code's own push into a session: a server's `notifications/claude/channel` is enqueued as a prompt, so the model sees it and an idle session starts a turn (read in the 2.1.310 bundle; documented).
- **Terminal only.** It needs `--channels` with an allowlisted plugin, or `--dangerously-load-development-channels`, first-party authentication and a 2025-era MCP connection. No desktop session ran with `--channels`, and the SDK's `channel_enable` accepts only marketplace plugins (the first verified live, the second read in the bundle). Requests #86800 and #98369 to lift this were open (reported).
- **A 2026-07-28 MCP connection refuses channels** ("no unsolicited notification path"; read in the bundle). Claude Code asks stdio servers for 2026-07-28 by default from 2.1.292 (reported).
- **No other MCP message reaches the model.** `list_changed` refreshes Claude Code's own lists, logging notifications aren't shown to the model, elicitation asks the human, and sampling isn't supported (read in the bundle; reported in the issues cited in [research](../research/mcp-native-messaging.md#mechanisms-by-client-and-session-state)).

## Plugins

- **A plugin installed from a marketplace is copied** into Claude Code's cache, not loaded in place. `claude plugin install` copied a whole checkout, 238 MB, into `~/.claude/plugins/cache/<marketplace>/<plugin>/<commit>` on both machines, and `${CLAUDE_PLUGIN_ROOT}` pointed at the copy (verified live at deploy, [finish-swap](../frames/finish-swap.md#the-problem)). A plugin loaded with `--plugin-dir`, or from a marketplace added from a local path, is read in place, from its source directory ([claude-wake](../frames/claude-wake.md#what-it-rests-on), verified live; documented).
- **A changed plugin reaches a session in two steps.** Run `claude plugin marketplace update` and `claude plugin update`, then restart the session: Claude Code loads a session's hooks at its start ([finish-swap](../frames/finish-swap.md#known-limits), verified live at deploy). That `/reload-plugins` does the second step wasn't probed.
- **Claude Code installs no dependencies** for a plugin it loads (documented).
- **A plugin's MCP server renames its tools** to `mcp__plugin_<plugin>_<server>__<tool>`, and registers the server as `plugin:<plugin>:<server>`. Permission rules, a skill's `allowed-tools` and hook matchers must use the full name (documented, Claude Code's MCP docs, read 2026-10-28; not tried here).
- **A running session keeps the MCP instructions and tool list it connected with** and sees changes only after it reconnects (observed: a long-running session still showed retired instructions after a deploy, [docs-consolidation](../frames/docs-consolidation.md#what-it-rests-on)). Whether a plugin's skill reaches a running session only after the plugin updates is unverified.
