# Frame: the ledger mailbox

Status: proposed, owner-approved direction (2026-11-19); representation settled by the D0 provider checks below, caller contract agreed between the directors, nothing implemented. DRA: claude/agent-bus; director codex/agent-bus-takeover; integration and rollout codex/agent-bus-release-operations. Current rules are still those in [messaging](../architecture/messaging.md#rules), [delivery](../architecture/delivery.md#rules) and [interfaces](../architecture/interfaces.md).

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

1. **The position is a ledger fact.** An address's position is derived at any cut from two kinds of entry the ledger already orders: the join that starts or keeps it, and the owner's acknowledgements since. A join writes its starting position in the same guarded write as its presence, so there is nothing to stage or restore. A takeover or rejoin inherits the position on any machine, and a replaced ledger has no positions by construction (today's rule 11). Inheriting must not copy: a disposable race showed a takeover guarded only on presence committing a position it read before the old holder's last acknowledgement, moving unread mail backward. Either a takeover and a rejoin write no position at all, so the position stays the latest start or acknowledgement in commit order and the old holder's later acknowledgements are refused by their own presence guard; or any position a join writes is also guarded on no newer acknowledgement for the address, and is redecided when refused. D0b ran the race against the first and it held, so D1 takes it.
2. **A read is recoverable, and can be made without consuming.** Every position move is one guarded acknowledgement. It attests the contiguous prefix actually served, with the subscription and limits that read ran under, and is fenced on the ledger incarnation and on the holding being unchanged since its decision read; it moves forward only and is idempotent when repeated. The guard is on position facts as well as presence: an acknowledgement is written only if no newer start or acknowledgement for the address has committed since its basis. Two readers of one holding, both from position 0, must not commit 20 and then a stale 10 at a later commit. `bus_read` keeps its meaning for every existing caller and loaded guidance: it returns the unread mail and acknowledges it. A read may carry an id its caller chose before sending; the acknowledgement records it, and calling again with that id returns the recorded range and writes nothing, whatever the session has read since. This replaces "inspect `bus_history`". A caller that sends no id can recover only its latest acknowledgement, which a second call, a changed budget or a replay has already moved past: a stated limit, not a guarantee. A caller that wants at-least-once reads without consuming and acknowledges separately (`peek`, then `bus_ack` with the returned `through`). Both paths are one mechanism. A read that returns nothing writes nothing, so an acknowledgement's own commit cannot start a loop. `take`, `wait`, `deliver` and `observeWake` share one side-effect-free read.
3. **Passing over non-mail is not a commit per pass.** Today an empty delivery scan moves the position so the range is not read again, a deliberate choice because a Fluree read walks every commit to the head. The acknowledged position stays what wake coverage, the Codex covered-mail record and the hosted Events checkpoint compare. How far a `serve` has scanned beyond it is held in memory, shared by every read path in that process and valid only for the ledger incarnation, the position entry it was scanned from and the subscription it was scanned under. A replay that rewinds from 100 to 0 with unchanged topics must not reuse a hint at 150, and a changed topic list discards it; D0b decides whether a bounded checkpoint is also written when the gap grows, so a restart or a quiet address does not rescan without limit.
4. **A send names its own id.** `bus_publish` accepts an optional caller-chosen operation id. The same sender resending the same content gets the original id and timestamp; different content under that id is an identity mismatch. Sameness ignores the timestamp and origin, which are taken again on each attempt. The original entry, read back by id, is the authority after any ambiguous write, including two attempts racing: today a second insert of an id is reported as a conflict, and a guarded no-op at a coincident commit can be read as admitted. `serve` resolves its own unconfirmed sends the same way.
5. **The files go.** One import moves each locally held position into the ledger, conditional on the address having none there. After both machines run the release, the file layer, converter, quiescence check and their procedures are deleted.

### Representation

Settled by D0b as A, with no position written on a takeover or rejoin. B and the sibling ledger are the alternatives rejected.

- **A. Acknowledgement entry (preferred).** An append-only entry of its own type, one per acknowledgement, guarded like a send on the address's presence being unchanged since the decision read. Append-only, so replay and rewind need no special case. It cannot be an address command: the command log is decoded strictly and one unknown shape fails the whole read as damage (`src/activity-read.ts`), which on an earlier `serve` would stop ambient delivery, activity and the peer list; and a position must survive a takeover and a rejoin after leave, where activity deliberately resets. A join's starting position is a second entry in the join's own guarded write, not a new presence field, for the same reason. Needs a per-address "latest acknowledgement" read; none exists, and the command log read is ledger-wide.
- **B. Mailbox node.** One mutable node per address replaced by compare-and-set on a never-reused revision, as designations are. Cheap to read; a second write path, and [presence-guard](presence-guard.md) rejected a head pointer for that reason.
- **Sibling ledger (fallback only).** Keeps acknowledgements out of the message log's commit count, but a join and its position could no longer commit together.

### Open points

- **Commit volume.** Every acknowledgement is a commit: it moves `t`, lengthens the 500-commit read windows and fires each `serve`'s change stream. The same fact makes a read visible to waiters and hosted Events at once, where today only the 15-second tick notices it. D0 measures both before the representation is fixed.
- **Caller contract.** Release operations requires that a caller which never acknowledges stays correct: sessions already running, their loaded tool descriptions and guidance, the hosted bridge and both hosted plugin channels. That rules out making explicit acknowledgement the only read. D0c fixes the names and decides whether any client (the hooks, the hosted bridge, the CLI) should move to read-then-acknowledge by default.
- **Cutover.** Both pre-upgrade servers are quiesced and each holding's position is imported from its owning installation's file at one known cut; a missing, conflicting or stale file is classified, never guessed. An address its session left but may rejoin keeps a recoverable position and is imported; that is distinguished from another session joining it after the leave, which starts at the present. The original files are preserved.
- **Going back.** Retained files do not make a rollback safe: a holding joined, taken over, replayed or left and rejoined after the cutover has no file, a stale one or one on the wrong machine, and the earlier release reads a missing file as not joined and a plain rejoin as starting at the present. R1 therefore needs either a qualified projection of ledger positions back into the earlier file format at a quiesced cut, or a declared fix-forward boundary. Release operations chooses after the paired rehearsal.
- **Older readers, and no older writer.** A pre-upgrade `serve` reads the new entries as absent, not as damage (shown in D0b). That makes them decodable; it does not make an older `serve` safe to run. From the import until an export back or the fix-forward boundary, neither pre-upgrade server may accept any operation that moves a position: after an import at 10, an older read of 11 would move only its file, and the new reader would deliver 11 again. The cutover enforces this, it is not left to timing.

## Caller contract (D0c draft)

Every addition is optional, so a caller that sends none of it behaves as today.

- **`bus_read`, `bus_wait`.** New optional `readId`, a lowercase UUIDv7. A read that returns mail records its acknowledgement under that id; the same holding calling again with the id gets the recorded batch and writes nothing. The result gains `receipt` (`readId`, `from`, `through`, `replayed`) and `nextReadId`, an id the server issues for the caller's following read, so a model caller never has to mint one: it passes back what the last result gave it, and after a lost result repeats the call unchanged. A programmatic client may mint its own.
- **Replay limits.** An id is recorded only when its read acknowledged mail: a keyed read that returned nothing wrote nothing, did not use its id, and a repeat of it is an ordinary read. An id replays only within the holding that made it; a takeover, or a rejoin after leave by another session, cannot replay it. A replay serves the recorded batch whole: if it does not fit the call's limits it is refused, naming the size needed, and nothing changes. A read without `readId` can be recovered only as the latest acknowledgement, and not after a later read. A caller's first read has no issued id, so if that response is lost the `nextReadId` in it is lost too: the first read is covered only by this weaker rule unless the caller minted its own id.
- **`bus_read` with `peek: true`, and `bus_ack`.** A peek returns the unread mail and a `receipt` and writes nothing. `bus_ack` takes that receipt and writes the acknowledgement; it is refused, with nothing written, if the position, holding, subscription or ledger is not the one the peek read. The receipt is validated, not trusted, and identifies the peek's basis and served prefix; an end position alone cannot. Two peeks can end at the same commit yet differ: under topics A a peek serves the A mail and a direct message, the owner rejoins with topics B and a second peek serves the B mail and the same direct message, and only the second may be acknowledged.
- **`bus_publish`.** New optional `operation`, a lowercase UUIDv7 naming the send and all its retries, the word `bus_activity` already uses; it becomes the message's id. The first admitted send under it is the message. A later send under it by the same address with the same audience, subject, body, `replyTo` and pierce returns the original `id` and `ts` with `replayed: true`; anything else under that operation, a different pierce included, is refused as an identity mismatch with nothing written. The stored entry, read back by id, decides, including when two attempts race or an answer is lost.
- **Guidance.** The lost-result sentence in the MCP and hosted instructions, the two tool descriptions, the Claude hook and Codex nudge text and the skill changes from "inspect `bus_history` before reading again" to "repeat the read with the same `readId`"; the publish guidance changes from "not retried" to "retry with the same `operation`".

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
| R1 | Paired-host rehearsal (interrupted import, interrupted acknowledgement, an older server refused every position-changing call after the import, going back, going forward, new joins, cross-machine takeover, replay, bounded reads), then both machines together | D3, D4 | |
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

### D0b provider checks (2026-11-20)

On a disposable Fluree 4.2.4 with the released Bus as the earlier reader. Provider-level facts, not production qualification, and no claim about performance or scale.

- A guarded join wrote its presence and a separate start entry together; a stale join wrote neither.
- Two acknowledgements racing from one basis both got the same commit in their HTTP answers, and one was stored. The answer therefore cannot say which: a read confirms its own entry by id before it serves mail as acknowledged.
- A takeover guarded only on presence committed a position read before the old holder's last acknowledgement. With no position written on takeover, the case passed with the acknowledgement before and after, including a discarded first answer.
- A same-session rejoin after leave, writing no position, kept the acknowledged position and began a new run; another session after the leave wrote a new start; a replay fenced the earlier run's acknowledgements.
- With the position at 2, other mail at 3 and the acknowledgement's own commit at 4, a read from the acknowledged position returned the mail at 3.
- The earlier reader ignored entries of the new types that carry no `bus:json`; an unknown field on an address command broke its log read.
- 501 acknowledgement-only commits across ten addresses, then two messages: the earlier read made two 500-commit window queries and returned both. A lone acknowledgement emits a change notice; the read it triggered wrote nothing.

What the checks require of D1 and D2:

- **Authority is the application's.** An acknowledgement from an earlier run, sent on a fresh basis, commits if nothing first establishes the caller as the current holder. The store guard is not that check.
- **Point reads check the stored entry.** A replay or a retried send reads the immutable attempted entry and compares its canonical intent, under the current holder's permission.
- **Damage fails.** A query that selected only well-formed rows hid a deliberately malformed newer acknowledgement. Reading a position fails on such an entry; it never falls back to an older one.
- **A served prefix is proved.** An acknowledgement's declared membership and byte prefix are pinned to the cut it read, not asserted.

### Gates still open before R1

A lost response through the new handlers end to end; a restart with positions in the ledger; the paired-host rehearsal and both directions of the cutover; query cost and damage reporting at a representative ledger; real wake feedback under acknowledgement commits. The tests that must exist: a lost read response is recovered by its read id after a later read, with nothing written; a read that returns nothing commits nothing; two acknowledgements race and one position results; a stale holder's acknowledgement is refused; a join, takeover and replay each leave the expected position on a second `serve`; a resent publish is stored once; the import is refused or a no-op wherever the ledger already holds a position.

## Moved into current docs

Nothing yet.

- [ ] Contract: `interfaces.md` and the tool descriptions
- [ ] Rule: `messaging.md` (rules 8 and 11, Limits), `delivery.md`, `topology.md` (state table)
- [ ] Agent guidance: the skill and the MCP and hosted instructions
- [ ] Platform claim: `platforms/fluree.md`
- [ ] Procedure: `deploy.md`, `recover.md`, `install.md`, `operate.md`
