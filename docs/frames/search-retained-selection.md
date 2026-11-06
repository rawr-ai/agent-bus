# Search retained selection

2026-11-05. Design and qualification of stable ranked paging for `search`. Current contracts belong to [interfaces](../architecture/interfaces.md#bus_run_query), where state lives to [topology](../architecture/topology.md#where-state-lives), and the Fluree findings it rests on to [Fluree](../platforms/fluree.md#query-limits).

## Problem

`search` paged by offset over a ranking that every page evaluated again. Fluree 4.2.4 scores full text from the current index's corpus statistics, not from statistics fixed by the pinned `t`, so two evaluations at one `t` can order matches differently. A traversal's later pages could then repeat or omit matches. The earlier contract said so and called stable ranked paging the intended outcome, not yet guaranteed.

## Decision

Evaluate the ranking once per traversal and keep only what that evaluation decided.

- **One grouped evaluation.** The first page runs one query grouped by each entry's commit and id: its best score and every node that formed it, ordered by score, then commit, then id, limited to the entry bound plus one. The extra row says whether lower-ranked matches were cut.
- **A descriptor, never text.** The kept selection is each entry's commit, id, score and node names. Every page, the first included, reads its own entries' stored JSON from the ledger by those nodes and checks each returned row against the kept commit and id. A missing match is a ledger error, never a silent gap. Message text stays only in the ledger.
- **Held by the serving process.** A traversal that needs more than one page is held in `serve`'s memory under a random 22-character handle, bound to the ledger incarnation, `t`, the normalized arguments and the page size. Its cursor carries the handle and a search revision. A cursor without a held selection, from another ledger, with other arguments or another revision is refused.
- **Absolute expiry.** A held selection lasts 10 minutes from its first page, its final page included, so any cursor it issued can be passed again for the same page until then; repeating the first request starts a new ranking. Expiry, a restart or another server ends it, and a new search must start.
- **Bounded, and refused rather than shortened.** One selection keeps at most 1,000 entries, 2,000 nodes and 256 KiB of descriptor. The process holds at most 128 selections and 32 MiB. Checking room and inserting happen in one step. A search that needs another page when there is no room is refused with `QueryCapacity` before any result, naming when room returns; a search that fits one page still runs whatever the room. A ranking over its own bounds is refused with `QueryCapacity` even when it would fit one page.
- **Ledger replacement reclaims at expiry only.** A replaced ledger's selections are refused at once by their incarnation, but each keeps its share of room until its own expiry.
- **`bus_history` holds nothing.** Its text form pages one ranking within one call through a call-scoped store, of at most 10,000 entries and 4 MiB whatever its `limit`, so its ranking query never asks Fluree for more than 10,001 rows. That bounds the selected and returned state, not Fluree's own full-text work, and fails with `QueryCapacity`, rather than return fewer messages than asked, when its ranking had to be cut and still yields too few readable ones. When the matches themselves run out, it returns what there is.
- **The envelope says what was kept.** A search page carries `selection`: the entries retained, whether lower-ranked matches were cut, and, while held, `expiresAt`. `exhausted` then means the end of the ranking, not of the matches.

## Rejected alternatives

| Alternative | Why not |
| --- | --- |
| Re-evaluate per page, by offset or a score keyset | The scores themselves move between evaluations at one `t`, so no position over them is stable. |
| Pin the index statistics to `t` | Not offered by Fluree 4.2.4. |
| Keep whole pages or message bodies | Holds message text outside the ledger, and skips each page's decoding and damage report. |
| Persist selections in the ledger or on disk | Writes query state into the append-only message store, or adds a second store, to survive a restart that a clear refusal already handles. |
| Shorten, evict the oldest or re-rank when full | Each one silently changes a ranking a caller already holds. A refusal that names the retry time keeps every issued page true. |
| Reclaim a replaced ledger's room at once, through an incarnation epoch | It needs extra ordering and invalidation, so that a late request from the old incarnation cannot evict newer state. The bounded expiry already returns the room. |
| Match hydration on (node, commit, id) in the query | Binding the node alone and checking the commit and id in code is relationally equivalent under the whole-response gateway, and simpler. |
| Hold `bus_history`'s ranking in the process store | One call needs no later pages, so it would only take room from traversals that do. |

## Qualification

Bounded and clock-driven; no claim beyond these.

- **Exact ranking.** Against a stub ledger whose scores change with each evaluation and that honours the pinned `t`, limit-1 pages equal the single evaluation's order, scores and commits exactly, and differ from a second evaluation's. A page trimmed to its byte budget continues the same evaluation in order. Each page reads only its own entries.
- **Real Fluree.** On a fresh ledger: exact entry sets and node shapes from the grouped query, including an entry whose nodes score differently; the cut at the bound equal to the ranked slice; exact hydration tuples, nulls included; parity with valid and damaged entries; writes after `t` not leaking; and a hand-built pre-change history cursor continuing identically.
- **Cursors.** Legacy, foreign, other-argument and other-revision cursors are refused. A held page replays at 9 minutes and is refused at 10.
- **Admission.** Bounds and records caps refuse before any result. Concurrent admissions, interruption, failed reads and bursts of abandoned traversals never exceed the store. After a ledger replacement, room returns only at expiry.
- **Policy.** With the process policy on a test clock, a viewer refreshing every 15 seconds and abandoning two maximum-size selections each time holds 80; 32 more fit; the 129th is refused, naming the earliest expiry; a selection one byte over its own bound is refused; room returns at expiry. Over 120 refreshes (240 admissions, almost twice the store), the rolling expiry keeps up with that viewer, every admission succeeds, and the store then holds exactly the last 10 minutes' 80.
- **Viewer.** Through the real bus, a search over several calls returns every match once; with the store's held count accounted for exactly, the refusal comes at the policy's capacity, a traversal held before it still continues, and a one-call search still runs. A truncated ranking is shown as its matches only, ranked and never complete.
- **Clients with an older schema.** Real search pages validate with the MCP SDK's own validator against both the advertised result schema and the schema without `selection`; the envelope's only change is that optional key.
- `bun run check` passed: typecheck, lint, every test and the documentation check.

No merge, deployment or service change is part of this qualification.

## Accepted limits

- Held selections live in one process and end at a restart, with their cursors refused.
- A ledger replacement's selections keep their room until expiry; nothing reclaims it earlier.
- At capacity, a search that needs more than one page is refused until room returns.

## Moved into current docs

- [x] Contract: the `search` note, the `bus_run_query` and `bus_history` tool descriptions, the envelope's `selection`, and [interfaces](../architecture/interfaces.md#bus_run_query) with its [limits](../architecture/interfaces.md#limits).
- [x] Rule: [topology](../architecture/topology.md#where-state-lives): held rankings in `serve`'s memory, what they hold, and what a restart costs.
- [x] Agent guidance: the [query reference](../../plugin/skills/agent-bus/references/queries.md): rank once per traversal, `selection`, and what to do on `QueryCapacity`.
- [x] Platform claim: [Fluree](../platforms/fluree.md#query-limits): scores not fixed by `t`, and one grouped evaluation naming every node of an entry.
- [x] Procedure: [operate](../runbooks/operate.md) and [deploy](../runbooks/deploy.md): a `serve` restart ends held search rankings.
