# agent-bus: overview

The entry map to agent-bus: what kind of system it is, where each part is documented, the ownership rules, and what is still open. It describes the system as deployed on 2026-10-27.

## What kind of system it is

agent-bus is an **append-only message log with one read cursor per address, plus wake signals**. It is not a broker that pushes messages over open connections.

- **Everything is an entry in one ledger:** messages, and joins and leaves (presence). Nothing is deleted; the latest presence entry per address is that peer's state.
- **An address is a private inbox.** Every subscriber has a cursor, and reading returns the entries addressed to it after the cursor, then advances it, so reading consumes. Each address has one owning session.
- **Three ways to address a message:**
  - an address (point to point);
  - `#topic` (every subscriber to the topic gets it, each on its own cursor);
  - `*` (everyone).

  So it is pub/sub in the sense that topics fan out. Underneath, each subscriber reads its own mailbox.
- **Waking is separate from delivery:** a wake only signals that mail may be waiting, and the owner's read decides what is delivered ([delivery](architecture/delivery.md#waking-is-separate-from-delivery)).

## Where to read what

| Document | Read it for |
| --- | --- |
| [Topology](architecture/topology.md) | The two machine roles, every process and port, the transports between them (loopback HTTP, stdio, unix socket, SSH tunnel, SSH proxy), and where the ledger, cursors, token and Codex state live |
| [Codex hosting](architecture/codex-hosting.md) | What agent-bus runs on Codex: why `serve` posts through a short-lived app-server of its own and borrows through the daemon, which threads it wakes, the owner's unload delay, and what each machine needs. Codex's own behaviour (app-servers, the writer lock, the queue, desktop features, the wake link, resuming, the daemon) is in [platforms: Codex](platforms/codex.md) |
| [Delivery](architecture/delivery.md) | Whether and how each kind of session is woken (the one table of it), the Claude wake hook and the Codex nudge step by step, why Claude uses a hook rather than a monitor, and the delivery policies |
| [Platforms and versions](platforms/README.md), with [Codex](platforms/codex.md), [Claude Code](platforms/claude-code.md) and [Fluree](platforms/fluree.md) | The installed Codex, Claude Code, Fluree, Bun and macOS versions, the owner's Codex setting, the versions each finding was observed on, and how claims are marked |
| [Connections and trust boundaries](connections.md) | What protects each connection, what `serve` may do to Codex threads, and approval in Codex |
| [README](../README.md) | Commands, setup, the MCP tools, address ownership, security settings and the ledger format |
| [Frames](frames/) | Each decision, with its evidence, the alternatives rejected and its qualification results. Frames are history: a later frame may supersede an earlier one |
| [Research](research/mcp-native-messaging.md) | Whether MCP or an existing server could wake sessions more simply (no) |

## The pieces in the code

