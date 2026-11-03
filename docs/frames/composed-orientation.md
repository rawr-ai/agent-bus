# Frame: composed orientation

This proposed first orientation release refines the accepted [coordination turnaround](coordination-turnaround.md) after the [query outcome](query-viewer-release-2026-11-02.md). It is a downstream contract and delivery plan, not implemented behaviour, a release qualification or consumer acceptance. Current behaviour remains in [interfaces](../architecture/interfaces.md), [messaging](../architecture/messaging.md) and [connections](../architecture/connections.md).

Status: director-owned direction for counterpart review, 2026-11-02. Tool names and schemas are provisional; the decisions identified below remain open before implementation.

## Frame

**Intent.** An incoming or returning participant can find the right concern, authoritative source and explicitly designated current handoff through one route. The maintainer publishes context once rather than reconstructing it in individual briefs. The foreground is correct next action and honest currentness and delivery, not registration volume.

**Scope and exterior.** Compose a stable repository directory, semantic concern links, explicit address associations, programme and concern bulletins, and a read-only orientation result. Do not add authentication or project ACLs, a generic record platform, a second membership registry, automatic subscriptions, activity-state implementation, viewer expansion, sandbox infrastructure or process supervision. Later activity, continuity, topic adoption and measurement remain in the broader turnaround.

**Alternative.** Source documents, ranked history and better individual briefs cost less to build, but keep the maintainer carrying context and require readers to infer designation from recency. Independent directory, topic and bulletin platforms would duplicate state without demonstrated value. The selected approach adds only explicit designation and discoverable relationships.

**Hard core.** One composed route; explicit relationships without inferred authority; atomic current-state replacement with one replay-safe notification; and usefulness in a real handoff, not synthetic adoption. Exact tool names and schemas remain provisional; operational limits below need validation against representative real handoff content before final freeze.

**Falsifier.** Reframe before expansion if an eligible participant follows the route but still needs the maintainer to reconstruct required current facts, or acts on a superseded or unavailable record represented as current. Two consecutive eligible handoffs needing the same missing orientation fact trigger design review, not more coaching. No eligible observation means unmeasured.

**Evidence and assumptions.** The broader model is owner-accepted in the turnaround frame. One actual director-to-lead handoff supplied five facts manually: frame, accepted branch/commit and location, action boundary, phase and next owner. The consumer says a returning delivery operator needs all five; a read-only reviewer may not need the physical checkout. Orientation-only effort remains unknown. A future eligible job, participant and maintainer remain consumer-owned; do not invent a trial. State-machine and simplicity judgments informed this proposal. Source-level conditional-transaction evidence is not a measured internal-overlap experiment.

## Downstream contract

Three provisional domain tools form one story:

- `bus_orient` reads the selected directory or unresolved candidates, registered concerns, explicitly associated addresses, separately labelled presence and subscriptions, current programme and selected concern bulletins, and a reference to the query-owned catalogue.
- `bus_directory` maintains one bounded directory with stable identity, explicit checkout aliases and concern definitions and links. It is not a separate project or topic lifecycle API.
- `bus_bulletin` publishes or withdraws a current programme or registered concern bulletin. It is not a generic public mutation API, nor an extra repository-wide bulletin without demonstrated need.

An additive association on existing join presence is the single address-association source. Alias matching discovers candidates but never enrols. Omitted fields preserve associations only for the same owner while the latest presence is joined, including explicit replay; an explicit empty list clears them. Leave copies associations into the left presence as historical evidence. Any join after leave starts unassociated unless explicitly supplied, even for the same session; an omitted association on takeover is unassociated. Legacy missing fields mean unassociated, without searching older presences. Fold the latest presence as a complete record, not a merge; project the actual association fields, not just their schema. Departed associations are not current membership, although their historical records remain queryable. Presence is not activity or runtime availability; responsibility remains in authoritative guidance.

Scope-less joins and unread cursors remain valid. Join commits before orientation is read: a failed read reports both the committed join and unavailable orientation, with a read-only retry. Orientation alone acquires no membership, subscription, cursor or wakeability. Programme guidance remains available when directory selection is absent or unresolved.

For an association-bearing join, the new CLI must check actual fresh server capability before mutation: an older server can ignore unknown parameters. Source review found the current CLI's native protocol lane can discover the generated input and output schemas, so preflight the association inputs and effective-association output without a new negotiation API. An older adapter can omit output schema; absent or ambiguous advertised capability refuses the association join before mutation rather than guessing. Verify the effective association echo after joining. An absent or mismatched echo reports a committed join and uncertain association, never an automatic rejoin. Old scope-less joins remain valid; do not claim a cached older native client can send new fields. Generated nested property names and cached-client behaviour need executable qualification, not source inference alone; qualify actual hosts or reconnect with a fresh session.

Composed ledger facts share one orientation cut; a historical investigation cut, evaluation time and catalogue/code revision are separate. Missing, withdrawn, expired, truncated, damaged and unavailable are distinct, not interchangeable empty results.

