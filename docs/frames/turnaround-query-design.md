# Design: read-only bus queries

2026-11-01. Design note for the query vertical of the coordination turnaround, written for cross-review before any implementation. It settles the mechanisms the turnaround query frame left open: the tool surface, the snapshot and continuation contract, the first saved-query catalogue, the raw SPARQL boundary, limits, tests, what the query refusal retires, and how the viewer moves onto the same definitions. Current behaviour stays in [interfaces](../architecture/interfaces.md), [connections](../architecture/connections.md), [Fluree](../platforms/fluree.md) and [viewer](../architecture/viewer.md) until the implementation lands.

Status: proposed; no code, deploy or acceptance. Every Fluree claim below carries its basis: **verified live** (a disposable Fluree 4.2.4 server with synthetic ledgers, 2026-11-01), **documented** (the installed 4.2.4 CLI's embedded docs, page and anchor named) or **read in code** (this repository, or the local archive MCP server used as prior art). The [evidence register](#evidence-register) lists them together.

## Decisions at a glance

| Question | Decision |
| --- | --- |
| Tools | `bus_query` (raw read-only SPARQL, existing `query`/`t` schema), `bus_run_query` (`name`, `args`, `t?`, `cursor?`), `bus_queries` (catalogue). `bus_history` and `bus_peers` stay as thin presets over catalogue operations. |
| Snapshot | One commit `t` per traversal: explicit, from the cursor, or head at the first call. Every query is sent to `POST /v1/fluree/query/{ledger}@t:{t}`; the server pins the whole read there. |
| Order | History and thread rows are ordered by commit `t`, which is unique per entry; `ts` is reported, never used as the order key. |
| Continuation | Opaque, unsigned, versioned cursor bound to operation, catalogue version, args hash, `t`, page size and position. Keyset on `t` for entry traversals, offset elsewhere. Any mismatch is an explicit error. |
| Decode or predicates | Rows that show entries decode `bus:json` server-side. Selection, ordering, reply links and aggregates use graph predicates. `peers` must decode (topics, session and note exist only in `bus:json`). No new predicates, so no migration. |
| Read-only | Three layers: a parser admits only SELECT and ASK with no dataset clause and no SERVICE, and regenerates the text (dropping comments, so no `# PRAGMA`); the gateway can only reach the pinned ledger-scoped query route; and the server itself refuses UPDATE, other ledgers and unknown SERVICE targets on that route (verified live). |
| Limits | 64 KiB per result envelope; per-operation page sizes; raw SPARQL capped at 500 rows, a 48 KiB Fluree row budget and 10 s, without a cursor. One row that cannot fit fails explicitly. |
| Undecodable | Counted per page and across the traversal (carried in the cursor); any undecodable entry makes the final page `complete: false`. |
| Stores | A separate `QueryGateway` service exists only for Fluree. The JSONL test ledger provides an explicitly refusing gateway. Query tests run a throwaway real Fluree server. |
| Viewer | Reads through `bus_run_query` on the same MCP client; its `bus_history`/`bus_peers` calls retire; window bounds and retained units carry their snapshot `t`. |

## Tool surface

The brief's split is confirmed, mirroring the archive prior art (`sparql_query`, `run_saved_query`, orientation listing), with one addition: a `search` operation in the catalogue, so text search has one definition shared by `bus_history` and the viewer.

- **`bus_query`** becomes raw read-only SPARQL. Its existing input schema (`query: string`, `t?: integer`) and read-only annotation already fit, so cached tool lists and approval settings keep working; only the description and success schema change. A rename (for example `bus_sparql`) would need either a removal gate for the old name or a second name for the same path, and buys only a clearer verb.
- **`bus_run_query`** runs one catalogue operation: `name` (enum), `args` (object, validated server-side against that operation's closed schema), `t?`, `cursor?`. With a cursor the caller resends the same `name` and `args`; the cursor's hash must match them. "run" plus a required `name` keeps it distinct from `bus_query`.
- **`bus_queries`** lists the catalogue: catalogue version, head `t`, and per operation its name, purpose, argument JSON Schema with defaults, unit, completeness note and one executable example (a literal `bus_run_query` call). Orientation embeds this listing by calling the same function; it does not copy it.
- **Presets.** `bus_history` without `query` is `history` read backward from head (newest first, then reversed to keep its "newest last" output); with `query` it is `search`. `bus_peers` is `peers` at head. Their input and output schemas stay as they are. They are not a second execution path: each call is one catalogue operation. Because they are presets, they need no removal gate; retiring them later is a separate decision.

All three new tools carry the `Lookup` annotations (read-only, not destructive, closed world) and take no `session`, like `bus_history` and `bus_peers`. They share one server-wide permit pool (4 concurrent query operations) so analysis cannot starve delivery reads of the same Fluree server.

## Snapshot, envelope and continuation

### Snapshot

1. Read head (`GET /info/{ledger}`). An explicit `t` outside `1..head` fails before any query: the server would otherwise wait for a future `t` and answer 408 after its 5 s min-t timeout, and treats `@t:0` as an empty ledger (both verified live).
2. The snapshot is the cursor's `t`, else the explicit `t`, else head. An explicit `t` that differs from the cursor's fails.
3. Every query goes to `POST /v1/fluree/query/{ledger}@t:{t}`. A path pin reads the whole ledger as of that commit (documented, `concepts/time-travel.md#pinning-the-ledger-in-the-request-path`; verified live: a count at `@t:4` returned 4 entries on a 7-commit ledger).
4. Read head again afterwards; when it differs from `t`, the result carries `currentHeadT`. A pinned commit is immutable, so later appends never change a traversal's rows (the per-operation tests prove it with appends between pages).

### Result envelope

```ts
{
  name: "history",            // operation, or "sparql" for bus_query
  catalogueVersion: 1,
  t: 1234,                    // the snapshot every row was read at
  currentHeadT?: 1240,        // present only when head moved past t
  unit: "entry",              // what one row is
  args: { ... },              // normalized args, defaults included (echoed)
  rows: [ ... ],
  undecodable: 0,             // entries skipped on this page because bus:json did not decode
  undecodableTotal: 0,        // across the traversal so far
  complete: false,            // true only on the last page of a traversal with undecodableTotal 0
  next?: "bq1.…",             // present while rows remain at t
  note: "…"                   // fixed per operation: scope and labelling limits
}
```

Operations add their own fields: `notFound` (messages), `missingReplyTargets` and `unlinkedNote` (thread), `total` (counts), `totals` (director-dm-volume). An entry row is `{ t, id, ts, from, to: [...], kind, subject?, body, replyTo?, origin?, presence?: { runtime, status, topics, note? } }`: one row per entry, `to` as the recorded array, never one row per recipient or per join match. `session`, `codexThreadId`, `takeover` and `rejoinOf` are not in saved-query rows (see [open questions](#open-questions-for-cross-review)). `success` in each tool's MCP schema is a union discriminated by `name`, so clients see a typed shape per operation.

### Cursor

`bq1.` followed by base64url of a JSON object with exactly these keys:

| Key | Meaning | Rejected when |
| --- | --- | --- |
| `v` | cursor format, `1` | not 1 |
| `cv` | catalogue version that issued it | not the running catalogue version: the error says so and suggests restarting with `t` to keep the snapshot |
| `op` | operation name | not the requested `name` |
| `h` | base64url of the first 16 bytes of SHA-256 over the canonical normalized args (defaults applied, sets sorted and deduplicated; `limit` and `cursor` excluded) | not the hash of the supplied args |
| `t` | snapshot | outside `1..head`, or unequal to an explicit `t` |
| `n` | page size | not the requested limit |
| `p` | position: `{ after: t }` / `{ before: t }` (keyset) or `{ offset: k }` | wrong form for the operation |
| `u` | undecodable entries counted so far | negative or not an integer |

The cursor is not signed: the archive's HMAC and principal machinery answer a threat model the bus does not have, and a hand-edited cursor can only mislead its own caller. The binding check is what protects consistency. Cursors over 1 KiB, malformed base64 or JSON, or extra keys are refused. The catalogue version is one code-owned integer, bumped by any change to any operation's rows, order, unit, defaults or arguments. A cursor from an older release is refused, never translated.

Keyset positions make byte trimming trivial: a trimmed page ends at its last emitted row's `t`, and the next page starts after it. Offset positions (messages, peers, counts, director-dm-volume) are stable because the pinned snapshot is immutable and the order is total (documented: a pinned `t` reads the ledger as of that point; the order keys below are unique).

## Catalogue v1

Every user value is bound through JSON-LD `values`, never spliced into query text. Enumerated arguments (kinds, direction, grouping) select between fixed code-owned query fragments. All sketches below are JSON-LD bodies sent to the pinned path with the bus `@context`; those marked verified ran unchanged in shape against the disposable server.

| Operation | Unit | Mechanism | Page size | Position |
| --- | --- | --- | --- | --- |
| `history` | entry | predicates select and order; `bus:json` decoded for rows | default 50, max 200 | keyset on `t` |
| `messages` | entry | `bus:id` lookup; decoded rows; not-found ids listed | 1 to 100 ids | offset into requested ids |
| `thread` | entry | `bus:replyTo` property path; decoded rows; missing targets listed | default 100, max 200 | keyset on `t` |
| `search` | ranked match | full-text on `bus:body`/`bus:subject`; decoded rows | default 50, max 200 | none |
| `counts` | group | predicates only (`bus:from`, `bus:to`, `bus:ts`); aggregated in Fluree | default 200, max 1000 groups | offset |
| `peers` | address | decodes every presence; shared fold with delivery | default 100, max 500 | offset by address |
| `director-dm-volume` | day | predicates only; aggregated in Fluree | all days in window (max 366) | offset |

### history

Args: `participants?` (1 to 50 literal tokens: addresses, `#topic`, `*`; an entry matches when its sender or any recorded recipient equals a token), `fromTs?`/`toTs?` (half-open message-time window on `bus:ts`; a filter, distinct from the snapshot), `kinds` (default `["message"]`, may add `"presence"`), `direction` (`forward` from the oldest, or `backward` from the newest), `limit`. Order is commit `t`, ascending or descending; equal `ts` never reorders anything.

Verified live, forward page after `t=2` for two participants:

```json
{
  "selectDistinct": ["?t", "?json"],
  "values": [["?p", "?after"], [["codex/b", 2], ["#t1", 2]]],
  "where": [
    { "@id": "?m", "@type": "bus:Message", "bus:json": { "@value": "?json", "@t": "?t" } },
    ["union", { "@id": "?m", "bus:from": "?p" }, { "@id": "?m", "bus:to": "?p" }],
    ["filter", "(> ?t ?after)"]
  ],
  "orderBy": "?t",
  "limit": 3
}
```

It returned three distinct entries in `t` order, including two with equal `ts` and one multi-recipient entry matched through two participants once. The window filter binds typed values, also verified: `values [["?from","?to"], [[{"@value": "…Z", "@type": "xsd:dateTime"}, {…}]]]` with `["filter", "(>= ?ts ?from)", "(< ?ts ?to)"]`. The server asks for `limit + 1` rows; a surplus row means `next`. Without participants the union and `?p` are omitted. `backward` uses `[["desc", "?t"]]` and `(< ?t ?before)`.

### messages

Args: `ids` (1 to 100). Verified live: `values [["?wanted"], [["m2"], ["nope"], ["bad"]]]` with an `optional` pattern on `bus:id`/`bus:json @t` returned a `t` for the present id and `null` for the absent ones, including an id committed after the snapshot. Rows keep the requested order; ids absent at `t` are listed in `notFound` (input resolution at the snapshot). Duplicated ids are refused rather than silently merged.

### thread

Args: `id`, `limit`. The thread is the whole reply tree containing the message: every entry from which some reply-ancestor of `id` is reachable along `bus:replyTo*`. Verified live, with the path declared in the context:

```json
{
  "@context": { "up": { "@path": "bus:replyTo*" } },
  "selectDistinct": ["?t", "?id"],
  "values": [["?fid"], [["m3"]]],
  "where": [
    { "@id": "?f", "bus:id": "?fid" }, { "@id": "?f", "up": "?top" }, { "@id": "?d", "up": "?top" },
    { "@id": "?d", "bus:id": "?id", "bus:json": { "@value": "?j", "@t": "?t" } }
  ],
  "orderBy": "?t"
}
```

The rows page by keyset on `t` like `history`. Each page also runs an id-only membership query (`?id`, `bus:replyTo` IRI) over the tree, capped at 10,000 members (beyond that the operation fails explicitly). Any present reply target is an ancestor and so a member, so `missingReplyTargets` is every member's target id that is not a member; the SPARQL equivalent (`FILTER NOT EXISTS { ?target bus:id ?x }`) was verified live and returned the one dangling reference. The fixed `unlinkedNote` says that related mail without reply links is outside this relation and that whole-job coverage pairs `thread` with `history`.

### search

Args: `text`, `participants?`, `limit`. The existing full-text recipe from `Ledger.search`, moved into the catalogue and pinned. Verified live at a pinned `t`: on a ledger with the full-text config, `@t:3` matched one of two entries and `@t:4` matched both, so the pin applies to text scoring too. The envelope never reports `complete: true`: ranked matches are not a complete relation, and index readiness limits are recorded in [Fluree](../platforms/fluree.md#full-text-search).

### counts

Args: `groupBy` (non-empty subset of `sender`, `recipient`, `topic`, `day`), `unit` (`message` or `recipient-pair`, required, echoed), `participants?`, `fromTs?`/`toTs?`, `timezone` (IANA, default `UTC`), `limit`. Messages only, no presences.

Fluree aggregates per UTC hour; the server folds hours into local days. Verified live:

```json
{
  "select": ["?from", "?hour", "(count-distinct ?m)"],
  "where": [
    { "@id": "?m", "@type": "bus:Message", "bus:from": "?from", "bus:ts": "?ts" },
    ["bind", "?hour", "(subStr (str ?ts) 1 13)"]
  ],
  "groupBy": ["?from", "?hour"]
}
```

`str` of the stored `xsd:dateTime` is the UTC form (`2026-11-01T10:05:00Z`, verified live), and the bus writes every `ts` with `toISOString` (read in code), so the first 13 characters name the UTC hour. Each message falls in exactly one hour, so summing per-hour distinct counts gives exact per-day distinct counts. A zone whose offset is not a whole hour at some instant of the window is refused by name rather than approximated. `recipient` groups use `bus:to ?r` (`(count ?m)` per `?r`, verified live); `topic` is the recipient groups whose token starts with `#`. With `unit: message` a message counts once per group it falls in, so group sums can exceed `total`, which reports distinct messages in scope; with `recipient-pair` each recorded recipient counts once.

### peers

Args: `includeLeft` (default false), `limit`. Latest recorded presence per address at `t`, labelled as such: not membership at send time and not receipt. This operation must decode: topics, session and note exist only in `bus:json`, and the delivery rule ignores presences without a session. The query is the existing presence read pinned at `t` (`bus:Presence`, `bus:json` with `@t`, ordered by `t`; verified live). The fold is one shared function, used by both `Bus.peers` (delivery) and this operation, so "who is a peer" has one definition. Rows: `{ address, runtime, status, topics, since, host?, note?, t }`. An undecodable presence may hide an address's latest state, so it counts like any other undecodable entry.

### director-dm-volume

Args: `director`, `cohort` (1 to 50 addresses, excluding the director), `concernTopics` (`#name` tokens), `fromTs`/`toTs` (required, aligned to local midnight in `timezone`, at most 366 days), `timezone`, `excludeTopics?`. Per local day:

- `directorToCohort`: distinct messages from `director` with at least one literal cohort address in `to`, counted once however many cohort addresses or topics share the audience. `*` and topics never count as a cohort addressee.
- `active`: true when at least one message is from or to a cohort address, or to a concern topic.

Rows are the active days; `totals` gives the active-day count, the numerator sum and their ratio (null with no active day). A day with `directorToCohort > 0` is active by construction. Both measures are predicate-only aggregates per UTC hour, folded into days as in `counts`; the numerator binds `?director` and each cohort address together in `values` rows and uses `count-distinct ?m`. `excludeTopics` drops any message addressed to an excluded topic from both measures. The definition is restated here for Codex to check against the parent frame before it is coded; the exclusion input is a proposal.

## Raw SPARQL

### Pinning and read-only enforcement

1. **Parse and regenerate.** `sparqljs` (re-added at 3.7.4, the version this repo removed with the refusal) parses with the bus prefixes predeclared and RDF-star enabled (for `<< … >> f:t ?t`). It admits a `query` of type SELECT or ASK only. It refuses every `update`, CONSTRUCT and DESCRIBE, any `from` (default or named) and any `service` node anywhere in the tree, then regenerates the query from the tree, which drops comments and so any `# PRAGMA` request option (documented, `query/sparql.md`; the archive prior art does the same). Query text is 1 to 32,768 characters.
2. **One route.** The gateway's only request is `POST /v1/fluree/query/{ledger}@t:{t}` with `Content-Type: application/sparql-query`. It has no update, insert or admin method, never sets `default-graph-uri` or `named-graph-uri`, and sends no fuel or tracking headers (fuel tracking replaces the budgeted Agent JSON result: [Fluree](../platforms/fluree.md#query-limits)).
3. **The server's own refusals on that route,** verified live by sending the forbidden forms straight to it, past any parser:

| Sent to the pinned ledger-scoped route | Result (Fluree 4.2.4) |
| --- | --- |
| `INSERT DATA` as `application/sparql-query` | 400 `err:parse/SparqlLower` "UPDATE queries are not yet supported for lowering" |
| `INSERT DATA` as `application/sparql-update` | 400 "SPARQL UPDATE requests should use the /v1/fluree/update/<ledger...> endpoint" |
| form-encoded `update=` | 400, same message |
| `FROM <other:main>`, `FROM <other:main@t:1>` | 400 "Ledger mismatch" |
| `FROM NAMED <other:main>` | 400 "Ledger mismatch" |
| `FROM <bus@t:7>` on a path pinned at `@t:4` | 400 "Time pin conflict" |
| `SERVICE <fluree:ledger:other:main>` | 400 "SERVICE endpoint references unknown ledger" |
| `SERVICE SILENT <fluree:ledger:other:main>` | 200, no rows |
| `GRAPH <other:main> { … }` without `FROM NAMED` | 200, no rows (never the other ledger's data) |

Head `t` was unchanged after all of these. `SERVICE SILENT` and `GRAPH` both return an empty success rather than reaching another ledger, which is why the parser layer still refuses SERVICE: a silently empty result would look complete. In-ledger graphs (`txn-meta`, which answered as `FROM <txn-meta>`, and the config graph) are read-only and harmless, but v1 keeps every dataset clause closed. The documented server behaviour agrees: on `/query/{ledger}`, `FROM` and `FROM NAMED` name graphs within that ledger and another ledger's name is a "Ledger mismatch" (documented, `api/endpoints.md#post-queryledger`).

### Bounded result

- **Rows.** No LIMIT, or LIMIT above 500, becomes `LIMIT 501` in the regenerated tree. A 501st row is dropped and the result is `complete: false` with `cut: "rows"`. A caller LIMIT of 500 or less is kept as written: it is the caller's query, not a cut.
- **Bytes.** `Accept: application/vnd.fluree.agent+json` with `Fluree-Max-Bytes: 49152`. Verified live: with a 50-byte budget the pinned route returned 2 of 6 rows with `hasMore: true`; `hasMore` becomes `complete: false` with `cut: "bytes"`. Fluree budgets row data only (documented, `query/output-formats.md#agent-json-format`), so the server also trims rows until the whole envelope fits 64 KiB, and refuses any HTTP response over 256 KiB before parsing it.
- **Snapshot.** Agent JSON reports `t` for a single-ledger SELECT (verified live, equal to the path pin); a different `t` fails the call. ASK under Agent JSON returns a bare `true`/`false` (verified live), so its envelope reports the pinned `t` it was sent to.
- **Time.** 10 s, after which the HTTP request is interrupted. A client disconnect signals cancellation to the running query (documented, `operations/configuration.md#query-timeout`; not verified here).
- **Envelope.** `{ name: "sparql", t, currentHeadT?, unit: "solution" | "boolean", columns: { var: datatype }, rows | boolean, complete, cut? }`, column names without `?`. No cursor: a caller who needs more pages writes its own ORDER BY with OFFSET or a keyset, or uses a catalogue operation.
- **Errors.** Parser refusals return the parser's message (it quotes only the caller's own text). A Fluree 400 returns its `error` text only for the parse and invalid-query types (`err:parse/*`, `err:db/InvalidQuery`, `err:api/BadRequest`), truncated to 300 characters; everything else stays `Fluree request failed (HTTP n).` as today.

Useful raw recipes the skill will carry: commit `t` per entry via `<< ?m bus:json ?j >> f:t ?t` on a pinned non-history query (verified live), reply ancestry via `bus:replyTo+`, and full-text via `f:fulltext`. `FROM … TO` history ranges are not reachable (dataset clauses are closed, and the pinned route refuses `to`, documented); bus entries are never retracted, so `f:t` on current assertions covers commit order.

## Limits

- **Envelope cap: 65,536 bytes** of UTF-8 JSON, applied to every `bus_run_query` and `bus_query` result. Rows are trimmed from the end until the envelope fits; with a keyset or offset position the next page starts at the first trimmed row. A single row that cannot fit alone fails with an error naming its `id` and `t`, and nothing is truncated. 64 KiB stays under typical MCP host output limits for agents; the viewer reaches the same cap and pages.
- **Page sizes** are in the catalogue table; requests above a maximum are refused, not clamped.
- **Undecodable entries** are entries whose `bus:json` fails `MessageJson` decoding. On operations that decode, each is counted on its page (`undecodable`) with its commit `t` listed (`undecodableAt`, up to 20), carried forward in the cursor (`u`), and makes the traversal's last page `complete: false`. Predicate-only operations (`counts`, `director-dm-volume`) do not decode and say so in their `note`; the bus writes predicates and `bus:json` from the same message in one insert (read in code), so they differ only on corruption.
- **Concurrency and time:** 4 permits across all query operations, 10 s each, interruption on timeout.

## Store and gateway

- `Ledger` keeps `instance`, `append`, `read`, `end`, `changes` and `presence` (delivery needs it). `select` and `search` are removed: search moves into the catalogue.
- A new `QueryGateway` service (Effect `Context.Service`) offers `head`, `jsonld(body, t)` and `sparql(text, t)`, each posting only to the pinned ledger-scoped route. `layerFluree` builds it from the same HTTP client, token and response mapping as `Ledger`, so no second connection or credential exists.
- The catalogue is a finite code-owned list of operation definitions: name, closed `Schema` for args with defaults, unit, note, example and an `Effect.fn` that runs through the gateway. `bus_queries` derives its listing, and `bus_run_query` its validation, from the same definitions.
- `test/jsonl-ledger.ts` provides no query support. Tests that run `serve` on JSONL provide `QueryGateway.layerUnavailable`, which fails every call with "Queries need the Fluree ledger" before doing anything.

## Tests and qualification

- **One shared throwaway server.** Extract the disposable authenticated Fluree from `test/bus.test.ts` into a `test/` helper (temporary directory, OS-assigned port via the existing probe pattern, token from `fluree token`, stopped by its own process handle). `bus.test.ts`, the new query tests and the viewer reader test use it.
- **`test/query.test.ts`** drives the real McpServer (`Serve.layerHttp` over `src/mcp.ts`) on that server: each operation's rows, units and notes; equal `ts`; multi-recipient entries as one row; replies with a missing target; presences with and without a session; an undecodable entry inserted directly over HTTP; appends between pages (rows unchanged, `currentHeadT` present); each cursor-mismatch case; `t` of 0, above head and non-integer; the oversize row; byte trimming. Raw SPARQL: every forbidden form refused by the parser through the tool, and the same forms sent through the gateway's raw request with the parser bypassed, asserting the server's refusal and an unchanged head. Errors carry no upstream body outside the allowlist.
- **`test/viewer-reader-bus.test.ts`** moves from the JSONL ledger to the throwaway Fluree server; its assertions gain `t`, `complete`, `next` and the window semantics below, and keep the never-observed private session marker.
- **Retired tests:** `test/public-query.test.ts` and the refusal assertions listed below. History cases in `bus.test.ts` that ran against both stores become Fluree-only.
- **`scripts/qualify-fluree.ts`** gains a durable, authenticated case: a traversal interrupted by a server restart resumes from its cursor with identical rows, and the read-only matrix holds there too.
- When the `fluree` binary is missing, the query and viewer reader tests fail with a message saying so, instead of skipping like the existing store matrix (see open questions).

## Retirement list

Code and tests: `PUBLIC_QUERY_REFUSAL`, `refusePublicQuery` and `Ledger.select` (`src/Ledger.ts`); `select: refusePublicQuery` in `src/Fluree.ts` and `test/jsonl-ledger.ts`; `Ledger.search`, its JSONL implementation and `Bus.history` (replaced by the catalogue `search`); the refusing `bus_query` definition and handler (`src/mcp.ts`); `test/public-query.test.ts`; the refusal assertions in `test/bus.test.ts`, `test/public-errors.test.ts` and `test/mcp-official.test.ts` (its "other than the withdrawn bus_query" case); the `bus_query` refusal call in `test/viewer-reading-fixture.ts`.

Docs and guidance: the `AGENTS.md` invariant that `bus_query` and `Ledger.select` must refuse; the README comparison row; [connections](../architecture/connections.md) rule 6 and its known-limit rows about older servers and the refusal; [interfaces](../architecture/interfaces.md) `bus_query` section, tool table, annotation table, refusal rows and rules 1 and 6; the [messaging](../architecture/messaging.md) and [topology](../architecture/topology.md) mentions; the [overview](../overview.md) rows; the [deploy runbook](../runbooks/deploy.md)'s public-query containment section, its rollback constraints and its refusal check (replaced by a check that a pinned `bus_query` answers and a forbidden one is refused); the skill's `SKILL.md`, `references/queries.md` (rewritten around the catalogue and recipes), `references/refusals.md` and `references/runtimes.md` (annotation list); [Fluree](../platforms/fluree.md)'s "public-query withdrawal" wording and the findings register's "before any public-query replacement" list. The repo memory whose rationale cites the old SELECT is updated through `fluree memory update`. The containment frames stay frozen; the frames index gains a retired-mechanism row.

## Viewer migration

The viewer branch stacks on the query branch and changes only the viewer and its tests and docs.

- **Reads.** `viewer/server/reader.ts` keeps its `RcRef` MCP client and calls `bus_run_query` only: `history` backward for the default window, `search` for text criteria, `history` with `participants` for exact participant criteria, and `peers`. Its `bus_history` and `bus_peers` lookups retire. Observations gain `t`, `currentHeadT`, `complete`, `hasOlder` and the undecodable counts, mapped onto the existing omitted-record states.
- **Bounded-window disclosure** (PR 15's first deferred item, as understood here). The window is assembled by following `next` at one `t` until it holds 200 entries or the history is exhausted, and its label says which: "latest 200 entries at t=…; older entries exist" or "all entries at t=…". A search window says "best 200 text matches at t=…; ranked, not complete". "Load older" follows the cursor at the same `t`, up to a fixed bound, so nothing accumulates into an unbounded archive. The label never infers completeness from the row count.
- **Retained-flow freezing** (the second deferred item, as understood here). A retained conversation or context flow records the `t` of the observation it came from and stays frozen at it: rereading it uses `thread` (or `history` with its criteria) at that explicit `t`, so a retained unit never mixes rows from two snapshots, and `missingReplyTargets` replaces inferred missing anchors. Accepting the current unit moves to the current `t`. A refresh whose head `t` is unchanged is a no-op observation.
- **Verification.** The reader test above, server tests for the new envelope mapping, Storybook plays for "older entries exist", undecodable and moved-head states, and the connected browser lane against a throwaway bus. [Viewer](../architecture/viewer.md) rule 5 and the runbook change with it.

## Evidence register

| Claim | Basis |
| --- | --- |
| Path pin reads the whole ledger at `t`; body time must agree; `to` refused on a pinned path | documented, `concepts/time-travel.md#pinning-the-ledger-in-the-request-path`, `api/endpoints.md#post-queryledger`; agreement and pinned count verified live |
| Future `t` waits then 408; `@t:0` is empty | verified live (408 after 5.0 s; empty bindings); wait cap documented, `operations/configuration.md#query-timeout` |
| UPDATE refused on the query route in three encodings | verified live |
| Other ledger via `FROM`/`FROM NAMED` is "Ledger mismatch"; same ledger at another `t` is "Time pin conflict" | verified live; documented, `api/endpoints.md#post-queryledger` |
| Local SERVICE to a ledger outside the dataset fails; SILENT returns empty; `GRAPH <other>` returns empty | verified live; SERVICE dataset requirement documented, `query/sparql.md#requirements` |
| Agent JSON: `t` on single-ledger SELECT, byte budget with `hasMore`, 406 for CONSTRUCT/DESCRIBE, bare boolean for ASK | verified live; budget semantics documented, `query/output-formats.md#agent-json-format` |
| `f:t` via RDF-star on a pinned non-history SPARQL query; `bus:replyTo*` in SPARQL and as JSON-LD `@path` | verified live |
| JSON-LD `@t` binding with `filter` on it, multi-variable `values`, typed `xsd:dateTime` values, `selectDistinct` over unions, `optional` lookup | verified live |
| `groupBy` with `bind (subStr (str ?ts) 1 13)` and `count-distinct`; `str` of a stored dateTime is UTC `Z` form | verified live |
| Full-text scoring at a pinned `t` | verified live (ledger with the full-text config) |
| Client disconnect cancels the running query | documented only, `operations/configuration.md#query-timeout` |
| Saved-query execution, closed args, `LIMIT n+1`, byte trimming, explicit oversize failure, `currentHeadT`, cursor binding | read in code (archive MCP prior art) |
| Former bus SELECT: pinned route, Agent JSON with a byte budget, 10 s deadline, `sparqljs` regeneration | read in code (this repository's history before the refusal) |

All live checks ran on one disposable file-backed server with no authentication, synthetic ledgers and a random high port, stopped by its process id afterwards. The running bus and its Fluree server were not touched. Authentication does not change query semantics in the documented model; the implementation's tests run the same matrix on the authenticated throwaway server.

## Open questions for cross-review

1. **CONSTRUCT.** Raw v1 admits SELECT and ASK only: Agent JSON is unavailable for CONSTRUCT (406), so it would need a second result shape and its own byte handling. Is a graph result needed for the consumer job?
2. **In-ledger graphs.** Should `FROM <txn-meta>` (commit metadata) be admitted? It is read-only and inside the bus ledger; v1 keeps every dataset clause closed.
3. **Error passthrough.** Is the allowlist of Fluree query-error text acceptable, or should raw errors stay status-only?
4. **Presence private fields.** Saved rows omit `session`, `codexThreadId`, `takeover` and `rejoinOf`; raw SPARQL can still read `bus:json`. Keep that split, or expose them in saved rows too now that the public-data premise is withdrawn?
5. **director-dm-volume.** Check the restated definition against the parent frame, especially `excludeTopics`, midnight alignment and refusing a director inside the cohort.
6. **Missing Fluree in `bun run check`.** Fail (proposed, since queries become core) or skip like the existing store matrix?
7. **Read-only token.** A separate read-scoped Fluree token for the gateway would make "no path to a transaction" structural rather than three layers deep. It is an operator and configuration change, so it needs the owner; propose deferring it.
8. **Thread scope.** Whole reply tree (proposed) or only the lineage (ancestors plus descendants of the focus)?
9. **Predicate-only aggregates.** Acceptable that `counts` and `director-dm-volume` do not detect undecodable `bus:json`?
10. **Versioning granularity.** One catalogue version (proposed) or one per operation, which would keep unrelated cursors valid across releases?
11. **Byte cap.** Fixed 64 KiB for every caller (proposed), or a per-call `maxBytes` the viewer could raise?
12. **Presets.** Keep `bus_history` and `bus_peers` as permanent presets (proposed), or set a removal gate?
13. **PR 15's deferred items.** Confirm that "bounded-window disclosure" and "retained-flow freezing" mean what the viewer section assumes.
14. **Dependency.** Re-adding `sparqljs` 3.7.4 and `@types/sparqljs` 3.1.12 is the lead's call; the alternative, relying on Fluree's own parser and the route's refusals alone, cannot refuse `SERVICE SILENT` or strip `# PRAGMA` before the server sees them.
15. **`search` in catalogue v1.** Added so text search has one definition for `bus_history` and the viewer; the brief's v1 list did not name it.
