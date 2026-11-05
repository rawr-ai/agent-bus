# Frame: reachable inactivity

This accepted frame turns the [reachable inactivity candidate](turnaround-activity.md) of the [coordination turnaround](coordination-turnaround.md) into an implementation contract. Current ownership, cursors and wake behaviour remain in [messaging](../architecture/messaging.md) and [delivery](../architecture/delivery.md) until it ships.

Status: accepted by the director, 2026-11-05. It is implemented on its own branch, which starts with failing tests. It is not shipped. DRA: Claude lead, cross-reviewed by Codex. Co-framing was checked by the state-machine, Fluree-query, simplicity and testing-design stewards. Those checks were code reads at the base commit, plus one read-only workload measurement on the running bus.

## Owner decisions

The owner's own words, 2026-11-05:
1. Inactive works like do-not-disturb: by default nothing ambient wakes an inactive address. That covers programme `*`, topic and project/concern mail.
2. A sender can deliberately push a message through to chosen inactive recipients, or to all of them. Doing so takes an intentional "are you sure" step.
3. A direct message reactivates the address.
4. Scoped muting is part of the experience. Stage 1 ships the active bit together with programme, topic and project/concern mutes. Thread mute comes later.
5. Agents rarely leave, roughly only when their platform archives them. A completed disposable delegate counts as archived. The default guidance changes to "go inactive", but only when this ships.

## Representation: commands are their own typed nodes

An owner call that sets activity, mutes or both writes one node and no message:
- `@id`: `urn:agent-bus:command:<id>`
- `@type`: `bus:AddressCommand`
- a single predicate, `bus:command`, holding JSON `{address, runtime, session, run, activity?, mutes?}`
- no `bus:json`

Orientation already stores revisions and witnesses the same way, beside messages.

Why this shape:
- **Legacy readers ignore it by construction.**
  - `Ledger.read` matches only `bus:json`.
  - `Ledger.presence` and the catalogue's typed queries match on `@type`.
  - So no pre-release or rolled-back serve can read a command as a join, a run or a holder.
- **Rejected: a command written as a marked presence entry.** A legacy fold keeps the latest session-bearing entry per sender and strips unknown keys on decode. On that fold a marked command would:
  - move the join id, `since` and the holder;
  - re-ring a Claude session's wake mark;
  - reset a Codex run's refusal and back-off through the same-run branch;
  - after a takeover, let an old session's command re-install the old holder.

  Making that safe would need every serve to understand commands before the first write, plus a permanent rollback floor.
- **Rejected: a presence-kind entry carrying no presence.** It is a fake presence. Every `kind` consumer, and the JSONL test ledger, would have to tell it apart. `toNode` would need a special case for its type, and it would carry filler id, timestamp, recipient and body fields.
- **Cost of this shape:**
  - one append operation, one query and one schema, in both the Fluree adapter and the JSONL ledger;
  - a merge of presence and commands ordered by commit `t`. Any option needs this, because `Ledger.presence` must now return `t`.

## The fold

One evaluator reads presence entries and command nodes in commit order:
- **Reset:** a leave, a join while absent or left, or a takeover. The address is active with no mutes, the join id is this entry, and the anchor is set at its `t`.
- **Rejoin without replay:** the same run. It updates the join id only.
- **Replay:** starts a new run. It keeps the anchor and the mutes, because replay re-delivers mail and is not a departure. Commands from the old run that are still in flight are refused.
- **Command:** accepted only when all of these hold:
  - the address is joined;
  - the command's runtime, session and run (`rejoinOf ?? joinId`) all equal the holder's.

  Once accepted:
  - An `activity` value moves the anchor (value and `t`).
  - A `mutes` value replaces the mutes.
  - A command never changes the join id, `since`, the holder or the wake identity.

  The guard refuses a delayed command from an earlier run of the same session, and an old session's command after a takeover, on any serve.

  A command that commits while damage that may be the address's stands (after it and before the next reset) is neither accepted nor refused. Its verdict is unknown and it changes nothing while the damage stands, because the unreadable entry may have moved the address or changed its standing.
- **Mutes** come only from accepted commands since the last reset, so no writer can erase them by omission.

## Activity at a cut

