# Frame: composed orientation

This proposed first orientation release refines the accepted [coordination turnaround](coordination-turnaround.md) after the [query outcome](query-viewer-release-2026-11-02.md). It is a downstream contract and delivery plan, not implemented behaviour, a release qualification or consumer acceptance. Current behaviour remains in [interfaces](../architecture/interfaces.md), [messaging](../architecture/messaging.md) and [connections](../architecture/connections.md).

Status: director-owned direction for counterpart review, 2026-11-02. Tool names and schemas are provisional; the decisions identified below remain open before implementation.

## Frame

**Intent.** An incoming or returning participant can find the right concern, authoritative source and explicitly designated current handoff through one route. The maintainer publishes context once rather than reconstructing it in individual briefs. The foreground is correct next action and honest currentness and delivery, not registration volume.

**Scope and exterior.** Compose a stable repository directory, semantic concern links, explicit address associations, programme and concern bulletins, and a read-only orientation result. Do not add authentication or project ACLs, a generic record platform, a second membership registry, automatic subscriptions, activity-state implementation, viewer expansion, sandbox infrastructure or process supervision. Later activity, continuity, topic adoption and measurement remain in the broader turnaround.

**Alternative.** Source documents, ranked history and better individual briefs cost less to build, but keep the maintainer carrying context and require readers to infer designation from recency. Independent directory, topic and bulletin platforms would duplicate state without demonstrated value. The selected approach adds only explicit designation and discoverable relationships.

**Hard core.** One composed route; explicit relationships without inferred authority; atomic current-state replacement with one replay-safe notification; and usefulness in a real handoff, not synthetic adoption. Exact tool names, schemas and limits are not fixed here.

**Falsifier.** Reframe before expansion if an eligible participant follows the route but still needs the maintainer to reconstruct required current facts, or acts on a superseded or unavailable record represented as current. Two consecutive eligible handoffs needing the same missing orientation fact trigger design review, not more coaching. No eligible observation means unmeasured.

**Evidence and assumptions.** The broader model is owner-accepted in the turnaround frame. One actual director-to-lead handoff supplied five facts manually: frame, source checkout, action boundary, phase and next owner. Which were necessary and orientation-only effort are unknown. A future eligible job, participant and maintainer remain consumer-owned; do not invent a trial. State-machine and simplicity judgments informed this proposal. Source-level conditional-transaction evidence is not a measured internal-overlap experiment.

## Downstream contract

Three provisional domain tools form one story:

- `bus_orient` reads the selected directory or unresolved candidates, registered concerns, explicitly associated addresses, separately labelled presence and subscriptions, current programme and selected concern bulletins, and a reference to the query-owned catalogue.
- `bus_directory` maintains one bounded directory with stable identity, explicit checkout aliases and concern definitions and links. It is not a separate project or topic lifecycle API.
- `bus_bulletin` publishes or withdraws a current programme or registered concern bulletin. It is not a generic public mutation API, nor an extra repository-wide bulletin without demonstrated need.

An additive association on existing join presence is the single address-association source. Alias matching discovers candidates but never enrols. Omitted association fields preserve the same owner's state, explicit clearing removes it, and a different owner does not silently inherit it. Presence is not activity or runtime availability; responsibility remains in authoritative guidance. Leave and rejoin retention needs a decision against the actual lifecycle before coding.

Scope-less joins and unread cursors remain valid. Join commits before orientation is read: a failed read reports both the committed join and unavailable orientation, with a read-only retry. Orientation alone acquires no membership, subscription, cursor or wakeability. Programme guidance remains available when directory selection is absent or unresolved.

Composed ledger facts share one orientation cut; a historical investigation cut, evaluation time and catalogue/code revision are separate. Missing, withdrawn, expired, truncated, damaged and unavailable are distinct, not interchangeable empty results. Result units, bounds and completion labels must be chosen before implementation; no silent partial directory or member result, and no unbounded context dump.

## Current state and notification

Use the existing Ledger service and qualified conditional transaction shape, not a new CAS service or single-writer fallback. For each scope retain one designated immutable revision, predecessor and provenance, optional expiry, and an immutable operation witness. Withdrawal is a retained revision, not pointer deletion; restoration explicitly replaces it. Expiry changes read-time freshness, not designation or admission preconditions.

Initial publication expects never registered. Replacement expects an exact non-reused revision and installs a different revision. Under that guard, commit revision, pointer, matching witness and exactly one fully encoded ordinary message. Other metadata must not carry `bus:json` or Message/Presence type. Exact replay adds no entry; reuse of a witnessed operation ID for different intent is an identity mismatch.

`APPLIED` means the matching witness exists, not that its revision remains current. Return revision and notification identity, and label any observed current designation with its own cut. `CONFLICT` requires established nonapplication and an observed revision and cut. Transport loss or an unqualified server failure is `UNKNOWN`: one bounded fresh-cut witness read may prove application, but absence alone cannot prove failure while the original can still arrive. Identical retries retain the operation ID, expectation and payload; do not automatically rebase, issue a new ID or loop.

Programme publication creates one ordinary message to `*`, since that guidance is bus-wide. Concern updates address the registered concern topic and only deliberately named necessary direct recipients. Association does not imply delivery; subscriptions use existing delivery semantics rather than a frozen roster. Committed notification is not proof of receipt or reading. Later sessions retrieve the designated bulletin through join/orient rather than replaying old mail.

## Delivery and evidence

The immediate prerequisite is the exact provider qualifier. A pass was reported on Fluree 4.2.4, including positive and negative history oracles, stale and unrelated commits, historical witnesses, client overlap, lost acknowledgement, identical replay, delivery comparison and killed mutants. Independent review identified two pending repairs: forwarding failure must settle the lost-ack harness promise so cleanup runs, and the source inference must state non-reused revisions. Publication waits for the repaired identity and scoped re-review. This report is not a fully qualified or merged production module.

Before production coding, settle and test: association retention on leave and rejoin; bounded result units, completeness and native join/CLI compatibility; and the exact fields the consumer requires. The testing steward shapes observable oracles. Then build and qualify one complete newcomer/publication story, cross-review with the counterpart, and use the normal Graphite and exact-identity deployment process. Ordinary release decisions belong to the leads; genuine trust, credential and irreversible external boundaries still apply. The implementation owner owns source, integrated checks and cleanup; stewards provide judgment, not an additional approval chain.

## Real handoff

Propose to the largest consumer a naturally occurring eligible handoff with the ordinary task outcome and the single orientation route, omitting only bespoke orientation facts. The consumer chooses which of the five observed fields are necessary. Check correct facts and next action, orientation-only clarification, wrong assumptions and unnecessary interruptions; ordinary authority and task questions remain normal. Do not block consumer work or count installation, a skill announcement or a fabricated role as acceptance. Do not claim time or relay savings without comparable evidence.

After the first real observation, iterate before expanding into later activity, reactivation and semantic-topic measurements. This release is one complete product step, not completion of the broader mission, including running and late-session guidance and reduced manual relay.

## Moved into current docs

- [ ] Contract: interfaces and tool descriptions reflect accepted, implemented APIs.
- [ ] Rules: architecture owners describe shipped behaviour and limits.
- [ ] Agent guidance: the skill supports the actual orientation route.
- [ ] Platform claims: version-sensitive findings carry their observed basis.
- [ ] Procedure: deployment, recovery and real handoff are verified.
