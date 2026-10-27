# Platforms and versions

agent-bus depends on the behaviour of Codex, Claude Code and Fluree, much of it experimental or undocumented. This page records which versions were installed and which versions each finding was observed on, so a reader can tell when a claim may have gone stale. The other architecture pages ([topology](topology.md), [Codex hosting](codex-hosting.md), [delivery](delivery.md)) tag version-sensitive statements inline, for example "(Codex 0.164, desktop 26.1021)".

## Installed versions

What was installed on 2026-10-27, read on both machines with the read-only commands in the last column. Installed is not the same as qualified: a finding holds for the version it was observed on, which the [findings table](#version-sensitive-findings) names.

| Component | Bus host | Other machine | How to check |
| --- | --- | --- | --- |
| macOS | 27.0.1 | 27.0 | `sw_vers` |
| Bun | 1.3.14 | 1.3.14 | `bun --version` (pinned in `package.json`) |
| Fluree | 4.2.4 | Not installed: reaches the bus host's server through the tunnel | `fluree --version` |
| Codex CLI on `PATH` | 0.164.0-alpha.11.1 | 0.164.0 | `codex --version` |
| Codex CLI bundled in the desktop app (what `serve` runs) | 0.164.0-alpha.11.1 | 0.164.0-alpha.11.1 | `<bundled path> --version` ([Codex hosting](codex-hosting.md#why-serve-uses-a-short-lived-app-server-of-its-own)) |
| Codex app-server daemon | 0.164.0-alpha.11.1 | 0.165.0 | `codex app-server daemon version` |
| ChatGPT desktop app (Codex) | 26.1021.31345 (build 21828) | 26.1021.31345 | `CFBundleShortVersionString` in `/Applications/ChatGPT.app/Contents/Info.plist` |
| Claude Code, terminal | 2.1.311 | 2.1.310 | `claude --version` |
| Claude desktop app | 3.6556.2 | 3.6556.2 | `CFBundleShortVersionString` in `/Applications/Claude.app/Contents/Info.plist` |
| Claude Code bundled in the desktop app | 2.1.308 | 2.1.308 | The version directory under `~/Library/Application Support/Claude/claude-code/` that running sessions use (`ps`) |

The two machines don't match exactly: the other machine's daemon is a release ahead of its CLIs. Codex doesn't update a running daemon, so a daemon can differ from the CLI that started it.

## Configuration the owner chose

| Setting | Value | Where | Since | Why |
| --- | --- | --- | --- | --- |
| `thread_unload_delay_secs` | 300 (Codex's default is 1800) | `~/.codex/config.toml`, both machines | 2026-10-27, on Codex 0.164 (bus host) and the 0.165 daemon (other machine) | So threads left on the daemon are freed in 5 minutes rather than 30 ([Codex hosting](codex-hosting.md#the-unload-delay-the-owner-chose)) |

## Version-sensitive findings

Each finding below was observed on the versions named, and should be checked again after an upgrade of that component.

| Finding | Observed on | Basis | Described in |
| --- | --- | --- | --- |
| One writer per Codex thread (`thread-writer-locks/`); a second app-server's resume is refused | Codex 0.164.0-alpha.11.1; the lock code is also in 0.165.0 | Verified live, read in code | [Codex hosting](codex-hosting.md#one-writer-per-thread) |
| How long a thread stays loaded: `thread_unload_delay_secs`, its per-request override, the daemon ignoring `-c` for it, and the desktop's 3 h and 10-thread hold | Codex 0.164.0-alpha.11.1 (same rule in 0.165.0); desktop 26.1021.31345 | Verified live (overrides, edge cases); read in code (the daemon, the desktop's hold, applying without a restart) | [Codex hosting](codex-hosting.md#how-long-a-thread-stays-loaded) |
| The queue methods (`thread/queue/*`) are experimental; any app-server can add, and the one that has the thread loaded runs the item | Codex 0.164.0-alpha.11.1 | Verified live | [Codex hosting](codex-hosting.md#the-shared-queue) |
| How fast a queued item runs, per kind of thread | Codex 0.164.0-alpha.11.1, desktop 26.1021.31345 | Verified live | [Codex hosting](codex-hosting.md#the-shared-queue) |
| A spawned subagent's queue refuses direct input | Codex 0.164.0-alpha.11.1 (daemon) | Verified live; desktop subagents inferred | [Codex hosting](codex-hosting.md#the-shared-queue) |
| Desktop features need the desktop's own app-server; SSH projects get part of them | Desktop 26.1021.31345, Codex 0.164 | Read in code; partly verified live, partly inferred | [Codex hosting](codex-hosting.md#what-desktop-capable-means) |
| The desktop's `codex://threads/wake/<id>` link: what it does, pickup, visible effects, the retry set | Desktop 26.1021.31345, Codex 0.164.0-alpha.11.1 | Read in code and verified live; a woken thread was held past 34 min, and holding until the app restarts is inferred | [Codex hosting](codex-hosting.md#the-threadswake-link) |
| Codex asks approval for MCP tools that are destructive or open-world, except under full access | Codex 0.164.0-alpha.11.1 | Verified live, read in code | [connections](../connections.md#approval-in-codex) |
| Plugin monitors don't start in stream-json mode; `asyncRewake` hooks wake an idle stream-json session | Claude Code 2.1.310, terminal and stream-json; extrapolated to the desktop's installed 2.1.308 | Verified live on throwaway sessions | [delivery](delivery.md#what-claude-code-provides) |
| `claude -p` ends async hooks when the run ends | Claude Code 2.1.310 | Documented | [delivery](delivery.md#what-claude-code-provides) |
| Fluree applies the full-text config at a ledger's first index, so text search finds nothing for about a second after creation; a fuel limit replaces the budgeted result | Fluree 4.2.4 | Recorded in `src/Fluree.ts`; `bun run qualify:fluree` rechecks search after an upgrade | [README](../../README.md#ledger-model) |

## How claims are marked

The architecture pages mark each claim about a platform with its basis:
- **verified live:** run on one of the machines, on throwaway threads or sessions. The frames call some of these "probed";
- **read in code:** read in the installed app bundle or in the Codex source at the matching tag;
- **documented:** stated in the platform's own documentation, not run here;
- **inferred:** reasoned from the above, not observed;
- **extrapolated:** observed on one version and assumed for another, which is named;
- **inconclusive** or **unknown:** looked for, without an answer;
- **unverified:** not yet checked.

What agent-bus itself does is read in this repository's code, and needs no mark. Each page keeps platform behaviour and agent-bus's decisions in separate sections.
