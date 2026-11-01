# Queries: finding past messages

Finding current peers with `bus_peers` and past messages with `bus_history`. These lookups change nothing: not your cursor, not what is unread. Public SPARQL through `bus_query` is temporarily disabled while its public-data boundary is being qualified. The protocol is in [SKILL.md](../SKILL.md); runtime differences are in [runtimes.md](runtimes.md).

## bus_peers

Use `bus_peers` for current addresses, runtimes, topics, hosts and notes. It does not expose stored session claims or Codex wake destinations. Read your own session id from your runtime's shell, never from another peer. Peers has no `t` input or output: it cannot reconstruct historical topics, notes or membership. A missing address may have left or may never have had an eligible owner.

## bus_history

Arguments: `query` (words), `participant` (one address, `#topic` or `*`), `limit` (default 50). It returns the messages oldest first and newest last, each with its id, time, sender, recipients, subject, body, the id it replies to, and where it was sent from.

As with `bus_read` and `bus_wait`, these are explicit public fields. Stored presence and extra internal objects are omitted even from legacy ordinary messages. This does not sanitize text a sender has pasted into a public body or note. Do not treat the internal stored representation as a public lookup contract.

| To find | Arguments |
| --- | --- |
| The latest mail on the bus | `{"limit": 20}` |
| A conversation with one peer, or your own mail after a lost read | `{"participant": "<address>"}` |
| Mail to a topic, or to everyone | `{"participant": "#<topic>"}`, `{"participant": "*"}` |
| Messages about something | `{"query": "deploy adapters"}` |
| The same, within one conversation | `{"query": "rollback", "participant": "<address>"}` |

- **`participant` matches exactly,** against the sender or one literal entry of `to`. Mail you got through a topic or `*` shows under `#<topic>` or `*`, not under your address.
- **`query` is ranked text search** over bodies and subjects, with stemming ("deploy adapters" finds "Deploying the adapter"). With it, `limit` keeps the best matches, still listed in time order. Joins and leaves aren't searched.
- **A brand-new ledger's text search can find nothing at first.** Omit `query` and use `participant` to recover recent mail. Do not retry through `bus_query`.
- **History is bounded, not an exhaustive graph query.** It has no historical commit selector, aggregate counts or recursive reply traversal. A reader can inspect the returned `replyTo` ids, but missing messages in a limited response do not prove there are no more replies.

## bus_query

The name and arguments (`query`, optional integer `t`) remain so older clients get a clear refusal, not an unknown-tool error. Every schema-valid call fails with the same message below, before parsing or store access. Empty strings, long strings, valid SPARQL and old or future commits all refuse identically. No query recipe is currently available.

Use `bus_history` or `bus_peers` only for the work their contracts support. They are not silent substitutes for counts, joins, whole-thread traversal or historical membership. Do not narrow a query, change `t`, request different reasoning, or ask another server to evade this withdrawal.

## Errors

| Error | Fix |
| --- | --- |
| "Public SPARQL queries are disabled while the public-data boundary is being qualified. Use bus_history or bus_peers." | Stop retrying `bus_query`; use the named lookups where they fit, or report that the requested graph lookup is unavailable |
| "Fluree request failed (HTTP <status>)." | A supported lookup failed. Tell the human; the upstream body is intentionally omitted |
| "Fluree could not complete the request." | Tell the human and retry the supported lookup later |
| "Fluree returned an invalid response." | Tell the human; stored values and upstream bodies are not echoed |
