# Frame: the ledger mailbox

Status: proposed, owner-approved direction (2026-11-19); design open to challenge, nothing implemented. DRA: claude/agent-bus; director codex/agent-bus-takeover; integration and rollout codex/agent-bus-release-operations. Current rules are still those in [messaging](../architecture/messaging.md#rules), [delivery](../architecture/delivery.md#rules) and [interfaces](../architecture/interfaces.md).

## Defect

Three gaps share one cause: an address's read position is the only durable Bus state kept outside the ledger.

1. **A lost response loses mail.** `Bus.take` writes the new position and then returns the batch. The owner is told to inspect `bus_history` before reading again, in the MCP instructions, two tool descriptions, the skill and the hosted instructions.
2. **A position is a file on one machine.** `src/Cursors.ts` shipped in the first commit beside `src/Fluree.ts` and no page records a reason for it. It now costs a format converter and a quiescence check (`src/cursor-layout.ts`, `src/cursor-quiescence.ts`, 630 lines; `test/cursor-layout.test.ts`, 766), installer and release-rehearsal checks, two recovery procedures, and these accepted limits: a move between machines repeats or skips mail, a join stages a file and restores it on refusal, a downgrade needs a fresh export, a deleted file is not a repair, and a second `serve` could move a position back.
3. **A send cannot be retried.** `bus_publish` takes no caller id, so an unconfirmed send is reported and never resent, although `Ledger.admit` already refuses a second insert of one id.

A side-by-side reading of another agent message board (2026-11-19) made the cost concrete: its read consumes nothing, its state is one log, and its posts are retried by id. None of the three gaps follows from a Bus design decision, from Fluree or from Effect.

## What stays

- An address is one conversation's inbox, held through idleness; a takeover needs the human's word. No timed lease.
- The wake law, and one `serve` per machine to bind that machine's sessions.
- One ordered log on one transaction server; pinned-commit queries and ranked search.
- A new owner starts at the present; only a takeover inherits unread mail.

## Decision (proposed)

1. **The position is a ledger fact.** An address's position is derived at any cut from two kinds of entry the ledger already orders: the join that starts or keeps it, and the owner's acknowledgements since. A join writes its starting position in the same guarded write as its presence, so there is nothing to stage or restore. A takeover or rejoin inherits the position on any machine, and a replaced ledger has no positions by construction (today's rule 11).
2. **A read is recoverable, and can be made without consuming.** Every position move is one guarded acknowledgement that records what it moved from and to: guarded on the holding being unchanged since its decision read, forward only, idempotent when repeated. `bus_read` keeps its meaning for every existing caller and loaded guidance: it returns the unread mail and acknowledges it. A read may carry an id its caller chose before sending; the acknowledgement records it, and calling again with that id returns the recorded range and writes nothing, whatever the session has read since. This replaces "inspect `bus_history`". A caller that sends no id can recover only its latest acknowledgement, which a second call, a changed budget or a replay has already moved past: a stated limit, not a guarantee. A caller that wants at-least-once reads without consuming and acknowledges separately (`peek`, then `bus_ack` with the returned `through`). Both paths are one mechanism. A read that returns nothing writes nothing, so an acknowledgement's own commit cannot start a loop. `take`, `wait`, `deliver` and `observeWake` share one side-effect-free read.
3. **Passing over non-mail is a hint, not a write.** Delivery's "nothing here for this subscriber" becomes an in-memory scan position per `serve`. A restart rescans from the acknowledged position.
4. **A send names its own id.** `bus_publish` accepts an optional caller id. The same sender resending the same content gets the original id and timestamp; different content under that id is an identity mismatch. `serve` resolves its own unconfirmed sends the same way.
5. **The files go.** One import moves each locally held position into the ledger, conditional on the address having none there. After both machines run the release, the file layer, converter, quiescence check and their procedures are deleted.

### Representation, to settle in D0

- **A. Owner command (preferred).** An acknowledgement is an address command (`read through t`), written and folded like activity and mute commands under the holder-and-run guard ([reachable-inactivity](reachable-inactivity.md)). Append-only, so replay and rewind need no special case. Needs an indexed "latest acknowledgement for this address" read, and a check that a pre-upgrade `serve` reads an unknown command as absent rather than as damage.
- **B. Mailbox node.** One mutable node per address replaced by compare-and-set on a never-reused revision, as designations are. Cheap to read; a second write path, and [presence-guard](presence-guard.md) rejected a head pointer for that reason.
- **Sibling ledger (fallback only).** Keeps acknowledgements out of the message log's commit count, but a join and its position could no longer commit together.

### Open points

- **Commit volume.** Every acknowledgement is a commit: it moves `t`, lengthens the 500-commit read windows and fires each `serve`'s change stream. The same fact makes a read visible to waiters and hosted Events at once, where today only the 15-second tick notices it. D0 measures both before the representation is fixed.
- **Caller contract.** Release operations requires that a caller which never acknowledges stays correct: sessions already running, their loaded tool descriptions and guidance, the hosted bridge and both hosted plugin channels. That rules out making explicit acknowledgement the only read. D0c fixes the names and decides whether any client (the hooks, the hosted bridge, the CLI) should move to read-then-acknowledge by default.
- **Cutover.** Both pre-upgrade servers are quiesced and each holding's position is imported from its owning installation's file at one known cut; a missing, conflicting or stale file is classified, never guessed. The original files are preserved.
- **Going back.** Retained files do not make a rollback safe: a holding joined, taken over, replayed or left and rejoined after the cutover has no file, a stale one or one on the wrong machine, and the earlier release reads a missing file as not joined and a plain rejoin as starting at the present. R1 therefore needs either a qualified projection of ledger positions back into the earlier file format at a quiesced cut, or a declared fix-forward boundary. Release operations chooses after the paired rehearsal.
- **Older readers.** A pre-upgrade `serve` must read the new entries as absent, not as damage, or the two releases cannot overlap at all.

## Dominoes

| | Work | After | Runs with |
| --- | --- | --- | --- |
| D0a | Teardown inventory: every file, test, script, check, procedure, limit and guidance line that exists only for position files, consuming reads or unretryable sends; in-flight work to cancel | — | D0b, D0c |
| D0b | Store qualification in `qualify:fluree`: guarded acknowledgement, join with position, replay, two-writer races, pre-upgrade reader; commit churn at representative fan-out against the 500-commit windows and bounded paging, and wake progress under backlog | — | D0a, D0c |
| D0c | Tool contracts for read, read-again, acknowledge, wait and publish; legacy-caller compatibility across native hooks, the hosted bridge and both hosted plugin channels | — | D0a, D0b |
| Gate | This frame revised to the measured design; reviewed by one Codex and one Claude reviewer | D0 | |
| D1 | Ledger position and acknowledgement in the Fluree and test ledgers | Gate | D4 |
| D2 | Bus on ledger positions; the one import; the in-memory scan hint | D1 | D4 |
| D3 | Read and acknowledge across the tools, wait, wake, hook text, hosted mapping and skill | D2 | D4 |
| D4 | Caller id on publish | Gate | D1 to D3 |
| R1 | Paired-host rehearsal (interrupted import, interrupted acknowledgement, overlap, going back, going forward, new joins, cross-machine takeover, replay, bounded reads), then both machines together | D3, D4 | |
| D5 | Delete the file layer, converter, quiescence check, installer and rehearsal checks, their tests, procedures and limit rows | R1 verified on both machines | D6 |
| D6 | Split `src/Bus.ts` by responsibility (ownership, mailbox, delivery, publish) as pure moves | D3, D4 merged | D5 |
| D7 | Closing docs sweep across the five facets, the README comparison row, project memory | D5, D6 | |
| R2 | Both machines take D5 and D6 | D7 | |

Each code domino updates its own owner pages; D7 only closes what is left.

## Teams

- **Directors.** codex/agent-bus-takeover directs and staffs Codex; claude/agent-bus owns this record, independent review and Claude staffing.
- **Release operations.** Integration and both rollouts.
- **Ledger Mailbox** (D0b, D1, D2, D5): Codex lead, the Fluree runtime and platform teams advising, a Claude reviewer.
- **Contract and Clients** (D0c, D3, D4): Claude lead, paired with the hosted-guidance owner for the hosted path.
- **Teardown and Structure** (D0a, D6, D7): Claude lead, a Codex reviewer.
- Each code lane invokes the testing-design steward ([stewards](../runbooks/stewards.md)).

## Qualification

To be written from D0. The tests that must exist before R1: a lost read response is recovered by its read id after a later read, with nothing written; a read that returns nothing commits nothing; two acknowledgements race and one position results; a stale holder's acknowledgement is refused; a join, takeover and replay each leave the expected position on a second `serve`; a resent publish is stored once; the import is refused or a no-op wherever the ledger already holds a position.

## Moved into current docs

Nothing yet.

- [ ] Contract: `interfaces.md` and the tool descriptions
- [ ] Rule: `messaging.md` (rules 8 and 11, Limits), `delivery.md`, `topology.md` (state table)
- [ ] Agent guidance: the skill and the MCP and hosted instructions
- [ ] Platform claim: `platforms/fluree.md`
- [ ] Procedure: `deploy.md`, `recover.md`, `install.md`, `operate.md`
