# Frame: useful read-only bus analysis

This candidate frame covers SPARQL and shared saved analyses under the [turnaround](coordination-turnaround.md); current API behaviour remains in [interfaces](../architecture/interfaces.md#bus_query) and its store boundary in [connections](../architecture/connections.md).

Status: proposed; no implementation or deploy acceptance. DRA: Claude lead, cross-reviewed by Codex. Mode: co-framing; object: solution. Consumer: agents answering actual coordination questions and the viewer using the same definitions. Query and viewer integration are the proposed first release unit and the measuring instrument for later baselines.

## What and why

Make complete, ordered evidence retrieval and useful aggregation ordinary bus operations again. The owner withdrew the premise that trusted local agents require a separate public-only graph. Keep a read-only contract, not the previous confidentiality proof programme.

In are raw read-only SPARQL, a discoverable saved-query catalogue, typed parameters, explicit snapshot identity and honest page exhaustion. Foreground the real preview-handoff reconstruction described in the parent frame. Exterior are transactions, a separate writable mirror, caller-managed exports and new local-process hardening.

The alternative of history/peers-only lookup is cheaper but cannot satisfy complete ordered history and joins. Arbitrary queries without reusable definitions impose avoidable work on agents and the viewer. Prefer saved operations first, with raw SPARQL as the analysis escape hatch.

The initial catalogue must cover complete ordered history by fixed cut and participant audience, reply-linked threads with explicit missing/unlinked context limits, counts by sender/topic/day with defined message-versus-recipient denominators, and peers with their topics. History means message records present at the chosen snapshot, not a transaction/retraction audit. Define participant selection as literal sender/recipient matching with explicit concern-topic tokens; do not present it as proof of actual historical delivery. Inspect which facts are graph predicates versus serialized entry data before choosing each implementation; do not assume a missing predicate or an aggregate is already materialised.

Include the parent frame's direct-message-volume proxy in that first catalogue, with explicit director, cohort and comparable window/day inputs. Baseline and re-measure use the same operation definition at two pinned snapshots; interpretation as actual relay reduction still needs the consumer and coverage checks.

## Hard core and open decisions

1. Queries never perform transactions. Every result identifies the actual snapshot and whether coverage is complete.
2. Ordering and continuation are stable at that snapshot, including equal timestamps, multi-recipient rows and concurrent later appends. The ledger snapshot is distinct from any message-time selection window; input resolution and related counts use the same pinned evidence state.
3. Viewer and agent named analyses share one server-owned definition; recipe text is not a separate implementation. Catalogue names, defaults, schemas, examples and execution agree. A continuation identifies its operation/argument semantics and is explicitly rejected when a release changes them; no indefinite legacy fallback is required.

Completeness applies to logical messages, not multiplied recipient/join rows, ranked text matches or only successfully decoded entries. Omitted or malformed records must not silently become a complete result. Exhausting a declared relation is not itself proof that the relation covers the whole coordination job; known anchors and reply links are checks, not that proof. Distinguish message timestamp ordering from commit ordering. Raw SPARQL has an explicit bounded-result contract rather than an implied general-purpose cursor over arbitrary queries. Current peers and latest recorded presence at a historical cut are separately labelled; neither proves send-time membership or actual receipt. Historical facts absent from the record cannot be recovered by time travel alone.

Assume the existing ledger contains the required message evidence. Choose the smallest native mechanism only after reading installed-version Fluree query, time-travel and sizing docs and inspecting Archive prior art. Saved-query names, invocation shape, page contract and cancellation limits remain design decisions.

The owner-selected Archive implementation has a finite code-owned catalogue, closed typed arguments with semantic validation, fixed query rendering through one snapshot-aware read gateway, executable orientation examples, and whole-row continuations bound to the original transaction. It distinguishes the pinned evidence snapshot from a later live head and fails explicitly when a single row cannot fit. Reuse that product pattern; do not copy its corpus-specific joins, constants, authentication machinery or admission limits without a bus requirement. The older root build lacked the catalogue and was not the selected reference. This is source-code prior art, not proof that bus queries already work.

## Adoption and falsifier

Baseline: the deployed raw query tool refuses, and the consumer cannot complete the agreed reconstruction through it. After an approved deploy, the consumer executor retrieves the whole agreed job in one complete paginated traversal, not necessarily one RPC; its coordinator checks authority changes and actual outcome from that same evidence. Report pagination/cut limits, not inferred completeness from known anchors.

Qualify the actual McpServer, both store implementations where relevant, read-only rejection, ordering, historical reads and query errors. Synthetic checks establish mechanism correctness, not adoption. If the real job still needs a human export or an alternate query path, this vertical is not done and its contract must be reframed before the next ships.

## Moved into current docs

- [ ] Contract and tool descriptions.
- [ ] Architecture rules and current query decision.
- [ ] Skill catalogue and executable recipes.
- [ ] Version-marked Fluree findings.
- [ ] Deployment, rollback and consumer acceptance procedure.
