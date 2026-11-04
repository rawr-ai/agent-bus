# Frame: reading an agent's pinned evidence in the viewer

This frame scopes the next viewer outcome of the [viewer query integration](turnaround-viewer.md): a reader opens the exact history evidence an agent returned and reads it in the viewer. The released viewer's rules are in [viewer](../architecture/viewer.md) and its procedures in [interfaces](../architecture/interfaces.md#viewer); the query contract it reuses is [`bus_run_query`](../architecture/interfaces.md#bus_run_query).

Status: proposed for cross-review, 2026-11-03; no implementation, deploy or adoption. DRA: Claude lead, cross-reviewed by Codex. Mode: co-framing; object: solution. It extends one bounded release decision deliberately (below) and changes no bus behaviour.

## Consumer job

An agent answers a coordination question from a fixed cut and reports what it found. Its reader, today the owner, wants to read that same ordered evidence without asking the agent for an export or a briefing. The [query release](query-viewer-release-2026-11-02.md) proved the agent half once: a fresh executor reconstructed 83 messages at one snapshot through `history` cursor pages. The released viewer cannot open that evidence. It reads only the newest 200 entries, or ranked matches, at whatever commit is current. It never continues past one window, and the browser cannot name a past commit.

That 83-message job is the qualification benchmark: ledger incarnation `bagay…7nya` at `t` 3014, `history` with `fromTs` 2026-11-01T17:31:12.174Z, `toTs` 2026-11-01T21:46:00.542Z, `kinds` `[message]`, `direction` `forward`, page size 200 and no participant filter. The bus recorded that identity, not the rows. A raw `bus_query` count at `t` 3014 over that window on 2026-11-03 still returned 83 on the same incarnation. Re-reading the case qualifies the mechanism; it is not adoption, because that job is finished.

## Minimal capability

A **pinned investigation** is one typed, closed request: the reference an agent already holds from its own `bus_run_query` result. That is `name` `history`, `catalogueVersion`, `ledger`, `t` and the history criteria (`fromTs`, `toTs`, `kinds`, `direction`, `participants`). No other operation, free SPARQL or forwarded MCP call is accepted. The viewer reads it at that commit through `history` cursor pages and shows the result. It reuses the existing conversation projection over those records, and it reads a selected reply tree at the same commit.

- **Shared definition.** The viewer validates the criteria with the same schema the catalogue uses, extracted to a module both import, so the viewer and the bus cannot disagree about what a valid argument is. The extraction changes no bus behaviour; the catalogue's own tests guard it.
- **Separate from live reading.** The live history, peers and thread observations, the automatic 15-second refresh and their labels keep their current meaning. An investigation is a separate reading with its own identity, and refresh never touches it.
- **Handoff.** The agent passes the reference as a viewer link; the viewer holds the reference in its URL, never message content. Agent guidance gains one line saying when to offer it.

## Bounds, identity and stops

- **Paging.** The browser requests one page per call through a fourth fixed procedure, passing the bus's opaque `next` back unchanged. Each call keeps the existing 10-second upstream deadline and 4,096-byte request body. The server keeps no traversal state, and the bus's cursor binding refuses a changed argument or a replaced ledger.
- **Identity check.** The server checks that every page's `ledger`, `t`, `name`, `catalogueVersion` and echoed normalised criteria equal the reference. A mismatch on any page fails the investigation rather than joining it. This is new validation: the live projection compares only `ledger`, `t`, continuation and status. Criteria reach the bus verbatim and are compared with the bus's echo, never re-encoded by the viewer. The bus takes no ledger argument, so incarnation is checked after each read, as `thread` already does.
- **Entry bound.** One investigation holds at most 200 entries, the existing history limit. Every page holds at least one row, so this also bounds pages. It is not raised in this unit. A reader who hits the bound sees a stop, and a need past it is measured before the bound changes.
- **Concurrency.** One investigation runs at a time, holding at most one of the eight upstream permits, so live observations keep at least seven.
- **Progress and cancellation.** The reader sees pages and entries as they arrive and can cancel. After a cancel or a failed request, the pages already read stay on screen, labelled as partial with the reason, never as the answer.
- **Stops are not exhaustion.** The investigation is complete only when the bus says `exhausted` with `damage` `checked`, `damagedTotal` 0 and no viewer omissions. Reaching the entry bound, a deadline, a byte refusal, cancellation, damage or an omitted record each stops the reading with its own label and the count read so far. None of them is shown as the whole window. A forward reading stopped early is labelled as the earliest part of the window; the live path's `latest` label is true only for a backward read. A stopped reading makes no damage claim beyond its cut.
- **Identity on screen.** The investigation shows the ledger, commit, catalogue version and criteria it was read with, and how many entries, omissions and damaged entries it found. Page size is recorded but excluded from evidence identity, because it moves page boundaries, not the record set.

