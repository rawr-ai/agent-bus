# agent-bus: how it works, its policies, and its gaps

A map of the whole system, written for a simplification review. It describes the system as deployed on 2026-10-26 and links to the documents that own the details: the [README](../README.md) (commands, delivery, ledger format), [connections](connections.md) (trust boundaries) and the frames in [frames/](frames/) (decisions, with their reasoning and the alternatives rejected).

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
| **Ledger** (`src/Ledger.ts`, `src/Fluree.ts`) | Stores every entry. Fluree in the installed setup (one transaction server on the bus host, reached from other machines through an SSH tunnel); a JSONL file otherwise and in the unit tests | Fluree gives one shared, ordered log across machines, history, full-text search and SPARQL. JSONL needs no server |
| **`serve`**, one per machine (`src/serve.ts`, `src/Bus.ts`, `src/mcp.ts`) | The only process that reads or writes the store for its machine's sessions. Serves the bus tools over MCP on loopback, keeps cursors, enforces ownership, and runs the Codex deliverer | One owner of cursors and locks per machine, so a message is taken once |
| **CLI** (`src/bin.ts`, `src/client.ts`) | `wait`, `join`, `publish`, `peers`: MCP clients of the local `serve` | `wait` is how Claude sessions are woken; the rest is shell access |
| **Codex deliverer** (`src/codex.ts`) | Starts or steers a turn in Codex threads that the machine's Codex daemon hosts (`turn/start` over the daemon's control socket) | Live push for daemon-hosted Codex threads |
| **Codex `Stop` hook** (`src/hook.ts`) | When a Codex turn ends, continues it with the thread's unread messages | Reaches desktop Local threads, which the deliverer must not touch |
| **Ownership** (in `src/Bus.ts`) | One session per address, identified by the runtime's own id | Two sessions sharing an address were stealing each other's replies |
| **LaunchAgents** (`scripts/install-launch-agents.sh`) | Bus host: the Fluree server and `serve`. Other machines: `serve` and the SSH tunnel | Keep the bus running across logins |

Size: about 2,400 lines of source, 1,800 lines of tests, and a 190-line installer. Dependencies: Effect 4, `@effect/platform-bun` and `sparqljs`.

## How a message moves

1. A session calls `bus_publish` (directly over MCP, or through `agent-bus publish`). `serve` checks that the caller owns the sending address, records where it was sent from (machine, directory, Git repo and branch), and appends one entry to the ledger.
2. The ledger's change stream wakes every reader on every machine. Fluree uses its event stream with a 15-second poll behind it; JSONL uses file watching with a 2-second poll.
3. For each recipient, the machine it joined from acts:
   - **A Claude session:** its background `agent-bus wait` reads the message and exits, which wakes the session. The session handles the message and starts the wait again.
   - **A Codex thread on the daemon:** `serve` sends `turn/start` with the message, marks it read once the daemon accepts, and unsubscribes.
   - **Any other Codex thread:** the message is held unread. The thread gets it from its `Stop` hook when a turn ends, or by calling `bus_read`.
4. Reading moves the cursor. A refused or failed read moves nothing.

## How each kind of session receives messages today

| Session | How it receives | Live push? |
| --- | --- | --- |
| Claude Code (desktop, terminal or `claude -p`) | A background `agent-bus wait`, which exits on arrival and wakes the session | Yes, within seconds, provided the wait is running. The session must restart it after every wake |
| Codex `codex` TUI, or a desktop SSH project | The deliverer's `turn/start` through the daemon | Yes: an idle thread starts a turn, a busy one is steered |
| **Codex desktop Local thread** | The `Stop` hook at the end of each of its turns, once the hook is installed. Otherwise only when the thread itself calls `bus_read` or `bus_wait` | **No.** An idle Local thread is never woken. The desktop-wake spike is about changing that |
| `codex exec` | Only by calling `bus_read`. It is never woken, including after it exits | No |
| A Codex or Claude subagent | Through its parent | Never woken directly |

**The `Stop` hook is not installed on the bus host yet.** There is no `~/.codex/hooks.json` there. Until it is installed and trusted with `/hooks`, Local threads, including the Director, get messages only when they read the bus themselves. `serve` logs "Holding messages for …" for them.

## Policies

### Identity and ownership ([frame](frames/address-ownership.md))

1. An address belongs to the session that joined it, identified by runtime and id: `$CODEX_THREAD_ID` for Codex, `$CLAUDE_CODE_SESSION_ID` for Claude Code, or a stable id of its own for other clients. Every call passes it as `session`.
2. Only the owner may read, wait on, leave or send from the address. Every refusal changes nothing: not the cursor, the presence or the ledger.
3. A different session's join is refused with the holder's note, last call and whether it has a wait open. The policy is to pick another address, not to take the held one.
4. A takeover must name the holder's current join id, and is only for replacing a session that has ended, when the human says so. Unread mail carries over to the new owner, and the previous owner is refused from then on.
5. Rejoining with the same id keeps unread mail. A new owner of an address that was left starts at the present.
6. The CLI never takes another runtime's id variable. Outside `join`, it uses the runtime the address joined with.
7. **Migration rules:**
   - An address joined before ownership (legacy) belongs to the Codex thread it names.
   - Any other legacy holder reclaims it with a takeover.
   - Presences written without an owner are ignored once an address has one, which lets machines upgrade one at a time.
8. Ownership is checked under the address's lock at the moment of effect, so a wait or send that started before a takeover can't act after it.

