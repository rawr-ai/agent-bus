# Frame: conditional presence writes

Status: implemented and qualified on its branch; not released. DRA: claude/agent-bus; director codex/agent-bus-takeover. Current rules are in [messaging](../architecture/messaging.md#rules) (rule 8 and Limits), refusals in [interfaces](../architecture/interfaces.md#refusals), and the platform claim in [Fluree](../platforms/fluree.md#conditional-updates).

## Defect

A join, takeover or leave read the latest presence, decided, then appended unconditionally. The in-process locks serialize only one `serve`, so a join or leave validated on one machine and committed after another machine's takeover re-installed or removed the old holder, and two sessions claiming a free address from two machines could both succeed. `test/lifecycle-takeover-race.test.ts` reproduced the first two as `test.failing`.

## Decision

The director chose a native conditional append of the ordinary presence entry: no inert entries and no head node. Rejected were a separate head pointer (a second write path and a second source of truth) and a blind retry (it hides conflict and can loop).

1. **Read at a cut.** Presence is read at one pinned commit `T`, with the ledger's incarnation checked before and after. Every presence is decoded; for a session-bearing presence the stored node, `bus:from` and single `bus:json` must match its JSON, or the read fails closed.
2. **Decide as before.** The holder, takeover, renewal and new-owner rules are unchanged.
3. **One guarded write.** The presence is inserted only if no presence from the address has `bus:json` asserted after `T` and its id is absent. The guard keys on `bus:json @t`, the predicate the ownership read itself uses, so the guard and the read cannot disagree about which presences exist.
4. **Admission from the id.** The attempted id at the answered commit, past `T`, is the only evidence of admission. The outcome is one of ADMITTED, REFUSED (with the refusing commit `R`) or UNKNOWN.
5. **Refused.** The cursor is restored exactly, including its absence. Presence is re-read at `R` and decided again without writing: that decision's refusal is returned, or else a new `PresenceConflict`. This applies to the same session's own concurrent calls too.
6. **Unknown.** A lost or unreadable answer with the id absent, or a replaced ledger, returns a `LedgerError` saying the change may have committed. The cursor the join set is kept, never rolled back.
7. **Cursor law.** A new owner starts at `T`, a replay at 0, and a rejoin or takeover with an existing cursor writes none. A leave never touches the cursor.

The test JSONL ledger mirrors the guard under a per-file lock: any presence for the address, unreadable line or reused id past the basis refuses, and an id written anywhere refuses.

## Qualification

- `test/lifecycle-takeover-race.test.ts`: the two reproductions now pass as ordinary tests. Also covered through a deterministic relay: two free claims, stale leave and rejoin, takeover against a rejoin, cursor restoration, lost answers before and after commit, damage at and after the cut, same-session conflicts and an old unconditional writer.
- `test/presence-guard.test.ts`: the guard's scope on Fluree and JSONL, and JSONL parity across two Bus layers.
- `bun run qualify:fluree` case 5: the installed Fluree 4.2.4 on a durable disposable server.

## Limits accepted

- Old serves keep the race until every `serve` is upgraded. Rolling back leaves no latent write, since a refused guarded write commits nothing.
- There is no liveness promise under churn.
- Raw damage whose `bus:from` names another address escapes the guard.
- A ledger replaced mid-call is untested (UNKNOWN by construction).

## Moved into current docs

- [x] Contract: `PresenceConflict` and the unconfirmed-write message in [interfaces](../architecture/interfaces.md#refusals), rule 2.
- [x] Rule: [messaging](../architecture/messaging.md#rules) rule 8, the locks paragraph and Limits.
- [x] Agent guidance: [refusals](../../plugin/skills/agent-bus/references/refusals.md).
- [x] Platform claim: [Fluree](../platforms/fluree.md#conditional-updates), with `qualify:fluree` case 5.
- [ ] Procedure: rollout order across machines, at release.
