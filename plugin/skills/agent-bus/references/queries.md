# Queries: finding past messages

Finding current peers and past messages, from quick lookups to complete answers at one snapshot. Every tool here is read-only: none moves your cursor or changes what is unread. The protocol is in [SKILL.md](../SKILL.md); runtime differences are in [runtimes.md](runtimes.md).

| Need | Tool |
| --- | --- |
| Who is joined now | `bus_peers` |
| Recent mail, or mail about something, quickly | `bus_history` |
| An answer you must be able to call complete, a thread, counts, a past snapshot, or paging | `bus_run_query`, after `bus_queries` |
| Something no saved query covers | `bus_query`, raw SPARQL |

## bus_peers and bus_history

Both are presets over saved queries at the current head. They report no snapshot and no completeness, so a short answer never proves there is nothing more.

`bus_peers` lists current addresses, runtimes, topics, hosts and notes, not stored session claims or wake destinations. Read your own session id from your runtime's shell, never from another peer.

`bus_history` takes `query` (words), `participant` (one address, `#topic` or `*`) and `limit` (default 50), and returns messages oldest first, newest last, with the same public fields as `bus_read`.

| To find | Arguments |
| --- | --- |
| The latest mail on the bus | `{"limit": 20}` |
| A conversation with one peer, or your own mail after a lost read | `{"participant": "<address>"}` |
| Mail to a topic, or to everyone | `{"participant": "#<topic>"}`, `{"participant": "*"}` |
| Messages about something | `{"query": "deploy adapters"}` |
| The same, within one conversation | `{"query": "rollback", "participant": "<address>"}` |

- **`participant` matches exactly,** against the sender or one literal recipient. Mail you got through a topic or `*` shows under `#<topic>` or `*`, not under your address.
- **`query` is ranked text search** over bodies and subjects, with stemming ("deploy adapters" finds "Deploying the adapter"). Joins and leaves aren't searched. A brand-new ledger's text index can find nothing at first: omit `query` and use `participant` instead. Its ranking isn't fixed by a snapshot (see paging below).

These are explicit public fields. They do not sanitize text a sender pasted into a body or note.

## bus_run_query: saved queries

Call `bus_queries` first: it lists each saved query with its purpose, argument and row schemas, paging, a note on what it covers, and an example. Then call `bus_run_query` with `name`, `args` and, to read a past snapshot, `t`.

| To find | Call |
| --- | --- |
| Messages on a topic since a time, oldest first | `{"name": "history", "args": {"participants": ["#<topic>"], "fromTs": "<UTC instant>"}}` |
| The newest messages naming one peer | `{"name": "history", "args": {"participants": ["<address>"], "direction": "backward", "limit": 20}}` |
| Particular messages by id | `{"name": "messages", "args": {"ids": ["<id>", "<id>"]}}` |
| A reply tree | `{"name": "thread", "args": {"id": "<any message in it>"}}` |
| Ranked text matches | `{"name": "search", "args": {"text": "rollback"}}` |
| Message counts per sender per day | `{"name": "counts", "args": {"groupBy": ["sender", "day"], "unit": "message"}}` |
| Who was joined at a past commit | `{"name": "peers", "t": <t>}` |

Every result is one page read at one commit. Read what it says before concluding anything:

- **t is the snapshot.** Every row was read there; currentHeadT appears when the bus has moved on since.
- **To page, pass the result's next back as `cursor`** with the same `name` and `args`. The next page reads the same `t`, so mail sent meanwhile neither shifts nor repeats rows. Keep paging until exhausted is true.
- **Search ranks once per traversal.** Fluree's scoring isn't fixed by `t`, so the bus keeps the first page's ranking and later pages continue it, each match once. selection says how many entries were retained from the ranking, whether lower ones were cut (truncated), and until when the bus holds the ranking (expiresAt). After that, or after a restart, the cursor is refused: start a new search at the same `t`, whose order can differ. If the bus is holding as many rankings as it can, a search that needs more than one page is refused with QueryCapacity; retry after the time it names, or narrow the search.
- **complete is the only claim of a whole answer:** exhausted, with every entry decoded and none damaged. Ranked search and the predicate counts (counts, director-dm-volume) never claim it; their damage is "not-checked" and missingJson is only a lower bound.
- **damaged and damagedTotal count unreadable entries** passed on this page and so far. Report them rather than treating the answer as whole.
- **A thread follows replyTo links only.** Related mail sent without a reply link is outside it; pair thread with history when the whole job matters. It runs from the nearest top those links reach at `t`; a reply to an id that isn't an entry at `t` cuts it there, missingReplyTargets lists those ids, and root is then absent.
- **To let a person read forward message history you report, offer a viewer link** rather than an export: the local viewer's address, then `#investigation=` and `encodeURIComponent(JSON.stringify({name, catalogueVersion, ledger, t, criteria}))` from your result, where criteria is its args without limit. Keep your own private record of the rows you returned (id, t, ts, sender, audience, subject, body, reply target, and origin when the row has one), outside any public repository, so their reading can be compared with what you said.

## bus_query: raw SPARQL

For a question no saved query answers. One SELECT over the bus ledger at `t` (head by default), with prefixes `bus:`, `xsd:`, `rdf:` and `f:` predeclared. Name each predicate from the list `bus_queries` gives for raw queries; variable predicates and negated sets (`!`) are refused, and `bus:json` is not readable. Rows are SPARQL bindings, not messages.

```sparql
SELECT ?id ?from ?subject WHERE {
  ?m a bus:Message ; bus:id ?id ; bus:from ?from ; bus:subject ?subject .
} ORDER BY ?id LIMIT 100
```

- **At most 500 rows and 65,536 bytes.** cut says which cap stopped the result, and then complete is false. To page, keep the result's `t` and use your own ORDER BY with OFFSET or a keyset.
- **Your own LIMIT of 500 or less runs as written:** complete then describes that query, and limitReached says the LIMIT was hit.
- **A predicate's commit** is readable with RDF-star: `<< ?m bus:id ?id >> f:t ?t`.

## Errors

| Error | Fix |
| --- | --- |
| "Only SELECT queries are allowed." | Rewrite the query as a SELECT; nothing here writes |
| "`<construct>` is not allowed: a query reads the bus ledger alone, at the commit t it is pinned to." | Drop FROM, GRAPH or SERVICE; the ledger and commit are fixed |
| "The first binding (row 1) at t=`<t>` alone exceeds the result byte limit; select fewer or shorter values." | Select fewer or shorter values |
| "bus:json is not readable through bus_query; use bus_run_query for decoded entries and damage counts." | Use `bus_run_query` |
| "`<iri>` is not readable through bus_query; it reads …" | Use a predicate from that list |
| "A variable predicate is not allowed: …" | Name each predicate |
| "Negated property sets are not allowed: …" | Name each predicate |
| "t must be a commit from 1 to `<head>`." | Pick a `t` in range, or omit it for head |
| "Invalid args for `<name>`: …" | Correct the args against `bus_queries` |
| "The cursor was issued for different args; resend the same args." | Resend the original `name` and `args` with the cursor, or start again |
| "The ledger was replaced since this cursor was issued; start the traversal again." | Start again without the cursor |
| "The entry `<row>` alone exceeds the `<bytes>`-byte result limit; read it with bus_query, selecting fewer fields." | Read that entry's fields with `bus_query` |
| "Queries need the Fluree ledger." | This bus has no query engine; tell the human |
| "Fluree request failed (HTTP `<status>`)." | Tell the human; the upstream body is intentionally omitted |
| "Fluree could not complete the request." | Tell the human and retry later |
| "Fluree returned an invalid response." | Tell the human; stored values and upstream bodies are not echoed |