| Piece | What it does | Why it exists |
| --- | --- | --- |
| **Ledger** (`src/Ledger.ts`, `src/Fluree.ts`) | Stores every entry in Fluree, on one transaction server on the bus host. The unit tests use a JSONL file | One shared, ordered log across machines, with history, full-text search and SPARQL |
| **`serve`**, one per machine (`src/serve.ts`, `src/Bus.ts`, `src/mcp.ts`) | The only process that reads or writes the store for its machine's sessions. Serves the bus tools over MCP on loopback, keeps cursors, enforces ownership, and runs the Codex deliverer | One owner of cursors and locks per machine, so a message is taken once |
| **CLI** (`src/bin.ts`, `src/client.ts`) | `serve`, `join`, `publish`, `peers` and `claude-wake`. All but `serve` are MCP clients of the local `serve` | Shell access, and the hook's command |
| **Claude wake** (`src/claude.ts`, `plugin/`) | A Claude Code plugin whose `asyncRewake` hook waits in `bus_wake` and wakes the session when its addresses have new mail ([delivery](architecture/delivery.md#claude-code-sessions)) | Wakes idle Claude sessions, desktop or terminal, without the model starting or restarting anything |
| **Codex deliverer** (`src/codex.ts`) | Gives each Codex thread with unread mail one nudge in its own queue, through a short-lived app-server of `serve`'s own ([delivery](architecture/delivery.md#codex-threads)) | Wakes every Codex thread, desktop or daemon, without a second writer |
| **Ownership** (in `src/Bus.ts`) | One session per address, identified by the runtime's own id | Two sessions sharing an address were stealing each other's replies |
| **Installer** (`scripts/install-launch-agents.sh`) | The LaunchAgents and the `~/.local/bin/agent-bus` link ([topology](architecture/topology.md#processes)) | Keeps the bus running across logins |

Size: about 2,450 lines of source, 2,850 lines of tests, and a 200-line installer. Dependencies: Effect 4, `@effect/platform-bun` and `sparqljs`.

## Policies

### Identity and ownership

From [address-ownership](frames/address-ownership.md); the [README](../README.md#addresses-belong-to-sessions) explains them for users.

1. An address belongs to the session that joined it, identified by runtime and id: `$CODEX_THREAD_ID` for Codex, `$CLAUDE_CODE_SESSION_ID` for Claude Code, or a stable id of its own for other clients. Every call passes it as `session`.
2. Only the owner may read, wait on, leave or send from the address. Every refusal changes nothing: not the cursor, the presence or the ledger.
3. A different session's join is refused with the holder's note, last call and whether it has a wait open. The policy is to pick another address, not to take the held one.
4. A takeover (`bus_takeover`, or `agent-bus join --takeover`) must name the holder's current join id, and is only for replacing a session that has ended, when the human says so. Unread mail carries over to the new owner, and the previous owner is refused from then on.
5. Rejoining with the same id keeps unread mail. A new owner of an address that was left starts at the present.
6. The CLI never takes another runtime's id variable. Outside `join`, it uses the runtime the address joined with.
7. Joins and leaves written without an owner, by a `serve` from before owners, are ignored.
8. Ownership is checked under the address's lock at the moment of effect, so a wait or send that started before a takeover can't act after it.

### Other policies, where they live

- **Delivery and Codex thread safety:** [delivery](architecture/delivery.md#policies-that-govern-delivery).
- **Security:** [connections](connections.md) (what each connection trusts and what protects it) and the [README](../README.md#security) (Fluree's token, `serve`'s Host check, `bus_query`'s limits).
- **Engineering:** [AGENTS.md](../AGENTS.md) (the `Ledger` service, `bun run check`, repo memory with no personal details).

## Open gaps and limits

What is still open, unverified or accepted as a limit. What has been verified is recorded with its versions in [platforms](platforms/README.md#version-sensitive-findings), and each frame's qualification results give the evidence: [address-ownership](frames/address-ownership.md#qualification-2026-10-26), [queue-wake](frames/queue-wake.md#qualification-2026-10-27), [one-codex-route](frames/one-codex-route.md#qualification-2026-10-27), [simplification-pass](frames/simplification-pass.md#qualification-2026-10-27) and [claude-wake](frames/claude-wake.md#results-2026-10-27), whose last open item, a `serve` restart while a hook waits, passed on 2026-10-27.

| Item | Status |
| --- | --- |
| How long the desktop holds a thread its wake link woke | **Measured** past 34 min; likely until the app restarts or the thread is opened and left (inferred, [platforms: Codex](platforms/codex.md#the-threadswake-link)) |
| That a change to `thread_unload_delay_secs` takes effect without restarting the daemon | **Read in code, not tested** |
| Which threads the daemon borrows depends on Codex's rollout format, read for each thread's stored permissions, since no Codex call reports them | **Accepted dependency** ([load-on-mail](frames/load-on-mail.md)): a format change makes threads ineligible, with a warning, which leaves them as they were before borrowing |
| A thread borrowed while the desktop had let it go shows "open in another app" in the desktop until 5 s after it goes idle; opened after that, it opens normally with no Retry (seen 2026-10-28) | **Accepted limit** ([load-on-mail](frames/load-on-mail.md#known-limits)) |
| A thread whose last turn was interrupted (by Stop, or by a `codex exec` run exiting mid-turn) runs no queued input, even when borrowed, so its mail waits until it gets new input ([platforms: Codex](platforms/codex.md#an-interrupted-thread-runs-no-queued-input)) | **Known limit**; reading the last turn's outcome and treating the thread as ineligible is a follow-up |
| Borrowed turns run as the login the daemon started with, so after a Codex login change they run as the earlier user until the daemon restarts ([platforms: Codex](platforms/codex.md#the-daemon)) | **Known limit**: restart the daemon after changing the login |
| Another machine's desktop running a nudge; a desktop subagent's add being refused like the daemon's | **Unverified** |
| The desktop's installed Claude Code (2.1.308) behaving as the probed 2.1.310 did in stream-json mode | **Extrapolated** |
| The queue methods (`thread/queue/*`) are experimental in the Codex app-server protocol | **Accepted risk:** `serve` uses the desktop's bundled CLI, so protocol and app move together; a change shows as logged errors, and the mail waits unread for the thread's next read |
| `bus_read` and `bus_wait` mark messages read before the response is sent, so a lost response loses those messages for that address (they stay in history) | **Known gap** |
| Locks are per process, and each machine runs one `serve`. Joins from two machines are ordered by the ledger, so the losing claim is refused only from its next call. Cursors are per machine, so a takeover from another machine may redeliver | **Documented limit** |
| A process started from a session's shell inherits that session's id and acts for it; a `codex exec` delegate can consume its Claude parent's mail | **Documented**: give delegates their own address |
| A Claude session isn't armed after an interrupted turn whose hook already fired, or after a hook dies holding its result ([delivery](architecture/delivery.md#when-a-claude-session-isnt-armed)) | **Documented limit** |
| Unit tests run on JSONL, plus the Fluree suites when the `fluree` CLI is installed. Fluree is also covered by `bun run qualify:fluree` and live use | **Accepted** |
| The other machine's non-interactive SSH `PATH` lacks `bun` | **Operations**: remote commands need `~/.bun/bin` |

## Questions for a simplification pass

Questions raised by the first version of this map. All but the last are answered; the frames hold the reasoning.

| # | Question | Outcome |
| --- | --- | --- |
| 1 | Is the daemon deliverer earning its place? | No: removed; every Codex thread takes the queue route ([one-codex-route](frames/one-codex-route.md)) |
| 2 | Two stores? | Fluree is the only production store; JSONL is the unit tests' ([simplification-pass](frames/simplification-pass.md)) |
| 3 | `bus_query` (SPARQL)? | Kept, for richer ledger properties to come |
| 4 | Origin repo and branch? | Kept as optional metadata; the commit-window view is dropped |
| 5 | Legacy ownership paths? | Removed: joins and leaves without an owner are ignored |
| 6 | Two locks per address? | Kept |
| 7 | Retire the Codex `Stop` hook? | Retired, and its no-op command too ([finish-swap](frames/finish-swap.md)) |
| 8 | Claude waking by background `wait`? | Replaced by the plugin's `asyncRewake` hook, and `wait` retired ([claude-wake](frames/claude-wake.md), [finish-swap](frames/finish-swap.md)) |
| 9 | `codexThreadId` at join? | **Open.** It must equal `session`, so it is only a "wake me" flag. Deriving it from the runtime would drop a join field, a CLI flag and a check |
