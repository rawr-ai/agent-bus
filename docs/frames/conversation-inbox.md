# Reading mail in a persistent conversation

This frame concerns the work a recipient does between a wake and a useful reply. It does not change addressing, storage, scheduling or who may act. The current protocol lives in [interfaces](../architecture/interfaces.md#bus_read).

## Outcome

One conversation has the accumulated context to handle a message. Send the message there, even if another worker happens to be idle. The bus does not assign work, reclaim leases, decide whether a job was completed, or turn a mailbox acknowledgement into evidence that the recipient acted.

A cold recipient should need one read to obtain the complete body, know who sent it, choose whom to answer, and link the answer. An already oriented recipient should not have to read a manual with every notification. Sender-written material stays in the tool result, not in the owner's wake input.

## What belongs where

| Moment | What the recipient needs |
| --- | --- |
| The harness wakes a conversation | Its held address, the read action and how to handle a quiet miss. The existing Codex prefix still identifies an outstanding nudge. |
| The client discovers the server | Cross-cutting identity and authority rules. Server instructions can be surfaced alongside individual tools; keep them short. |
| The agent selects a tool | Its inputs, ordinary effect and recovery contract. A lost keyed read repeats the original call; a lost unkeyed read is not repaired by consuming again. |
| The agent receives mail | The whole actionable message and its existing read handles in both MCP result representations. Machine and checkout origin are not needed to reply. |
| A fact about context matters | Use the existing named `messages` operation with the id or `thread` with the focus id. Preserve the returned ledger and commit for follow-on pages. The skill gives examples, not a prerequisite to read. |

Considered and rejected: a per-client instruction cache requiring a handshake, a second inbox tool, header-only consuming reads, a new grouping identifier, and raw provider queries in the reply path. Shortening messages by dropping required timestamp or kind breaks already discovered schemas. The optional origin can be omitted without that break. Counting the original full projection for admission and stored acknowledgements preserves replay in either release direction; compact presentation does not buy extra batch capacity.

## Evidence and boundaries

SDK tests read and reply with a full escaped body and explicit audience; exact-id detail recovers origin without moving the inbox. In a two-message fixture, the compact peek carrier was 1,736 bytes versus 2,860 with origin, and keyed replay was 1,340 versus 2,464. Without recorded origin the message size is unchanged. These are wire sizes, not measured model token savings. The short-address native cues are 191 bytes for Claude and 188 for Codex versus 730 and 732. Neither fixture proves that a hosted client woke or that a recipient acted exactly once.

A loopback probe compared the incumbent and candidate projections with fresh, skill-free native Codex and Claude Code clients, a synthetic read, and a scripted provider. Each client's outgoing request contained the complete message once, despite two MCP result representations. For that message, Codex's provider-bound field went from 823 to 649 UTF-8 bytes; Claude's went from 787 to 613. This observes the adapters, not model reasoning, a desktop wake or a hosted conversation. It is a reason to keep both MCP representations substantive rather than remove one to chase a presumed duplicate.

An ID is a reference to a message, not a snapshot handle. The ordinary read does not return the ledger incarnation of its basis. A later navigation pins its own snapshot; a thread shows only explicit reply links, subject to paging and damage. A single rich row can exceed the saved-query page limit; detail failure does not undo delivery or truncate the original body.

Qualify against the actual predecessor acknowledgement and outstanding peek on disposable storage, then verify installed native and hosted read/reply through the normal release path. No retrospective grant, new watch, provider restart or format migration is needed.

## Next question

The [semantic-message discovery brief](https://github.com/rawr-ai/agent-bus/issues/134) sets the prose control, sampling limit and stopping rule.

After the basics ship, examine ordinary exchanges that required another turn just to explain *what changed* or *what the recipient is being asked to decide*. Compare clear ordinary prose with one optional, typed meaning on real examples, including an older text-only recipient. A type earns its place only if it eliminates clarification or redundant payload while preserving a useful verbatim text fallback. A command lifecycle, assignment, universal taxonomy or inference of authority is not the objective.

## Moved into current docs

- Contract: [inbox and its limits](../architecture/interfaces.md#bus_read); the consuming tools describe recovery.
- Rule: [public projections](../architecture/messaging.md) and [wake ownership](../architecture/interfaces.md#instructions-and-wake-texts).
- Agent guidance: [read and reply](../../plugin/skills/agent-bus/SKILL.md#when-a-wake-arrives) and [named lookups](../../plugin/skills/agent-bus/references/queries.md).
- Platform: no change to the underlying client protocols or promise about how a host renders the two result channels.
- Procedure: the existing [guidance refresh](../runbooks/upgrade.md#refreshing-guidance-in-running-sessions) and [release](../runbooks/deploy.md) procedures apply.
