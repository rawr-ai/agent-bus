# Platforms and versions

agent-bus depends on the behaviour of Codex, Claude Code and Fluree, much of it experimental or undocumented. This folder keeps those facts apart from agent-bus's own decisions, which are in [`docs/architecture/`](../architecture/):
- [Codex](codex.md): app-servers, the writer lock, unloading, the queue, desktop features, the wake link, what a resume restores, the daemon, and `codex exec`;
- [Claude Code](claude-code.md): hooks, plugins, and how the desktop app runs it;
- [Fluree](fluree.md): the transaction server, its event stream, full-text search and query limits.

This page records which versions were installed and which versions each finding was observed on, so a reader can tell when a claim may have gone stale. Each fact carries its version inline, for example "(Codex 0.164, desktop 26.1021)", and its basis.

## Installed versions

What was installed on 2026-10-27, read on both machines with the read-only commands in the last column. Installed is not the same as qualified: a finding holds for the version it was observed on, which the [findings table](#version-sensitive-findings) names.

| Component | Bus host | Other machine | How to check |
| --- | --- | --- | --- |
| macOS | 27.0.1 | 27.0 | `sw_vers` |
| Bun | 1.3.14 | 1.3.14 | `bun --version` (pinned in `package.json`) |
| Fluree | 4.2.4 | Not installed: reaches the bus host's server through the tunnel | `fluree --version` |
| Codex CLI on `PATH` | 0.164.0-alpha.11.1 | 0.164.0 | `codex --version` |
| Codex CLI bundled in the desktop app (what `serve` runs) | 0.164.0-alpha.11.1 | 0.164.0-alpha.11.1 | `<bundled path> --version` ([Codex hosting](../architecture/codex-hosting.md#why-serve-uses-a-short-lived-app-server-of-its-own)) |
| Codex app-server daemon | 0.164.0-alpha.11.1; since 2026-10-28 the desktop's bundled CLI, started under a desktop SSH project's connection, as of 2026-10-28 ([Codex](codex.md#the-daemon)) | 0.165.0, the managed package | `codex app-server daemon version`, and `ps` for which binary runs |
| ChatGPT desktop app (Codex) | 26.1021.31345 (build 21828) | 26.1021.31345 | `CFBundleShortVersionString` in `/Applications/ChatGPT.app/Contents/Info.plist` |
| Claude Code, terminal | 2.1.311 | 2.1.310 | `claude --version` |
| Claude desktop app | 3.6556.2 | 3.6556.2 | `CFBundleShortVersionString` in `/Applications/Claude.app/Contents/Info.plist` |
| Claude Code bundled in the desktop app | 2.1.308 | 2.1.308 | The version directory under `~/Library/Application Support/Claude/claude-code/` that running sessions use (`ps`) |

The two machines don't match exactly: the other machine's daemon is a release ahead of its CLIs. A managed daemon runs its own update loop, on by default, and restarts on a new version (read in code, 0.164), so a daemon can be ahead of the CLI that started it.

## Configuration the owner chose

| Setting | Value | Where | Since | Why |
| --- | --- | --- | --- | --- |
| `thread_unload_delay_secs` | 300 (Codex's default is 1800) | `~/.codex/config.toml`, both machines | 2026-10-27, on Codex 0.164 (bus host) and the 0.165 daemon (other machine) | So threads left on the daemon are freed in 5 minutes rather than 30 ([Codex hosting](../architecture/codex-hosting.md#the-unload-delay-the-owner-chose)) |

## Version-sensitive findings

Each finding below was observed on the versions named, and should be checked again after an upgrade of that component.

| Finding | Observed on | Basis | Described in |
| --- | --- | --- | --- |
| One writer per Codex thread (`thread-writer-locks/`); a second app-server's resume is refused | Codex 0.164.0-alpha.11.1; the lock code is also in 0.165.0 | Verified live, read in code | [Codex](codex.md#one-writer-per-thread) |
| How long a thread stays loaded: `thread_unload_delay_secs`, its per-request override, the daemon ignoring `-c` for it, and the desktop's 3 h and 10-thread hold | Codex 0.164.0-alpha.11.1 (same rule in 0.165.0); desktop 26.1021.31345 | Verified live (overrides, edge cases); read in code (the daemon, the desktop's hold, applying without a restart) | [Codex](codex.md#how-long-a-thread-stays-loaded) |
| The queue methods (`thread/queue/*`) are experimental; any app-server can add, and the one that has the thread loaded runs the item | Codex 0.164.0-alpha.11.1 | Verified live | [Codex](codex.md#the-shared-queue) |
| How fast a queued item runs, per kind of thread | Codex 0.164.0-alpha.11.1, desktop 26.1021.31345 | Verified live | [Codex](codex.md#the-shared-queue) |
| A spawned subagent's queue refuses direct input | Codex 0.164.0-alpha.11.1 (daemon) | Verified live; desktop subagents inferred | [Codex](codex.md#the-shared-queue) |
| Desktop features need the desktop's own app-server; SSH projects get part of them | Desktop 26.1021.31345, Codex 0.164 | Read in code; partly verified live, partly inferred | [Codex](codex.md#what-desktop-capable-means) |
| The desktop's `codex://threads/wake/<id>` link: what it does, pickup, visible effects, the retry set | Desktop 26.1021.31345, Codex 0.164.0-alpha.11.1 | Read in code and verified live; a woken thread was held past 34 min, and holding until the app restarts is inferred | [Codex](codex.md#the-threadswake-link) |
| What a resume restores: approval from the latest record, permissions and mode from the thread's own snapshot, a built-in profile compiled again by name, dynamic tools from the first record, the paginated lineage | Codex 0.164.0-alpha.11.1 | Read in code; verified live: `thread/read` has no settings, and the `workspace-write` widening | [Codex](codex.md#what-a-resume-restores) |
| A resume with no client: the queued item runs, the lock goes about 5 s after idle, a held thread is refused, an attached client is unaffected | Daemon 0.164.0-alpha.11.1 (bus host); daemon 0.165.0 with CLI 0.164.0 (other machine) | Verified live, 2026-10-28 | [Codex](codex.md#a-resume-with-no-client) |
| The daemon: `daemon start`, its update loop, an SSH connection starting an unmanaged one, `daemon stop`, and keeping the login it started with | Codex 0.164.0-alpha.11.1 | Read in code (start, updates, the proxy); verified live (the SSH start, stop, login); inferred (what starts it) | [Codex](codex.md#the-daemon) |
| `codex exec` holds the lock while it runs, takes one queued item after its turn and may exit mid-way; a thread whose last turn was interrupted runs no queued input, even after a resume | Codex 0.164.0-alpha.11.1 | Verified live, read in code (the queue rule) | [Codex](codex.md#an-interrupted-thread-runs-no-queued-input) |
| Codex asks approval for MCP tools that are destructive or open-world, except under full access | Codex 0.164.0-alpha.11.1 | Verified live, read in code | [Codex](codex.md#approvals-for-mcp-tools) |
| Plugin monitors don't start in stream-json mode; `asyncRewake` hooks wake an idle stream-json session | Claude Code 2.1.310, terminal and stream-json; extrapolated to the desktop's installed 2.1.308 | Verified live on throwaway sessions | [Claude Code](claude-code.md) |
| `claude -p` ends async hooks when the run ends | Claude Code 2.1.310 | Documented | [Claude Code](claude-code.md) |
| Fluree applies the full-text config at a ledger's first index, so text search finds nothing for about a second after creation; a fuel limit replaces the budgeted result | Fluree 4.2.4 | Recorded in `src/Fluree.ts`; `bun run qualify:fluree` rechecks search after an upgrade | [Fluree](fluree.md) |

## How claims are marked

Each claim about a platform is marked with its basis:
- **verified live:** run on one of the machines, on throwaway threads or sessions. The frames call some of these "probed";
- **read in code:** read in the installed app bundle or in the Codex source at the matching tag;
- **documented:** stated in the platform's own documentation, not run here;
- **inferred:** reasoned from the above, not observed;
- **extrapolated:** observed on one version and assumed for another, which is named;
- **inconclusive** or **unknown:** looked for, without an answer;
- **unverified:** not yet checked.

What agent-bus itself does is read in this repository's code, needs no mark, and belongs in `docs/architecture/`, not here.