The result is `active`, `inactive` or `unknown`, evaluated in this order:
1. **Unknown from damage first.** A damaged presence entry anywhere in the log, or a damaged command possibly from the address after its last reset, makes it unknown. Damage to a presence lasts until repair, because whether a later presence reset the address depends on it, and a retraction leaves no commit to date it by. A later valid direct message cannot settle this.
2. **Active** if the anchor is not inactive.
3. **Active** if a decoded qualifying direct message was committed after the anchor and at or before the cut. Qualifying means kind `message`, `to` literally names the address, and `from` is a different address. The decoded entry is authoritative for qualification.
4. **Unknown** if any damaged candidate is in that window, or the scan is truncated or incomplete. An indexed `bus:from` never rules a damaged candidate out.
5. **Inactive** otherwise.

Queries show `unknown` with its reason and never coerce it. The wake law treats unknown as active.

On the live path, damage already blocks reading for that address. That stays as it is, and the frame states it rather than claiming the path fails toward contact.

## One basis for every path

Candidates come from one indexed function: messages whose `bus:to` names the address, with commit `t` after the anchor. Each candidate is decoded and classified as above.

The same function answers:
- peers, members and orientation at a pinned commit;
- the live wake decision at the read slice's cut.

The live path calls it only for an ambient wake decision about an anchor-inactive address. Direct mail needs no activity read, because direct wins. There is no last-direct cache and no seeding, so live, pinned and restarted readings are one function of the ledger.

**Measurement.** Read-only through the public query tools, at head `t` 3536. The ledger then held 2,930 messages and 604 presences over 11 days: about 266 messages a day on average, peaking at 781.

| Read | Time | Detail |
| --- | --- | --- |
| Indexed shape | 9–12 ms | any window up to the full history; 20–426 rows; complete |
| Decoding every entry through paged history | 1.7 s for the full history | about 0.5 ms per entry |

A thirty-day inactive window decoded entry by entry would cost that on every pinned peers or members read, and so on every orientation. Bounding the window would turn long-inactive addresses unknown. That would wake them and silently end their do-not-disturb.

**Integrity boundary.** At the measured head, no message lacked `bus:to` or `bus:id`. `append` writes the projections and the JSON in one insert, from one message. Live, query and restart therefore agree by construction under the writer's atomic projection contract. This is not a claim of immunity to arbitrary store corruption. Detected damage and incomplete phases return unknown, and tests pin:
- that `toNode` projects every recipient;
- that a current-state `@t` equals the entry's single commit;
- parity across a restart.

## Wake law

Applied per address and message, after `pending`. Never in `isFor` or `pending`, where suppressed mail would count as read. The routes are the matching members of `to`: direct, `*`, `#topic` and concern.
1. **Direct route present:** wake. If inactive, also reactivate. Direct wins, even when the address is also pierced.
2. **Otherwise, in the message's stored pierce set:** wake, without reactivating.
3. **Otherwise:** wake only if the address is active (or unknown) and at least one matching ambient route is unmuted. A programme mute mutes only `*`, so one unmuted matching topic still wakes.

One rule serves the Claude wake, the fresh compact ring and the Codex nudge:
- The mark is the join id plus the span of the eligible set, and moves only when that set is non-empty.
- Reactivation rings the retained backlog once.
- `bus_wait` stays unfiltered.
- A queued nudge stays queued.
- A suppressed pass records no coverage.

## Push-through

- **Named pierce.** `pierce: [addresses]` bypasses inactivity and mutes.
  - An address outside the audience is refused.
  - An address the message already reaches directly is dropped.
- **Pierce "all", first call.** Without `confirm`, nothing is sent. The call returns NOT_SENT with the bypass set and a digest.
  - The bypass set is every audience member who would otherwise be suppressed: inactive, or active with every matching ambient route muted. Unknown counts as active, and directly addressed members are excluded.
  - The digest covers the sender, the routes, subject, body, kind, `replyTo` and that exact set.
- **Pierce "all", confirmation.** Repeating the call with `confirm` set to the digest sends it. A mismatch returns NOT_SENT with the new set. There is no pending store.
- **Stored form.** The message stores the confirmed set itself, never "all". A pierce never changes activity and never appears in `to`.
- **Compatibility.** The set is an additive message field. Legacy decoders strip it, and legacy serves deliver normally.
- **Rejected:**
  - an echo after the send, which cannot confirm anything;
  - MCP elicitation, which asks the client's human rather than the sending agent.

## Queries and display

**Peers and orientation members.**
- A joined peer gets `activity` (`active`, `inactive` or `unknown`), plus `activeSince` and its mutes.
- It is never coerced to left and never hidden.
- Peers skip damaged presences, so the damage rule above applies there.
- Members keep their existing all-or-nothing damage behaviour.
- Activity is computed before sorting and paging.

