# Stable native delivery across network changes

This frame covers where native wake eligibility comes from, how existing addresses move to it, and how to distinguish retained mail from successful native delivery. It does not change ownership, delivery transports, or deployment approval.

## Evidence

The serving process's OS hostname changed with the network while its local runtime queues, hooks and cursors stayed put. The latest joins retained the earlier names. Codex compares against the hostname captured at process start, except for a Codex-only `--host` override; Claude and new origins use the live hostname. Removing DNS suffixes and case does not reconcile distinct names. Direct mail still reached the ledger; an owner's explicit read from its native client succeeded without a native wake. This is a locality selection failure, not lost mail.

A cursor file holds only a position for an address and ledger incarnation. Its presence does not prove that the latest join was made here; neither does finding a thread with that id locally. Renaming, active state, a matching short name, or app inventory cannot adopt a join.

## Decision

Use one random installation ID persisted in `AGENT_BUS_DIR/installation-id`, not ambient hostname aliases, an administrator's unique-name convention, or hardware identity. The same directory can have existing cursor files on first upgrade, so a missing identity is not proof of a fresh installation. `serve` refuses to start when the file is missing, unreadable or invalid; it does not fall back to a hostname or create a replacement. An explicit `agent-bus initialize-installation` writes a complete file without overwriting an existing identity. The fresh full installer calls it before first writing `config.json`; a directory with retained cursor state and neither file is refused. Upgrading an existing installation requires an explicit initialization before first starting the new `serve`. Normal restart reuses the identity without writing a join. Do not share or clone the file between installations.

The optional internal `Presence.installation` field records this value for joins. Keep `origin.host` descriptive for joins, messages, and designation notifications; it is not a routing key. The field lives only in the encoded `bus:json`, not a new graph predicate or tool output. Apply one exact locality rule for both native paths, and apply it and the runtime eligibility rule again to the latest join observed under the local address lock before scanning or advancing a delivery cursor, posting a nudge, or retracting one. This does not fence changes another `serve` commits after that read or Codex's post-lock borrow. Retire the Codex-only `serve --host` flag; installed launch scripts do not use it. Preserve history and ledger incarnation; never edit an old presence in place.

## Rollout and rollback

Use one normal same-owner renewal on the existing machine per live legacy native address, provided its local cursor still exists. It continues the run and preserves the unread position; an owner can still read before renewing. Do not use leave, replay, or takeover. The caller omits topics and associations to keep them and supplies its normal runtime identity, working directory, and Codex thread id where applicable. No automatic adoption based on observed hostname or runtime inventory. An exact operator-attested join list is possible, but requires additional attribution, enrollment, and retirement machinery for a one-time transition.

Coordinate an upgrade of all serves sharing the ledger. Old serves ignore the new field and still select by descriptive hostname; new serves cannot natively wake old hostname-only joins. Do not assume wake safety or availability with mixed versions. Notify live owners before the change, or use their native client to prompt the one-time renewal after it. Use an owner prompt for dormant addresses only when they need waking again. Verify real native wakes after renewal. No identities or session claims belong in the instructions or in logs.

The old binary can still read the ledger and its local cursor after rollback; rollback restores the old mutable-host routing and may need an ordinary owner renewal on the old binary. Old native wake is separate from verified old reads. Keep the installation file with the same installation's state so a later upgrade reuses it. Restore a missing or corrupt file from this installation's backup. Only if that identity is irretrievably lost may the operator explicitly initialize a new identity and repeat owner renewal, not a replay or adoption from another machine's state.

## Qualification

1. **Routing and unread position.** `test/stable-native-delivery.test.ts` uses real Bus layers and cursor files against one disposable JSONL ledger, synthetic changes to the descriptive hostname, and a restart. It asserts the exact Codex queue target, the Claude wake address, untouched delivery cursors, and exact owner reads without rejoin. Colliding names, legacy joins, and deterministic stale discovery followed by a foreign latest join do not cause cursor access or native work. Disabling the lock-held locality check makes both stale-discovery cases fail; replacing installation equality with short-hostname matching makes all four tests fail. Existing Codex tests exercise borrowing after queuing separately.
2. **Initialization.** `test/installation.test.ts` uses the actual CLI and filesystem for missing and invalid state, distinct IDs, concurrent creation and repeat initialization. Installer fixtures cover fresh, interrupted and existing-config installs, retained cursors without config or identity, and the unchanged runtime-only route.
3. **Actual previous source and Fluree.** On 2026-11-08, archived the deployed source at `dea3616`, used its frozen dependencies, and ran previous, candidate, restarted candidate, then previous `serve` on the same disposable ledger and state directory (Bun 1.4.4, Fluree 4.2.4). The official MCP client confirmed that a legacy join did not wake until its own session renewed, with its nonzero cursor and subscription intact. It then got a wake and read exactly the retained message. The restarted candidate woke the same owner without another join. The public roster retained the hostname without the installation claim, and the previous server decoded the candidate presence and read the exact candidate mail plus old and new history after rollback.
4. **Activation gate.** None of these checks was a real Codex turn or Claude hook wake. Qualify both on the installed cohort before calling the rollout successful. Simultaneous mixed-version delivery is not qualified. This frame does not authorize production activation.

## Moved into current docs

- [x] Contract: [interfaces](../architecture/interfaces.md) and the `bus_wake` description.
- [x] Rule: [delivery](../architecture/delivery.md) and [topology](../architecture/topology.md).
- [x] Agent guidance: [runtime reference](../../plugin/skills/agent-bus/references/runtimes.md).
- [x] Platform claims: no new platform behavior claimed; installed native wake remains an activation check.
- [x] Procedure: [deploy](../runbooks/deploy.md) and [recover](../runbooks/recover.md).
