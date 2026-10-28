# Connections and trust boundaries

Every connection the bus makes or depends on, what protects it, what it trusts, and what each party may do to another's address, thread or queue item. The bus host runs Fluree and `serve`; every other machine runs `serve` and an SSH tunnel to the bus host. [Topology](topology.md) shows where each process runs and where its state lives; who is woken, and how, is in [delivery](delivery.md); what an owner of an address is and may do is in [messaging](messaging.md).

## What it does

### Connections

| From | To | Transport | Protection | Trusts |
| --- | --- | --- | --- | --- |
| A Claude or Codex session | `serve` | HTTP on `127.0.0.1:8096/mcp` | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (stops DNS rebinding); any browser `Origin` is rejected. Each call names its session, and only an address's owner may use it ([messaging](messaging.md#rules)), which keeps cooperating sessions apart but proves nothing | Every process of the user on the machine; loopback is not authentication |
| `serve` on the bus host | Fluree | HTTP on `127.0.0.1:8095` | Bearer token (`~/.agent-bus/fluree-token`, mode 0600) on the data and admin APIs; CORS off | Holders of the token |
| `serve` | Fluree's event stream | The same port, no token | Carries ledger names and commit pointers only, never message content | Anyone on the machine |
| `serve` on another machine | The bus host's Fluree | SSH local forward (`ai.rawr.agent-bus.tunnel`), on the same local port | SSH host key and key authentication, plus the Fluree token, copied over `scp` at install | The SSH account on the bus host |
| `serve` | A `codex app-server` it starts for each nudge, and for each removal of one (the desktop's bundled CLI) | stdio (a child process), ended before the address's lock is released | Process boundary. The child runs with the user's Codex configuration and `~/.codex`; `serve` sends it only `initialize`, `thread/queue/list`, `thread/queue/add`, `thread/queue/delete` (only for an item it added) and `thread/read`, which load no thread | The Codex CLI binary |
| `serve` | The machine's Codex daemon, to borrow a thread | WebSocket JSON-RPC at `/rpc` on the daemon's Unix socket (`~/.codex/app-server-control/app-server-control.sock`), one short connection per borrow | The socket is mode 0600 in a 0700 directory, the same boundary as `~/.codex`; the daemon has no other authentication. `serve` first checks that something listens with a plain connection, then sends only `initialize`, `thread/resume` and `thread/unsubscribe` | Every process of the user on the machine, as the TUI does |
| `serve` | `codex app-server daemon start`, when the daemon isn't running | A child process, ended within 10 s; the daemon it starts runs in a session of its own | Process boundary. It runs the managed daemon package installed in `~/.codex`, with the user's configuration | The Codex CLI and its managed package |
| The Codex desktop app, SSH project | The daemon on the SSH host, through `codex app-server proxy` | SSH, then the daemon's Unix socket | SSH host key and key authentication | The SSH account |
| Any process of the user (not the bus) | The Codex desktop app's IPC router, which connects its windows | Unix socket, `$CODEX_HOME/ipc/ipc.sock` | The directory is 0700 and the socket 0600; the router makes no peer check, and doesn't check who sends broadcasts ([platforms: Codex](../platforms/codex.md#the-desktops-ipc-router)) | Every process of the user on the machine: any of them can ask the window that owns a desktop thread to start or steer a turn, and receives the broadcasts about every thread. The bus doesn't connect to it |

### Who may do what to whose thread or queue item

The first rows are what a session can do through `serve`; the rest are what `serve` itself does to Codex threads, built from `src/Bus.ts` and `src/codex.ts`. A process of the user that bypasses `serve` is in the table above.

| Actor | Does | To | Only when | Held by |
| --- | --- | --- | --- | --- |
| A session | Sends | Any address, `#topic` or `*` | It owns the address it sends from | The ownership check under the address's lock |
| A session | Reads, waits on, leaves, sends from | An address another session holds | Never: the call is refused, and nothing changes | The same check, under the address's lock |
| A session | Joins | An address another session holds | Never with `bus_join`, whose refusal says what the bus knows of the holder (runtime, machine, note, last call, whether a wait is open) and gives its join id. `bus_takeover` with that join id replaces the holder, which is refused from then on. The human's word is asked for by the tool's description and its destructive annotation, not checked | A match of the holder's join id only |
| A session | Rewinds with `replay` | Its own cursor | Always | The ownership check |
| A session | Looks up | Every message, peer and note on the ledger (`bus_history`, `bus_query`, `bus_peers`) | Always: there is no privacy between addresses | Only the read-only limits of rule 6 |
| A Codex session | Has `serve` nudge | The thread id it names, which must equal its own `session` | It joined from this machine, and the address has unread mail | The join check. A session id is self-asserted, so nothing proves the thread is the caller's |
| `serve` | Lists the queue, and adds one nudge | The queue of that Codex thread | None of its nudges already waits for that address; the nudge is a fixed text with no text from other sessions | `src/codex.ts`; [delivery](delivery.md#rules) |
| `serve` | Removes its nudge | The queue item it added | The mail has been read, and the item still has the ids Codex gave it and exactly its text. This is the removal policy of [delivery's rules](delivery.md#rules); Codex deletes by id, so an owner's edit landing between the check and the delete is lost ([delivery's limits](delivery.md#limits)) | `src/codex.ts`; delivery |
| `serve` | Borrows | A thread loaded nowhere | The thread passes delivery's eligibility, and the writer lock is free: it refuses while another process holds the thread | The daemon's writer lock; [delivery](delivery.md#codex-threads) |
| `serve` | Starts or steers a turn, answers an approval request, deletes or edits an item it didn't add, passes permission settings | Any thread | Never. The thread's current writer runs the nudge, with the thread's own permissions | Nothing in `serve` sends such a call (rule 7) |

### What `serve` may do to Codex threads

`serve` starts or steers no turn itself. It can start turns in the user's threads only through their queue, and load a thread only so that its queue runs:

- only for a Codex thread that joined an address from this machine with its own thread id;
- only while that address has unread mail, with at most one nudge waiting at a time; once the mail is read, it removes that nudge if it still waits with the ids Codex gave it and exactly its text, and nothing else in the queue;
- only with a fixed message that carries no text from other sessions;
- it loads a thread only by asking the machine's daemon to borrow it, which the writer lock refuses while another process holds the thread. It passes no permission settings, and [delivery](delivery.md#codex-threads) says which threads are eligible.

Whichever app-server has the thread loaded (the desktop app's, or the daemon's) runs the nudge with the thread's own permissions, which is why it names nothing but the thread's own address. A borrowed thread runs on the daemon, without the desktop app's features. A thread a client registered tools for is never borrowed: the daemon offers those tools to the model, and a call to one would wait for a client that isn't there.

### Approval in Codex

Codex asks approval for an MCP call, or refuses it under approval policy `never`, unless the thread has full access or the tool says it is safe ([platforms: Codex](../platforms/codex.md#approvals-for-mcp-tools)). The bus's tools say they reach only the bus's peers, and lookups say they are read-only. Only `bus_takeover` says it is destructive, because it replaces another session's hold. `bus_join` doesn't: it claims a free address or reconnects the caller's own session, and refuses an address another session holds before writing anything; its `replay` rewinds only the caller's own cursor.

So under Codex's default approval mode for the server (`auto`, without strict auto-review), only a takeover needs approval outside full access, and a thread can join, read and answer its mail in any sandbox. A server or tool set to `prompt` or `writes`, or strict auto-review, asks for more; one set to `approve` allows the takeover too. Replacing another session stays the human's call: `bus_takeover`'s description says so, and an annotation is no authorization. It also means a sandboxed thread can send to peers that aren't sandboxed. Mail is another session's words, to be weighed as data.

## Rules

1. **`serve` answers only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`,** and the MCP endpoint rejects any browser `Origin`. Both answer 403. This stops a web page, or one that rebinds a domain to loopback, from reaching the bus.
2. **Loopback is not authentication.** The bus trusts every process of the user on the machine. Ownership of an address is collision protection between cooperating sessions, not security.
3. **Fluree's data and admin APIs require the bearer token,** and CORS is off. The installer starts Fluree with `--data-auth-mode required`, `--admin-auth-mode required` and `--cors-enabled=false`. The token is in `~/.agent-bus/fluree-token` (mode 0600), is sent only to the data and admin APIs, and is never logged.
4. **The token has no subject.** One naming an identity would be held to identity policies, which deny writes.
5. **Fluree's event stream is open and carries no message content.** `serve` sends it no token. It names ledgers and commit pointers only, so a reader of it learns that something changed, never what ([platforms: Fluree](../platforms/fluree.md#the-event-stream)).
6. **`bus_query` is read-only and bounded.** It takes one SPARQL `SELECT`, parsed and regenerated from its syntax tree, so caller comments (which Fluree reads for `PRAGMA`s) never reach Fluree. It has no `FROM` or `SERVICE` anywhere. The ledger and `t` are fixed in the request path, and `t` must be an existing commit. The query is at most 32,768 characters, the result is cut off at 32 KB of rows, and a query is abandoned after 10 seconds. No Fluree fuel limit is set ([platforms: Fluree](../platforms/fluree.md#query-limits)).
7. **`serve` calls Codex only with a short list of methods.** To its own app-server: `initialize`, `thread/queue/list`, `thread/queue/add`, `thread/queue/delete` (only for an item it added) and `thread/read`. To the daemon: `initialize`, `thread/resume` and `thread/unsubscribe`, and the `codex app-server daemon start` command. It answers none of the requests an app-server sends it.
8. **A nudge or a wake text carries no text from other sessions.** A queued item runs as the thread owner's own input, and a Claude hook's output enters the session as Claude Code's own, so senders' words stay in `bus_read`'s result.
9. **`serve` loads a thread only by asking the daemon to borrow it,** and the writer lock refuses that while another process holds the thread. It passes no permission settings, and an ineligible thread is left as it was.
10. **`serve` removes only its own nudge,** under [delivery's rules](delivery.md#rules).
11. **The other machine reaches Fluree only through SSH,** with key authentication and no prompts (`BatchMode`). The Fluree token is copied to it over `scp` at install and still applies.
12. **Replacing another session is the human's call.** Only `bus_takeover` is marked destructive, so that Codex asks approval for it outside full access, and mail from other sessions is data, not instruction.

## Why

- **Loopback, a `Host` check and an `Origin` check, rather than a credential on `serve`.** The bus serves one user's processes on one machine, and a session's id is only a claim it makes. Ownership was added after two unrelated sessions shared an address and one consumed the other's reply, as collision protection, with no pretence of security.
- **A token on Fluree, as well as loopback.** CORS off alone doesn't stop a cross-origin `text/plain` POST from writing, so the token is what protects the loopback server. The token has no subject because Fluree holds a token that names an identity to its identity policies, and those deny writes on a ledger that has none.
- **An open event stream.** It carries only change notices. A token with no subject is not accepted there ([platforms: Fluree](../platforms/fluree.md#the-event-stream) has its status), so `serve` sends none.
- **A queue for waking, not a socket that starts turns.** `serve` adds a fixed nudge to the thread's own queue and lets the thread's writer run it, so it never drives a turn itself. The borrow loads a thread only so that its queue runs, behind the writer lock. This keeps the bus's reach to a text the owner can see, in a place the owner can edit.
- **Rejected: starting or steering turns through the daemon,** as the first Codex route did. It made the bus a second writer, which locked the owner out of a desktop thread.
- **Rejected: the desktop's IPC router,** to start or steer a turn in a window that owns the thread. It is private and unauthenticated, any same-user process can use it, and the queue already wakes idle Local threads. It was never built.
- **Rejected: moving the owner's desktop threads onto the daemon,** through an SSH project to the same machine or the `CODEX_APP_SERVER_WS_URL` override, so that the bus could wake them live. Both lose desktop features the owner needs ([platforms: Codex](../platforms/codex.md#what-desktop-capable-means)), so the owner stays in Local threads.

## Limits

| Gap | Status |
| --- | --- |
| Every process of the user on the machine can call `serve`, read the token, connect to the Codex daemon's socket and, on a desktop machine, the app's IPC router. None of them authenticates its caller | **Accepted risk**: the bus's boundary is the user's account |
| A session id is a claim, not a credential: any process that knows another session's id can act as it, and one started from a session's shell inherits it. A process can also name another thread's id in a Codex join and so have `serve` nudge that thread, with a fixed text | **Known limit** (read in `src/Bus.ts`); give a delegate its own address |
| A takeover needs only the holder's join id, which the refusal gives; "only on the human's word" is guidance in the tool's description | **Known limit** |
| Any session can read every message on the ledger, to any address, through `bus_history` and `bus_query`, and list every peer | **Known limit** |
| The Fluree token lasts 520 weeks. The installer makes a new token only when the file is missing or invalid, or the key is recreated, and there is no rotation procedure | **Known limit** |
| Codex deletes a queued item by id with no check on its content, so an owner's edit of a nudge landing between `serve`'s check and its delete would be lost | **Accepted risk**, owned by [delivery's limits](delivery.md#limits) |
| A sandboxed Codex thread can send to peers that aren't sandboxed | **Known limit**: mail is data to be weighed, not instruction |
| `serve` assumes the Codex CLI it runs speaks the experimental queue methods; a change shows as logged errors, and the mail waits unread | **Accepted risk**, owned by [delivery's limits](delivery.md#limits) |
| That the event stream refuses a token with no subject | **Unverified** here; recorded on [the platform page](../platforms/fluree.md#the-event-stream) |

## Rests on

- [Fluree: the transaction server](../platforms/fluree.md#the-transaction-server) (token modes, CORS), [the event stream](../platforms/fluree.md#the-event-stream) and [query limits](../platforms/fluree.md#query-limits).
- [Codex: approvals for MCP tools](../platforms/codex.md#approvals-for-mcp-tools), [one writer per thread](../platforms/codex.md#one-writer-per-thread), [the shared queue](../platforms/codex.md#the-shared-queue) and [the daemon](../platforms/codex.md#the-daemon).
- [Codex: the desktop's IPC router](../platforms/codex.md#the-desktops-ipc-router), whose exposure the connections table records.

## History

How these boundaries were decided is in the [frames index](../frames/README.md). The frames behind this page:
- [address-ownership](../frames/address-ownership.md): an address belongs to one session; collision protection, not security.
- [one-codex-route](../frames/one-codex-route.md): every Codex thread takes the queue nudge, and `serve` stops driving the daemon.
- [load-on-mail](../frames/load-on-mail.md): the daemon borrow, and what `serve` sends the daemon.
- [desktop-wake-spike](../frames/desktop-wake-spike.md): the desktop IPC router and its exposure.
- [codex-wake](../frames/codex-wake.md): the second-writer lockout, and moving desktop threads onto the daemon.
- [nudge-hygiene](../frames/nudge-hygiene.md): removing `serve`'s own nudge, and `bus_takeover` as its own destructive tool.
