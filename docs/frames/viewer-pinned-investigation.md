# Frame: reading an agent's pinned evidence in the viewer

This frame scopes the next viewer outcome of the [viewer query integration](turnaround-viewer.md): a reader opens the exact history evidence an agent returned and reads it in the viewer. The released viewer's rules are in [viewer](../architecture/viewer.md) and its procedures in [interfaces](../architecture/interfaces.md#viewer); the query contract it reuses is [`bus_run_query`](../architecture/interfaces.md#bus_run_query).

Status: accepted in direction by Codex, with transport and admission corrections, 2026-11-04; application qualification on the synthetic fixture accepted by Codex, 2026-11-04, on one declared integrated attempt. One owned harness limitation remains: an intermittent Storybook play-runner abort, a transport defect tracked in [agent-bus#37](https://github.com/rawr-ai/agent-bus/issues/37), whose original cause is unknown. Not yet merged, deployed or adopted, and no claim about what the provider holds. DRA: Claude lead, cross-reviewed by Codex. Mode: co-framing; object: solution. It extends one bounded release decision deliberately (below) and changes no bus behaviour. This is a bounded-replay increment of at most 200 entries, not completion of unrestricted complete-history reading.

## Consumer job

An agent answers a coordination question from a fixed cut and reports what it found. Its reader wants to read that same ordered evidence without asking the agent for an export or a briefing. The [query release](query-viewer-release-2026-11-02.md) proved the agent half once: a fresh executor reconstructed 83 messages at one snapshot through forward `history` cursor pages. The released viewer cannot open that evidence. It reads only the newest 200 entries, or ranked matches, at whatever commit is current. It never continues past one window, and the browser cannot name a past commit.

That 83-message job is the qualification benchmark: ledger incarnation `bagay…7nya` at `t` 3014, `history` with `fromTs` 2026-11-01T17:31:12.174Z, `toTs` 2026-11-01T21:46:00.542Z, `kinds` `[message]`, `direction` `forward`, page size 200 and no participant filter. The bus recorded that identity, not the rows. A raw `bus_query` count at `t` 3014 over that window on 2026-11-03 still returned 83 on the same incarnation. Re-reading the case qualifies the mechanism; it is not adoption, because that job is finished.

## Minimal capability

A **pinned investigation** is one typed, closed reference, taken from an agent's own `bus_run_query` result: `name` `history`, `catalogueVersion`, `ledger`, `t` and the history criteria. No other operation, free SPARQL or forwarded MCP call is accepted. The viewer reads that reference at that commit through `history` cursor pages and shows the result.

- **Message-only, forward.** This unit accepts `kinds` `[message]` and `direction` `forward` only, matching the actual job. Presence kinds and backward order are refused with their own reason, not read through a projection that cannot keep them. Broadening either needs a real consumer's evidence first.
- **Investigation-entry projection.** A validated projection keeps each entry's commit `t` and the bus's source order, beside the public message fields the live projection keeps. That ordered list is the evidence and the basis of every comparison. Conversation grouping, at the same commit, is a presentation over it, not a second answer.
- **Shared definition.** The viewer validates criteria with the same schema the catalogue uses, extracted to a module both import, so the viewer and the bus cannot disagree about what a valid argument is. The extraction changes no bus behaviour; the catalogue's own tests guard it. A valid query need not fit the viewer's transport (below).
- **Separate from live reading.** The live history, peers and thread observations, the automatic 15-second refresh and their labels keep their current meaning. An investigation has its own identity, and refresh never touches it.
- **Handoff.** The agent passes the reference as a viewer link. The reference is carried in the URL fragment, never the query string, which the host refuses, and never message content. Agent guidance gains one line saying when to offer it.

## Bounds, identity and stops

- **Two identities.** The logical identity is `name`, `catalogueVersion`, `ledger`, `t` and the normalised criteria, which are the bus's echoed arguments without `limit`. It is what an agent and a reader compare, whatever page size the agent used. The traversal identity adds page size. The viewer always sends `limit` 200 and keeps it for the whole traversal, and the bus binds it into each cursor. A continuation never changes page size.
- **Paging.** The browser requests one page per call through a fourth fixed procedure, passing the bus's opaque `next` back unchanged. Each call keeps the existing 10-second upstream deadline. The server keeps no traversal state, so the traversal rules below (the bound, faults, duplicates across pages) belong to the browser's traversal logic. The bus's cursor binding refuses a changed argument, page size or replaced ledger.
- **Identity check.** The server checks that every page's `ledger`, `t`, `name` and `catalogueVersion` equal the reference, that its echoed arguments without `limit` equal the reference's criteria, and separately that its echoed `limit` is 200. A mismatch on any page, the second included, fails the investigation rather than joining it. This is new validation: the live projection compares only `ledger`, `t`, continuation and status. Criteria reach the bus verbatim and are compared with the bus's echo, never re-encoded by the viewer. The bus takes no ledger argument, so incarnation is checked after each read, as `thread` already does.
- **Transport subset.** A page request stays within the existing 4,096-byte body. The bus decodes continuations of at most 1,024 characters but caps none it encodes, so the investigation supports continuations of at most 1,024 ASCII characters. Before the first page, the viewer checks that the actual serialized oRPC request, with a 1,024-character continuation reserved, fits in UTF-8 bytes. A reference that does not fit is refused with a request to narrow its participants, not started and cut short later. Every send is checked again against its actual body. A returned `next` that is longer than 1,024 characters or not ASCII stops the reading as a transport stop, keeping the validated entries read so far. The first check guarantees only this supported subset, not every cursor the bus might emit.
- **Entry bound.** One investigation keeps at most 200 entries. This is a deliberate product limit for this increment, to be evaluated in use; the no-archive rule does not itself require it. A page that would pass 200 is kept only up to the bound, and the rest of that page is discarded. The investigation then stops at the bound, and its last page's `exhausted`, damage and `complete` claims are not borrowed, because they describe rows the viewer did not keep. The bus places damage only by commit, so a cut page reporting any damage stops as damaged, never as a clean bound stop. When the page that reaches exactly 200 is itself exhausted, the result is exhausted, not a bound stop.
- **Work bound.** A page can hold no rows: a page of only damaged entries, or an empty exhausted result, is valid. Damage stops the reading on its page. An empty exhausted result is a complete reading with no entries. These page shapes each end the reading as a fault: a clean page that is neither exhausted nor has rows; a continuation the bus has already returned; `exhausted` false with no `next`; `exhausted` true with a `next`; and an id already kept from an earlier page. Every page that continues adds at least one kept row, so the 200-entry bound ends any traversal by its 200th upstream page call. Refused busy attempts are not page calls and do not count. No separate request guard is needed.
- **Admission.** Across the whole viewer process, at most one investigation page is in flight. Another investigation page, from any tab, is refused as busy before it takes a host slot or an upstream permit. Live observations therefore keep at least seven of the eight upstream permits, and no traversal store is needed. Busy is its own retryable state, not a stop. After a cancel, the slot frees only when the server's handler has settled, so an immediate rerun may briefly see busy.
- **Progress and cancellation.** The reader sees pages and entries as they arrive and can cancel. After a cancel, a stop or a failed request, the entries already read stay on screen, labelled as partial with the reason, never as the answer.
- **Stops are not exhaustion.** The investigation is complete only when the bus says `exhausted` with `damage` `checked`, `damagedTotal` 0 and no viewer omissions. The entry bound, a deadline, a byte refusal or unsupported continuation, cancellation, damage, an omitted record and a fault each stop the reading with their own label and the count read so far. A stopped forward reading is the earliest part of the window, with an unread remainder; the live path's `latest` label belongs to backward reads only. It makes no damage claim about the unread remainder.
- **Identity on screen.** The investigation shows its logical identity, page size, and how many entries, omissions and damaged entries it found.

## Rules this unit supersedes

These are deliberate extensions of the bounded first release, named here so review can accept or refuse each one:

1. [Viewer rule 1](../architecture/viewer.md#rules): "Viewer business calls are exactly … `history`, `search`, `peers` and `thread` operations, with server-fixed arguments; a thread is read at the commit the browser names, which must be one the bus already reported." An investigation lets the browser name a commit from an agent's reference, which the viewer may never have reported. It also carries criteria from the closed forward, message-only history set. The bus still validates `t` from 1 to head.
2. [Viewer rule 5](../architecture/viewer.md#rules): "History is a bounded newest or best-match selection at one commit." An investigation adds a third kind: a forward message window at a named commit, followed to exhaustion or a labelled stop within 200 entries.
3. [Viewer limits](../architecture/viewer.md#limits): "There is no complete-history pagination past one window (200 entries, eight pages) … the browser cannot pick an arbitrary past commit." Both change for investigations only, within the 200-entry bound.
4. [Viewer interfaces](../architecture/interfaces.md#viewer): "Its only RPC paths are `POST /rpc/history`, `POST /rpc/peers` and `POST /rpc/thread`" and `history` has "no cursor". A fourth fixed path carries one investigation page and its cursor.

Unchanged: [rule 7](../architecture/viewer.md#rules) (nothing persisted, no unbounded archive) and the 200-entry live window. The transport, origin and body rules are also unchanged, as are the live projection, omission and damage rules.

## Non-claims

- **Not an audit product.** It does not establish authentic or complete historical reconstruction, historical membership, delivery or reading. A complete investigation is complete for its criteria at its cut, nothing wider.
- **Not provider-independent.** The agent and the viewer read through the same pinned JSON-LD gateway family, and raw SPARQL is a different query shape over the same provider. Neither is independent evidence that the provider returned every entry. History and thread are not known to share the orientation defect, and they are not shown to be insulated from it. The stopped provider diagnostic stays stopped.
- **Search is not history.** Ranked search exhaustion is never complete history. A reply tree's completeness excludes coordination that carried no reply links.
- **A window at a cut.** The time window selects by recorded `ts` as of `t`. Entries committed after `t` are absent even when their `ts` falls inside the window.
- **Cancellation is the viewer's.** Cancelling stops the viewer's requests; it does not prove Fluree stopped its work. Nothing is shown about production ledger size or load.
- **Not adoption.** Mechanism qualification, a re-read of the finished benchmark and any coached or operator-run reading do not count as adoption.

## Qualification

Shaped with the testing-design steward before code, and re-engaged on the revised contracts. Each check names the claim it can falsify. The layers are the existing ones: a real `serve` on a throwaway Fluree, the fake upstream in `test/bus-pages.ts`, Storybook plays on production components, and one local Stagehand journey. Because the server keeps no traversal state, the browser's traversal logic is a unit under test of its own: pure Bun tests over page sequences, with one integrated path for each rule.

| Check | It falsifies | Layer and oracle |
| --- | --- | --- |
| Equivalence | The investigation returns other ordered records, material content or terminal claims than the agent path. | Real `serve`. Two oracles: the seeded expectation the test wrote, and, for fully traversed seeds, a differential of the viewer at page size 200 against the MCP SDK client following `bus_run_query` itself at the reference's own page size and at 7. Seeds cover two or more byte-cut pages, an entry exactly at `fromTs` (kept) and one exactly at `toTs` (dropped), and entries sharing a commit. A reference made at the default page size of 50 is read at 200 and still matches. |
| The bound | 199, 200 or 201 matching entries are labelled wrongly, or a cut page's claims are borrowed. | Traversal unit tests and real `serve`. 199 and 200 exhausted are complete; 200 with more to read and 201 stop at the bound. A page cut at the bound lends no claims, and page size never shrinks. After 196 entries, a 7-row page with damage in the kept head and one with damage only in the discarded tail both stop as damaged. A one-row-per-page sequence ends as a bound stop after exactly 200 recorded calls. |
| Empty, damaged, stalled and malformed pages | A row-less or malformed page is mishandled. | Traversal unit tests over fake pages. An empty exhausted result is complete with no entries, and a damage-only page stops as damaged. Each of these ends as a fault: a clean nonterminal empty page, a repeated continuation, `exhausted` false with no `next`, `exhausted` true with a `next`, and an id repeated across a page boundary. |
| Identity | A wrong incarnation, `t`, `name`, `catalogueVersion`, criteria or echoed page size is joined. | Fake upstream for each field, including a mismatch on page 2 only. Real `serve` for `t` past head and a ledger the bus does not serve. Unsupported kinds and backward order are refused before any page. |
| Transport fit | The fit check passes a reference that a later page cannot send, refuses one that fits, or an unsupported continuation is sent or loses the prefix. | Two separate oracles. Host admission: a boundary pair against the real host, whose 413 is the oracle; a serialized page request with a 1,024-character continuation at exactly 4,096 UTF-8 bytes is admitted, and one byte more is refused, both with multibyte participants and measured as the actual oRPC body. The fit check passes the first and refuses the second before page 1. Bus acceptance: on real `serve`, a valid continuation issued by the bus is accepted on the next page. Fake upstream: a late `next` over 1,024 characters, and one that is not ASCII, stop as transport stops before any send, keeping the validated prefix. |
| Changed content | The same ids with altered content pass as the same evidence. | Comparator over the investigation-entry projection: an altered body, literal audience, reply target or order under unchanged ids fails. |
| Admission, cancellation and progress | A second investigation page takes shared capacity, cancelling leaves work running, busy is shown as a stop, or progress overstates what arrived. | Fake upstream with controlled timing. With one investigation page and six live reads held open, a seventh live read is admitted. Separately, with all eight permits held by one investigation page and seven live reads, another investigation page is refused as busy before host admission. On cancel during page k, page k aborts and k+1 never starts; the cancelled page keeps its slot until its handler settles, a rerun meanwhile is busy, and the rerun is then admitted. Busy attempts never count toward the 200 page calls. |
| Damage and omission | Bus damage and viewer omissions are merged or hidden. | Real `serve` with raw damaged entries; fake duplicate ids. |
| Live path | The live observations change meaning. | The existing suites and plays, unmodified. Live `history` still refuses investigation fields. Any edited live assertion records its reason. |
| Rendered states | A screen shows a claim it does not have. | One play per terminal state: complete, complete and empty, each stop, a fault, cancelled with partial progress, busy, identity failure, refused reference and omission. "Complete" never appears beside a stop, and the identity header is always visible. |
| Journey | The connected flow does not work. | One local Stagehand run on the synthetic fixture: open a reference by link, see progress, cancel, and rerun to exhaustion once admitted. It proves wiring, never what the provider holds. |

Every oracle through the bus shares its provider, so agreement with the agent path is equivalence, not correctness. Re-reading the benchmark is a read-only call on the live bus. It can match only the envelope (incarnation, commit, criteria, terminal claims and count), because the agent's rows were not kept, and the count query decodes no entries.

## Adoption and falsifier

Any genuine reader who did not implement this and did not run the job is eligible, when a decision of theirs naturally needs a pinned window, such as checking a closed decision an agent reported. The owner may be that reader but is not assigned as a tester, and no current need is assumed. While none exists, the record says so.

When the agent hands over the reference, it keeps a private, bounded baseline of what it returned, outside the public repository. For each entry, that is the material projected fields in order: id, commit, ts, sender, literal audience, subject, body, reply target and, where the entry has one, its complete projected origin. Before reading, the reader writes down what they must decide. They open the reference in the deployed viewer and answer from it, citing its identity and terminal claim. Afterwards they say in their own words what the result does and does not cover. Only then do the leads compare the baseline with the viewer's investigation entries: order, bodies, literal audiences and reply relationships. Matching ids with altered content fail. Record the deployed revision, the reference identity, both completeness claims and any help the reader needed. The 83-message benchmark stays envelope-only.

The integration is refused, and reframed before more viewer work, if any of these happen:
- the reader needs an export, the agent's rows, `bus_run_query` or `bus_query` to trust or finish the answer;
- the identities, ordered entries or their material content differ;
- either side claims completeness the other does not;
- the reader's stated coverage contradicts the terminal claim, such as reading a stop as the whole window or a history window as the whole coordination;
- the bound stops the reader and they cannot narrow the request.

These do not count: re-enacting the benchmark, the frame owner or an implementer acting as the reader, Storybook or Stagehand passes, matching counts, or a request to try the feature. Acceptance waits for a naturally occurring need; none is manufactured, and no other team's work is delayed for it.

## Decisions

Resolved in cross-review:

1. The four extensions above, within a forward, message-only, 200-entry bounded replay.
2. A fourth fixed, stateless page procedure driven by the browser, rather than a server-held stream. The cursor round-trips through the browser, and the bus binds and refuses it when changed.
3. A stopped reading stays on screen, labelled as partial, rather than being discarded; the reader can narrow the criteria from it.
4. Process-wide fail-fast admission of one investigation page, keeping seven upstream permits for live observations.
5. No ordered-id digest in the bus result for now; the private baseline carries material content instead.

Open: none needing the owner. Broader kinds, backward order or more than 200 entries each need a real consumer's evidence before a new frame.

## Moved into current docs

- [x] Contract: the investigation procedure, its reference fields, transport subset and bounds in [interfaces](../architecture/interfaces.md#viewer).
- [x] Rule: the superseded viewer rules and limits, rewritten in [viewer](../architecture/viewer.md).
- [x] Agent guidance: when an agent offers a viewer reference and keeps its baseline, in the skill's queries reference.
- [x] Platform claim: none expected; only what is observed.
- [x] Procedure: opening and reading an investigation, and its failures, in the [viewer runbook](../runbooks/viewer.md).
