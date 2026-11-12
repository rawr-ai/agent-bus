# Recorded wake prerequisites

This frame records a bounded correction to [stable native delivery](stable-native-delivery.md). It lets a direct sender see recipients whose latest join cannot take a native wake, without changing how messages are admitted, stored, routed or acknowledged.

## Evidence

After stable native delivery, a join written before installation identity existed is stored and readable, but no `serve` wakes it until its owner renews the join. Its sender got the same `{id, ts}` either way. In one observed coordination incident, mail to such an address sat unread until a human prompted the owner, while senders took the successful publish as a sign the recipient had been woken. `bus_peers` returned no field that could tell the two cases apart. The roster deliberately omits the installation and thread ids, so the sender couldn't check this independently.

The ownership check in `bus_publish` already reads every presence once, under the sender's claiming lock and before the append. That read is enough for the sender to say what it observed, without another read or any stored state.

## Decision

One pure classification, `wakeStanding`, applies to a joined presence:

- `recorded` means a Claude join with an installation, or a Codex join with an installation and a thread.
- `interactive` covers human and other runtimes, which have no native wake by design.
- `no-installation`, `no-codex-thread` and `no-installation-or-codex-thread` name what is missing.

`recorded` says only that the prerequisites are there. It does not check the hook, the queue, the installation's `serve` or the recipient's activity.

`bus_publish` returns `wake: {ledger, t, lacking}` only when the sender's own ownership read shows a lacking direct recipient. `ledger` and `t` are that read's incarnation and commit, taken before the append, so a replaced ledger can't be confused with this one.

- **Direct recipients.** Each named address counts once. The sender, `#topics` and `*` are excluded.
- **Not joined.** A recipient with no session-bearing join, or whose latest join is a leave, is `not-joined`. Never-joined and left recipients are deliberately not told apart.
- **Lacking.** A joined recipient is lacking with its `no-*` standing.
- **Bounded.** The notice lists the first lacking recipients whose JSON array fits 4 KiB, possibly none, and counts the rest as `unlisted`. `to` and its addresses aren't length-bounded, and a receipt that outgrew its carrier would fail after the message was already stored. A byte budget keeps the notice's own size constant on every carrier, native and hosted, without restricting input. The unlisted recipients can be named by paging the `peers` relation with the same `ledger` and `t` to exhaustion with damage checked, and comparing `to` against its joined rows. A refused ledger, damage or a page cut short leaves them unnamed.

The message is stored either way. Pierce, `NOT_SENT` and topic-only sends behave as before, and a pierce's own audience read can differ from the notice.

When the field is absent, nothing lacking was observed. That never means a wake will route or arrive. Only the sender is locked, so recipients can change after `t`.

`bus_peers` and the `peers` relation show the same `wake` standing on joined rows, never on left rows. It needs no additional read. The relation's existing activity fold already reads every presence at `t` under the same law as ownership, and refuses the cut if any presence is damaged, lacks its id or has its id claimed twice, since that record could be any address's newest state. A standing is therefore never shown from a possibly superseded join.

The private hosted peer's tool wire is closed: its output schemas are built from the serve's with excess properties refused. A retained host artifact rebound to a serve carrying this change would therefore fail `bus_peers`, and fail a `bus_publish` that carries `wake` after the message was appended. This change needs a host artifact built from the same source, activated with the serve; a version-only rebind of the retained host is not compatible.

Excluded: admission refusal, automatic renewal or repair, hostname fallback, extra reads or persisted status, delivery acknowledgements and attention-policy changes. Installation and thread ids stay out of all output.

## Qualification

1. **The rule.** `test/wake-prerequisites.test.ts` lists the standing for every runtime, installation and thread combination as literal rows, and fails if a runtime has no row. The `lackingWake` cases cover `to` order, duplicates, the sender (but not another address its session holds), `*`, `#topics`, left, never-joined and ownerless joins, and a sessionless leave that delivery ignores.
2. **Agreement with delivery.** `test/stable-native-delivery.test.ts` asserts the notice in the same scenarios that prove which joins are actually woken:
   - A remote installation's recorded joins are not lacking, while a Codex join without a thread is.
   - Legacy joins report `no-installation` until their owners renew, and report nothing after renewal.
   - A send that reaches the local owners carries no notice.
   - A counting ledger shows that a plain send makes exactly one presence read, and the notice's `t` is that read's cut. Left and never-joined recipients are `not-joined`, and the message is stored once. Topic and programme mail, and mail to oneself, carry no notice.
   - A send to 200 never-joined recipients lists the longest `to`-order prefix whose serialized array is within the budget and counts the rest. An address too long to list, even one escaped twice over, is only counted. The official MCP client and the hosted wire each receive the bounded notice with its count.
3. **Roster.** `test/query.test.ts` checks the peers standing table on real Fluree with no installation leak, the left row without a standing and `bus_peers` matching the relation. A presence id claimed twice at one commit, and a presence without an id, each refuse both while the earlier cut still answers.
4. **Surfaces.** The official MCP client, over all three protocol versions, receives the exact `wake` structure with optional output fields. The bundled CLI keeps the id as its only stdout line and writes the notice to stderr.

Pierce interleaving wasn't pinned: it would only restate the existing difference between the two reads that is documented above. An unreadable ownership read already fails a send before the append, as the existing ownership tests show.

None of these is a live native wake, and this frame does not authorize activation. Release integration stays with the release-operations owner.

## Moved into current docs

- [x] Contract: [interfaces](../architecture/interfaces.md) `bus_publish`, `bus_peers`, the `peers` relation and the CLI; the tool and schema descriptions.
- [x] Rule: [delivery](../architecture/delivery.md) says what a recorded standing does and does not establish.
- [x] Agent guidance: [the skill](../../plugin/skills/agent-bus/SKILL.md) and its [addressing reference](../../plugin/skills/agent-bus/references/addressing.md).
- [x] Platform claim: none changed; no new provider behavior is asserted.
- [x] Procedure: none changed; an owner renews a lacking join as [stable native delivery](stable-native-delivery.md) already prescribes.
