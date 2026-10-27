# agent-bus: how it works, its policies, and its gaps

A map of the whole system, written for a simplification review. It describes the system as deployed on 2026-10-27 and links to the documents that own the details: the [README](../README.md) (commands, delivery, ledger format), [connections](connections.md) (trust boundaries) and the frames in [frames/](frames/) (decisions, with their reasoning and the alternatives rejected).

## What kind of system it is

agent-bus is an **append-only message log with one read cursor per address, plus wake signals**. It is not a broker that pushes messages over open connections.

- **Everything is an entry in one ledger:** messages, and joins and leaves (presence). Nothing is deleted; the latest presence entry per address is that peer's state.
- **An address is a private inbox.** Every subscriber has a cursor, and reading returns the entries addressed to it after the cursor, then advances it, so reading consumes. Each address has one owning session.
- **Three ways to address a message:**
  - an address (point to point);
  - `#topic` (every subscriber to the topic gets it, each on its own cursor);
  - `*` (everyone).

  So it is pub/sub in the sense that topics fan out. Underneath, each subscriber reads its own mailbox.
- **Waking is separate from delivery.** A change in the ledger only signals that something may be waiting. What is delivered is decided by reading from the cursor, under that address's lock. A message is delivered once, to whoever owns the address at that moment.

## The pieces

