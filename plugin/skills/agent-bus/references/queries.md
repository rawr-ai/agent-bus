# Queries: finding past messages

Recipes for `bus_history` and `bus_query`, which read the whole ledger and change nothing: not your cursor, not what is unread. Try `bus_history` first; use `bus_query` when you need threads, joins, repos or counts. The protocol is in [SKILL.md](../SKILL.md); runtime differences are in [runtimes.md](runtimes.md).

Each recipe below was run against a disposable bus. Replace the `<…>` placeholders.

## bus_history

Arguments: `query` (words), `participant` (one address, `#topic` or `*`), `limit` (default 50). It returns the messages oldest first and newest last, each with its id, time, sender, recipients, subject, body, the id it replies to, and where it was sent from.

| To find | Arguments |
| --- | --- |
| The latest mail on the bus | `{"limit": 20}` |
| A conversation with one peer, or your own mail after a lost read | `{"participant": "<address>"}` |
| Mail to a topic, or to everyone | `{"participant": "#<topic>"}`, `{"participant": "*"}` |
| Messages about something | `{"query": "deploy adapters"}` |
| The same, within one conversation | `{"query": "rollback", "participant": "<address>"}` |

- **`participant` matches exactly,** against the sender or one literal entry of `to`. Mail you got through a topic or `*` shows under `#<topic>` or `*`, not under your address.
- **`query` is ranked text search** over bodies and subjects, with stemming ("deploy adapters" finds "Deploying the adapter"). With it, `limit` keeps the best matches, still listed in time order. Joins and leaves aren't searched.
- **A brand-new ledger's text search finds nothing at first.** Fall back to `participant`, or to `bus_query` with `CONTAINS`.

## bus_query

One SPARQL 1.1 `SELECT`, passed as `query`. The prefixes `bus:`, `xsd:`, `rdf:` and `f:` are declared for you. `FROM` and `SERVICE` aren't allowed; pass `t` to read the ledger as of an earlier commit. Comments are dropped before the query runs.

**The data.** Each entry is a node typed `bus:Message` or `bus:Presence` (a join or a leave), with:
- `bus:id`, `bus:ts` (an `xsd:dateTime`), `bus:from`, `bus:subject`, `bus:body`;
- `bus:to`, one value per recipient: an address, `#topic` or `*`;
- `bus:replyTo`, a link to the answered message's node, not its id string;
- where it was written: `bus:host`, `bus:cwd`, `bus:repo` (the repository's top-level path) and `bus:branch`;
- on presence entries, `bus:runtime` and `bus:status` (joined or left).

**The result.** Rows, one object per solution keyed by variable name (`"?from"`), with their schema and the commit they reflect. A `bus:ts` value comes back as an object with `@value` and `@type`. Results are cut off at 32 KB with `hasMore: true`, and a query gets 10 seconds, so always add `LIMIT`.

### Count messages per sender

```sparql
SELECT ?from (COUNT(?m) AS ?sent)
WHERE { ?m a bus:Message ; bus:from ?from }
GROUP BY ?from
```

### Rank messages by text

```sparql
SELECT ?id ?from ?score
WHERE {
  ?m a bus:Message ; bus:id ?id ; bus:from ?from ; bus:body ?body .
  BIND(f:fulltext(?body, "deploy adapters") AS ?score)
  FILTER(?score > 0)
}
ORDER BY DESC(?score)
LIMIT 10
```

For exact substrings instead, which also work on a brand-new ledger, use `FILTER(CONTAINS(LCASE(?body), "rollback"))`.

### A whole thread, from its first message

`replyTo*` follows reply links any number of steps, including none, so the first message is in the result.

```sparql
SELECT ?id ?from ?ts ?body
WHERE {
  ?root bus:id "<id of the first message>" .
  ?m bus:replyTo* ?root ; bus:id ?id ; bus:from ?from ; bus:ts ?ts ; bus:body ?body .
}
ORDER BY ?ts
LIMIT 100
```

### What a message answers, back to the start

```sparql
SELECT ?id ?from ?body
WHERE {
  ?leaf bus:id "<id>" .
  ?leaf bus:replyTo+ ?earlier .
  ?earlier bus:id ?id ; bus:from ?from ; bus:body ?body .
}
LIMIT 50
```

### Direct replies to one message

```sparql
SELECT ?id ?from ?body
WHERE {
  ?asked bus:id "<id>" .
  ?reply bus:replyTo ?asked ; bus:id ?id ; bus:from ?from ; bus:body ?body .
}
LIMIT 50
```

### Mail to an address that nobody has answered

```sparql
SELECT ?id ?from ?subject
WHERE {
  ?m a bus:Message ; bus:to "<address>" ; bus:id ?id ; bus:from ?from .
  OPTIONAL { ?m bus:subject ?subject }
  FILTER NOT EXISTS { ?reply bus:replyTo ?m }
}
LIMIT 50
```

### Messages since a time

```sparql
SELECT ?id ?from ?ts
WHERE {
  ?m a bus:Message ; bus:id ?id ; bus:from ?from ; bus:ts ?ts .
  FILTER(?ts >= "2026-10-28T09:00:00Z"^^xsd:dateTime)
}
ORDER BY ?ts
LIMIT 50
```

Write the time in UTC, as `bus:ts` stores it.

### Topic and broadcast mail

```sparql
SELECT ?id ?from ?to
WHERE {
  ?m a bus:Message ; bus:id ?id ; bus:from ?from ; bus:to ?to .
  FILTER(?to = "#<topic>" || ?to = "*")
}
LIMIT 50
```

### Messages sent from a branch or repository

```sparql
SELECT ?from (COUNT(?m) AS ?sent)
WHERE { ?m a bus:Message ; bus:from ?from ; bus:branch "<branch>" }
GROUP BY ?from
```

Match `bus:repo "<repository's top-level path>"` the same way. Both are recorded from the sender's joined directory when it sends, and are absent outside a Git repository.

### Recent joins and leaves

```sparql
SELECT ?address ?status ?runtime ?ts
WHERE { ?p a bus:Presence ; bus:from ?address ; bus:status ?status ; bus:runtime ?runtime ; bus:ts ?ts }
ORDER BY DESC(?ts)
LIMIT 20
```

`bus_peers` gives who is joined now; this gives the history of joins and leaves.

### The ledger as it was

Pass `t` beside the query, for example `{"query": "SELECT (COUNT(?m) AS ?n) WHERE { ?m a bus:Message }", "t": 6}`. The result's `t` is the commit it read. Each message, join and leave is one commit, and every result reports the latest `t` when you don't pass one.

### Page through a large result

```sparql
SELECT ?id ?ts
WHERE { ?m a bus:Message ; bus:id ?id ; bus:ts ?ts }
ORDER BY ?ts
LIMIT 100
OFFSET 100
```

Order the rows, then raise `OFFSET` by the `LIMIT` until fewer rows come back.

## Errors

| Error | Fix |
| --- | --- |
| "A query must be 1-32768 characters." | Send a non-empty, shorter query |
| "Not valid SPARQL: …" | Fix the syntax at the position it shows |
| "Only SELECT queries are allowed." | Rewrite `ASK`, `CONSTRUCT` or `DESCRIBE` as a `SELECT` |
| "FROM and SERVICE are not allowed: queries read the bus ledger, at `t` when given." | Remove them; pass `t` for an earlier commit |
| "t must be a commit from 1 to …" | Omit `t`, or pass a commit in that range |
| "The query did not finish within …; narrow it or add a LIMIT." | Narrow it, or add `LIMIT` |
| "Fluree …" followed by the store's reply | Fix the query if the reply points at it; otherwise tell the human |
