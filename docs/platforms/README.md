# Platforms and versions

This folder holds the behaviour of Codex, Claude Code and Fluree that agent-bus depends on, much of it experimental or undocumented, apart from agent-bus's own decisions, which are in [`docs/architecture/`](../architecture/). Each fact carries its basis and its version. This page records which versions were installed, which version each finding was observed on, and what could make a finding stale, so a reader can tell when to recheck a claim. A page of this folder may cite the frame or research page whose experiment established a claim; no other page relies on one.
- [Codex](codex.md): app-servers, the writer lock, unloading and the gap after it, the queue, desktop features and the desktop's IPC router, the wake link, what a resume restores, hooks, ids, the daemon, `codex exec` and what a plugin can carry;
- [Claude Code](claude-code.md): how the desktop app runs it, hooks, session ids, plugin monitors, the inbox socket, channels and plugins;
- [Fluree](fluree.md): the transaction server, its event stream and tokens, full-text search and query limits.

## Installed versions

What was installed on 2026-10-27, read on both machines with the read-only commands in the last column. Installed is not the same as qualified: a finding holds for the version it was observed on, which the [findings table](#version-sensitive-findings) names.

| Component | Bus host | Other machine | How to check |
| --- | --- | --- | --- |
| macOS | 27.0.1 | 27.0 | `sw_vers` |
| Bun | 1.3.14 | 1.3.14 | `bun --version` (pinned in `package.json`) |
| Fluree | 4.2.4 | Not installed: reaches the bus host's server through the tunnel | `fluree --version` |
| Codex CLI on `PATH` | 0.164.0-alpha.11.1 | 0.164.0 | `codex --version` |
| Codex CLI bundled in the desktop app (what `serve` runs) | 0.164.0-alpha.11.1 | 0.164.0-alpha.11.1 | `<bundled path> --version` ([Codex](codex.md#the-bundled-cli-and-private-app-servers)) |
| Codex app-server daemon | 0.164.0-alpha.11.1; since 2026-10-28 the desktop's bundled CLI, started under a desktop SSH project's connection, as of 2026-10-28 ([Codex](codex.md#the-daemon)) | 0.165.0, the managed package | `codex app-server daemon version`, and `ps` for which binary runs |
| ChatGPT desktop app (Codex) | 26.1021.31345 (build 21828) | 26.1021.31345 | `CFBundleShortVersionString` in `/Applications/ChatGPT.app/Contents/Info.plist` |
| Claude Code, terminal | 2.1.311 | 2.1.310 | `claude --version` |
| Claude desktop app | 3.6556.2 | 3.6556.2 | `CFBundleShortVersionString` in `/Applications/Claude.app/Contents/Info.plist` |
| Claude Code bundled in the desktop app | 2.1.308 | 2.1.308 | The version directory under `~/Library/Application Support/Claude/claude-code/` that running sessions use (`ps`) |

The two machines don't match exactly: the other machine's daemon is a release ahead of its CLIs. A managed daemon runs its own update loop, on by default, and restarts on a new version (read in code, 0.164), so a daemon can be ahead of the CLI that started it.

## Configuration the owner chose

| Setting | Value | Where | Since | Why |
| --- | --- | --- | --- | --- |
| `thread_unload_delay_secs` | 300 (Codex's default is 1800) | `~/.codex/config.toml`, both machines | 2026-10-27, on Codex 0.164 (bus host) and the 0.165 daemon (other machine) | So threads left on the daemon are freed in 5 minutes rather than 30. How the setting works is in [Codex](codex.md#how-long-a-thread-stays-loaded); setting it is in [operate](../runbooks/operate.md) |

## Version-sensitive findings

Each finding below was observed on the versions named. The last column says what could make it stale, so a reader after an upgrade or a setting change knows which rows to recheck ([upgrade](../runbooks/upgrade.md) has the procedure). Frames cited in the pages named in the fourth column are the evidence, not current rules.

| Finding | Observed on | Basis | Described in | Recheck when |
| --- | --- | --- | --- | --- |
| One writer per Codex thread (`thread-writer-locks/`); a second app-server's resume is refused | Codex 0.164.0-alpha.11.1; the lock code is also in 0.165.0 | Verified live, read in code | [Codex](codex.md#one-writer-per-thread) | Codex is upgraded on any machine: rerun the two-app-server resume |
| A private app-server's queue list, add, delete and read load no thread and meet no lock; the bundled CLI is the desktop's build | Codex 0.164.0-alpha.11.1 (bundled CLI on both machines; daemon 0.165.0 on the other) | Verified live, read in code | [Codex](codex.md#the-bundled-cli-and-private-app-servers) | The desktop app or the daemon is upgraded, or the bundled CLI's version stops matching the daemon's |
| How long a thread stays loaded: `thread_unload_delay_secs`, its per-request override, the daemon ignoring `-c` for it, and the desktop's 3 h and 10-thread hold | Codex 0.164.0-alpha.11.1 (same rule in 0.165.0); desktop 26.1021.31345 | Verified live (overrides, edge cases); read in code (the daemon, the desktop's hold, applying without a restart) | [Codex](codex.md#how-long-a-thread-stays-loaded) | Codex or the desktop app is upgraded; `~/.codex/config.toml` is edited |
| What a resume meets in the gap after a release: who becomes the writer, the answers, the per-resume 5 s release, why not 0 | Codex 0.164.0-alpha.11.1; 0.165.0 read in source | Verified live (answers, release time); read in code (why not 0); observed in operation (the lock-out) | [Codex](codex.md#the-gap-after-a-thread-is-released) | Codex changes unloading, queue dispatch or resume; before delivery's 5 s release is changed |
| The queue methods (`thread/queue/*`) are experimental; any app-server can add, and the one that has the thread loaded runs the item | Codex 0.164.0-alpha.11.1 | Verified live | [Codex](codex.md#the-shared-queue) | Every Codex upgrade: pin and retest the queue |
| How fast a queued item runs, per kind of thread | Codex 0.164.0-alpha.11.1, desktop 26.1021.31345 | Verified live | [Codex](codex.md#the-shared-queue) | Codex or the desktop app is upgraded (the poll interval may change) |
| A spawned subagent's queue refuses direct input | Codex 0.164.0-alpha.11.1 (daemon) | Verified live; desktop subagents inferred | [Codex](codex.md#the-shared-queue) | Codex is upgraded |
| Desktop features need the desktop's own app-server; SSH projects get part of them | Desktop 26.1021.31345, Codex 0.164 | Read in code; partly verified live, partly inferred | [Codex](codex.md#what-desktop-capable-means) | The desktop app is updated, or one of the override variables changes |
| The desktop's IPC router: its socket, the lack of a peer check, the broadcasts, the request versions | Desktop 26.1021.31345 | Read in code; never connected to | [Codex](codex.md#the-desktops-ipc-router) | The desktop app is updated (names are minified, so read by string literal) |
| The desktop's `codex://threads/wake/<id>` link: what it does, pickup, visible effects, the retry set | Desktop 26.1021.31345, Codex 0.164.0-alpha.11.1 | Read in code and verified live; a woken thread was held past 34 min, and holding until the app restarts is inferred | [Codex](codex.md#the-threadswake-link) | The desktop app is updated; if the link is ever used |
| What a resume restores: approval from the latest record, permissions and mode from the thread's own snapshot, a built-in profile compiled again by name, dynamic tools from the first record, the paginated lineage | Codex 0.164.0-alpha.11.1 | Read in code; verified live: `thread/read` has no settings, and the `workspace-write` widening | [Codex](codex.md#what-a-resume-restores) | Codex is upgraded: the borrow's eligibility test follows this code |
| A resume with no client: the queued item runs, the lock goes about 5 s after idle, a held thread is refused, an attached client is unaffected | Daemon 0.164.0-alpha.11.1 (bus host); daemon 0.165.0 with CLI 0.164.0 (other machine) | Verified live, 2026-10-28 | [Codex](codex.md#a-resume-with-no-client) | The daemon or the bundled CLI is upgraded on either machine |
| The daemon: `daemon start`, its update loop, an SSH connection starting an unmanaged one, `daemon stop`, and keeping the login it started with | Codex 0.164.0-alpha.11.1 | Read in code (start, updates, the proxy); verified live (the SSH start, stop, login); inferred (what starts it) | [Codex](codex.md#the-daemon) | Codex is upgraded; the Codex login changes; a desktop SSH project is added or removed |
| The daemon's open-file limit: 4096 for a managed daemon, the shell's for another; the descriptor exhaustion seen at the shell's default | Codex 0.164 (code); observed in operation 2026-10-26 | Read in code (4096); observed in operation, not rerun (exhaustion); not observed live (the limit) | [Codex](codex.md#the-daemon) | Codex or macOS is upgraded; the daemon is started another way |
| `codex exec` holds the lock while it runs, takes one queued item after its turn and may exit mid-way; a thread whose last turn was interrupted runs no queued input, even after a resume | Codex 0.164.0-alpha.11.1 | Verified live, read in code (the queue rule) | [Codex](codex.md#an-interrupted-thread-runs-no-queued-input) | Codex is upgraded |
| The persisted status events (`task_started`, `task_complete`, `turn_aborted`) and what each restores | Codex 0.164.0-alpha.11.1 | Read in code | [Codex](codex.md#persisted-status-events) | Codex is upgraded: `src/rollout.ts` reads the same list |
| Hooks are built once at thread load and never reloaded; a failing `Stop` hook never blocks a turn | Codex 0.164 | Read in code; consistent with a live check | [Codex](codex.md#hooks) | Codex is upgraded, or a hook is added or removed |
| `CODEX_THREAD_ID`: set in a thread's shells, distinct for a subagent, inherited beside a Claude id by a child | Codex 0.164, Claude Code 2.1.310 | Verified live, 2026-10-26 | [Codex](codex.md#thread-ids-and-codex_thread_id) | Either runtime changes how it sets its shell environment |
| Codex asks approval for MCP tools that are destructive or open-world, except under full access | Codex 0.164.0-alpha.11.1 | Verified live, read in code | [Codex](codex.md#approvals-for-mcp-tools) | Codex is upgraded, or a tool's annotations change |
| A Codex plugin can carry `skills/<name>/SKILL.md` and `.mcp.json` `mcpServers`; a long skill body appears truncated | Codex 0.164 | Read in code (what it carries); inferred, unverified (truncation, how skills load) | [Codex](codex.md#what-a-codex-plugin-can-carry) | Codex is upgraded; before a skill is relied on in Codex |
| Plugin monitors don't start in stream-json mode; `asyncRewake` hooks wake an idle stream-json session | Claude Code 2.1.310, terminal and stream-json; extrapolated to the desktop's installed 2.1.308 | Verified live on throwaway sessions | [Claude Code](claude-code.md#plugin-monitors) | Claude Code is upgraded, or the desktop app bundles a new Claude Code |
| A hook's `timeout` kills it; an `asyncRewake` `SessionStart` hook starts a turn with no input | Claude Code 2.1.310, stream-json | Verified live | [Claude Code](claude-code.md#hooks) | Claude Code is upgraded |
| `claude -p` ends async hooks when the run ends | Claude Code 2.1.310 | Documented | [Claude Code](claude-code.md#hooks) | Claude Code is upgraded |
| `CLAUDE_CODE_SESSION_ID`: set in the desktop app, the terminal and `-p`; inherited by children; kept by `--resume`, changed by `/clear` and forks; shared by subagents | Claude Code 2.1.310 | Verified live, 2026-10-26 | [Claude Code](claude-code.md#session-ids) | Claude Code is upgraded |
| The session inbox socket wakes an idle session; mail from outside is held by rule, and the desktop drops it after 5 minutes | Claude Code 2.1.310 | Verified live (wakes); read in code, documented (the rules) | [Claude Code](claude-code.md#the-session-inbox-socket) | Claude Code is upgraded (the frame format is undocumented) |
| Channels reach the model, in the terminal only | Claude Code 2.1.310 | Read in code, documented; absent from the desktop verified live | [Claude Code](claude-code.md#channels) | Claude Code is upgraded; the channel requests are answered; MCP moves to 2026-07-28 |
| A marketplace plugin is copied into Claude Code's cache; a change needs `claude plugin update` and a restart | Claude Code 2.1.310 | Verified live at deploy | [Claude Code](claude-code.md#plugins) | Claude Code is upgraded; the plugin's manifest changes |
| A plugin's MCP server renames its tools to `mcp__plugin_…` | Claude Code docs, read 2026-10-28 | Documented; not tried | [Claude Code](claude-code.md#plugins) | Claude Code is upgraded; before the MCP server is bundled in a plugin |
| A subject-less token is refused on the event stream when its authentication is required; a token with a subject is denied writes | Fluree 4.2.4 | Verified live, 2026-10-28; not in the docs | [Fluree](fluree.md#the-event-stream) | Fluree is upgraded; events authentication is turned on |
| With CORS off, a cross-origin `text/plain` POST still writes unless the data API requires the token | Fluree 4.2.4 | Verified live, 2026-10-28 | [Fluree](fluree.md#the-transaction-server) | Fluree is upgraded, or its CORS or authentication defaults change |
| Fluree applies the full-text config at a ledger's first index, so text search finds nothing until then (about 0.25 s on a default server); a fuel limit replaces the budgeted result | Fluree 4.2.4 | Verified live, 2026-10-28 (the search delay); recorded in `src/Fluree.ts` (the fuel limit); `bun run qualify:fluree` rechecks search across the index boundary only | [Fluree](fluree.md#full-text-search) | Fluree is upgraded, or its indexing settings change |

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
