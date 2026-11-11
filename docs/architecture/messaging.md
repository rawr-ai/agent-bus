# Messaging: addresses, ownership and the ledger

Who may use an address, how messages are addressed, replied to and read, and how the ledger and cursors record them. Where the processes and stores run is in [topology](topology.md); how a session learns it has mail is in [delivery](delivery.md); each tool and its parameters are in [interfaces](interfaces.md); what the bus trusts is in [connections](connections.md).

## What it does

agent-bus is an append-only ledger with one read cursor per address. It is not a broker that pushes messages over open connections. A session reads its mail when it chooses, and a wake ([delivery](delivery.md)) only tells it that there may be some.

### One ledger, in one order

Messages and presence entries for joins and leaves are immutable entries in one ledger. Each entry is one commit on the Fluree transaction server on the bus host, so every machine sees the same order, and a position in the ledger is a commit number. Orientation also retains immutable revisions and changes a designated pointer in the same commit as one ordinary notification; its metadata is not an entry ([orientation](orientation.md)).

### Addressing and replies

A message's `to` lists its recipients, each one of:
- **an address,** for that address's owner (point to point);
- **`#topic`,** for every address subscribed to the topic;
- **`*`,** for every joined address.

So topics and `*` fan out, as in pub/sub, but underneath each recipient reads its own inbox on its own cursor. An address never receives a message sent from itself, even through a topic or `*`. Topic membership is checked when the mail is read, against the address's topics at that moment: an address reads a topic's mail only while it subscribes to the topic.

Subscriptions use bare names, such as `topics: ["project"]` for `to: ["#project"]`. A join canonicalises a supplied list: it trims outer whitespace, removes one optional `#`, trims the resulting name, and merges duplicates in first-seen order without changing case. Empty names and another leading `#` refuse the entire join before the cursor or presence changes. An explicit `[]` clears subscriptions.

Older stored subscriptions are matched literally and, when recognisable, by the same canonical name, so an existing `"#project"` subscription receives `#project` mail without rejoining. History is never rewritten. A rejoin with no list canonicalises recognisable names and retains unrecognised legacy names. The join result echoes the effective subscriptions.

Publish recipients stay literal and case-sensitive: join normalisation does not change `to` entries. For a canonical `reviews` subscription, `#reviews` matches, but `# reviews` and `#Reviews` do not. Recipients aren't checked to exist or corrected for spelling or case. Mail to an address nobody has joined is written, and stays in `bus_history`. A session that later joins that address starts at the present, so it gets that mail only if it joins with `replay`.

A topic and an address can appear together in `to`; an address matching both receives the message once. An `@mention` in the body has no routing effect. Recipient forms determine delivery, not whether a response is expected.

A reply sets `replyTo` to the id of the message it answers. `replyTo` doesn't route: the reply goes only to whatever its own `to` names. It never inherits the original sender or recipients, including `*`. History returns that id so a reader can relate messages; the ledger also stores it as a link. The bus doesn't check that the id exists.

### Presence: joins and leaves

A join or a leave writes a presence entry. It is addressed to `*`, but it is never delivered as mail. It records the runtime, the status (joined or left), the topics and the owning session, and, when they apply:
- `takeover`, the join it replaced;
- `rejoinOf`, the first join of the run of joins it continues (see the table below);
- `codexThreadId`, the Codex thread to wake;
- `note`, what the session is working on.
- `associations`, the explicit directories and concerns the address names ([orientation](orientation.md)); they do not subscribe it to a topic.

For each address, the latest presence with an owner is its complete state; absent association fields on older entries are not recovered from earlier entries. The addresses whose latest presence is a join are the peers that `bus_peers` lists. A leave clears the address's topics, preserves associations as historical evidence, takes it off the peer list, and stops the bus waking it.

Each machine's `serve` also keeps, in memory, the last call it has seen for each address and how many waits are open on it. A refused join reports them, so the caller can tell a live holder from a dead one.

### Activity and mutes