| Piece | What it does | Why it exists |
| --- | --- | --- |
| **Ledger** (`src/Ledger.ts`, `src/Fluree.ts`) | Stores every entry in Fluree: one transaction server on the bus host, reached from other machines through an SSH tunnel. The unit tests use a JSONL file | One shared, ordered log across machines, with history, full-text search and SPARQL |
| **`serve`**, one per machine (`src/serve.ts`, `src/Bus.ts`, `src/mcp.ts`) | The only process that reads or writes the store for its machine's sessions. Serves the bus tools over MCP on loopback, keeps cursors, enforces ownership, and runs the Codex deliverer | One owner of cursors and locks per machine, so a message is taken once |
| **CLI** (`src/bin.ts`, `src/client.ts`) | `wait`, `join`, `publish`, `peers`: MCP clients of the local `serve` | `wait` is how Claude sessions are woken; the rest is shell access |
| **Codex deliverer** (`src/codex.ts`) | Gives each Codex thread with unread mail one nudge in its own queue (`thread/queue/list` and `add`, through a short-lived app-server of `serve`'s own), which whichever app-server has the thread loaded runs as a turn | Idle wake for every Codex thread, desktop or daemon, without a second writer |
| **Ownership** (in `src/Bus.ts`) | One session per address, identified by the runtime's own id | Two sessions sharing an address were stealing each other's replies |
| **LaunchAgents** (`scripts/install-launch-agents.sh`) | Bus host: the Fluree server and `serve`. Other machines: `serve` and the SSH tunnel | Keep the bus running across logins |

Size: about 2,250 lines of source, 2,350 lines of tests, and a 190-line installer. Dependencies: Effect 4, `@effect/platform-bun` and `sparqljs`.

## How a message moves

1. A session calls `bus_publish` (directly over MCP, or through `agent-bus publish`). `serve` checks that the caller owns the sending address, records where it was sent from (machine, directory, Git repo and branch), and appends one entry to the ledger.
2. The ledger's change stream wakes every reader on every machine. Fluree's event stream does this, with a 15-second poll behind it.
3. For each recipient, the machine it joined from acts:
   - **A Claude session:** its background `agent-bus wait` reads the message and exits, which wakes the session. The session handles the message and starts the wait again.
   - **A Codex thread:** `serve` adds one nudge to the thread's queue, unless one of ours is already waiting. Whichever app-server has the thread loaded (the desktop app's, or the daemon's for the TUI) runs it as a turn, and the thread reads its mail with `bus_read`. The message stays unread until then.
4. Reading moves the cursor. A refused or failed read moves nothing.

## How each kind of session receives messages today

| Session | How it receives | Live push? |
| --- | --- | --- |
| Claude Code (desktop, terminal or `claude -p`) | A background `agent-bus wait`, which exits on arrival and wakes the session | Yes, within seconds, provided the wait is running. The session must restart it after every wake |
| Codex `codex` TUI, or a desktop SSH project | A nudge in its queue, which the daemon runs as a turn, with or without the TUI attached | Yes, seen within 3–15 s when idle, and after the current turn when busy (verified 2026-10-27, [one-codex-route](frames/one-codex-route.md)). A thread the daemon no longer has loaded, as after a daemon restart, runs it when next opened |
| **Codex desktop Local thread** | A nudge in its queue, which the desktop runs as a turn: at once when idle, after the current turn when busy | **Yes**, within seconds while the thread is open (verified 2026-10-27, [queue-wake](frames/queue-wake.md)). A thread nobody has open runs it when next opened |
| `codex exec` | Only by calling `bus_read`. A nudge waits in its queue, and runs only if the thread is opened in an app | No |
| A Codex or Claude subagent | Through its parent | Never woken directly: a Codex subagent's queue refuses direct input |

## Policies

### Identity and ownership ([frame](frames/address-ownership.md))

1. An address belongs to the session that joined it, identified by runtime and id: `$CODEX_THREAD_ID` for Codex, `$CLAUDE_CODE_SESSION_ID` for Claude Code, or a stable id of its own for other clients. Every call passes it as `session`.
2. Only the owner may read, wait on, leave or send from the address. Every refusal changes nothing: not the cursor, the presence or the ledger.
3. A different session's join is refused with the holder's note, last call and whether it has a wait open. The policy is to pick another address, not to take the held one.
4. A takeover must name the holder's current join id, and is only for replacing a session that has ended, when the human says so. Unread mail carries over to the new owner, and the previous owner is refused from then on.
5. Rejoining with the same id keeps unread mail. A new owner of an address that was left starts at the present.
6. The CLI never takes another runtime's id variable. Outside `join`, it uses the runtime the address joined with.
7. Joins and leaves written without an owner, by a `serve` from before owners, are ignored.
8. Ownership is checked under the address's lock at the moment of effect, so a wait or send that started before a takeover can't act after it.

### Delivery

9. A change notification only wakes readers; reading from the cursor decides delivery. A cursor advances only after a complete read.
10. `serve` nudges only Codex peers that joined from its own machine.
11. A message the bus can't deliver is held, never dropped. Transport failures are retried with back-off up to five minutes. An ownership refusal ends a CLI command; an unreachable bus is retried.

### Codex thread safety ([one-codex-route](frames/one-codex-route.md), [connections](connections.md))

12. `serve` never loads, resumes or starts a turn in a Codex thread, and never connects to the daemon. Its only reach into Codex is listing and adding to a thread's queue through an app-server of its own, which loads no thread, so no thread ever has a second writer.
13. A subagent's queue refuses direct input. The deliverer holds that join as refused, and retries only after a rejoin or a `serve` restart.
14. A queue nudge carries no text from other sessions and marks nothing read. At most one waits in a thread's queue per address, so at most one empty turn per address follows any read. With nothing for a subscriber, the deliverer moves its cursor past the entries its own read would pass over.

### Security ([connections](connections.md))

15. The bus trusts every process of the user on the machine. Ownership keeps cooperating sessions apart; it is not authentication.
16. Every server listens on loopback only. `serve` checks the `Host` header and rejects any browser `Origin`. Fluree's data and admin APIs require the token.
17. `bus_query` runs one SELECT, regenerated from its syntax tree, with no FROM or SERVICE, a 32 KB cap and a 10-second limit.
18. Credentials and raw tool responses never go into messages, logs or the ledger.

### Engineering

19. All storage goes through the `Ledger` service.
20. `bun run check` must pass before a commit.
21. Decisions, constraints and traps go in repo Fluree memory, with no machine names or personal details, since the repository is public.

## Verified, unverified and known gaps

| Item | Status |
| --- | --- |
| Ownership: the incident, takeover, concurrency, cross-machine claims, identity refusals, leave and rejoin | **Verified live**, 2026-10-26 ([results](frames/address-ownership.md#qualification-2026-10-26)) |
| Claude ids: set in the desktop app, the terminal and `claude -p`; `/clear` and forks change them; `--resume` keeps them | **Verified live** |
| A desktop Local Codex thread's shell has `CODEX_THREAD_ID`, equal to its thread id | **Verified live** |
| A session whose cached tool list predates `session` can pass it as an extra argument, in both Claude Code and Codex | **Verified live** |
| Idle desktop Local threads are woken by a queue nudge, coalesced, restart-safe and ownership-safe | **Verified live**, 2026-10-27 ([results](frames/queue-wake.md#qualification-2026-10-27)) |
| Daemon threads run a queued nudge with or without a client attached; one loaded nowhere runs it when reopened; a mid-turn add runs after the turn; a subagent's queue refuses the add | **Verified live**, 2026-10-27 ([evidence](frames/one-codex-route.md#what-it-rests-on)) |
| Codex calls the bus's tools without approval in any sandbox, except `bus_join` outside full access | **Verified live** ([results](frames/one-codex-route.md#found-in-qualification-codex-refused-the-read-outside-full-access)) |
| The queue methods (`thread/queue/*`) are experimental in the Codex app-server protocol | **Accepted risk:** `serve` uses the desktop's bundled CLI, so protocol and app move together; a change shows as logged errors, and the mail waits unread for the thread's next read |
| Another machine's desktop running a nudge; a desktop subagent's add being refused like the daemon's | **Unverified** |
| The retired `codex-stop-hook` command does nothing, for threads that loaded the hook before it was removed | **Transition:** remove the command once every Codex app-server has started since ([simplification-pass](frames/simplification-pass.md)) |
| `codex exec` threads get a nudge only if opened in an app | **Open decision** (codex-wake item 7) |
| `bus_read` and `bus_wait` mark messages read before the response is sent, so a lost response loses those messages for that address (they stay in history) | **Known gap** |
| Locks are per process, and each machine runs one `serve`. Joins from two machines are ordered by the ledger, so the losing claim is refused only from its next call. Cursors are per machine, so a takeover from another machine may redeliver | **Documented limit** |
| A process started from a session's shell inherits that session's id and acts for it; a `codex exec` delegate can consume its Claude parent's mail | **Documented**: give delegates their own address |
| Unit tests run on JSONL, plus the Fluree suites when the `fluree` CLI is installed. Fluree is also covered by `bun run qualify:fluree` and live use | **Accepted** |
| The other machine's non-interactive SSH `PATH` lacks `bun` | **Operations**: remote commands need `~/.bun/bin` |

## Questions for a simplification pass

These were found while writing this map and are not recommendations. Each names what the piece costs and what would have to be true to remove it.

1. **Is the daemon deliverer earning its place?** Answered (2026-10-27): no. It is removed, and every Codex thread takes the queue route ([one-codex-route](frames/one-codex-route.md)). The cost accepted is that a thread the daemon no longer has loaded gets its mail when next opened, not by a headless resume.
2. **Two stores.** Answered (2026-10-27): Fluree is the only production store; JSONL is the unit tests' ([simplification-pass](frames/simplification-pass.md)).
3. **`bus_query` (SPARQL).** Answered: kept. The owner plans richer ledger properties (topic, task, workstream, decisions, tags, reference docs), so history can be queried by meaning.
4. **Origin repo and branch.** Answered: kept as optional metadata for those queries, since a branch can't be recovered later. The commit-window view is dropped.
5. **Legacy ownership paths.** Answered: removed. Joins and leaves without an owner are ignored.
6. **Two locks per address.** Answered: kept.
7. **Retire the `Stop` hook?** Answered: retired. A nudged turn reads the mail itself.
8. **Claude waking by background `wait`.** It works, but every session must restart its wait after each wake, and a forgotten restart silently stops delivery. The MCP research found no MCP mechanism that reaches the model or starts a turn in an idle session (other than Claude Code's terminal-only channels). A host-armed plugin `monitors` entry could replace the model re-arming `wait` after every wake.
9. **`codexThreadId` at join.** It must equal `session`, so it is only a "wake me" flag. Deriving it from the runtime would drop a join field, a CLI flag and a check.