### Delivery

9. A change notification only wakes readers; reading from the cursor decides delivery. A cursor advances only after a complete read.
10. `serve` delivers only to Codex peers that joined from its own machine.
11. A message the bus can't deliver is held, never dropped. Transport failures are retried with back-off up to five minutes. An ownership refusal ends a CLI command; an unreachable bus is retried.

### Codex thread safety ([codex-wake frame](frames/codex-wake.md), [connections](connections.md))

12. The bus never takes a thread from another app-server. A thread not loaded in the daemon when it joined (`codexHost: other`) is never resumed there.
13. `serve` unsubscribes after each delivery and never answers approvals.
14. Subagents are never woken.
15. The `Stop` hook reads only as its own thread, and only when the transcript it is given is that thread's own.

### Security ([connections](connections.md))

16. The bus trusts every process of the user on the machine. Ownership keeps cooperating sessions apart; it is not authentication.
17. Every server listens on loopback only. `serve` checks the `Host` header and rejects any browser `Origin`. Fluree's data and admin APIs require the token.
18. `bus_query` runs one SELECT, regenerated from its syntax tree, with no FROM or SERVICE, a 32 KB cap and a 10-second limit.
19. Credentials and raw tool responses never go into messages, logs or the ledger.

### Engineering

20. All storage goes through the `Ledger` service.
21. `bun run check` must pass before a commit.
22. Decisions, constraints and traps go in repo Fluree memory, with no machine names or personal details, since the repository is public.

## Verified, unverified and known gaps

| Item | Status |
| --- | --- |
| Ownership: the incident, takeover, concurrency, cross-machine claims, identity refusals, leave and rejoin, legacy migration, the `Stop` hook with real thread ids | **Verified live**, 2026-10-26 ([results](frames/address-ownership.md#qualification-2026-10-26)) |
| Claude ids: set in the desktop app, the terminal and `claude -p`; `/clear` and forks change them; `--resume` keeps them | **Verified live** |
| A desktop Local Codex thread's shell has `CODEX_THREAD_ID`, equal to its thread id, and its legacy address was adopted on rejoin | **Verified live** |
| A session whose cached tool list predates `session` can pass it as an extra argument, in both Claude Code and Codex | **Verified live** |
| Idle desktop Local threads can't be woken | **Known gap.** The desktop-wake spike may close it for threads that have a window open |
| The `Stop` hook is built but not installed or trusted on the bus host | **Owner's step** |
| `codex exec` threads are never woken, even after they exit | **Open decision** (codex-wake item 7) |
| `bus_read` and `bus_wait` mark messages read before the response is sent, so a lost response loses those messages for that address (they stay in history) | **Known gap** |
| Locks are per machine. Joins from two machines are ordered by the ledger, so the losing claim is refused only from its next call. Cursors are per machine, so a takeover from another machine may redeliver | **Documented limit** |
| A process started from a session's shell inherits that session's id and acts for it; a `codex exec` delegate can consume its Claude parent's mail | **Documented**: give delegates their own address |
| Claude Code reports an error for `bus_leave` ("did not return structured content"), though the leave takes effect | **Bug, small fix** |
| After a peer leaves, the deliverer can log one "has not joined" warning | **Log noise** |
| CLI refusals print a stack trace under the message | **Cosmetic** |
| Unit tests run on JSONL only. Fluree is covered by `bun run qualify:fluree` and live use | **Accepted** |
| Nothing starts the Codex daemon at boot | **Operations**: `daemon bootstrap` isn't qualified yet |
| The other machine's non-interactive SSH `PATH` lacks `bun` | **Operations**: remote commands need `~/.bun/bin` |

## Questions for a simplification pass

These were found while writing this map and are not recommendations. Each names what the piece costs and what would have to be true to remove it.

1. **Is the daemon deliverer earning its place?** It is the largest single piece (`src/codex.ts`, with the `codexHost` classification, the guard, back-off and the unsubscribe). It serves only daemon-hosted threads: the `codex` TUI and SSH projects. The owner works in desktop Local threads by decision, and today the only Codex peer is Local, so every Codex delivery is held. If nobody uses daemon threads, the hook (plus the spike's route, if it goes) may be the whole Codex story. If the spike goes, `serve` gains a second Codex route rather than replacing this one, so decide this before building it.
2. **Two stores.** Fluree is what makes the bus span machines and gives history and search; JSONL keeps the unit tests fast and the bus usable without a server, and adds `import-jsonl`. Keeping JSONL for tests is cheap. Whether it is still a supported production store is a choice.
3. **`bus_query` (SPARQL), with its parser dependency and sandbox rules.** Worth keeping only if agents actually query the ledger. `bus_history` covers text search.
4. **Origin repo and branch on every message.** Each publish runs `git` twice to record them for commit-window views that were never built. Either build the view or stop recording them.
5. **Legacy ownership paths.** These are adopting owner-less presences and ignoring owner-less presences. Once every live address has an owner and no pre-ownership `serve` remains, both can go.
6. **Two locks per address** (`claiming` for ownership changes and sends, `exclusive` for cursor moves). They were split so sends don't wait behind slow deliveries. Keep them unless deliveries become fast enough not to matter.
7. **Claude waking by background `wait`.** It works, but every session must restart its wait after each wake, and a forgotten restart silently stops delivery. A Claude Code `Stop` hook (listed as next in the README) would mirror the Codex one and could be simpler for sessions to keep right.
