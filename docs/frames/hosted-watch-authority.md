# Explicit hosted watch authority

The prepared-watch release separates notification authority from ordinary conversation identity. Current contracts belong to [interfaces](../architecture/interfaces.md#hosted-events), trust rules to [connections](../architecture/connections.md#rules), and operator steps to [deploy](../runbooks/deploy.md#when-a-hosted-peer-is-connected).

## Objective and decision

The objective is an idle intended conversation waking, reading its own fresh mail and sending a nonce-linked reply without another prompt. Catalogue discovery, accepted subscription and callback receipt are intermediate evidence, not that outcome.

A valid `params._meta` carrier is preserved by the selected host, but conversation correlation is not promised for Events by the client documentation. Use explicit owner-minted watch authority through documented Events arguments, rather than infer a native owner from an account, address, cached tool invocation or absent metadata. Ordinary read, publish, join and takeover retain their existing conversation identity.

One hosted preparation tool proves current account/resource grant, normal tool correlation and fresh native ownership. It persists a random 16-byte opaque handle scoped to the principal, resource, event and full native binding. One address has one row; unchanged preparation and restart return identical bytes. Subscription requires `{address,ticket}` and fresh expected-binding observation. Usable contradictory metadata refuses; metadata never replaces the ticket. Notifications remain `{address}` only.

The private map uses embedded Bun SQLite without another service, dependency or cryptographic construction. Its connection owns exclusive process access independently of the shared host's Events store: host shutdown joins authored tool work but closes its Events resources concurrently. A serialized preparation reads a revision, awaits observation outside a transaction, then compares and commits synchronously. New tickets are returned only after durable commit. Shutdown refuses queued work and joins the actual writer before closing.

Provisioning is explicit and exclusive. Runtime refuses missing, zero-byte, corrupt, incompatible or oversized state, with no reset, truncation or eviction. Strict schemas, private modes, file identity, bounded rows/bytes/pages and DELETE-journal recovery constrain the state. Restored stale claims cannot adopt a successor holding. Rollback to an otherwise identical valid holding remains undetectable.

## Lifetime and limits

The ticket has no clock. Finite host leases, native authorization, current grants, exact holdings and callback authority remain independent checks. Refresh preserves exact arguments and uses the actual returned `refreshBefore`. A new native run requires fresh owner preparation. Tickets do not detect client reboot or retire orphaned holdings.

Existing account-authorized unsubscribe stops one deterministic subscription. There is no new stop tool or global revocation feature. Removing a map row affects subsequent setup/refresh, not an already accepted scope's immediate delivery authority. A same-account conversation given a ticket can receive address-only notices, never inbox reading rights. Different callback URLs remain different subscriptions.

Rejected alternatives were account-wide owner lookup, metadata fallback, finite reminting that churns subscription arguments, bespoke sealing and lockfile/heartbeat recovery solely to preserve a JSON format. The selected store is a bounded private file, not a generic permission or subscription framework. The shared host still owns protocol, encrypted subscription/pending state, verification, capture CAS and delivery retries; native Bus remains unchanged.

## Qualification

The implementation uses independent file/process/queue controls, real native ownership checks and the existing released-host HTTP/relocated/Events fixtures. The disposable fixtures passed with actual production preparation, metadata-free subscription, stable refresh/restart, address-only payload and secret exclusion. Ordinary two-principal tools and account-only unsubscribe remained covered. The relocated bundle also executed the literal exclusive initialization procedure and refused a repeated attempt without changing state. A supervised owner retained the actual connection through shutdown; process liveness alone was rejected as an ownership oracle. The mandatory full source check and exact committed-bundle attribution remain separate receipts; none of these establishes an actual-client wake outcome.

Power-loss guarantees, other-user filesystem ownership and rollback to an identical holding are not established by unit tests. The single preparation queue deliberately waits for actual observation settlement, even if an observation ignores cancellation; that can delay other accounts and shutdown rather than release ownership around a possible writer. The actual-client procedure remains separate: preparation, identical-argument refresh, idle nonce, rightful own-inbox read, linked reply and exact-watch cleanup.

## Moved into current docs

| Facet | Owner |
| --- | --- |
| Contract and tool | [Hosted Events](../architecture/interfaces.md#hosted-events), `src/private-web/events.ts` |
| Rule | [Connections rule 17](../architecture/connections.md#rules) |
| Agent guidance | [Hosted runtimes](../../plugin/skills/agent-bus/references/runtimes.md#hosted-chatgpt) |
| Platform claim | [Optional Events](../platforms/mcp-openapi.md#optional-events) |
| Procedure | [Hosted deployment](../runbooks/deploy.md#when-a-hosted-peer-is-connected), [qualification](../runbooks/qualify-private-peer.md) |
