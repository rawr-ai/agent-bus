# Mailbox transition retirement

2026-11-26. Source design and disposable qualification scope for [issue #129](https://github.com/rawr-ai/agent-bus/issues/129); this frame does not authorize installation changes or record a live rollout.

## Decision

The paired file-to-ledger import was already reconciled and verified on both original installations. The successor should no longer interpret a cursor directory, fence or paired permit on every start. It must not weaken admission or run the import again. The prior release's source and results remain evidence, not live mailbox state.

Use an immutable per-installation serving binding to the configured target, installation UUID, genesis CID, unique active ownership era and an exact commit at or beyond the verified import. The one-time handoff verifies both original admissions with the exact retained verifier, checks the same later history on both sides, and publishes binding records before successor activation. It does not write the ledger. An already completed native bootstrap still has its exact verified incarnation; a newly provisioned attachment requires an independently chosen pin. A new, targeted reservation alone permits one real create-if-absent on proven absence.

Rejected: trust a recognized ownership-era value or the absence of old files as admission; silently attach a new installation to a matching alias; copy the earlier file positions again; or maintain a second high-water file advanced on every write. The serving anchor rejects wrong history but is not a claim about freshness after the anchor. Deliberate restore separately compares the last independently known cut and mailbox evidence before releasing the hold.

The old executable is not made safe by deleting its files. Archive the complete predecessor state and keep its authentic `layout` manifest and `.export-pending` sentinel at their exact old paths until Release Operations proves that predecessor cannot reach the live ledger as a writer. This exercises the predecessor's intentional fence rather than relying on damage to its layout. The successor reads neither file. The later origin-receipt retry contract is unchanged: a manual legacy read after an ACK still proves the original import against ledger history before authorizing that source installation.

## Qualification

Exercise the migrated binding without old files, ordinary restarts and update, protected restores including a stale descendant, explicit fresh attach or create with lost outcomes, and actual predecessor refusal. Seed synthetic legacy facts instead of rerunning the production-sized import. Keep executable verification separate from release activation and real-client witnesses.

## Moved into current docs

- Contract: [CLI and state](../architecture/interfaces.md#configuration-and-environment).
- Rule: [topology](../architecture/topology.md#rules) and the unchanged [mailbox rules](../architecture/messaging.md#rules).
- Agent guidance: no tool or skill behavior change.
- Platform claims: no new provider behavior claim; the same pinned native commit and ownership-era reads are used.
- Procedures: [install](../runbooks/install.md), [deploy](../runbooks/deploy.md), [recover](../runbooks/recover.md) and [provider copies](../runbooks/recover-provider-copy.md).
