# Compact Recovery

This frame records the read-only ownership/context recovery vertical and its qualification boundary. Current contracts live in [interfaces](../architecture/interfaces.md), rules in [delivery](../architecture/delivery.md), and provider evidence in [Codex](../platforms/codex.md#hooks) and [Claude Code](../platforms/claude-code.md#hooks).

## Intent and Boundary

Compaction loses remembered joins without ending bus ownership. Restore knowledge from authoritative latest joined holdings, then route to current guidance; do not rejoin, read mail or infer role assignment from every address sharing a session id.

The chosen surface is one read-only MCP ownership lookup over existing `Bus.peers`, reached by one shared synchronous compact helper. Native payload identity is normative; model guidance names its own runtime session variable without printing the value. No registry, transcript scan, observer, polling, new HTTP route or public peer projection was added. Existing Claude async compact wake behavior remains separate.

## Decisions

- Match exact session and runtime against complete latest joined holdings. Valid no-holdings is empty success; invalid identity and storage failure refuse.
- Emit fixed instructions plus JSON-quoted whole holdings and absolute cwd, or emit nothing. Do not inject bulletin bodies, notes or failure diagnostics.
- Keep one finite deadline over stdin and MCP connection/discovery/call, with interruption and resource finalization, no retries or late output.
- Preserve assigned-inbox boundaries and normal ownership refusals. Session holdings are not evidence that the current agent should read every inbox.
- Use separate explicit native manifests while preserving Claude's existing async wake commands. Do not override native context limits to accommodate oversized output.

The rejected alternative was reconstructing ownership from a transcript/registry or using `bus_wake` as a probe: the former creates a second authority, and the latter intentionally changes wake state.

## Evidence and Remaining Gates

The Codex carrier was qualified in native interactive 0.166.0-alpha.6 with normal settings and exact hook trust. Claude's carrier was qualified in native interactive 2.1.311 with restricted settings/MCP sources and a disposable plugin, so ordinary shipped-hook composition was not established. Both manual-compact controls withheld a marker before compact and exposed it through hook context afterward without tools. These are carrier qualifications, not bus recovery or adoption.

Candidate checks cover exact lifecycle holdings, same-session other-runtime separation, storage damage, addresses-only official MCP outputs and annotations, durable/ephemeral noninterference, native payload validation, complete UTF-8 output budgeting, cancellation/finalization, and actual manifest command/runtime binding. Integrated results are recorded by the release owner.

Installed qualification is deliberately after normal reviewed Mini-first activation, not a process-scoped candidate launcher/server detour. It must retain normal settings, exact Codex hook trust and Claude's shipped async composition; recover only the assigned address, avoid rejoining, and retrieve actual current guidance through non-consuming orientation. Pro follows only after Mini passes. Preserve rollback cohorts and exact trust-change provenance. Until that gate passes the release is incomplete. Ordinary-team adoption requires real ordinary use and is not established by a disposable trial.

## Falsifier

Revisit the carrier boundary if a normally installed trusted hook cannot receive native identity/cwd or deliver complete fixed context, or if the ownership observation mutates lifecycle state or hides an incomplete read. Do not patch around those failures with transcript scans, wake probes or another ownership registry.

## Moved into Current Docs

- [x] Contract: ownership tool, compact CLI and annotations in interfaces.
- [x] Rules: read-only compact recovery and unchanged async wake baseline in delivery.
- [x] Agent guidance: assigned-address recovery and current-guidance lookup in the skill.
- [x] Platform claims: versioned native carrier evidence and findings with explicit limits.
- [x] Procedure: plugin ordering, exact trust and post-activation qualification in install.
