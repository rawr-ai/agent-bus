# Frame: one session per address

## Outcome

Two unrelated sessions can't silently read, wait on or send as each other's address. A session can still reconnect to its own address, a replacement session can take an address over on purpose, and `#topic` fan-out works as before.

Requested by the Opa Director for the owner, after a real misrouting.

## The incident

Two independent Claude sessions on one machine both used `claude/opa-website`. One of them published a request under that address. The Director's reply went to `claude/opa-website`, and the other session's background `agent-bus wait` consumed it, so the session that had asked never saw it. The sessions now use `claude/opa-story-worktrees` and `claude/opa-guest-journeys`, and both subscribe to `#opa-website`.

## Current semantics

- An address is a mailbox with one cursor, and reading consumes: `bus_read`, `bus_wait` and the CLI's `wait` advance the cursor past what they return.
- Any caller may `bus_join`, read, wait on or `bus_publish` from any address. Nothing ties an address to the session using it; the latest presence entry is the address's state.
- So two sessions on one address act as competing consumers: each directed message goes to whichever reads first. And any session can send under another's address, so replies go back to the wrong place.
- Topics are the group mechanism: each subscriber has its own address and cursor, and every subscriber gets every topic message.

This is collision protection between cooperating local sessions, not security. Every process of the user can reach `serve` and its store anyway (see [connections](../connections.md)).

## Decision

Reviewed by GPT-6 Astra (max effort), GPT-6.1 Sol (extra-high) and Claude Opus 5.5 (high), who agreed on the basis and the locked checks; takeover follows Astra and Sol.

1. **An address is owned by one session, identified by `(runtime, id)`.**
   - The id comes from the runtime, never from the address: a Codex thread id, or a Claude Code session id. A human or other client supplies its own stable id.
   - Ownership is recorded in the presence entry, so it survives `serve` restarts.
   - One owner may hold several addresses.
2. **Identity travels as an explicit `session` argument** on `bus_join`, `bus_read`, `bus_wait`, `bus_publish` and `bus_leave`, not as an HTTP header.
   - Why not a header: Claude Code documents its session id only for shells, hooks and stdio MCP subprocesses; `/clear` changes it while a connection's headers stay fixed; and one Codex daemon serves many threads.
   - Agents read their id from their shell, which also works after compaction.
   - The join fixes the owner's runtime; later calls present only the id, which is a UUID in both runtimes.
   - The CLI defaults `--session` by `--runtime`: `$CODEX_THREAD_ID` for codex, `$CLAUDE_CODE_SESSION_ID` for claude, and `$AGENT_BUS_SESSION` otherwise. It never takes whichever variable happens to be set, because a Codex process started from a Claude shell inherits the Claude id. Outside `join`, `--runtime` defaults to the runtime the address joined with, so `agent-bus wait --address <address>` keeps working.
   - Empty values and unexpanded `${…}` placeholders are refused.
   - A lease token issued by `bus_join` was rejected: it would have to survive compaction and be handed to the background `wait` and the hook, and it protects nothing more between cooperating sessions.
3. **No anonymous access.**
   - Reading, waiting, leaving and publishing all require the caller to be the address's current owner, including `publish.from`. Today an address that never joined can publish.
   - A refusal leaves the cursor, the presence and the ledger unchanged.
   - The CLI treats an ownership refusal as final and doesn't retry it. The tool schemas leave `session` optional so that a call without one, including from a CLI older than this change, gets the bus's refusal (which ends its retries) rather than a protocol error (which it would retry).
4. **Checks run under the address lock, at the moment of effect.**
   - Ownership is checked inside `Bus.deliver`, just before the cursor moves, on every attempt. A wait that started before a takeover therefore can't consume the new owner's messages.
   - Publishing takes the sender address's lock and checks ownership before appending.
   - The Codex deliverer runs inside `serve` against the current subscriber under the lock, so it needs no identity.
5. **Joins:**
   - **Same identity:** a reconnect; the cursor and unread messages are kept. After `/clear` or a fork, Claude Code has a new id, so the session is a new owner. Its old background `wait` is refused on its next call and exits.
   - **A different identity while the address is held:** refused. The error shows the holder's runtime, note, last call and whether it has a wait open, and suggests a fresh address.
   - **Takeover:** `takeover` must name the holder's current join id, so it can't race and can't happen by reflex. It is recorded in presence, and the previous owner is refused from then on. Unread messages carry over. The tool description reserves it for replacing a session that has ended, when the human says so.
   - **Legacy presences** (no recorded owner): a Codex join adopts one only when its thread id equals the stored `codexThreadId`; anything else needs a takeover. Background waits running at the upgrade exit once with a refusal.
6. **The Codex Stop hook is an identified client.**
   - It presents the thread id it receives as `session_id`.
   - It requires a transcript path naming that thread; a missing transcript means no delivery.
   - It returns whatever it has already read even if a later read fails, so no consumed messages are lost.
7. **Scope.** Claims are atomic within one machine's `serve`, whose locks are process-local. Joins from different machines are ordered by the ledger, and the losing claim is refused from its next call. A cross-machine takeover keeps the presence, but the cursor is machine-local, so unread messages may be redelivered from the new machine's position. These limits are documented rather than solved.
8. **Descriptions.**
   - An address is one session's private inbox; pick one specific to the session.
   - `#topics` are for groups.
   - Pass your runtime's session id on every call, and run one `wait` per address.
   - Subagents act for their parent: within one owner, independent consumers need their own addresses.
9. **Qualification.** Over MCP and the CLI, with real runtime ids where the runtime is available:
   - **The incident:** two listeners on one address.
   - **Concurrency:** two joins at once on one machine; a takeover while the old owner's wait is blocked, and while it is publishing.
   - **Identity:** a call with no id, an empty id or a `${…}` placeholder; a Codex process started from a Claude shell.
   - **Session changes:** `/clear`; a `serve` restart with unread mail; leave and rejoin.
   - **Migration and the hook:** legacy adoption; a Stop hook read for the owner and for a non-owner; a hook whose second read fails.
   - **Every refusal:** the cursor, presence and ledger are unchanged.

## Verified and unverified

- **Verified:** `CODEX_THREAD_ID` is set in Codex shells, with distinct values for a thread and its subagent (two reviewers' own shells). Claude subagents share the parent's `CLAUDE_CODE_SESSION_ID` (a reviewer's own shell). Codex documents that subagent hooks carry the parent's `session_id`.
- **Unverified:** that `CLAUDE_CODE_SESSION_ID` is set the same way in terminal sessions as in the desktop app, and how it behaves on `--resume`; whether a desktop Local Codex thread's shell has `CODEX_THREAD_ID` (qualification checks both).

## Out of scope

Authentication between processes of the same user, and cross-user access.
