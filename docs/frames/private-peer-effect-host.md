# Private Peer Effect Host

Nonproduction consumer adoption and qualification of the selected modern-only
host candidate. Current platform evidence is in [the direct host page](../platforms/mcp-openapi.md),
and operator steps are in [private-peer qualification](../runbooks/qualify-private-peer.md).
This frame does not select an installed binding or expand hosted access.

## Decision

Use one exact producer archive for the private consumer. Its required runtime
belongs inside the isolated host module, not the native Bus dependency graph or
an ambient application installation. Keep the existing three-file private
artifact: bundled peer, separately rebundled host and checksum manifest.

The builder verifies the approved archive and installed raw entry, resolves the
host-relative runtime, refuses a different version or escaping bare runtime
import, and bundles that closure. The review manifest separately records the
raw producer entry and transformed host checksum. It does not attest an otherwise
dirty working-tree source; committed-source attribution remains an operator
receipt. Native runtime pins and production state are unchanged.

The selected host's modern contract is intentional. Existing legacy SDK
initialization is not a supported new-host client and is not hidden behind a
fallback. A small qualification-only raw HTTP helper sends modern discovery,
protocol/client metadata and authored per-call metadata, asserts response ID,
complete-result and server-info metadata, then checks the independent carrier.
Synthetic OAuth reuses its existing public authorization helper without legacy
MCP transport bootstrap. No public client framework or runtime upgrade is added.

## Qualification

The exact archive and runtime identities are recorded in the platform page.
The ordinary HTTP qualifier checks actual resolver and handler metadata under
distinct, omitted, empty and deliberately overlapping correlations. Reversed
completion must retain the correct correlation, marker and actor session in
both observations. Grant revocation reuses a previously authorized correlation
and requires a fresh identity and grant check. Foreign read preserves mail for
its rightful reader; large complete results, pre-identity body refusal, hidden
argument rejection before execution and one stored publication after an injected
post-commit response loss remain checked.

The relocation qualifier copies only the artifact away from source and all
`node_modules` ancestors. Its actual entry starts under a fresh home/minimal
environment. Omitted/disabled/enabled diagnostics, explicit disposable watch
initialization and refusal to reinitialize remain separate checks. Its modern
two-principal fixture exercises ordinary tools and direct production Events
callbacks, not public Events transport.

The full Events qualifier supplies that distinct public bridge: synthetic native
OAuth, actual preparation, metadata-free ticket subscription, contradictory and
foreign refusal, signed address-only callback, rightful read, account unsubscribe
after grant loss, native expiry and fresh authorization. Restart restores the
exact 120-ID checkpoint, exceeding four KiB, after the old host has joined.
All three qualifiers passed on the selected runtime cohort with disposable
services and supervised children. The mandatory full source check and committed
native-package independence remain separate from these fixture results.

## Limits And Deployment

The helper qualifies the JSON-response path, not general SSE-client behavior.
Tools-only cold startup does not independently inspect an authenticated disabled
catalogue; omission also rests on unchanged service conditionals. Synthetic
provider proof and fixture DNS/TLS redirection are not real provider or public
callback evidence. These checks do not establish a saved client's modern
discovery support, automatic Work invocation ownership, renewal or compaction.

Current-state code recovery, actual saved-client exchange, any temporary Work
observation and exact cleanup need a separately admitted consumer interval under
[deployment](../runbooks/deploy.md#when-a-hosted-peer-is-connected). Preserve the
existing grants, keys, resources, OAuth/watch state, native servers and tunnels.
No state initialization, snapshot rewind, new public route or activation is
part of this source qualification. A successful successor cannot retrospectively
explain an earlier client identity incident.

## Moved into current docs

| Facet | Owner |
| --- | --- |
| Contract and tool | [Hosted interfaces](../architecture/interfaces.md#hosted-events); native tool and authority contracts unchanged |
| Rule | [Connections](../architecture/connections.md#rules); no new ownership or exposure policy |
| Agent guidance | [Hosted runtimes](../../plugin/skills/agent-bus/references/runtimes.md#hosted-chatgpt); no new client or wake guarantee |
| Platform claim | [Direct host](../platforms/mcp-openapi.md#direct-host-and-http-admission) and findings register |
| Procedure | [Qualification](../runbooks/qualify-private-peer.md); build and transport changes are explicit |
