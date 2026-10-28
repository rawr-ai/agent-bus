# Fluree

What agent-bus rests on in Fluree, observed on Fluree 4.2.4 on the bus host (the other machine reaches it through the tunnel and runs none). What agent-bus does with it (CORS off, the token, the 15 s poll, no fuel limit, regenerated queries) is in the [README](../../README.md#security) and [topology](../architecture/topology.md). Each claim is marked with its basis, as [platforms](README.md#how-claims-are-marked) defines. After upgrading Fluree, follow the installed version's docs (`fluree docs search`, `fluree docs get`) and run `bun run qualify:fluree`, which rechecks the claims it names below.

## The transaction server

- **One server orders the commits.** Every bus process writes to one transaction server over HTTP, and each `/insert` is one commit with its own `t` (inferred from the transaction model, and relied on by every cursor; `qualify:fluree` exercises it).
- **Restart and catch-up.** On a durable, file-backed server, a reader holding a `t` from before a restart reads every commit after it once the server is back (verified live, by `bun run qualify:fluree`).
- **Authentication.** With `--data-auth-mode required` and `--admin-auth-mode required`, the data and admin APIs refuse requests without the bearer token (documented, `operations/README.md`).
- **CORS is on by default,** allowing any origin, method and header, with no per-origin list (documented, `operations/configuration.md`).

## The event stream

- **`/v1/fluree/events?ledger=<name>`** is a server-sent event stream of nameservice changes: which ledger moved, and to which commit, never the committed data (documented, `operations/query-peers.md`).
- **Its authentication is separate** from the data API's (`--events-auth-mode`, default not required; documented). That the stream refuses a token with no subject, as the [README](../../README.md#security) records, is unverified here.
- **After a server restart,** a reader that was waiting is woken by the next commit (verified live end to end by `bun run qualify:fluree`, through agent-bus's reader, which also polls; the stream's own recovery isn't isolated).

## Full-text search

- **The ledger's config graph enables inline full-text scoring** on chosen properties, for `f:fulltext` in SPARQL (documented, `indexing-and-search/README.md`).
- **The config applies at the ledger's first index,** so for about a second after a ledger is created, text search finds nothing or fails (unverified: recorded in the [README](../../README.md#ledger-model) without how it was seen; `qualify:fluree` doesn't recheck it).
- **Across the index boundary,** search finds both indexed commits and fresh, unindexed ones, and the same results once the index catches up (verified live, by `bun run qualify:fluree`).

## Query limits

- **Agent JSON** (`application/vnd.fluree.agent+json`) is a compact result that Fluree truncates to a byte budget (documented, `ai/mcp-server.md`).
- **A fuel limit switches on fuel tracking,** which replaces Agent JSON with an unbudgeted SPARQL JSON result (observed in 4.2.4 and recorded in `src/Fluree.ts`; fuel behaviour is documented in `query/tracking-and-fuel.md`).
- **Comments in a SPARQL query can carry request options** (`# PRAGMA`) (documented, `query/sparql.md`).
