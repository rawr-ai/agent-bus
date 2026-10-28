# Claude Code

What agent-bus rests on in Claude Code: how the desktop app runs it, and how hooks and plugins behave. What agent-bus does with it is in [delivery](../architecture/delivery.md#claude-code-sessions). Each claim is marked with its basis, as [platforms](README.md#how-claims-are-marked) defines.

## Hooks, plugins and the desktop app

Verified live on 2026-10-27, on throwaway sessions running Claude Code 2.1.310, in the terminal and in stream-json mode, the way the desktop app runs it ([claude-wake](../frames/claude-wake.md#what-it-rests-on)). The desktop app's installed build is 2.1.308; that it behaves as 2.1.310 did in stream-json mode is extrapolated.
- **The desktop app runs Claude Code in stream-json mode,** as `claude --input-format stream-json --output-format stream-json`, with no terminal (verified live, from the process list).
- **Plugin monitors start in the terminal but not in stream-json mode.** A monitor is a long-running command a plugin declares, and a line it prints wakes an idle session. In the terminal it started about 1 s after the folder was trusted and woke idle sessions; in stream-json mode the plugin loaded but its monitor never ran, in two runs of more than 5 minutes (verified live).
- **`asyncRewake` hooks work in both.** A hook marked `asyncRewake` runs in the background, and when it exits 2, its stderr wakes the session, even an idle one. `Stop` and `SessionStart` hooks, from settings or from a plugin, woke idle stream-json sessions (verified live). A `timeout` of 30 days is accepted (verified live). `StopFailure` with `asyncRewake` is documented but wasn't probed.
- **The hook's input** carries the session's id, equal to its `CLAUDE_CODE_SESSION_ID` (verified live). `/clear` and forks change the id; `--resume` keeps it; subagents share their parent's (verified live).
- **Hooks inherit Claude Code's environment,** not a shell's, so `PATH` may lack `bun` (documented; the hook was checked with the desktop app's `PATH` and with launchd's).
- **`claude -p` ends async hooks** when the run ends (documented).
- **A plugin installed from a marketplace is copied** into Claude Code's cache, not loaded in place (verified live at deploy, [finish-swap](../frames/finish-swap.md)).