An owner sets its address's activity and mutes with `bus_activity`, which writes one command node beside the messages, named by the caller's UUIDv7 operation. It is not a message and not a presence: nobody is notified, and earlier serves ignore it. A command records the holder's runtime, session and run when it was validated, and applies only if, at its own commit, the same session still holds the address in the same run. Otherwise it is a `CONFLICT` and changes nothing, so a takeover or a replay that commits first wins. Activity at any commit is folded from the address's presences and commands, and from direct mail after it went inactive; [delivery](delivery.md#when-unread-mail-doesnt-wake-inactivity-and-mutes) gives what it does to waking. `bus_peers` and orientation members show it as `active`, `inactive` or `unknown` (direct mail after it went inactive can't be read, or that scan is incomplete), with `activeSince` and the mutes. A presence or command entry that can't be read, including a presence the guarded presence read would refuse, leaves no standing to fold: reads that need one fail, as joins and leaves do, and `bus_activity` writes nothing; [interfaces](interfaces.md) says what ends it; an inactive address is still a peer, and is never shown as left.

### Who owns an address

An address belongs to one session, identified by its runtime and the runtime's own id for it. The join fixes both, and every later call presents the id as `session`. One session may hold several addresses. Ownership is recorded in the presence entry, so it survives a `serve` restart. A client whose tool list predates `session` can still pass it as an extra argument, without reconnecting.

An address is in one of five states: free (never joined, or joined only by presences without an owner), held, left, taken over, or replayed. Taken over and replayed are kinds of held: an owner holds the address, and a new run of joins has started. Delivery keeps a Codex thread's wake state for a run of joins, so an ordinary rejoin doesn't wake it again ([delivery](delivery.md)).

| From | Event, and who may cause it | To | The cursor | Run of joins |
| --- | --- | --- | --- | --- |
| Free, or left by another session | `bus_join`, by any session | Held, by the caller | Starts at the present: earlier mail isn't delivered | Starts |
| Left, by the same session | `bus_join`, by that session | Held | Kept on this machine: mail since its last read is still unread. From another machine, it starts at the present ([limits](#limits)) | Starts |
| Held | `bus_join`, by the holder (same runtime and id) | Held | Kept on this machine. From another machine, it starts at the present ([limits](#limits)) | Continues: the presence records `rejoinOf` |
| Held | `bus_join`, by any other session | Held, unchanged: the join is refused | Unchanged | — |
| Held | `bus_takeover` naming the holder's current join id, by another session, only when the human says the holder has ended | Taken over: held by the caller, and the previous holder is refused from then on | Kept, so unread mail carries over ([limits](#limits)) | Starts |
| Any state a join may claim | Any of the joins above, with `replay` | Replayed: held | Moved to the ledger's start, so every message ever for the address is unread | Starts |
| Held | `bus_leave`, by the holder | Left | Kept | Ends |

`bus_takeover` on a free address, or on the caller's own, joins as `bus_join` does: the holder id is checked only while another session holds the address.

### Reading and cursors

Each address has a cursor: how far its owner has read. Only the owner's read consumes mail.
- **`bus_read`** returns the unread mail, oldest first, and moves the cursor past everything it looked at. With a limit, it stops at the last message it returns, and the cursor moves only that far.
- **Count and byte admission** select a whole-message prefix under the same address lock, before moving the cursor. They stop only between commits, so messages sharing one commit cannot be split; if the oldest unread commit cannot fit, the call refuses without moving the cursor. Without either limit, the usual complete read remains.
- **`bus_wait`** reads the same way. If nothing is waiting, it reads again at each change in the ledger, until mail arrives or its timeout ends.
- **A failed or refused read** moves nothing: the cursor advances only after a complete read.

```mermaid
flowchart TD
  read["The owner's bus_read or bus_wait"] --> scan["Each entry after the address's cursor, oldest first"]
  scan --> kind{"A message, not a presence entry,<br/>and not sent from this address?"}
  kind -- "No" --> past["Passed over"]
  kind -- "Yes" --> addressed{"Its to names this address,<br/>a #topic it subscribes to, or *?"}
  addressed -- "No" --> past
  addressed -- "Yes" --> mail["Returned as mail"]
  past --> moved["The cursor moves past everything read"]
  mail --> moved
```

The wake paths look at unread mail without consuming it. With nothing unread for the address, they move its cursor past entries that aren't its mail, as the owner's read would, and nothing else ([delivery](delivery.md)).

A change in the ledger only wakes readers; reading from the cursor decides what is delivered. Each `serve` has one change stream, shared by every waiter: Fluree's event stream, with a 15-second poll behind it, and one extra wake each time the stream reconnects, since commits may have landed meanwhile.

On Fluree, a cursor is the last commit `t` read. A read is a history query over the entries from the cursor to the head, in windows of 500 commits. Cursors are kept by the `serve` of the machine the address joined from, one file per address, and belong to one incarnation of the ledger (rule 11; [topology](topology.md) gives the path).

Every JSON entry returned for the range is decoded before a read returns, even when the caller asks for a limit. Malformed or schema-invalid JSON fails the read without returning a prefix or moving the cursor. The presence read that decides ownership reads every typed presence node under the activity log's law, and decodes each entry before deciding, including old entries superseded by a later presence. Each node must hold exactly one entry, one id that agrees with it and at most one sender, and an entry holding a session must also be the node its id names, recorded under its own sender. A node that breaks this, including one with no entry or no id, fails the read, so no ownership decision rests on a standing the activity log refuses. A failure does not infer an older owner or an unclaimed address.

Each `serve` has two locks per address. One serializes reads, deliveries and anything else that moves the cursor. The other serializes changes of ownership with sends. A join or a leave takes both, the ownership lock first. Across machines, the ledger orders presence writes instead: each is conditional on no presence for the address having been committed since the commit its decision read (rule 8; [platforms: Fluree](../platforms/fluree.md#conditional-updates)). Its admission is read from its own entry id at its own commit, never from the HTTP status.

### How an entry is stored

Every entry (`src/domain.ts`) has:
- a time-ordered UUIDv7 `id` and an ISO `ts`;
- `from`, `to` and `kind` (message or presence);
- an optional `subject`, and a `body`;
- an optional `replyTo`;
- an `origin`: the machine, and the session's joined directory with its Git repo and branch, worked out when the entry is written;
- for a presence entry, the presence described above.

Repo and branch are optional metadata for queries. Each `git` call gets 2 seconds, and a field it misses is left out.

This is the internal representation used for persistence, ownership and delivery after a restart. `bus_read`, `bus_wait` and `bus_history` return a separate explicit public projection: message content and the named origin fields, never `presence` or other extra internal objects, even if an old ordinary message contains them. `bus_peers` projects only current address, runtime, topics, host and note. Neither projection rewrites stored entries or changes cursors; [interfaces](interfaces.md#mcp-tools) owns their result contracts.

In Fluree, each entry is a node `urn:agent-bus:message:<id>`, typed `bus:Message` or `bus:Presence` (`bus:` is `https://rawr.ai/ns/agent-bus#`). Its properties are:
- `bus:id`, `bus:ts` (`xsd:dateTime`), `bus:from`, `bus:to` (one value per recipient), `bus:subject` and `bus:body`;
- `bus:replyTo`, a link to the answered message's node;
- `bus:host`, `bus:cwd`, `bus:repo` and `bus:branch`;
- for presence, `bus:runtime` and `bus:status`;
- `bus:json`, the exact encoded entry, which is what the bus reads back. The rest of a presence (its owning session, topics, `takeover`, `rejoinOf`, `codexThreadId` and note) is only there.

The ledger's config graph enables inline full-text scoring on `bus:body` and `bus:subject`. `bus_history` ranks stemmed matches (`deploy adapters` finds "Deploying the adapter"). A new ledger's text search finds nothing at first ([platforms: Fluree](../platforms/fluree.md#full-text-search)). Saved queries decode entries into rows of their own, so this stored representation is not their contract; raw `bus_query` reads its projected predicates but not `bus:json`, so stored session claims stay off every query surface ([interfaces](interfaces.md#bus_query)).

## Rules

1. **An address belongs to the session that joined it,** identified by its runtime and that runtime's id: `$CODEX_THREAD_ID` for Codex, `$CLAUDE_CODE_SESSION_ID` for Claude Code, or a stable id of its own for other clients. Every call that acts for the address passes it as `session`. A missing or blank id, or a placeholder that was never expanded (`${…}`, or a value starting with `$`), is refused. A join compares runtime and id, so the same id under another runtime can't join a held address; the later calls compare the id alone, so they accept it under any runtime.
2. **Only the owner may read, wait on, leave or send from the address.** Every refusal changes nothing: not the cursor, the presence or the ledger.
3. **A different session's join is refused** with what the bus knows of the holder: its runtime, machine, join time, note, last call, whether it has a wait open on this machine, and its join id. The policy is to pick another address, not to take the held one.
4. **A takeover (`bus_takeover`, or `agent-bus join --takeover`) must name the holder's current join id,** and is only for replacing a session that has ended, when the human says so. Unread mail carries over to the new owner, and the previous owner is refused from then on.
5. **Rejoining with the same id keeps unread mail,** after a leave too. A new owner of an address that was left starts at the present, so a left address's mail isn't handed to another session. A join with `replay` starts at the ledger's beginning instead, whoever makes it.
6. **The CLI never takes another runtime's id variable.** It presents `--session`, or else the variable of `--runtime` (`$AGENT_BUS_SESSION` for runtimes other than Codex and Claude). Outside `join`, `--runtime` defaults to the runtime the address joined with.
7. **Joins and leaves written without an owner,** by a `serve` from before owners, are ignored.
8. **Ownership is checked under the address's lock at the moment of effect,** so a wait or send that started before a takeover can't act after it. **A join, takeover or leave is written only if the address's presence is unchanged since it was decided,** on any machine: the bus reads presence at one commit, decides, and makes one guarded write that the ledger refuses if a presence for the address was committed after that commit. A refused write is answered from the address's current state (its refusal, or a conflict saying nothing was written) with the cursor restored exactly, including its absence. A write whose outcome can't be confirmed is reported as such and keeps its cursor.
9. **The caller controls topic membership.** A rejoin that names no topics preserves canonical subscriptions and unrecognised names, canonicalising recognisable legacy names; a supplied list replaces them. Canonicalising `"#reviews"` to `"reviews"` keeps `#reviews` delivery but ends the legacy literal match for malformed `##reviews` recipients, including unread mail. New names accept one optional `#` and outer whitespace, preserve case and deduplicate. Malformed new names refuse the whole join; an explicit empty list or a leave clears subscriptions.
10. **A Codex join's `codexThreadId` must be its own thread id,** the same as `session`, or the join is refused. It is what lets this machine's `serve` wake the thread.
11. **A cursor belongs to one incarnation of the ledger.** Cursors are kept per ledger instance, named by its first commit, so a replacement store starts every subscriber over instead of skipping messages. A cursor ahead of the ledger fails the read rather than skipping.
12. **Unreadable entries fail the complete read.** A malformed or schema-invalid entry fails the Fluree read before a cursor, nudge or idle action; the limit on returned mail does not shorten that check. An unreadable presence anywhere in the complete history fails ownership-dependent operations before a cursor or announcement changes.
13. **Associations are explicit and separate from subscriptions.** On a same-runtime, same-session rejoin while the latest presence is joined, omission preserves them, including with replay; `[]` clears them. Leave retains them only as history. A join after leave or a takeover starts unassociated unless it supplies associations. A new association-bearing join checks its size before the cursor or presence changes; [orientation](orientation.md#rules) owns the bounds and unresolved-reference rules.
14. **Activity and mutes belong to the holder's run.** Only the owning session may set them, and a command applies at its own commit only while that session's run holds the address. A leave, a join while absent or left, a takeover, or another session's join resets the address to active with no mutes; an ordinary rejoin and a replay keep them. Every accepted command writes, so repeating one moves its anchor rather than doing nothing. A retry with the same operation and intent returns the original verdict without writing; a different intent under it is `IDENTITY_MISMATCH`.

## Why

### One session per address

Two Claude sessions on one machine once used the same address. One of them sent a request, and the other's background `agent-bus wait` (since retired) consumed the reply, so the session that had asked never saw it. Because reading consumes, two sessions on one address are competing consumers, each getting whatever it reads first. And before owners, any session could send as another's address, so replies went back to the wrong place. Groups have their own mechanism: a `#topic`, where each subscriber has its own address and cursor and gets every message.

### The id as an explicit `session` argument

Identity travels in each call, not in an HTTP header. Claude Code documents its session id only for shells, hooks and stdio MCP subprocesses; `/clear` changes the id while a connection's headers stay fixed; and one Codex daemon serves many threads over one connection. An agent reads its id from its shell, which still works after compaction.
- **Rejected: a lease token issued by `bus_join`.** It would have to survive compaction and be handed to the wake hook, and it protects nothing more between cooperating sessions.
- **`session` is optional in the tool schemas on purpose.** A call without it gets the bus's refusal, which says what to pass, rather than a protocol error, which a client would retry. It is optional in a presence entry too, so presences from before owners still decode.
- **The CLI picks the variable by runtime** (rule 6), never whichever is set, because a Codex process started from a Claude shell inherits the Claude id.

### Takeover as its own tool, naming the holder's join id

Naming the holder's current join id means a takeover can't race a newer join, and can't happen by reflex: the caller must have read the refusal. It is a tool of its own so that `bus_join`, which only claims a free address or reconnects the caller's own, can say it is neither destructive nor open-world. A read-only Codex thread under approval policy `never` can then join itself, while `bus_takeover` stays destructive and still needs approval ([connections](connections.md#approval-in-codex)).
- **Rejected: `takeover` as a parameter of `bus_join`,** which made every join destructive, so such a thread couldn't join at all.

### Fluree as the one store

One shared, ordered log across machines, with history and full-text search. Each message is one commit, so a cursor is a commit number and every machine sees the same order. Queries read the same log at a pinned commit through a read-only gateway ([interfaces](interfaces.md#bus_queries)); they do not change the internal representation or the reads used by ownership and delivery.
- **JSONL is test support only.** The unit tests' ledger (`test/jsonl-ledger.ts`) has byte-offset cursors, file watching and substring search. Like Fluree, its retained `select` capability refuses.
- **Rejected: JSONL as a second production store.** Both machines already ran on Fluree, so a second path had no use ([retired mechanisms](../frames/README.md#retired-mechanisms)).

### Smaller choices

- **Owner-less presences are ignored,** rather than adopted under legacy rules. The cost: an address whose history was only owner-less left the peer list, and a plain join of it starts at the present, without its earlier mail.
- **A new owner starts at the present,** so mail left on an address isn't handed to whoever claims it next. A takeover is the one way to inherit unread mail, and it needs the human's word.
- **Topic names are canonicalised at join.** Both `"reviews"` and `"#reviews"` mean the subscription reached by `#reviews`. Blank or repeated-marker inputs are refused rather than silently dropped, since dropping an entire replacement list would unsubscribe the caller. Legacy matching fixes existing prefixed subscriptions without a migration or cursor reset; exact legacy matching remains for unrecognised names.
- **Case and publish recipients keep their existing meaning.** Case folding would merge distinct topics. A `to` list mixes addresses and topics, so normalising its strings could change the audience; publish-side normalisation needs its own contract.
- **Topics are kept on a rejoin that names none.** Models rejoin with few arguments, and a rejoin without topics used to drop every subscription, so a later read passed over pending topic mail.
- **Two locks per address,** so a send doesn't wait behind a slow delivery (a Codex nudge holds the read lock for up to 6 s), while a session that loses an address still can't send after it.
- **Origin repo and branch on every entry.** A branch can't be recovered once its worktree or branch is gone, and a session can switch branches. Recording them once at join, which misses switches, and dropping them, which loses workstream context, were both rejected. `git` gets 2 seconds because it runs under the address's lock.

## Limits

| Limit | Status |
| --- | --- |
| **Publish recipients are literal and unchecked.** Subscription normalisation does not normalise `to` or detect unjoined, misspelled or wrong-case targets. `# reviews` does not reach a canonical `reviews` subscription | Known limit; read in code |
| **A lost response loses mail.** `bus_read` and `bus_wait` mark messages read before the response is sent. If the response is lost (the caller dies mid-call), those messages are skipped for that address; they stay in `bus_history` | Known gap |
| **Unreadable stored JSON can block unrelated work.** A damaged JSON entry returned in a read range blocks every address reading through that range, and one returned from the presence history blocks ownership-dependent operations. Rejoin, replay and restart do not repair damaged presence history. Schema-valid wrong values are not detected by decoding, nor are entries a read range's query omits, such as a message without `bus:json`; a typed presence node without one fails the presence read | Known limit; recovery is not automated ([recover](../runbooks/recover.md#an-entry-cannot-be-decoded)) |
| **A `serve` from before conditional presence writes keeps the old race.** It writes presence unconditionally, so a join or leave it validated can still land after another machine's takeover, re-installing or removing the old holder. A guarded write from an upgraded `serve` is refused after such a write, as after any other. Rolling back leaves no latent write behind, since a refused guarded write commits nothing | Known limit until every `serve` on the ledger is upgraded |
| **An unconfirmed presence write is reported, not undone.** If the ledger's answer is lost and the entry can't be found, the join, takeover or leave may still have committed; the caller is told so, and that calling again is safe but doesn't reveal what the attempt did. The cursor the join set is kept | Known limit |
| **Conditional presence writes promise no progress under churn.** Each call makes one guarded attempt and never resends it. While other calls keep changing the address, every caller can be told to call again | Accepted: one attempt per call, no hidden retry |
| **Damage committed after a decision is only seen by later reads.** The guard refuses only a presence for the address, recorded under it in raw `bus:from`, whose entry was committed after the basis. A refused write re-reads presence at the refusing commit; an unreadable presence there is returned as the decode failure, with the cursor restored. Other damage committed after the basis doesn't refuse the write: a typed presence node with no entry, an entry retracted, an id or sender added to or removed from an existing node, a session-bearing entry recorded under no sender or another one, or damage to another address's presence. The write lands, and the next presence read fails for every address until the damage is repaired | Known limit; the bus never writes such an entry |
| **Cursors are per machine.** A join, rejoin or takeover from another machine uses that machine's cursor for the address. If it has one from an earlier join there, mail after that position is delivered again. If it has none, the session starts at the present, and the unread mail isn't carried over | Known limit; the second case read in code |
| **An inherited id acts for its session.** A process started from a session's shell inherits that session's id and acts for it, as subagents do, so a `codex exec` delegate can consume its Claude parent's mail | Known limit: give a delegate that needs its own inbox its own address |
| **A new Claude Code id needs a new address.** After `/clear` or a fork, Claude Code has a new id, and the old address is still held by the old one | Known limit |
| **`codexThreadId` is only a "wake me" flag.** It must equal `session` (rule 10), so deriving it from the runtime would drop a join field, a CLI flag and a check | Open |
| **A replay reaches the address's whole history.** It delivers every message ever addressed to the address, its current topics or `*`, including mail an earlier owner read | Accepted, read in code: `bus_history` shows every message to every session anyway |
| **Collision protection, not security.** Every process of the user can reach `serve` and the store, and can present any id ([connections](connections.md)) | Accepted |

## Rests on

- **Claude Code's session id:** `CLAUDE_CODE_SESSION_ID` is set in the desktop app, the terminal and `claude -p`, each with its own value, and a child process inherits it; `/clear` and forks change it, `--resume` keeps it, and subagents share their parent's ([platforms: Claude Code](../platforms/claude-code.md#session-ids)).
- **Codex's thread id:** `CODEX_THREAD_ID` is set in a thread's shells and differs for a subagent; a `codex exec` started from a Claude shell has its own and also inherits the Claude id; and a thread whose tool list predates `session` can pass it as an extra argument ([platforms: Codex](../platforms/codex.md#thread-ids-and-codex_thread_id)).
- **Fluree's ordering and catch-up:** one transaction server orders the commits, and a reader holding a `t` from before a restart reads every commit after it ([platforms: Fluree](../platforms/fluree.md#the-transaction-server)). The event stream carries only change notices ([the event stream](../platforms/fluree.md#the-event-stream)), and full-text scoring starts at the ledger's first index ([full-text search](../platforms/fluree.md#full-text-search)).

## History

Indexed in [frames](../frames/README.md).
- [address-ownership](../frames/address-ownership.md): one session per address, the `session` argument, takeover by join id, and the misrouting that started it.
- [simplification-pass](../frames/simplification-pass.md): Fluree as the only production store, owner-less presences ignored, origin repo and branch kept, and `bus_query` and two locks per address kept.
- [nudge-hygiene](../frames/nudge-hygiene.md): runs of joins (`rejoinOf`), topics kept on a rejoin, and takeover as `bus_takeover`.
- [bus-design-query](../frames/bus-design-query.md): keep full internal presence for ownership and delivery while projecting ordinary public responses.
- [public-query-containment](../frames/public-query-containment.md): withdrew only public SPARQL, retaining internal reads, representation and delivery; retired by turnaround-query-design.
- [reachable-inactivity](../frames/reachable-inactivity.md): activity and mutes as commands folded per run, peers shown inactive rather than left.
- [turnaround-query-design](../frames/turnaround-query-design.md): saved queries and raw SPARQL at a pinned commit, through a gateway separate from delivery's ledger.