**Viewer and CLI.** They render the serve's rows and fold nothing themselves. New fields are additive only, so rollout order doesn't matter.

**Ownership lookup.** The lookup that compact recovery uses stays activity-neutral and cheap. It never requires activity enrichment.

**Still open:** the transition tool and parameter names, and whether a command also posts a human-readable notice. Commands write no presence announcement.

## Deployment and rollback

- **No write-order prerequisite.** Legacy serves ignore command nodes.
- **Do-not-disturb is honoured per host,** because delivery is per host. Inactivity and mutes are promised, and the leave guidance changes, only after both serves run this release. Until then a legacy serve wakes its peers as today. That errs toward contact and loses nothing.
- **Rollback to any earlier release from the base commit is allowed.** Addresses read active and unmuted there. Rolling forward restores activity and mutes from the commands, and a takeover since then resets them as usual.
- **Older rollback targets are unverified.** That covers releases before the orientation release. The ledger already holds non-message nodes, so such targets face the same shape today.
- **Never add a `kind` value.** A legacy `Ledger.read` would fail to decode, for every address whose window covers the entry.

## Tests

Written failing before the change:
- **A.** Inactive with `*` and `#t` mail: no ring, cursor unchanged, both messages readable. Run on both backends.
- **B.** A later direct message wakes and reactivates, keeping mutes. An earlier unread one does not reactivate.
- **C.** Commit orderings:
  - deactivate, then a direct message, then a mute-only command: the address is active;
  - a rejoin racing a direct message;
  - re-deactivation;
  - reset by leave and join, and by takeover.
- **D.** A command changes neither the join id nor `since`. No re-ring. The Codex hold's back-off and refusal are unchanged.
- **E.** The guard refuses:
  - an old session's command after a takeover;
  - a delayed command from an earlier run of the same session;
  - an old-run command after replay. Here the anchor and mutes are kept.
- **F.** Legacy readers over a ledger containing commands: join id and `since` unchanged, no damage, reads succeed, nothing delivered. Rollback then roll-forward restores state.
- **G.** Mixed routes:
  - a muted `*` plus an unmuted `#t` wakes;
  - direct plus muted wakes and reactivates;
  - direct plus pierce reactivates.
- **H.** Pierce:
  - named recipients wake and stay inactive;
  - "all" without confirm sends nothing;
  - a stale digest returns NOT_SENT;
  - the stored set equals the confirmed set;
  - direct recipients are excluded;
  - a legacy decoder strips the field.
- **I.** Unknown:
  - a damaged command or presence after reset, even with a later valid direct message;
  - a damaged candidate;
  - a truncated phase;
  - members stay all-or-nothing.
- **J.** Real Fluree restart:
  - the state is rebuilt from the ledger alone;
  - legacy data reads active;
  - live equals pinned before and after the restart, including direct mail consumed on the other machine;
  - the `@t` fixture;
  - the projection test.
- **K.** A compact while inactive with only topic mail rings nothing.
- **L.** A Codex address while inactive gets no nudge and no coverage record. A direct message nudges once.

Reuse the existing delivery tests rather than a cross-product matrix.

Real-host checks: one Claude compaction while inactive, one Codex reactivation by direct message, and the falsifier.

**Tracked separately.** The existing race where a join or leave commits after a takeover on another serve is a defect of its own, with its own failing case. This release does not depend on it, because the guard covers only command nodes.

## Falsifier

Baseline the real finish-and-reactivate workflow first. Then a real participant, with no one manipulating its session:
1. goes inactive or mutes a scope;
2. stops receiving those notifications;
3. is reached by a direct message or a deliberate pierce;
4. recovers current orientation.

Reframe if:
- a human must restore contact;
- unread mail is lost;
- a deliberate mute is silently cleared.

## Out of scope

- thread mute;
- liveness inferred from silence;
- expiry that releases ownership;
- automatic takeover;
- task tracking;
- bulletin injection;
- compact restoration, which has its own frame;
- the viewer's lifecycle.

## Moved into current docs

- [x] Contract: interfaces and tool descriptions for the transition call, the pierce fields and the peer activity fields.
- [x] Rules: messaging and delivery describe activity, mutes, the wake law and their limits.
- [x] Agent guidance: the skill retires blanket leave-when-done in favour of going inactive. MCP instruction 7 is retired with it, and the delegate-leave rule is kept.
- [ ] Platform claims: none expected beyond the existing Fluree `@t` behaviour, pinned by its fixture.
- [x] Procedure: deploy notes both serves before promising do-not-disturb, and the rollback behaviour.
