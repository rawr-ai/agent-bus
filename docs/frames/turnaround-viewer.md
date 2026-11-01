# Frame: one evidence model for agents and the viewer

This candidate frame covers the viewer's move onto shared query definitions in the [turnaround](coordination-turnaround.md). The existing [viewer release](agent-bus-viewer-release.md) and [architecture](../architecture/viewer.md) describe the separately owned implementation and its present bounded observations.

Status: proposed query-integration feature, not deployment approval. DRA: Claude lead, cross-reviewed by Codex. Mode: co-framing; object: solution. Query and viewer integration are the proposed first release unit, not an interim bounded-reader deployment to manufacture a baseline.

## What and why

The viewer should inspect the same complete, ordered and snapshot-labelled coordination evidence that agents query. Its own history/peers implementation must not become a second definition of threads, counts or current membership.

In are saved-query integration, complete thread/history investigation, useful counts, paging, currentness and accessible reading states. Foreground the real preview-delivery reconstruction and orientation job. Exterior are message sending, silent merging of incompatible snapshots, a separate ledger connection and unrelated visual redesign.

The alternative is retaining bounded observations and improving their labels. That remains truthful but cannot satisfy the owner's explicit query-based viewer direction or a complete-history job. Reuse the accepted query definitions rather than inventing viewer-only SPARQL.

## Hard core and assumptions

1. Viewer reads are read-only and use the bus contract; no inbox consumption or parallel store path.
2. Snapshot, pagination, incomplete results and separately changing current state are visible and correctly labelled.
3. Refresh does not silently replace or misidentify the evidence being read, and interaction state remains accessible.

Assume query restoration supplies the required operations. Existing review fixes keep their current owner and can be reviewed independently; this frame does not duplicate their work or treat merge as deploy. Exact controls and migration mechanics follow the accepted query contract.

## Adoption and falsifier

Record how the real consumer answers the fixed evidence question through the actual live installation, including missing/truncated context and briefing steps. Record that installation's exact deployed revision in the private acceptance record. If no viewer is available there, record unavailable as the baseline; do not substitute undeployed development trunk. Identify the installation and exact candidate later qualified and activated. After query integration and approved deploy, a real participant completes the same investigation from the shared snapshot without an agent-only export. Qualify the actual McpServer, component states and rendered journeys. If the viewer and agent answer from different evidence or the reader still needs a private export, this integration is not accepted.

## Moved into current docs

- [ ] Viewer query contract and validated arguments.
- [ ] Shared evidence/currentness architecture rules.
- [ ] Relevant agent/viewer guidance.
- [ ] Updated platform claims only where observed.
- [ ] Viewer deployment, verification and use procedure.