The proposed limits are one directory document of at most 16 KiB serialized UTF-8, with at most eight aliases and 20 concerns, and a bulletin body of at most 4 KiB UTF-8. There is no global directory-count cap. Orient includes the full programme and selected concern bodies, directory and concerns, up to 20 candidate summaries and up to 50 current associated members, with a total order. Members continue through the query-owned same relation, filters, order, ledger incarnation, cut and catalogue version, not a second paging engine. Never silently trim or skip; claim complete only when exhausted without unchecked or encountered damage.

The aggregate logical structured result is at most 65,536 UTF-8 bytes of JSON, using existing whole-unit admission. This is not a full wire or host guarantee: Effect duplicates text and structured output, and escaping adds bytes. Measure actual transport and model-visible host behaviour in qualification. If a required whole unit cannot fit, report that section unavailable with same-cut recovery; do not consume its continuation.

## Current state and notification

Use the existing Ledger service and qualified conditional transaction shape, not a new CAS service or single-writer fallback. Server-derived, kind-namespaced scope variants prevent cross-domain pointer collisions and arbitrary scopes. For each scope retain one designated immutable revision, predecessor and provenance, optional expiry, and an immutable operation witness. Withdrawal is a retained revision, not pointer deletion; restoration explicitly replaces it. Expiry changes read-time freshness, not designation or admission preconditions.

Initial publication expects never registered. Replacement expects an exact non-reused revision and installs a different revision. The transaction guards both the expected pointer (or initial absence) and absence of the operation witness. Under those guards, commit revision, pointer, matching witness and exactly one fully encoded ordinary message. A bare insert can add to an existing node and create ABA or a duplicate entry, so the immutable witness guard is required. Other metadata must not carry `bus:json` or Message/Presence type. Exact replay adds no entry; reuse of a witnessed operation ID for different intent is an identity mismatch.

`APPLIED` means the witness matches the exact scope, expectation and stored JSON, not merely that a witness exists or that its revision remains current. Return revision and notification identity, and label any observed current designation with its own cut. `CONFLICT` requires established nonapplication and an observed revision and cut. Transport loss or an unqualified server failure is `UNKNOWN`: one bounded fresh-cut witness read may prove application, but absence alone cannot prove failure while the original can still arrive. Identical retries retain the operation ID, expectation and payload; do not automatically rebase, issue a new ID or loop.

Programme publication creates one ordinary message to `*`, since that guidance is bus-wide. Concern updates address the registered concern topic and only deliberately named necessary direct recipients. Directory updates address an explicitly named audience, not one derived from members. A withdrawal notifies the same audience as the withdrawn revision. Association does not imply delivery; subscriptions use existing delivery semantics rather than a frozen roster. Committed notification is not proof of receipt or reading. Later sessions retrieve the designated bulletin through join/orient rather than replaying old mail.

## Delivery and evidence

The immediate prerequisite is the exact provider qualifier. A held candidate on Fluree 4.2.4 reports 22 qualifier checks and 528 tests passing, including positive and negative history oracles, stale and unrelated commits, historical witnesses, client overlap, lost acknowledgement, identical replay, delivery comparison and killed mutants. An operation-ID reuse counterexample exposed the insufficiency of a pointer-only guard; the candidate adds the witness-absence guard. The two prior harness and source-inference review repairs are in the held candidate. Scoped review now requests one additional absence-reconciliation `UNKNOWN` check, without identifying a current behaviour bug; that check is being added. The proof is not yet merged or finally qualified and there is no production module.

Before production coding, validate the proposed limits against representative handoff content and test native capability discovery and compatibility, completeness, whole-unit recovery and the decided association lifecycle against actual code. The testing steward shapes observable oracles. Then build and qualify one complete newcomer/publication story, including transport and actual host visibility, cross-review with the counterpart, and use the normal Graphite and exact-identity deployment process. Ordinary release decisions belong to the leads; genuine trust, credential and irreversible external boundaries still apply. The implementation owner owns source, integrated checks and cleanup; stewards provide judgment, not an additional approval chain.

## Real handoff

The largest consumer agreed to a naturally occurring eligible handoff with the ordinary task outcome, actual action and permission commission, and the single orientation route, omitting only bespoke currentness facts. Role-needed facts may be carried by bulletin text or authoritative links, not necessarily five dedicated schema fields. Check correct facts and next action, orientation-only clarification, wrong assumptions and unnecessary interruptions; ordinary authority and task questions remain normal. There is no eligible uninformed handoff now: await the next real assignment rather than retrofitting one. Do not block consumer work or count installation, a skill announcement or a fabricated role as acceptance. Do not claim time or relay savings without comparable evidence.

After the first real observation, iterate before expanding into later activity, reactivation and semantic-topic measurements. This release is one complete product step, not completion of the broader mission, including running and late-session guidance and reduced manual relay.

## Moved into current docs

- [ ] Contract: interfaces and tool descriptions reflect accepted, implemented APIs.
- [ ] Rules: architecture owners describe shipped behaviour and limits.
- [ ] Agent guidance: the skill supports the actual orientation route.
- [ ] Platform claims: version-sensitive findings carry their observed basis.
- [ ] Procedure: deployment, recovery and real handoff are verified.