## Rules this unit supersedes

These are deliberate extensions of the bounded first release, named here so review can accept or refuse each one:

1. [Viewer rule 1](../architecture/viewer.md#rules): "Viewer business calls are exactly … `history`, `search`, `peers` and `thread` operations, with server-fixed arguments; a thread is read at the commit the browser names, which must be one the bus already reported." An investigation lets the browser name a commit from an agent's reference, which the viewer may never have reported, and it carries criteria within the closed history set. The bus still validates `t` from 1 to head.
2. [Viewer rule 5](../architecture/viewer.md#rules): "History is a bounded newest or best-match selection at one commit." An investigation adds a third kind: a criteria-bounded window at a named commit, followed to exhaustion or a labelled stop.
3. [Viewer limits](../architecture/viewer.md#limits): "There is no complete-history pagination past one window (200 entries, eight pages) … the browser cannot pick an arbitrary past commit." Both change for investigations only, within the 200-entry bound.
4. [Viewer interfaces](../architecture/interfaces.md#viewer): "Its only RPC paths are `POST /rpc/history`, `POST /rpc/peers` and `POST /rpc/thread`" and `history` has "no cursor". A fourth fixed path carries one investigation page and its cursor.

Unchanged: [rule 7](../architecture/viewer.md#rules) (nothing persisted, no unbounded archive) and the 200-entry live window. Also unchanged are the transport, origin and body rules, and the projection, omission and damage rules.

## Non-claims

- **Not an audit product.** It does not establish authentic or complete historical reconstruction, historical membership, delivery or reading. A complete investigation is complete for its criteria at its cut, nothing wider.
- **Not provider-independent.** The agent and the viewer read through the same pinned JSON-LD gateway family. Raw SPARQL is a different query shape over the same provider. Neither is independent evidence that the provider returned every entry. History and thread are not known to share the orientation defect, and they are not shown to be insulated from it. The stopped provider diagnostic stays stopped.
- **Search is not history.** Ranked search exhaustion is never complete history. A reply tree's completeness excludes coordination that carried no reply links.
- **A window at a cut.** The time window selects by recorded `ts` as of `t`. Entries committed after `t` are absent even when their `ts` falls inside the window.
- **Cancellation is the viewer's.** Cancelling stops the viewer's requests; it does not prove Fluree stopped its work. Nothing is shown about production ledger size or load.
- **Not adoption.** Mechanism qualification, a re-read of the finished benchmark and any coached or operator-run reading do not count as adoption.

## Qualification

Shaped with the testing-design steward before code. Each check names the claim it can falsify. The layers are the existing ones: a real `serve` on a throwaway Fluree, the fake upstream in `test/bus-pages.ts`, Storybook plays on production components, and one local Stagehand journey.

| Check | It falsifies | Layer and oracle |
| --- | --- | --- |
| Equivalence | The investigation returns other ordered records, material content or terminal claims than the agent path. | Real `serve`. Three oracles: the seeded expectation the test wrote; a differential against the MCP SDK client following `bus_run_query` itself; and a metamorphic run at page size 200 and 7, which must give identical records and claims. Seeds cover two or more byte-cut pages, presence rows, an entry exactly at `fromTs` (kept) and one exactly at `toTs` (dropped), and entries sharing a commit. |
| Stop is not exhaustion | Any stop is shown as complete, or as `latest` on a forward read. | Fake upstream for each stop: the entry bound, a deadline, a byte refusal, an omission and cancellation. One real case seeds damage after the stop point and checks that no zero-damage claim is made for the window. |
| Cancellation and progress | Cancelling leaves a page running or starts another, or progress overstates what arrived. | Fake upstream with controlled timing. The fake's call record shows page k aborted and k+1 never started, with its permit freed. While an investigation runs, a live history read still succeeds within its deadline. |
| Identity | A wrong incarnation, `t`, `name`, `catalogueVersion` or criteria is joined. | Fake upstream for each field, including a mismatch on page 2 only. Real `serve` for `t` past head and a ledger the bus does not serve. |
| Damage and omission | Bus damage and viewer omissions are merged or hidden. | Real `serve` with raw damaged entries; fake duplicate ids. |
| Live path | The live observations change meaning. | The existing suites and plays, unmodified. Live `history` still refuses investigation fields. Any edited live assertion records its reason. |
| Rendered states | A screen shows a claim it does not have. | One play per terminal state: complete, readable with damage, each stop, cancelled with partial progress, identity failure and omission. "Complete" never appears beside a stop, and the identity header is always visible. |
| Journey | The connected flow does not work. | One local Stagehand run on the synthetic fixture: open a reference, see progress, cancel and rerun to exhaustion. It proves wiring, never what the provider holds. |

Every oracle through the bus shares its provider, so agreement with the agent path is equivalence, not correctness. Re-reading the benchmark is a read-only call on the live bus. It can match only the envelope (incarnation, commit, criteria, terminal claims and count), because the agent's rows were not kept. The count query decodes no entries.

## Adoption and falsifier

A genuine reader who did not run the job has a current question that needs a pinned window, such as checking a closed decision an agent reported. Before reading, they write down what they must decide. They open the agent's reference in the deployed viewer and answer from it, citing the identity and the terminal claim. Afterwards they say in their own words what the result does and does not cover. The agent keeps the ordered entry ids and commits it returned, and the leads compare them with the viewer's after the reader has answered. Record the deployed revision, the reference identity, both completeness claims and any help the reader needed.

The integration is refused, and reframed before more viewer work, if any of these happen:
- the reader needs an export, the agent's rows, `bus_run_query` or `bus_query` to trust or finish the answer;
- the identities or ordered entries differ;
- either side claims completeness the other does not;
- the reader's stated coverage contradicts the terminal claim, such as reading a stop as the whole window or a history window as the whole coordination;
- the bound stops the reader and they cannot narrow the request.

These do not count: re-enacting the benchmark, the frame owner or an implementer acting as the reader, Storybook or Stagehand passes, matching counts, or a request to try the feature.

This waits for a naturally occurring need; none is manufactured, and no other team's work is delayed for it.

## Decisions for review

1. Accept or refuse the four extensions above, with the 200-entry bound kept.
2. Browser-driven page calls with a stateless server, rather than a server-held stream. The browser keeps progress and cancellation and the server keeps no traversal state; the cost is a cursor round-tripped through the browser, which the bus already binds and refuses when changed. The alternative is an oRPC event stream from a server-side traversal.
3. The reader for acceptance is the owner, on their next real need to check an agent's fixed-cut evidence.
4. A stopped reading stays on screen, labelled as partial, rather than being discarded; the reader can narrow the criteria from it.
5. Deferred: an ordered id digest in the bus result, so that equivalence could go past the envelope without keeping rows. It would be a bus change, and this unit makes none.

## Moved into current docs

- [ ] Contract: the investigation procedure, its reference fields and bounds in [interfaces](../architecture/interfaces.md#viewer).
- [ ] Rule: the superseded viewer rules and limits, rewritten in [viewer](../architecture/viewer.md).
- [ ] Agent guidance: when an agent offers a viewer reference, in the skill's queries reference.
- [ ] Platform claim: none expected; only what is observed.
- [ ] Procedure: opening and reading an investigation, and its failures, in the [viewer runbook](../runbooks/viewer.md).
