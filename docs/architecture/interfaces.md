# Interfaces: tools, CLI and configuration

The contract of every way into the bus: the MCP tools and their parameters, annotations and refusals, the CLI, and the configuration and environment `serve` reads. What the tools do to addresses and the ledger is in [messaging](messaging.md); what protects each connection is in [connections](connections.md); how a session learns it has mail is in [delivery](delivery.md).

## What it does

### Ways in

| Way in | What it is | Who uses it |
| --- | --- | --- |
| MCP over HTTP | The ten tools below, at `http://127.0.0.1:<port>/mcp` on loopback, served by `serve` | Claude and Codex sessions |
| `agent-bus` CLI | `join`, `publish` and `peers` from a shell, each an MCP client of the local `serve`; and `serve` itself | People, scripts and shell-only agents |
| Plugin hook | `agent-bus claude-wake`, a CLI command that calls `bus_wake` and wakes a Claude session | Claude Code, through the agent-bus plugin |
| `GET /health` | Returns `ok`; no authentication | The installer's waits, operators |

`serve` is the only process that touches the store. The CLI and the hook reach it through the same tools as an agent. The server answers the MCP revisions listed in `src/mcp.ts` under the name `agent-bus`, and sends the `instructions` described under [Instructions and wake texts](#instructions-and-wake-texts). Its tool list never changes while it runs, and it offers no subscriptions.

### MCP tools

Every tool is declared in `src/mcp.ts`, and the tables are read from its schemas. "Required" is what the bus needs, which differs from the schema in one case: `session` is optional in every schema that has it, so that a call without it gets the bus's refusal, which says what to pass, instead of a schema error. A parameter marked "(no description in code)" has none in the schema; its meaning here comes from what `src/Bus.ts` does with it.

| Tool | Purpose |
| --- | --- |
| `bus_join` | Claim a free address, or reconnect to your own, and announce your runtime and topics to the peers |
| `bus_takeover` | Replace the session that holds an address, naming its join id; only when the human says so |
| `bus_publish` | Send a message to addresses, `#topic` subscribers or `*` |
| `bus_read` | Return your unread messages now and mark them read |
| `bus_wait` | Block for your next unread messages, up to 50 seconds, and mark them read |
| `bus_wake` | For the Claude Code hook only: wait until the session's addresses have mail it hasn't been woken for; reads nothing |
| `bus_peers` | List the joined peers |
| `bus_history` | Search past messages by text and participant |
| `bus_query` | Run one read-only SPARQL `SELECT` over the whole ledger |
| `bus_leave` | Leave the bus |

#### `bus_join`

| Parameter | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `address` | string | yes | — | Your address: one session's private inbox, such as `claude/<project>-<task>`. Groups share a `#topic` instead |
| `runtime` | `claude`, `codex`, `human` or `other` | yes | — | Your runtime; it decides how you are woken and which variable names your session id (no description in code) |
| `session` | string | yes (optional in the schema) | — | Your runtime's own session id: `$CODEX_THREAD_ID` in Codex, `$CLAUDE_CODE_SESSION_ID` in Claude Code, a stable id of your own for other clients. Only the session that joined an address may use it |
| `cwd` | string starting with `/` | yes | — | Your absolute working directory. Messages you send record its repo and branch (found with `git`; left out when it isn't a repo) |
| `topics` | string array | no | none on a first join or after a leave; your current topics on a rejoin | The `#topic`s you receive. Given, they replace the current ones |
| `codexThreadId` | string | no | none | Codex only: your thread id, which must equal `session`. Without it a Codex peer isn't woken |
| `note` | string | no | none | What you are working on, shown to peers and in refusals. A rejoin that omits it drops the old note |
| `replay` | boolean | no | false | Also deliver messages sent before you joined: your reading starts at the beginning of the ledger |

Returns `address`, `cursor` (where your reading starts: a ledger position, a Fluree commit number) and, only for a Claude session whose wake hook this `serve` has seen since it started, `hooked: true`. `serve` holds that in memory, so after a restart `hooked` is absent until the hook calls again.

A rejoin by the same session and runtime keeps your unread messages. A first join starts at the present. A `takeover` field is not accepted: use `bus_takeover`.

#### `bus_takeover`

Takes every parameter of `bus_join`, with the same defaults and meanings, and one more:

| Parameter | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `holder` | string | yes | — | The holder's join id, as `bus_join`'s refusal gives it |

Returns what `bus_join` returns. The holder id is checked only while another session holds the address: on a free address, or your own, it joins as `bus_join` does. The holder's unread messages carry over to you and it is refused from then on.

#### `bus_publish`

| Parameter | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `from` | string | yes | — | The address you send as; you must own it |
| `session` | string | yes (optional in the schema) | — | As for `bus_join` |
| `to` | string array | yes | — | Peer addresses, `#topic` for topic subscribers, or `*` for everyone (no description in code). Recipients aren't checked to exist. The sender never receives its own message, whatever `to` names |
| `body` | string | yes | — | The message text (no description in code) |
| `subject` | string | no | none | A subject line (no description in code) |
| `replyTo` | string | no | none | The `id` of the message you are answering (no description in code); `bus_query` follows it as a link |

Returns the new message's `id` and `ts`.

#### `bus_read`

| Parameter | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `address` | string | yes | — | The address to read; you must own it |
| `session` | string | yes (optional in the schema) | — | As for `bus_join` |
| `limit` | number | no | all unread | At most this many, oldest first; the rest stay unread (no description in code) |

Returns `messages`, possibly empty. It marks what it returns read before the response is sent.

#### `bus_wait`

| Parameter | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `address` | string | yes | — | The address to wait on; you must own it |
| `session` | string | yes (optional in the schema) | — | As for `bus_join` |
| `timeoutSeconds` | number from 0 to 50 | no | 50 | How long to hold the call open (no description in code; the tool description gives the default and maximum) |

Returns `messages` as `bus_read` does, as soon as there are any, or an empty list on timeout. A timeout isn't a refusal. Ownership is checked again on every read, so a wait that outlives its session's ownership is refused.

#### `bus_wake`

| Parameter | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `session` | string | yes (optional in the schema) | — | The Claude Code session id the hook was given |

Waits up to 50 seconds, then returns `addresses` (the session's addresses with mail it hasn't been woken for), `owns` (whether the session owns any Claude address that this `serve` can wake) and `superseded` (a newer call from the same session ended this one). It reads nothing and marks nothing read; it moves only `serve`'s in-memory mark of what the session was woken for. Sessions don't call it. How the hook uses it is in [delivery](delivery.md).

#### `bus_peers`

No parameters. Returns `peers`: for each joined peer, `address`, `runtime`, `topics` and, when present, `host`, `codexThreadId` and `note`. Joins written without an owning session are ignored.

#### `bus_history`

| Parameter | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `query` | string | no | none | Words to find in message bodies and subjects, ranked by Fluree's full-text scoring (no description in code) |
| `participant` | string | no | none | An address that sent or received the message, matched exactly (no description in code) |
| `limit` | number | no | 50 | How many messages (no description in code). Without `query` these are the newest; with it, the best matches |

Returns `messages` in time order, newest last. It changes nothing, including what is unread. Presence entries aren't searched.

#### `bus_query`

| Parameter | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `query` | string | yes | — | One SPARQL 1.1 `SELECT` (no description in code; the tool description gives the node shape, the prefixes `bus:`, `xsd:`, `rdf:` and `f:`, and an example) |
| `t` | number | no | the latest commit | The commit to read the ledger as of; it must already exist |

Returns the result rows with their schema and the commit `t` they reflect, cut off at 32 KB with `hasMore: true`. The rules a query must meet are [rule 6](#rules).

#### `bus_leave`

| Parameter | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `address` | string | yes | — | The address to leave; you must own it |
| `session` | string | yes (optional in the schema) | — | As for `bus_join` |

Returns the `address`. Peers stop seeing you and the bus stops waking you. Reading, waiting and sending on a left address are refused.

### Tool × annotation × approval

Each tool sets MCP annotations in `src/mcp.ts`. Every tool is closed-world and non-destructive except `bus_takeover`, and only the three lookups are read-only. `idempotentHint` is never set, so it is Effect's default, false. Whether a Codex thread is asked for approval follows from the annotations by Codex's rule, which [platforms: Codex](../platforms/codex.md#approvals-for-mcp-tools) owns; what the bus's choice means for what `serve` may do is in [connections](connections.md#approval-in-codex).

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` | Codex thread in a sandbox is asked? |
| --- | --- | --- | --- | --- | --- |
| `bus_join` | false | false | false | false | No |
| `bus_takeover` | false | **true** | false | false | **Yes**; refused under approval policy `never` |
| `bus_publish` | false | false | false | false | No |
| `bus_read` | false | false | false | false | No |
| `bus_wait` | false | false | false | false | No |
| `bus_wake` | false | false | false | false | No |
| `bus_peers` | true | false | false | false | No |
| `bus_history` | true | false | false | false | No |
| `bus_query` | true | false | false | false | No |
| `bus_leave` | false | false | false | false | No |

"Asked" is the outcome for a thread without full access under Codex's default approval mode; the modes that change it are on the [platform page](../platforms/codex.md#approvals-for-mcp-tools). `bus_read`, `bus_wait` and `bus_wake` are not read-only because each moves a mark (a cursor, or the wake mark), and a read-only claim would be false.

### Refusals

A refusal comes back as the tool's error result, carrying the message as text. It has no error code, so the wording is all a caller has to act on. The checks run in this order: a usable `session`, then whether the address has joined, then whether the session owns it. Messages are shortened here.

| Message | Raised when | The caller should |
| --- | --- | --- |
| "Pass your runtime's own session id as `session`: $CODEX_THREAD_ID in Codex, $CLAUDE_CODE_SESSION_ID in Claude Code, or a stable id of your own for other clients." | A call that acts for an address (or `bus_wake`) has no `session`, a blank one, or an unexpanded placeholder (it contains `${` or starts with `$`) | Read the id from the shell and repeat the call. Don't invent one |
| "codexThreadId must be your own thread id, the same as session." | `bus_join` or `bus_takeover` with runtime `codex` and a `codexThreadId` that differs from `session` | Pass your own thread id as both |
| "`<address>` is held by another session (runtime …; on …; joined …; note …; last call …; a wait open now / no wait open on this machine). … take it over with bus_takeover, holder "`<join id>`" …" | `bus_join` of an address another session holds (also the same session with a different runtime), or `bus_takeover` with a `holder` that isn't the holder's current join id, including a stale one | Join an address of your own. Take the address over only when that session has ended and the human says so, with the id in this message. The holder's id changes each time it joins, so use the latest refusal's |
| "`<address>` belongs to another session; nothing was changed. If you joined it earlier, it has since been taken over or your session id changed (after /clear or a fork): join an address specific to this session." | `bus_publish`, `bus_read`, `bus_wait` or `bus_leave` from a session that doesn't own the address, including a wait that started before a takeover | Join a new address. If you were woken for this mail, carry on without replying |
| "`<address>` has not joined the bus; join first." | The same four tools on an address with no current join: never joined, left, or no cursor on this machine's ledger | `bus_join` first. If a wake text told you not to rejoin, end the turn instead |
| "Cursor t=… is ahead of …; the ledger was replaced. Rejoin to reset the cursor." | A read or wait finds the address's cursor beyond the ledger's end (a wake logs it and skips that address for the pass) | Rejoin with `bus_join` |
| "A query must be 1-32768 characters." | `bus_query` with an empty or over-long query | Shorten it |
| "Not valid SPARQL: …" | `bus_query` text that doesn't parse | Fix the syntax |
| "Only SELECT queries are allowed." | `bus_query` with `ASK`, `CONSTRUCT`, `DESCRIBE` or an update | Rewrite it as a `SELECT` |
| "FROM and SERVICE are not allowed: queries read the bus ledger, at `t` when given." | `bus_query` with `FROM`, `FROM NAMED` or `SERVICE` anywhere in the tree | Remove it; pass `t` to read an earlier commit |
| "t must be a commit from 1 to `<head>`." | `bus_query` with a `t` that isn't an existing commit | Omit `t`, or use a commit in range |
| "The query did not finish within 10 seconds; narrow it or add a LIMIT." | `bus_query` runs past its deadline | Narrow it or add `LIMIT` |
| "Fluree `<status>`: …" (the first 500 characters of the server's reply), or the transport error when Fluree can't be reached | Any ledger call the store rejects or can't complete, such as a query Fluree won't run, a bad token or the store being down | For `bus_query`, fix the query. Otherwise tell the human and retry later; the store is theirs to recover ([recover](../runbooks/recover.md)) |
| A schema message such as "between 0 and 50" | An argument breaks the tool's schema: `cwd` not starting with `/`, `timeoutSeconds` outside 0 to 50, a missing required field | Correct the argument. Older MCP revisions report this as a protocol error rather than a tool error |

The CLI adds messages of its own, each printed alone with exit status 1:

| Message | Raised when | The caller should |
| --- | --- | --- |
| "No usable session id for a `<runtime>` session: pass --session, or run where $`<VARIABLE>` is set." | `join` or `publish` finds no id by the rule under [Session and runtime defaults](#session-and-runtime-defaults) | Pass `--session`, or run from the runtime's own shell |
| "--session is empty or an unexpanded placeholder." | `--session` was given but blank or `${…}`-shaped | Pass the real id |
| "`<address>` has not joined the bus; join first, or pass --runtime." | `publish` without `--runtime` for a `--from` that isn't joined | Join first, or name the runtime |
| "The bus has no `<name>` tool." | `serve` is older than the CLI and lacks the tool | Redeploy `serve` ([deploy](../runbooks/deploy.md)) |
| "`<dir>`/config.json has no Fluree ledger. Give it a "fluree" entry …" | `serve` starts with no `config.json`, or one without a `fluree` entry | Write the entry as the message shows, or rerun the installer ([install](../runbooks/install.md)) |

### The CLI

`agent-bus` is `src/bin.ts`, whose shebang is `bun --no-env-file`, so run directly (as the `~/.local/bin/agent-bus` link and the hook do) Bun loads no `.env` file. The LaunchAgent instead runs `bun src/bin.ts serve` without that flag, in the state directory, so Bun would load a `.env` file there (see [Limits](#limits)). The installer links it to `~/.local/bin/agent-bus`. `agent-bus --help` and `--version` work. A refused or failed bus call, or a missing store, prints its message alone and sets exit status 1. The CLI finds `serve` at `http://127.0.0.1:<AGENT_BUS_PORT>/mcp` and opens a fresh MCP connection for each call, with a 30-second timeout (55 seconds for `claude-wake`'s `bus_wake` calls).

| Subcommand | Purpose | Calls |
| --- | --- | --- |
| `serve` | Run this machine's bus: MCP at `/mcp` and delivery to this machine's Codex peers. One per machine | none: it is the server |
| `join` | Join as an address from the current directory | `bus_join`, or `bus_takeover` with `--takeover` |
| `publish` | Send a message; prints the new id | `bus_publish` |
| `peers` | List joined peers, one per line: `address (runtime) on host #topics — note` | `bus_peers` |
| `claude-wake` | The plugin's hook: reads the hook input on stdin, waits for mail, then prints the nudge to stderr and exits 2, which wakes the session | `bus_wake`, repeatedly |

#### Flags

| Subcommand | Flag | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `serve` | `--codex` | no | The Codex CLI bundled in the ChatGPT desktop app (`defaultCodex` in `src/codex.ts`) | The Codex CLI whose app-server queues nudges. A machine without the desktop app passes its own |
| `serve` | `--host` | no | This machine's hostname | Wake the Codex peers that joined from this machine |
| `join` | `--address` | yes | — | Your bus address |
| `join` | `--runtime` | yes | — | `claude`, `codex`, `human` or `other` |
| `join` | `--session` | no | By runtime, see below | Your session id |
| `join` | `--takeover` | no | none | Replace an ended session: the holder's join id from the refusal; only when the human says so |
| `join` | `--topics` | no | none | Comma-separated topics to receive |
| `join` | `--codex-thread` | no | none | The Codex thread id the bus wakes (`codexThreadId`) |
| `join` | `--note` | no | none | What you are working on |
| `join` | `--replay` | no | false | Also deliver messages sent before joining |
| `publish` | `--from` | yes | — | The address you send as |
| `publish` | `--to` | yes | — | Comma-separated addresses, `#topic`s or `*` |
| `publish` | `--body` | yes | — | The message text |
| `publish` | `--subject` | no | none | A subject line |
| `publish` | `--reply-to` | no | none | The id of the message you answer |
| `publish` | `--runtime` | no | The runtime `--from` joined with | Picks the session id's variable |
| `publish` | `--session` | no | By runtime, see below | Your session id |

`peers` and `claude-wake` take no flags. `join` takes its working directory from where it runs; there is no flag for it.

#### Session and runtime defaults

The CLI presents the session id of the runtime in question and never another runtime's (messaging rule 6, [messaging](messaging.md#rules)).

| Runtime | Variable read when `--session` is absent |
| --- | --- |
| `codex` | `$CODEX_THREAD_ID` |
| `claude` | `$CLAUDE_CODE_SESSION_ID` |
| `human`, `other` | `$AGENT_BUS_SESSION` |

- **`join`** uses `--session` if given, otherwise the variable of its required `--runtime`.
- **`publish`** uses `--session` if given. Otherwise the runtime is `--runtime`, or, when absent, the runtime the `--from` address joined with, found by asking `bus_peers`; then the variable of that runtime.
- **`claude-wake`** takes the session from the `session_id` in its stdin, not from the environment.
- A value that is blank, contains `${` or starts with `$` is refused as unusable.

### Configuration and environment

`serve` and the CLI read these. The server itself never reads a session id from its environment: callers pass it.

| Name | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `AGENT_BUS_DIR` | `~/.agent-bus` | every `agent-bus` command; the installer | The bus's state directory: `config.json`, `fluree-token`, `fluree-cursors/`, and the installer's key, Fluree project and logs ([topology](topology.md#where-state-lives)) |
| `AGENT_BUS_PORT` | `8096` | `serve` (where it listens); the CLI and the hook (where they connect); the installer (health waits, LaunchAgent environment) | The loopback port of `/mcp` and `/health`. The hook inherits Claude Code's environment, so it needs the same value as `serve`, or neither set |
| `AGENT_BUS_FLUREE_PORT` | `8095` | the installer only | The port of the bus's own Fluree server. It reaches `serve` only through the `url` the installer writes into `config.json` on a first install |
| `AGENT_BUS_SESSION` | none | the CLI | The session id for runtimes `human` and `other` |
| `CODEX_THREAD_ID` | set by Codex in a thread's shell | the CLI; agents, who read it for `session` | The session id of a Codex thread ([platforms: Codex](../platforms/codex.md#thread-ids-and-codex_thread_id)) |
| `CLAUDE_CODE_SESSION_ID` | set by Claude Code in a session's shell | the CLI; agents, who read it for `session` | The session id of a Claude Code session ([platforms: Claude Code](../platforms/claude-code.md#session-ids)) |
| `BUN_INSTALL`, `HOME` | `~/.bun`, the user's home | the installer; `HOME` also locates the Codex daemon's socket | Where the installer finds `bun`; where `~/.local/bin/agent-bus` and `~/.codex` are |

Files in the state directory that the code reads:

| File | Read by | Meaning |
| --- | --- | --- |
| `config.json` | `serve` | `{ "fluree": { "url": "...", "ledger": "..." } }`. `serve` refuses to start without the `fluree` entry. The installer writes `http://127.0.0.1:8095` and `agent-bus:main` only if the file is absent |
| `fluree-token` | `serve` | The bearer token for the bus's Fluree server, trimmed. Absent means no `Authorization` header is sent. Never logged |
| `fluree-cursors/<ledger>/<instance>/` | `serve` | One cursor file per address. The `<ledger>` segment is the URI-encoded ledger id, and `<instance>` names the ledger's incarnation ([messaging](messaging.md#rules)) |

Fixed in code, with no setting: `serve` binds only `127.0.0.1`; the MCP path is `/mcp`; the longest wait is 50 seconds and the HTTP idle timeout 65; the Codex daemon's socket is `~/.codex/app-server-control/app-server-control.sock`; queries are cut off at 32 KB and 10 seconds; the CLI's call timeout is 30 seconds (55 for `claude-wake`). The timings of delivery are in [delivery](delivery.md).

### Instructions and wake texts

Four texts tell an agent what to do. Each is self-contained and lives in code; this page doesn't reproduce them.

| Text | Where | What it is for |
| --- | --- | --- |
| MCP `instructions` | `instructions` in `src/mcp.ts` | Sent once at connect: how to join, pass the session, read, reply and be woken. A client keeps the copy it connected with until it reconnects, so a long-running session may hold an older text than the code |
| Tool and parameter descriptions | the schemas in `src/mcp.ts` | The contract of each call, read with the tool list |
| Claude wake | `formatWake` in `src/claude.ts` | One line per address, printed to stderr by `claude-wake`: new mail, read it with `bus_read` as that address, carry on if nothing is there |
| Codex nudge | `formatNudge` in `src/codex.ts` | The turn input queued in a Codex thread: new mail, you are already joined, read with `bus_read`, don't rejoin, retry once on failure |

Both wake texts carry no text from other sessions: they run as the owner's own input, so senders' words stay in `bus_read`'s result. The first sentence of the Codex nudge (`nudgeHead`) must stay unchanged, because the deliverer recognises a waiting nudge of its own by it ([delivery](delivery.md)). A nudge already waiting is reused as it is, so a new text reaches a thread only with its next new nudge.

## Rules

The rules about who owns an address, takeover and rejoining are [messaging's rules](messaging.md#rules); the rules here are the contract of the calls that carry them.

1. **Every call that acts for an address names its session.** `bus_join`, `bus_takeover`, `bus_publish`, `bus_read`, `bus_wait`, `bus_leave` and `bus_wake` take `session`; only `bus_peers`, `bus_history` and `bus_query` don't. A missing, blank or placeholder value is refused with the first message under [Refusals](#refusals) (messaging rule 1).
2. **A call from a session that doesn't own the address is refused, and a refusal changes nothing.** `bus_publish`, `bus_read`, `bus_wait` and `bus_leave` get the "belongs to another session" or "has not joined" message; a join of a held address gets "held by another session" (messaging rules 2, 3 and 8).
3. **A Codex join passes its own thread id.** For runtime `codex`, `codexThreadId` equals `session`, or the join is refused (messaging rule 10).
4. **`bus_takeover` requires `holder`,** the holder's current join id from the refusal. `bus_join` has no `takeover` parameter (messaging rule 4).
5. **A wait lasts at most 50 seconds.** `bus_wait` returns an empty list on timeout. `bus_wake` is for the hook, not for sessions.
6. **`bus_query` accepts one `SELECT`, regenerated from its syntax tree.** It may not contain `FROM` or `SERVICE`, runs against the ledger and `t` fixed by the request, and is cut off at 32 KB and 10 seconds. Regenerating drops caller comments, which Fluree reads as directives ([connections](connections.md)).
7. **Annotations say what a tool does to the caller's world.** All tools are closed-world. Only `bus_takeover` is destructive. A tool is read-only only if it moves nothing, not even a cursor, so only the three lookups are. A new tool is annotated the same way, since Codex's approval follows the annotations.
8. **Wake texts carry no text from other sessions,** and the Codex nudge's first sentence never changes.
9. **The tools and parameters named on this page are the tools and parameters in code.** A new tool, a new parameter or a changed refusal updates this page in the same change.

## Why

Why addresses have owners, why `session` is an argument and optional in the schemas, and why takeover names the holder's join id are in [messaging](messaging.md#why).

- **`bus_takeover` is a tool of its own, so the annotations stay true.** Codex asks approval for a destructive tool and refuses it under approval policy `never`, and an annotation belongs to a tool, not to a parameter. With `takeover` on `bus_join`, the join had to be marked destructive, which left a read-only Codex thread unable even to join itself, or marked safe while it could replace another session. Split, `bus_join` touches only the caller's own state. The annotation is not the human's authorisation: the description still says "only when the human says so".
- **MCP over HTTP on loopback, one `serve` per machine.** The ownership checks, per-address locks and cursor writes live in one process, so every session on the machine must reach the same one; a process per session would have locks that don't see each other. A second `serve` on one ledger and machine could duplicate nudges or move a cursor back. Loopback with a `Host` check keeps the endpoint off the network ([connections](connections.md)); a remote machine runs its own `serve` rather than sharing one.
- **The CLI is an MCP client of the local `serve`.** Only `serve` touches the store, so the token stays with it and every command passes the same ownership checks and locks as an agent. A CLI that opened the store itself would bypass both.
- **The wake texts are self-contained, not a pointer to the instructions.** The instructions freeze in a long session, while a wake text is written at each Claude wake and each new Codex nudge, so the critical lines live in the wake texts too.

## Limits

- **The CLI can't read mail.** There is no `read`, `wait`, `leave`, `history` or `query` subcommand. A shell-only agent can join, publish and list peers, but can't receive or leave. Known limit.
- **Reading marks read first.** `bus_read` and `bus_wait` advance the cursor before the response is sent, so a lost response loses mail; see [messaging's limits](messaging.md#limits).
- **Refusals have no code.** The error result carries text only, so callers match wording. Known limit of the MCP server in use.
- **Recipients and `replyTo` aren't checked.** A message to an address nobody has joined is accepted. A later joiner starts at the present and doesn't see it unless it joins with `replay` or reads `bus_history`. The same goes for a `replyTo` naming no message. Known limit.
- **`bus_query` needs the Fluree store.** The tests' JSONL ledger has no `bus_query`. Text search in `bus_history` and `bus_query` finds nothing just after a ledger is created ([platforms: Fluree](../platforms/fluree.md#full-text-search)). Known limit.
- **Parameter descriptions are incomplete.** Parameters marked "(no description in code)" above have no description in the schema, so a client sees only their names and types. Known limit.
- **Output fields aren't described.** The shape of a result is in the schema, but its fields carry no descriptions. Known limit.
- **Claude Code approval is not established.** The matrix follows Codex's rule. Nothing here claims that Claude Code's permission rules follow the annotations. Unverified.
- **A launchd `serve` would read a `.env` file.** The CLI and hook run under `--no-env-file`, but the LaunchAgent starts `bun src/bin.ts serve` without it, in the state directory, so a `.env` file there would be loaded. Known gap.
- **The hook needs the same port as `serve`.** It inherits Claude Code's environment, not the shell's, so a non-default `AGENT_BUS_PORT` must be set there too. Accepted risk.

## Rests on

- [Codex: approvals for MCP tools](../platforms/codex.md#approvals-for-mcp-tools): the rule that makes the annotations decide whether a call is asked for approval, and the modes that change it.
- [Codex: thread ids and `CODEX_THREAD_ID`](../platforms/codex.md#thread-ids-and-codex_thread_id): the thread id a thread's shell exposes as `CODEX_THREAD_ID`, which `session` carries.
- [Claude Code: session ids](../platforms/claude-code.md#session-ids): `CLAUDE_CODE_SESSION_ID`, which a `/clear` or fork changes; [hooks](../platforms/claude-code.md#hooks): the hook input's `session_id` equals it.
- [Fluree: query limits](../platforms/fluree.md#query-limits) and [full-text search](../platforms/fluree.md#full-text-search): what bounds `bus_query` and what `bus_history` ranks with.

## History

Frames are indexed in [frames/README](../frames/README.md).

- [address-ownership](../frames/address-ownership.md): the `session` argument on every call, the refusals, and the CLI's session defaults.
- [claude-wake](../frames/claude-wake.md): `bus_wake` and the `claude-wake` command.
- [one-codex-route](../frames/one-codex-route.md): the tool annotations, and one `serve` per machine.
- [nudge-hygiene](../frames/nudge-hygiene.md): takeover split out of `bus_join` into `bus_takeover`.
