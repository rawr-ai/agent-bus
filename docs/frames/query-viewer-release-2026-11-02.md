# Query and viewer release qualification

This dated record distinguishes deployment, controlled checks, native client usability, real viewer reading and customer acceptance. Current procedures are in [deploy](../runbooks/deploy.md), [upgrade](../runbooks/upgrade.md) and [viewer](../runbooks/viewer.md); query and viewer contracts are in [interfaces](../architecture/interfaces.md).

## Activation

On 2026-11-02, PRs 15, 17, 18 and 16 merged as the reviewed unit. Both hosts activated commit `0b1fe6e090914b4b8cfc3028b18019314f29041e`, tree `41a62db6bc7addeae8336fa9403993705ac7cd3c`, in clean detached primaries. The pinned Bun 1.4.4 and Effect 4.1.2 cohort remained unchanged; only `serve` was restarted for source activation. Fluree, configuration and credentials were preserved. An existing tunnel was separately reconnected with owner approval for pre-existing latency, without a network configuration change.

## Evidence and limits

- Both installed endpoints passed the runbook SDK check: a pinned SELECT answered at its requested commit and a `SERVICE` query was refused. Controlled delivery, topic, cursor, compact-hook and projection checks passed; owned addresses were left. These controlled checks are not a real idle session wake.
- Native plugin refresh on both hosts produced complete Codex and Claude copies byte-equal to deployed source. Claude Code was 2.1.310 and 2.1.311 respectively; both installed Claude plugin copies named commit `0b1fe6e09091`. A fresh native Codex child directly listed the seven-operation, version 1 catalogue and ran a peers query at limit 1, preserving `complete: false` at `t=3000`. This does not refresh an already-loaded parent's schemas.
- An owned native Claude session on one host joined and drained, finished its initial turn, then received an operator nonce only after idle. Its `Stop` `asyncRewake` exited 2; the session read the nonce unsolicited in 2823 ms, left, and exited successfully. The other host's owned fresh session terminated before join, idle or publish because a standalone-session prerequisite was unmet. Its real wake is unverified, not a product failure or a pass. Owned probe resources were verified absent; no conclusion is drawn about other sessions.
- The first compiled viewer was started in a user-facing terminal, listening on loopback and using the existing local bus. Its main artifact SHA-256 was `d7a54935a1c765d5ca6a4b552e03e39d84bf1d73cb49dd10ff5bc14d6059e971`; its manifest SHA-256 was `92171ab4744277d74ddea926184852c675e817a29f347291bfdaf0ac5f87b428`. A native browser live check passed in 7734 ms, reading nonempty history and context, full Source and literal audiences, switching theme, and independently observing 23 peers. This is actual UI reading, not a synthetic browser test or evidence of adoption.
- Real customer acceptance remains pending: the same whole fixed-cut reconstruction was requested for retrieval and interpretation, but no outcome is recorded. Deployment, native usability and UI reading do not establish adoption. No orientation, bulletin or activity implementation or adoption is claimed here.

## Moved into current docs

- [x] Contract: existing [interfaces](../architecture/interfaces.md) describes the released query and viewer surfaces; no contract change in this record.
- [x] Rule: existing [connections](../architecture/connections.md) and [viewer](../architecture/viewer.md) own the released rules; no rule change in this record.
- [x] Agent guidance: the installed skill was refreshed; existing [query guidance](../../plugin/skills/agent-bus/references/queries.md) owns its use.
- [x] Platform: the native client observations and their recheck triggers are in [Codex](../platforms/codex.md), [Claude Code](../platforms/claude-code.md) and the [findings register](../platforms/README.md).
- [x] Procedure: installed query verification, plugin refresh and first-start viewer observations are in [deploy](../runbooks/deploy.md), [upgrade](../runbooks/upgrade.md) and [viewer](../runbooks/viewer.md).
