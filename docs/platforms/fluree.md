# Fluree

What agent-bus rests on in Fluree, observed on Fluree 4.2.4 on the bus host (the other machine reaches it through the tunnel and runs none). What agent-bus does with it (CORS off, the token, the 15 s poll, no fuel limit, regenerated queries) is in [connections](../architecture/connections.md) and [topology](../architecture/topology.md). Each claim is marked with its basis, as [platforms](README.md#how-claims-are-marked) defines. After upgrading Fluree, follow the installed version's docs (`fluree docs search`, `fluree docs get`) and run `bun run qualify:fluree`, which rechecks the claims it names below.

## The transaction server

- **One server orders the commits.** Every bus process writes to one transaction server over HTTP, and each `/insert` is one commit with its own `t` (inferred from the transaction model, and relied on by every cursor; `qualify:fluree` exercises it).
- **Restart and catch-up.** On a durable, file-backed server, a reader holding a `t` from before a restart reads every commit after it once the server is back (verified live, by `bun run qualify:fluree`).
- **Authentication.** With `--data-auth-mode required` and `--admin-auth-mode required`, the data and admin APIs refuse requests without the bearer token (documented, `operations/README.md`).
- **CORS is on by default,** allowing any origin, method and header, with no per-origin list (documented, `operations/configuration.md`).
- **Turning CORS off doesn't stop a cross-origin write.** A page can send a "simple" POST (`Content-Type: text/plain`) with no preflight, and the server runs it whatever its CORS setting. On a throwaway server started with `--cors-enabled=false` and no authentication, such a POST with a foreign `Origin` to `/insert` returned 200 and committed `t=1`; with `--data-auth-mode required` the same request got 401 "Bearer token required" (verified live, Fluree 4.2.4, 2026-10-28; recorded earlier in repo memory). The token is therefore the control, and CORS only keeps a page from reading the answer.

## The event stream

- **`/v1/fluree/events?ledger=<name>`** is a server-sent event stream of nameservice changes: which ledger moved, and to which commit, never the committed data (documented, `operations/query-peers.md`).
- **Its authentication is separate** from the data API's (`--events-auth-mode`, default not required; documented, `operations/query-peers.md`). agent-bus leaves it at the default, so the stream is open.
- **A token with no subject is refused on the stream when its authentication is required,** and a token with a subject is accepted there (verified live, Fluree 4.2.4, 2026-10-28, on a throwaway server started with `--events-auth-mode required`: the subject-less token got 401 "identity required but not present (sub or fluree.identity)", the same token with `--subject` got 200). The Fluree docs don't state the rule.
- **A token with a subject is held to identity policies,** which deny writes on a ledger that has none: the subject token's `/insert` got 403 "Policy enforcement prevents modification", where the subject-less token's succeeded (verified live, same server and date; recorded earlier in repo memory). This is why the bus's token has no subject, and why it can't be used on a stream that requires events auth.
- **After a server restart,** a reader that was waiting is woken by the next commit (verified live end to end by `bun run qualify:fluree`, through agent-bus's reader, which also polls; the stream's own recovery isn't isolated).

## Full-text search

- **The ledger's config graph enables inline full-text scoring** on chosen properties, for `f:fulltext` in SPARQL (documented, `indexing-and-search/README.md`).
- **The config applies when the ledger is first indexed,** so until then text search finds nothing. The docs say new commits pick the config up "during the next incremental index build" (documented, `indexing-and-search/fulltext.md`). Observed (verified live, Fluree 4.2.4, 2026-10-28, throwaway server, config written before the first message): a search made right after the first insert returned no rows and no error, and the message was found about 0.25 s later in each of six trials, once the first index had run. With indexing held back (`--reindex-min-bytes 1000000000`) a new ledger's search stayed empty for the 3.7 s watched, with `index-t` at 0. So the delay is the time to the first index, which depends on the server's indexing settings; it was about a quarter of a second on a default server, not the "about a second" once recorded, and a failure (as opposed to an empty result) was not seen. `qualify:fluree` doesn't recheck this case.
- **After the first index,** a new commit is searchable at once (verified live, same server: a third message was found by a search made straight after its insert).
- **Across the index boundary,** search finds both indexed commits and fresh, unindexed ones, and the same results once the index catches up (verified live, by `bun run qualify:fluree`).

## Query limits

- **Agent JSON** (`application/vnd.fluree.agent+json`) is a compact result that Fluree truncates to a byte budget (documented, `ai/mcp-server.md`).
- **A fuel limit switches on fuel tracking,** which replaces Agent JSON with an unbudgeted SPARQL JSON result (observed in 4.2.4 and recorded in `src/Fluree.ts`; fuel behaviour is documented in `query/tracking-and-fuel.md`).
- **Comments in a SPARQL query can carry request options** (`# PRAGMA`) (documented, `query/sparql.md`).
