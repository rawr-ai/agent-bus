# Design: read-only bus queries

2026-11-01, revised 2026-11-02 after cross-review. This note covers the query vertical of the coordination turnaround: the tool surface, the snapshot and continuation contract, the first saved-query catalogue, the raw SPARQL boundary, limits, tests, what the query refusal retires, and how the viewer moves onto the same definitions. Current behaviour stays in [interfaces](../architecture/interfaces.md), [connections](../architecture/connections.md), [Fluree](../platforms/fluree.md) and [viewer](../architecture/viewer.md) until the implementation lands.

Status: the cross-review accepted the three-tool split and a JSONL test store that refuses queries, and selected the revisions below. The implementation on this branch follows the note as revised during it ([implementation revisions](#implementation-revisions)); current behaviour is now in [interfaces](../architecture/interfaces.md#bus_run_query) and [connections](../architecture/connections.md#rules). Every Fluree claim carries its basis: **verified live** (a disposable Fluree 4.2.4 server with synthetic ledgers, 2026-11-01 and 2026-11-02), **documented** (the installed 4.2.4 CLI's embedded docs, page and anchor named) or **read in code** (this repository, or the local archive MCP server used as prior art). The [evidence register](#evidence-register) lists them together.

## Decisions at a glance

| Question | Decision |
| --- | --- |
| Tools | `bus_query` (raw read-only SPARQL SELECT, existing `query`/`t` schema), `bus_run_query` (`name`, `args`, `t?`, `cursor?`), `bus_queries` (catalogue). `bus_history` and `bus_peers` stay as convenience presets over the same catalogue definitions. |
| Snapshot | Pin first: one commit `t` and one ledger incarnation per traversal, chosen before any name or input is resolved. Every query is sent to `POST /v1/fluree/query/{ledger}@t:{t}`; the caller's query is never rewritten to add `FROM`. |
| Population | The records visible at the pinned cut (current assertions at `t`), never a `FROM … TO` history range, which can include later-retracted assertions. Entries are ordered by commit `t`, unique per entry. |
| Identity | Results and cursors carry the ledger incarnation (the id of its first commit, as `Ledger.instance` already uses) beside `t`. An alias plus `t` alone can name a different ledger after replacement; a changed incarnation is an explicit error. |
| Damage | Candidate entries are found by `@type` and `bus:id` before `bus:json` is required, so a missing `bus:json` is counted like one that fails to decode. Traversal advances past damaged candidates. |
| Exhaustion versus completeness | `next` absent means the relation is exhausted at `t`. `complete` additionally requires that no damaged candidate was met anywhere in the traversal, carried in the cursor. An exhausted but incomplete last page is representable. |
| Raw SPARQL | SELECT only. Rows are bindings, not messages. No dataset clause, no `GRAPH`, no `SERVICE`; text regenerated from the parse tree. A server row cap of 500 with a sentinel row, distinct from a `LIMIT` the caller wrote. Our parser's messages pass through; Fluree's error text does not. |
| Limits | One fixed 64 KiB envelope per `bus_run_query` and `bus_query` result, applied on top of Fluree's own sizing; whole rows are trimmed and the position advances by emitted rows; one row that cannot fit fails explicitly. |
| Catalogue | One code-owned definition per operation holds its metadata, argument schema, row schema and execution; the listing, validation and dispatch derive from it, and tests assert they agree. One catalogue version. |
| Stores | A separate `QueryGateway` service exists only for Fluree. The JSONL test ledger keeps presence, ownership and delivery, and refuses queries explicitly. Query-dependent tests run on the throwaway real Fluree server; a missing `fluree` binary fails the check. |
| Viewer | Reads through `bus_run_query`; window bounds and retained units carry their snapshot `t`; it keeps upstream incompleteness and its own projection omissions apart. |

## Tool surface

- **`bus_query`** is raw read-only SPARQL. Its existing input schema (`query: string`, `t?: integer`) and read-only annotation already fit, so cached tool lists and approval settings keep working; the description and success schema change.
- **`bus_run_query`** runs one catalogue operation: `name` (enum), `args` (object, validated server-side against that operation's closed schema), `t?`, `cursor?`. With a cursor the caller resends the same `name` and `args`; the cursor's hash must match them.
- **`bus_queries`** lists the catalogue: catalogue version, the ledger incarnation and head `t`, and per operation its name, purpose, unit, paging mode, argument JSON Schema with defaults, row JSON Schema, completeness note and one executable example. Orientation reads the same listing function.
- **Presets.** `bus_history` and `bus_peers` keep their input and output schemas and their meaning, so they are built on catalogue modes that carry that meaning, not on a naive forward read:
  - `bus_history` without `query` is the newest window: `history` with `direction: "backward"` (newest first) at one `t`, paged until `limit` messages, then shown newest last. `limit: 1` is the newest message.
  - `bus_history` with `query` is relevance-ranked full text: `search` at one `t`, paged until `limit` matches, then shown newest last, as today.
  - `bus_peers` is `peers` at head, all pages.

  The presets are real convenience presets: one catalogue definition per relation, no second execution path. They keep their historical output, with no envelope or byte cap (their existing contracts), and they stay; retiring them would be a later decision.

All three new tools carry the `Lookup` annotations (read-only, not destructive, closed world) and take no `session`. They and the presets share one server-wide pool of 4 concurrent query operations.

## Snapshot, identity and continuation

### Pinning

1. **Pin.** Read head (`GET /info/{ledger}`) and the incarnation (`GET /show/{ledger}?commit=t:1`). With a cursor, its incarnation must equal the current one, and its `t` must not exceed head. Otherwise `t` is the explicit `t` or head; an explicit `t` outside `1..head` fails before any query: the server would wait for a future `t` and answer 408 after its 5 s min-t timeout, and reads `@t:0` as an empty ledger (both verified live). An explicit `t` that differs from the cursor's fails.
2. **Resolve at the pin.** Inputs that name records (a thread's message id, a list of ids) are resolved by queries pinned at `t`, after step 1, so an append during resolution cannot change what they resolve to.
3. **Query.** Every query goes to `POST /v1/fluree/query/{ledger}@t:{t}`. A path pin reads the ledger as of that commit (documented, `concepts/time-travel.md#pinning-the-ledger-in-the-request-path`; verified live: a count at `@t:4` returned 4 entries on a 7-commit ledger). Catalogue queries never use `from`/`to` history ranges, so the population is what is visible at the cut.
4. **Check.** Read head and incarnation again. A changed incarnation fails the call; a head past `t` is reported as `currentHeadT`.

### Result envelope

```ts
{
  name: "history",              // operation, or "sparql" for bus_query
  catalogueVersion: 1,
  ledger: "fluree:commit:…",    // incarnation: the id of the ledger's first commit
  t: 1234,                      // the snapshot every row was read at
  currentHeadT?: 1240,          // present only when head moved past t
  unit: "entry",                // what one row is
  args: { ... },                // normalized args, defaults included
  rows: [ ... ],
  damage: "checked",            // or "not-checked": predicate-only aggregates decode no entries
  damaged: 0,                   // damaged candidates passed on this page
  damagedAt?: [ 812 ],          // their commit t, up to 20
  damagedTotal: 0,              // across the traversal so far
  exhausted: false,             // true when no next page exists at t
  complete: false,              // exhausted, damage checked, damagedTotal 0, entry coverage
  missingJson?: 0,              // not-checked only: a lower bound, entries in scope without bus:json
  next?: "bq1.…",               // present while the relation continues at t
  note: "…"                     // fixed per operation: scope and labelling limits
}
```

Operations add their own fields (`notFound`, `missingReplyTargets`, `root`, `members`, `total`, `totals`). An entry row is `{ t, id, ts, from, to: [...], kind, subject?, body, replyTo?, origin?, presence?: { runtime, status, topics, note? } }`: one row per entry with distinct logical ids, `to` as the recorded array, never one row per recipient or join match. `session`, `codexThreadId`, `takeover` and `rejoinOf` are not in saved-query rows; raw SPARQL can read `bus:json`. The MCP success schema is one object schema (MCP requires an object at the top), with `rows` described per operation in `bus_queries`.

### Cursor

`bq1.` followed by base64url of a JSON object with exactly these keys:

| Key | Meaning | Rejected when |
| --- | --- | --- |
| `v` | cursor format, `1` | not 1 |
| `cv` | catalogue version that issued it | not the running catalogue version |
| `op` | operation name | not the requested `name` |
| `h` | base64url of the first 16 bytes of SHA-256 over the canonical normalized args (defaults applied, set-valued lists sorted; `limit` excluded) | not the hash of the supplied args |
| `i` | ledger incarnation | not the current incarnation: the ledger was replaced |
| `t` | snapshot | above head, or unequal to an explicit `t` |
| `n` | page size | not the requested limit |
| `p` | position: `{ after: [t, id] }` / `{ before: [t, id] }` (keyset) or `{ offset: k }` | wrong form for the operation |
| `u` | damaged candidates met so far | negative or not an integer |

The cursor is not signed: the binding check protects consistency, and a hand-edited cursor can only mislead its own caller. Cursors over 1 KiB, malformed base64 or JSON, or extra keys are refused. One catalogue version covers every operation and is bumped by any change to an operation's rows, order, unit, defaults or arguments; an older cursor is refused, never translated.

### Damage, exhaustion and completeness

A candidate entry is a node with `@type` `bus:Message` or `bus:Presence` and a `bus:id`; its commit `t` comes from `bus:id`'s `@t`, and `bus:json` is an `optional` pattern (verified live: a node without `bus:json` returns `null` for it). A candidate is damaged when `bus:json` is missing, does not decode as a message, or names a different id. Damaged candidates occupy their place in the order, so keyset and offset positions move past them; each page reports how many it passed and their `t`, and the cursor carries the running total. The last page is `exhausted: true`; it is `complete: true` only when the whole traversal met no damage. `search` is never complete (ranked matches are not a complete relation). `counts` and `director-dm-volume` read predicates only and cannot detect damaged `bus:json`: they report `damage: "not-checked"` and are never `complete`, only `exhausted`, with `missingJson` counting entries in scope that have no `bus:json` at all, a lower bound on damage.

## Catalogue v1

Every user value is bound through JSON-LD `values`, never spliced into query text. Enumerated arguments (kinds, direction, grouping) select fixed code-owned fragments. All sketches are JSON-LD bodies sent to the pinned path with the bus `@context`.

| Operation | Unit | Mechanism | Page size | Position |
| --- | --- | --- | --- | --- |
| `history` | entry | candidates by type and id; predicates filter and order; `bus:json` decoded for rows | default 50, max 200 | keyset on (`t`, id), forward or backward |
| `messages` | entry | `bus:id` lookup at `t`; decoded rows; `notFound` ids | 1 to 100 ids | offset into the ids |
| `thread` | entry | whole reply tree from its root via `bus:replyTo*`; decoded rows; missing targets | default 100, max 200 | keyset on (`t`, id) |
| `search` | ranked match | full text on `bus:body`/`bus:subject`, best score per message; decoded rows | default 50, max 200 | offset into the ranking |
| `counts` | group | predicates only; aggregated in Fluree with distinct counts | default 200, max 1000 groups | offset |
| `peers` | address | decodes every presence at `t`; the fold delivery uses | default 100, max 500 | offset by address |
| `director-dm-volume` | UTC day | predicates only; distinct ids per measure, folded into UTC days | every day in the window (max 366) | none |

### history

Args: `participants?` (1 to 50 literal tokens: addresses, `#topic`, `*`; an entry matches when its sender or any recorded recipient equals a token), `fromTs?`/`toTs?` (half-open window on `bus:ts`, UTC instants; a filter, distinct from the snapshot), `kinds` (default `["message"]`, may add `"presence"`), `direction` (`forward` from the oldest, `backward` from the newest), `limit`. Order is commit `t`; equal `ts` never reorders anything.

```json
{
  "selectDistinct": ["?t", "?id", "?json"],
  "values": [["?p", "?after"], [["codex/b", 2], ["#t1", 2]]],
  "where": [
    { "@id": "?m", "@type": "bus:Message", "bus:id": { "@value": "?id", "@t": "?t" } },
    ["union", { "@id": "?m", "bus:from": "?p" }, { "@id": "?m", "bus:to": "?p" }],
    ["filter", "(> ?t ?after)"],
    ["optional", { "@id": "?m", "bus:json": "?json" }]
  ],
  "orderBy": "?t",
  "limit": 51
}
```

Verified live: `bus:id` with `@t`, the optional `bus:json` returning `null` for a damaged node, `selectDistinct` collapsing a multi-recipient entry matched through two participants, typed `xsd:dateTime` window values, and a type `union` for both kinds. The server asks for `limit + 1` candidates; a surplus means `next`. `backward` uses `[["desc", "?t"]]` and `(< ?t ?before)`.

### messages

Args: `ids` (1 to 100, unique). Each id is looked up at `t` with `values` and an `optional` `bus:json`; rows keep the requested order, ids absent at `t` (including ids committed after it) are listed in `notFound`, damaged ones in `damagedAt` (verified live). Duplicated ids are refused.

### thread

Args: `id`, `limit`. The id is resolved at `t` first; an id absent at `t` is an explicit error. The thread is the whole reply tree from its root: every entry that shares a reply ancestor with `id` along `bus:replyTo*`, which is the root's whole tree (verified live, with `{"@path": "bus:replyTo*"}` in the context). A membership query returns each member and its reply target as IRIs (capped at 10,000 members; beyond that the call fails), so the page reports `root` (the member without a reply link, absent when the tree hangs from a missing message), `members`, and `missingReplyTargets`: targets that are not entries at `t` (verified live: the dangling target appears as a node without `bus:id`). Rows page by keyset on (`t`, id). The note says that related mail without reply links is outside this relation; whole-job coverage pairs `thread` with `history`.

### search

Args: `text` (1 to 1,000 characters), `participants?`, `limit`. Verified live at a pinned `t`: grouping by message with `(as (max ?score) ?best)` gives one row per message across body and subject matches, ordered by `?best` then `?t`, with `offset` paging; a matched node without `bus:json` is returned with `null` and counted as damaged. Scores at a pinned `t` reflect that commit (verified live: `@t:3` and `@t:4` matched different sets). Never `complete`; index readiness limits are recorded in [Fluree](../platforms/fluree.md#full-text-search).

### counts

Args: `groupBy` (non-empty subset of `sender`, `recipient`, `day`), `unit` (`message` or `recipient-pair`, required, echoed), `participants?`, `fromTs?`/`toTs?`, `limit`. Messages only; `day` is the UTC day of `bus:ts`.

```json
{
  "select": ["?from", "?day", "(as (count-distinct ?m) ?n)"],
  "values": [["?p"], [["#t1"], ["codex/b"]]],
  "where": [
    { "@id": "?m", "@type": "bus:Message", "bus:from": "?from", "bus:ts": "?ts" },
    ["exists", ["union", { "@id": "?m", "bus:from": "?p" }, { "@id": "?m", "bus:to": "?p" }]],
    ["bind", "?day", "(subStr (str ?ts) 1 10)"]
  ],
  "groupBy": ["?from", "?day"]
}
```

Verified live: `exists` over the participant union, `subStr` of the stored dateTime (its string form is UTC `Z`), and `count-distinct`. Several participant rows in `values` repeat a message once per matching token, so both units count distinct values: `?m` for `message`, and a bound `(concat (str ?m) " " ?r)` for `recipient-pair` (verified live: equal to the hand count). The server fetches every group (failing beyond 10,000) and pages them. With `unit: message`, a message counts once per group it falls in, so group sums can exceed `total`, the distinct units in scope.

### peers

Args: `includeLeft` (default false), `limit`. The latest recorded presence per address at `t`, labelled as such: not membership at send time and not receipt. Candidate presences are found by type and id, decoded at `t`, and folded by the same function delivery uses (presences without a session are ignored). Old evidence is never joined to today's peers: a historical cut decodes the presences visible at that cut. Rows: `{ address, runtime, status, topics, since, t, host?, note? }`, ordered by address.

### director-dm-volume

Args: `director`, `cohort` (1 to 50 literal addresses, not the director, no `#topic` or `*`), `concernTopics` (`#name` tokens), `fromDay`/`toDay` (UTC days, half-open, at most 366 days), `excludeTopics?`. Messages only (`bus:Message`); UTC day boundaries only.

- **Numerator** (`directorToCohort`): distinct message ids from `director` with at least one cohort address literally in `to`, counted once per message, including mail that mixes direct and topic recipients. `*` and topics never count as a cohort addressee.
- **Observed-traffic day**: a UTC day with at least one message from or to a cohort address, or to a concern topic. It is observed traffic, not evidence of eligible concern work: unrelated cohort work or outsider topic traffic moves it.
- `excludeTopics` drops any message addressed to an excluded topic from both measures.

Three pinned queries return distinct `(id, ts)` pairs for the numerator, the traffic and the exclusions (each failing beyond 100,000 rows); the server folds them into UTC days. Rows are the days with either measure; `totals` returns the numerator and the observed-traffic day count separately, and their ratio (null with no such day). The note states that the predeclared comparable-window, workload and coverage checks still apply, and that a falling ratio alone never passes adoption.

## Raw SPARQL

### Read-only enforcement

1. **Parse and regenerate.** `sparqljs` 3.7.4 parses with the bus prefixes predeclared and RDF-star enabled (for `<< … >> f:t ?t`). It admits one `SELECT` query. It refuses every update, `ASK`, `CONSTRUCT` and `DESCRIBE`; any `FROM` or `FROM NAMED` anywhere, including in-ledger graphs such as `txn-meta`; any `GRAPH` pattern; and any `SERVICE`, silent or not. It then regenerates the text from the tree, which drops comments and so any `# PRAGMA` request option (documented, `query/sparql.md`). Query text is 1 to 32,768 characters.
2. **One route.** The gateway's only raw request is `POST /v1/fluree/query/{ledger}@t:{t}` with `Content-Type: application/sparql-query`. It has no update, insert or admin method, never sets `default-graph-uri` or `named-graph-uri`, and sends no fuel or tracking headers (fuel tracking replaces the budgeted Agent JSON result: [Fluree](../platforms/fluree.md#query-limits)).
3. **The server's own refusals on that route,** verified live with the parser bypassed:

| Sent to the pinned ledger-scoped route | Result (Fluree 4.2.4) |
| --- | --- |
| `INSERT DATA` as `application/sparql-query` | 400 `err:parse/SparqlLower` "UPDATE queries are not yet supported for lowering" |
| `INSERT DATA` as `application/sparql-update` | 400 "SPARQL UPDATE requests should use the /v1/fluree/update/<ledger...> endpoint" |
| form-encoded `update=` | 400, same message |
| `FROM <other:main>`, `FROM <other:main@t:1>`, `FROM NAMED <other:main>` | 400 "Ledger mismatch" |
| `FROM <bus@t:7>` on a path pinned at `@t:4` | 400 "Time pin conflict" |
| `SERVICE <fluree:ledger:other:main>` | 400 "SERVICE endpoint references unknown ledger" |
| `SERVICE SILENT <fluree:ledger:other:main>` | 200, no rows |
| `GRAPH <other:main> { … }` without `FROM NAMED` | 200, no rows |

Head `t` was unchanged after all of these. `SERVICE SILENT` and `GRAPH` return an empty success rather than reaching another ledger, which would pass for a complete answer; that is why the parser refuses every `SERVICE` and `GRAPH`. The bus ledger has no user-named graphs, so refusing `GRAPH` loses nothing in v1.

### Bounded result

- **Rows are bindings,** one object per solution keyed by variable, as Agent JSON returns them, with the column datatypes in `columns`. A row is not a logical message; one message can produce many rows or none.
- **Server cap and caller `LIMIT`.** The server cap is 500 rows. A query without `LIMIT`, or with one above 500, is sent with `LIMIT 501`; a 501st row proves more solutions exist, so the result keeps 500 and is `complete: false` with `cut: "rows"`. A result is never called complete at the cap without that sentinel's absence. A caller `LIMIT` of 500 or less is kept as written: the result answers the query as written, and when it returns exactly that many rows it reports `limitReached: true`, since the caller's own `LIMIT` may have stopped it.
- **Bytes.** Agent JSON with `Fluree-Max-Bytes: 49152`. Its `hasMore: true` is formatter truncation metadata, not proof about the relation after `LIMIT` (documented, `query/output-formats.md#agent-json-format`), so it only marks `cut: "bytes"` and `complete: false`; `hasMore: false` proves nothing beyond the rows returned. The application's own 64 KiB envelope cap applies on top, and any HTTP response over 256 KiB is refused before parsing.
- **Snapshot.** Agent JSON reports `t` for a single-ledger SELECT (verified live, equal to the path pin); a different `t` fails the call.
- **Time.** 10 s, after which the HTTP request is interrupted. A client disconnect signals cancellation to the running query (documented, `operations/configuration.md#query-timeout`; not verified here).
- **Envelope.** `{ name: "sparql", ledger, t, currentHeadT?, unit: "binding", columns, rows, complete, cut?, limitReached?, note }`. No cursor: a caller who needs more pages writes its own `ORDER BY` with `OFFSET` or a keyset, or uses a catalogue operation.
- **Errors.** Our parser's refusals pass through (they quote only the caller's own text). Fluree failures stay `Fluree request failed (HTTP n).`; Fluree's error text is not passed through.

## Limits

- **Envelope cap: 65,536 bytes** of UTF-8 JSON for every `bus_run_query` and `bus_query` result, on top of Fluree's own sizing. Whole rows are trimmed from the end until the envelope fits, then back to the last emitted row (damaged candidates after it are neither counted nor passed), and the next page starts after the last emitted row. A single row that cannot fit alone fails with an error naming its `id` and `t`; nothing is truncated. The presets keep their historical contracts and are not trimmed.
- **Page sizes** are in the catalogue table; requests above a maximum are refused, not clamped.
- **Fluree responses** for catalogue queries are refused above 32 MiB, raw responses above 256 KiB.
- **Concurrency and time:** 4 permits across all query operations, 10 s per Fluree request, interruption on timeout.

## Store and gateway

- `Ledger` keeps `instance`, `append`, `read`, `end`, `changes` and `presence`, which serve delivery. `select` and `search` are removed: search moves into the catalogue, so no second public path remains.
- A new `QueryGateway` service (Effect `Context.Service`) offers `pin` (head and incarnation), `jsonld(t, body)` and `sparql(t, text)`, each posting only to the pinned ledger-scoped route. `layerFluree` builds it from the same HTTP client, token and response mapping as `Ledger`.
- The catalogue is a finite code-owned list of operation definitions: name, purpose, unit, paging, note, closed argument `Schema` with defaults, row `Schema`, example, and the `Effect.fn` that runs a page through the gateway. `bus_queries`, the `name` enum, argument validation and dispatch all derive from that list; a test asserts that every listed example validates and runs, and that the enum, listing and dispatch name the same operations.
- The JSONL test ledger keeps presence, ownership and delivery (`Bus.peers` serves delivery, not only analysis) and provides `QueryGateway.layerUnavailable`, which fails every call with "Queries need the Fluree ledger." No JSONL query engine is added.

## Tests and qualification

- **One shared throwaway server.** The disposable authenticated Fluree in `test/bus.test.ts` moves to a `test/` helper used by the store matrix, the MCP and viewer reader tests and the query tests. A missing `fluree` binary fails the check.
- **`test/query.test.ts`** drives the real McpServer on that server: each operation's rows, units and notes; equal `ts`; multi-recipient entries as one row; replies with a missing target; presences with and without a session, at a historical cut; a damaged entry without `bus:json` and one with undecodable `bus:json`, inserted directly; a damaged page followed by a clean last page (`exhausted` without `complete`); appends between pages and during input resolution (rows unchanged, `currentHeadT` present); a replaced ledger refusing an old cursor; each cursor-mismatch case; `t` of 0 and above head; the oversize row; byte trimming. Raw SPARQL: every forbidden form refused by the parser through the tool, and the same forms sent with the parser bypassed, asserting the server's refusal and an unchanged head; the row sentinel and a caller `LIMIT`. Errors carry no Fluree text.
- **Moved lanes.** The query-dependent assertions in `test/mcp-official.test.ts` and `test/viewer-reader-bus.test.ts` move to the throwaway server unchanged in strength; `bus_history` behaviour (newest window, `limit: 1`, participant, ranked text) is asserted through the presets there.
- **Retired tests:** `test/public-query.test.ts` and the refusal assertions listed below. History and search cases in `bus.test.ts` move to the query tests; the store matrix keeps delivery.
- **`scripts/qualify-fluree.ts`** gains a durable, authenticated case: a traversal interrupted by a server restart resumes from its cursor with identical rows.

## Retirement list

Code and tests: `PUBLIC_QUERY_REFUSAL`, `refusePublicQuery`, `Ledger.select` and `Ledger.search` (`src/Ledger.ts`, `src/Fluree.ts`, `test/jsonl-ledger.ts`); `Bus.history`; the refusing `bus_query` definition and handler (`src/mcp.ts`); `test/public-query.test.ts`; the refusal assertions in `test/bus.test.ts`, `test/public-errors.test.ts` and `test/mcp-official.test.ts`; the `bus_query` refusal call in `test/viewer-reading-fixture.ts`.

Docs and guidance: the `AGENTS.md` invariant that `bus_query` and `Ledger.select` must refuse; the README comparison row; [connections](../architecture/connections.md) rule 6 and its known-limit rows; [interfaces](../architecture/interfaces.md) `bus_query` section, tool and annotation tables and refusal rows; the [messaging](../architecture/messaging.md) and [topology](../architecture/topology.md) mentions; the [overview](../overview.md) rows; the [deploy runbook](../runbooks/deploy.md)'s public-query containment section, its rollback constraints and its refusal check (replaced by a check that a pinned `bus_query` answers and a forbidden one is refused); the skill's `SKILL.md`, `references/queries.md` (rewritten around the catalogue and raw recipes), `references/refusals.md` and `references/runtimes.md`; [Fluree](../platforms/fluree.md)'s public-query withdrawal wording and the findings register's list. The repo memory whose rationale cites the withdrawn SELECT is updated through `fluree memory update`. The containment frames stay frozen; the frames index gains a retired-mechanism row.

## Viewer migration

The viewer branch stacks on the query branch and changes only the viewer and its tests and docs.

- **Reads.** `viewer/server/reader.ts` keeps its `RcRef` MCP client and calls `bus_run_query` only: `history` backward for the default window, `search` for text criteria, `history` with `participants` for exact participant criteria, and `peers`. Observations gain `ledger`, `t`, `currentHeadT`, `exhausted`, `complete`, `hasOlder` and the damaged count. Upstream incompleteness (damaged candidates, ranked search, a window that stopped before exhaustion) and the viewer's own projection omissions (records its public projection rejects) are reported separately.
- **Bounded-window disclosure** (PR 15's first deferred item, confirmed). The window follows `next` at one `t` until it holds 200 entries or the relation is exhausted, and says which: "latest 200 entries at t=…; older entries exist" or "all entries at t=…". A search window says "best matches at t=…; ranked, not complete". The label never infers completeness from the row count.
- **Retained-flow freezing** (the second deferred item, confirmed). A retained conversation or context flow records the `ledger` and `t` of the observation it came from and stays frozen there: rereading it uses `thread` (or `history` with its criteria) at that explicit `t`, so a retained unit never mixes rows from two snapshots, and `missingReplyTargets` replaces inferred missing anchors. Accepting the current unit moves to the current `t`.
- **Verification.** The reader test on the throwaway server, server tests for the envelope mapping, Storybook plays for older-entries, damaged and moved-head states, and the connected browser lane where it applies.

## Implementation revisions

Settled during implementation with the coordinator and the cross-reviewer; the sections above are revised to match.

- **Keyset on (t, id).** Several entries can share a commit, so history and thread order by `t` then id, and positions and cursors carry both: `(or (> ?t ?bt) (and (= ?t ?bt) (> ?id ?bid)))`, and its mirror with descending order for `backward` (verified live).
- **Consumed prefix.** A page trimmed for bytes ends at its last emitted row. Damage counts and the next position cover only the candidates up to that row: with damaged@11, valid@12, damaged@13 and valid@14 where only valid@12 fits, the page counts damage@11 and resumes after @12. A page of damaged candidates alone still advances. A first row that cannot fit alone fails, naming it.
- **Aggregates are never complete.** `counts` and `director-dm-volume` report `damage: "not-checked"`, `exhausted` and an optional `missingJson` lower bound, never `complete: true`.
- **Raw zero-binding failure.** A raw result where no binding fits, including Agent JSON `hasMore` with no rows, fails as an oversized first row, naming `t` and the row position; an empty preview is never returned. Exactly 500 rows without the sentinel or a byte cut can be complete.
- **Ids by subject IRI.** Binding `?id` with `values` before `bus:id {"@value": "?id", "@t": "?t"}` returns a null `t` (verified live), so `messages` and `thread` bind the subject IRI (`urn:agent-bus:message:<id>`) instead; an id outside the IRI-safe character set is treated as absent at `t`.
- **Mixed column types.** Agent JSON's `schema` gives an array of datatypes for a variable whose values vary, so `columns` accepts either.
- **Authenticated qualification.** `scripts/qualify-fluree.ts` starts its server with required data and admin authentication, and resumes a traversal across a restart from its cursor with identical rows.

## Evidence register

| Claim | Basis |
| --- | --- |
| Path pin reads the ledger at `t`; body time must agree; `to` refused on a pinned path | documented, `concepts/time-travel.md#pinning-the-ledger-in-the-request-path`, `api/endpoints.md#post-queryledger`; pinned count verified live |
| Future `t` waits then 408; `@t:0` is empty | verified live; wait cap documented, `operations/configuration.md#query-timeout` |
| UPDATE refused on the query route in three encodings | verified live |
| Other ledger via `FROM`/`FROM NAMED` is "Ledger mismatch"; same ledger at another `t` is "Time pin conflict" | verified live; documented, `api/endpoints.md#post-queryledger` |
| SERVICE to an unknown ledger fails; SILENT and `GRAPH <other>` return empty successes | verified live; SERVICE dataset requirement documented, `query/sparql.md#requirements` |
| Agent JSON shape (`schema`, `rows`, `rowCount`, `t`, `hasMore`, `message`) and byte truncation | verified live; `hasMore` semantics documented, `query/output-formats.md#agent-json-format` |
| `bus:id` with `@t`, `optional` `bus:json` returning `null`, type `union`, `selectDistinct` | verified live |
| `exists` over a union, `minus`, `count-distinct` of `?m` and of a bound pair string, UTC day `subStr` | verified live |
| Grouped full text with an aliased `max` score, `orderBy` alias, `offset` | verified live (ledger with the full-text config); aggregates must be aliased to order by them |
| Thread tree via `@path bus:replyTo*`; a dangling target is a node without `bus:id` | verified live |
| `sparqljs` parse trees for `GRAPH`, `SERVICE SILENT`, `FROM`, subqueries and RDF-star; regeneration drops comments | verified with sparqljs 3.7.4 |
| Client disconnect cancels the running query | documented only, `operations/configuration.md#query-timeout` |
| Saved-query execution, closed args, `LIMIT n+1`, byte trimming, explicit oversize failure, `currentHeadT`, cursor binding | read in code (archive MCP prior art) |

All live checks ran on disposable servers with no authentication, synthetic ledgers and random high ports, stopped by process id afterwards. The running bus and its Fluree server were not touched; the implementation's tests run the same matrix on the authenticated throwaway server.

## Settled in cross-review

SELECT only for raw SPARQL; no `txn-meta`; parser errors only; session fields out of saved rows while raw SPARQL may read `bus:json`; a missing `fluree` binary fails the check; a read-only Fluree token deferred to the owner; the whole reply tree from the root plus missing targets; predicate-only aggregates accepted with their note; one catalogue version; a fixed byte cap; presets stay; the reading of PR 15's deferred items confirmed; `sparqljs` re-added; `search` in catalogue v1; UTC day boundaries for `director-dm-volume`, with the observed-traffic label above.
