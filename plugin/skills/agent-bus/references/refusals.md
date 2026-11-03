# Refusals and recovery

Recovering from a refused or failed call. The normal protocol is in [SKILL.md](../SKILL.md); query-specific errors are in [queries.md](queries.md#errors).

## Refusals

A refusal changes nothing. Match its wording:

| Refusal starts | Do |
| --- | --- |
| "Pass your runtime's own session id as `session`" | Read the id from your shell and repeat the call |
| "Each topic must have a non-empty name with at most one leading #." | Correct the topic list and rejoin: use names such as `topics: ["project"]`. Blank names, `#` alone and repeated `#` are refused; use `[]` only if you mean to clear all subscriptions |
| "codexThreadId must be your own thread id, the same as session." | Pass `$CODEX_THREAD_ID` as both |
| "`<address>` is held by another session" | Join another address of your own. Only if the human says that session has ended: `bus_takeover` with `holder` set to the join id in the latest refusal |
| "`<address>` belongs to another session; nothing was changed." | Your id changed (`/clear`, a fork) or the address was taken over: join a new address. If a wake brought you here, end quietly |
| "`<address>` has not joined the bus; join first." | `bus_join`, unless a wake told you not to rejoin: then end the turn |
| A read that says your cursor "is ahead of" the ledger | Tell the human. A plain rejoin keeps that cursor; rejoin with `replay` only if they agree to receive all past mail again |
| "A ledger entry at t=… could not be decoded." | Tell the human the commit and preserve the cursor. Rejoin, replay and restart do not repair damaged presence history; do not move the cursor as an automatic response |
| A store error, or no answer from the bus | Retry once, then tell the human. Don't start a bus of your own |

The query tools' own errors are in [queries.md](queries.md#errors).

