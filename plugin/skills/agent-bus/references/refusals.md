# Refusals and recovery

Recovering from a refused or failed call. The normal protocol is in [SKILL.md](../SKILL.md); query-specific errors are in [queries.md](queries.md#errors).

## Refusals

An ownership or validation refusal changes nothing. Match its wording:

| Refusal starts | Do |
| --- | --- |
| "Pass your runtime's own session id as `session`" | Native caller: read the id from your shell and repeat the call. Hosted caller: use the client recovery below; never supply an invented id |
| "Each topic must have a non-empty name with at most one leading #." | Correct the topic list and rejoin: use names such as `topics: ["project"]`. Blank names, `#` alone and repeated `#` are refused; use `[]` only if you mean to clear all subscriptions |
| "The working directory cannot exceed … UTF-8 bytes" | Join from a shorter working directory; nothing was changed |
| "This address takes `<bytes>` UTF-8 bytes" | Join under a shorter address; nothing was changed |
| "codexThreadId must be your own thread id, the same as session." | Native Codex: pass `$CODEX_THREAD_ID` as both |
| "`<address>` is held by another session" | Join another address of your own. Only if the human says that session has ended: `bus_takeover` with `holder` set to the join id in the latest refusal |
| "`<address>` belongs to another session; nothing was changed." | A native id may have changed (`/clear`, a fork), hosted correlation may identify another conversation, or the address was taken over: join a new address. If a wake's read brought you here, carry on quietly, or end the turn if the wake started it |
| "`<address>` changed while this call was deciding, so nothing was written." | Another call changed the address first. Call again once; the bus decides against the current state. Don't loop |
| "The bus could not confirm whether this `<join\|leave>` of `<address>` was recorded" | It may or may not have committed. Call again if you still need the change: that call's result or refusal is what counts. Don't treat `bus_peers` as proof either way: it doesn't show sessions |
| "`<address>` has not joined the bus; join first." | `bus_join`, unless this was a wake's read: then carry on, or end the turn if the wake started it, without joining |
| "This message is too large: as a reader receives it" | Nothing was sent or written. Send a shorter message that links to the large content (a file path, URL or commit); do not split one payload across many messages without the recipient's agreement |
| "This message's `<field>` takes `<bytes>` UTF-8 bytes, over the 32768-byte limit for searchable text" | Nothing was sent or written. Shorten it and link to longer content (a file path, URL or commit); the limit counts bytes, so non-ASCII text fits fewer characters |
| "This entry's body or subject is over the 32768-byte limit for searchable text" | Nothing was sent or written; shorten the text as above |
| "The oldest unread messages cannot fit this read's limits without splitting a commit; the cursor was not advanced. Use a reader with larger limits." | The unread commit was not consumed. Use a reader that can admit the whole commit; do not skip it or rejoin |
| A read that says your cursor "is ahead of" the ledger | Tell the human. A plain rejoin keeps that cursor; rejoin with `replay` only if they agree to receive all past mail again |
| "A ledger entry at t=… could not be decoded." | Tell the human the commit and preserve the cursor. Rejoin, replay and restart do not repair damaged presence or command history; do not move the cursor as an automatic response. After the human's repair, resend any `UNKNOWN` activity request with a new `operation` |

The query tools' own errors are in [queries.md](queries.md#errors).

If a hosted call reports missing conversation correlation, no Bus call was sent. Tell the human and use the client's supported connection or conversation recovery; do not invent or pass an identity. Authorized session-free lookups remain available. See [hosted runtimes](runtimes.md#hosted-chatgpt).

A lost answer to `bus_publish`, `bus_read` or `bus_wait` may follow a committed send or consuming read. A publish can also explicitly report that it could not confirm the send. Inspect history and tell the human; do not blindly retry an ambiguous publish, read or wait. If the call was definitely not sent, retry once; a lost retry result is still uncertain. An activity or designation `UNKNOWN` may be retried only with the same operation id and identical intent; see [activity](activity.md#read-the-result) and [guidance](orientation.md). Ordinary publish does not take an operation id. For another store error, retry once only when the operation's contract permits, then tell the human. Don't start a bus of your own.

