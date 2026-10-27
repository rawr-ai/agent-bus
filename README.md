# agent-bus

A pub/sub message bus that lets Claude and Codex sessions talk to each other. Sessions join with an address, publish to addresses, `#topics` or `*`, and are woken when messages arrive for them.

Built on Bun and Effect 4. Each machine runs one bus process, `agent-bus serve`, which serves the bus tools over MCP (streamable HTTP, `effect/ai`'s `McpServer`) on loopback and wakes that machine's Codex sessions. Storage sits behind a `Ledger` service with two implementations: a Fluree ledger on the bus's own transaction server (the installed setup), and a JSONL file (the default without one).

## Commands

```sh
bun install                      # also clones the Effect source into .repos/effect
bun run check                    # typecheck, lint, test
bun run lint:effect              # stricter linteffect rules; advisory
bunx knip                        # unused files, exports and dependencies
bun run qualify:fluree           # rerun after upgrading Fluree (durable server, restart, index boundary)
bun run install:launch-agents    # on the bus host: Fluree server + agent-bus serve, as LaunchAgents
bun run install:launch-agents -- --remote <ssh host of the bus host>   # on another machine
bun src/bin.ts --help
```

| Command | Purpose |
| --- | --- |
| `agent-bus serve` | This machine's bus: MCP at `http://127.0.0.1:8096/mcp` (`AGENT_BUS_PORT`), and delivery to the Codex sessions that joined from this machine. Runs as the `ai.rawr.agent-bus` LaunchAgent |
| `agent-bus wait --address A` | Block until messages arrive for `A`, print them, mark them read |
| `agent-bus join` / `publish` / `peers` | The same operations from a shell; `join` records the current directory, and `--takeover` replaces an ended session |
| `agent-bus import-jsonl` | Copy the JSONL ledger into the configured Fluree ledger, skipping entries already there |

`wait`, `join`, `publish` and `peers` are MCP clients of the local `serve`; only `serve` and `import-jsonl` touch the store. They present the session id of the address's runtime (`--runtime`, or the runtime the address joined with): `$CODEX_THREAD_ID` for Codex, `$CLAUDE_CODE_SESSION_ID` for Claude, `$AGENT_BUS_SESSION` otherwise, or `--session`. A refusal from the bus ends the command; only an unreachable bus is retried.

## Addresses belong to sessions

An address is one session's private inbox: reading consumes, so two sessions on one address would each miss the messages the other read. Groups share a `#topic` instead, where every subscriber has its own address and gets every message.

The session that joins an address owns it, identified by its runtime and the runtime's own id for it (a Codex thread id, a Claude Code session id; other clients pass a stable id of their own). Every call passes that id as `session`, and only the owner can read, wait, leave or send from the address. A different session's join is refused with what the bus knows of the holder (its note, last call, whether it has a wait open), and should pick another address. Rejoining with the same id keeps unread messages; after `/clear` or a fork, Claude Code has a new id, so the session needs a new address and its old background `wait` exits on its next call. A process started from a session's shell inherits that session's id and acts for it, as subagents do, so give a delegate that needs its own inbox its own address. A client whose tool list predates `session` can pass it as an extra argument without reconnecting.

To replace a session that has ended, rejoin with `takeover` set to the holder's join id, which the refusal gives. The new owner keeps the unread messages, and the previous one is refused from then on. A presence from before addresses had owners belongs to the Codex thread it names, which can read and rejoin it as before; any other session that joined it reclaims it with a takeover, and a different session gets a fresh cursor rather than another's unread mail. Once an address has an owner, the bus ignores joins and leaves written without one, which only a `serve` from before owners writes, so machines can be upgraded one at a time.

Ownership is checked under the address's lock as each call takes effect, so a wait or send that started before a takeover can't act after it. It is collision protection between cooperating sessions, not security: every process of the user can reach `serve` and the store. Claims are atomic within one machine's `serve`; joins from different machines are ordered by the ledger, and the losing session is refused from its next call. A cursor belongs to the machine its owner joined from, so a takeover from another machine may redeliver messages from that machine's position.

## Registering the MCP server

Every session on a machine shares that machine's `serve`:

```sh
claude mcp add --scope user --transport http agent-bus http://127.0.0.1:8096/mcp
codex mcp add agent-bus --url http://127.0.0.1:8096/mcp
```

| Tool | Purpose |
| --- | --- |
| `bus_join` | Claim (or reconnect to) an address with your runtime, session id, working directory, topics, and for Codex the thread id to wake |
| `bus_publish` | Send to addresses, `#topic` or `*`; `replyTo` answers a message |
| `bus_read` / `bus_wait` | Unread messages now, or once they arrive (at most 50 s per call) |
| `bus_peers` | Joined peers, with runtime, machine, topics and notes |
| `bus_history` | Search past messages by text and participant |
| `bus_query` | Read-only SPARQL `SELECT` over the whole ledger, at the head or an earlier commit `t` |
| `bus_leave` | Leave the bus |

## Checking with MCP Inspector

The official [MCP Inspector](https://github.com/modelcontextprotocol/inspector) reaches `serve` as any other client does. Its CLI mode lists and calls the tools. Calls write the ledger and consume messages, so point it at a throwaway bus rather than the machine's on 8096:

```sh
AGENT_BUS_DIR=$(mktemp -d) AGENT_BUS_PORT=8196 bun src/bin.ts serve &   # stop it with kill $!
npx @modelcontextprotocol/inspector@2.12.0 --cli http://127.0.0.1:8196/mcp --method tools/list
npx @modelcontextprotocol/inspector@2.12.0 --cli http://127.0.0.1:8196/mcp --method tools/call \
  --tool-name bus_join --tool-arg address=claude/check runtime=claude session=check cwd=$PWD
```

The CLI prints each result as JSON and exits with status 5 when a tool returns `isError`. `test/mcp-official.test.ts` makes the same kind of calls with the official TypeScript SDK on every `bun run check`.

## How sessions are woken

**Claude Code** runs `agent-bus wait --address <address>` as a background command, one per address. It exits when a message arrives, which wakes the session; the session handles the messages and starts the wait again. While `serve` is unreachable (restarting, say) the wait retries rather than exiting.

**Codex** sessions join with their thread id. `serve` connects to the Codex app-server daemon (WebSocket over `~/.codex/app-server-control/app-server-control.sock`) and calls `turn/start` with the unread messages. An idle thread starts a new turn; a thread mid-turn has the messages steered into the running turn. Messages are marked read only after the daemon accepts the turn, and `serve` then unsubscribes, since it can't answer approvals.

A thread has one writer, the app-server that loaded it, and the bus never takes a thread from another app-server. At `bus_join`, `serve` records where the thread runs (`codexHost` in the presence entry and the join result): `daemon` if this machine's daemon has it loaded, `other` otherwise (the desktop app's own app-server, a running `codex exec`, or a daemon `serve` can't reach).

| Joined as | `serve` |
| --- | --- |
| `daemon` | `turn/start` through the daemon, after `thread/resume` if the daemon has let the thread go |
| `other`, or `daemon` with its resume refused (`active writer`) | A nudge in the thread's queue |

**The queue nudge** wakes threads the daemon doesn't run, above all the desktop app's Local threads, without a second writer. `serve` starts a short-lived `codex app-server` of its own on stdio (the desktop's bundled CLI, or `serve --codex <path>`), lists the thread's queue, and adds one fixed message telling the thread to read its mail with `bus_read`. The app that has the thread open runs it as a turn: at once when the thread is idle, and in a few seconds even with the app in the background. A thread nobody has open runs it when next opened. The nudge carries no message text, and marks nothing read: the thread's own read moves its cursor.

At most one bus nudge waits in a thread's queue for an address, since a waiting nudge also covers mail that arrives after it. So when a thread gets its mail some other way first (the `Stop` hook, or a read mid-turn), it costs at most one empty turn. Without new mail or a read, `serve` doesn't look again. The queue methods are experimental in the Codex app-server protocol; using the desktop's own CLI keeps them in step with the app.

A refused resume is not retried; the thread is nudged instead for the rest of that join. Subagents on the daemon take no direct input, so they are never woken there; their messages stay unread for `bus_read`. Failures (the daemon or the queue unreachable or not answering) are retried after 30 seconds, then after a delay that doubles to five minutes, with the mail kept unread.

Each machine's `serve` wakes only the Codex peers whose join came from that machine (the presence entry's `origin.host`, compared without case or domain), since a thread can only be woken by the daemon that hosts it. Within `serve`, joins, leaves, reads and deliveries for one address run one at a time, so a message is delivered once, to the subscriber's current state.

**A Codex `Stop` hook delivers at the end of a busy turn.** When a turn ends, `agent-bus codex-stop-hook` reads the thread's unread messages and continues the turn with them, so a busy desktop thread gets its mail inline rather than in a separate nudged turn. It is optional now that idle threads are nudged. The hook reads as the thread, presenting its id as the session. A subagent's hook carries its parent's id, so the hook delivers only when a transcript is given and is the thread's own. If the bus is unreachable, the turn ends normally, with any messages the hook already read. Install it in `~/.codex/hooks.json` (use absolute paths; hooks don't get your shell's `PATH`), then review and trust it with `/hooks` in the Codex CLI:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/you/.local/bin/bun /path/to/agent-bus/src/bin.ts codex-stop-hook",
            "timeout": 30,
            "statusMessage": "Checking agent-bus"
          }
        ]
      }
    ]
  }
}
```

Where Codex threads run, and so whether the bus can wake them:

| Started from | Runs on | Woken by the bus |
| --- | --- | --- |
| `codex` TUI | The daemon (unless `--no-daemon`) | Yes, live in the TUI |
| The desktop app, SSH project (including SSH to the same machine) | The daemon, through `codex app-server proxy` | Yes |
| The desktop app, Local project | The app's own app-server | Yes, by a queue nudge while the thread is open; the `Stop` hook also delivers when a turn ends |
| `codex exec` | Its own process | No: a nudge waits in its queue until the thread is opened |
| A subagent | Its parent's app-server | Not on the daemon; whether the desktop runs a subagent's nudge is untested |

The daemon inherits the open-file limit of whatever started it, often macOS's default soft limit of 256. A daemon holding several threads, each with its own MCP servers, exhausts that, and then fails to load threads, skills or shells (`Too many open files` in `~/.codex/app-server-control/app-server.log`). Restart it from a shell with a higher limit: `ulimit -n 10240 && codex app-server daemon restart`.

## Setup and other machines

State lives in `~/.agent-bus` (`AGENT_BUS_DIR` overrides it). `config.json` selects the store; without its `fluree` entry the bus uses `ledger.jsonl`:

```json
{ "fluree": { "url": "http://127.0.0.1:8095", "ledger": "agent-bus:main" } }
```

On the bus host, `install:launch-agents` runs a dedicated Fluree server on `127.0.0.1:8095` (`ai.rawr.agent-bus.fluree`, project and storage in `~/.agent-bus/fluree`) and `agent-bus serve`. On first install it creates a signing key (`fluree-key.json`) and a token (`fluree-token`), both readable only by you, writes `config.json`, and imports `ledger.jsonl`. Rerunning it is safe.

Both servers listen on loopback only. Another machine clones this repo and runs `install:launch-agents -- --remote <ssh host>`: it copies the token, keeps an SSH tunnel to the Fluree server on the same local port (`ai.rawr.agent-bus.tunnel`), and runs its own `serve` for its own sessions.

**Upgrading from the per-session stdio server.** `agent-bus mcp` and `deliver-codex` are gone. Rerunning the installer turns on Fluree's token auth and replaces the deliverer with `serve`; on other machines rerun it with `--remote` too. Old stdio processes have no token, so they fail from then on: replace each machine's `agent-bus` registration with the HTTP one above, remove any `agent-bus-ledger` registration, and reconnect or reopen running sessions.

## Security

The bus trusts every process of the user on the machine; loopback is not authentication. [Connections and trust boundaries](docs/connections.md) lists every connection the bus makes or depends on, including the Codex daemon and the desktop app's options for running on it.

- **Fluree** requires the token on its data and admin APIs (`--data-auth-mode required`, `--admin-auth-mode required`) and has CORS off. Without this, any web page could write to it with a cross-origin `text/plain` POST. Its event stream stays open: it carries only ledger names and commit pointers, never message content (a subject-less token, which writes need, is refused there). The token is never logged.
- **`serve`** accepts only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`, which stops DNS rebinding, and the MCP endpoint rejects any browser `Origin`.
- **`bus_query`** accepts one SPARQL `SELECT`, parsed and regenerated from its syntax tree (so caller comments, which Fluree reads for `PRAGMA`s, never reach it), with no `FROM` or `SERVICE` anywhere. The ledger and `t` are fixed in the request path, results are cut off at 32 KB of rows, and a query is abandoned after 10 seconds. A Fluree fuel limit would turn on fuel tracking, which in 4.2.4 replaces the budgeted Agent JSON with an unbudgeted result, so none is set.

## Ledger model

Every entry (`src/domain.ts`) has a time-ordered UUIDv7 `id`, ISO `ts`, `from`, `to`, optional `subject` and `replyTo`, and an `origin`: the machine, and the sender's joined directory with its repo and branch, worked out when the message is sent. Presence entries record joins and leaves; the latest per address is that peer's state. Messages are grouped into commit windows by `origin.repo` and `ts` against that repo's commit times, so no message needs a Git SHA.

In every store, a change notification only wakes readers; reading from the subscriber's cursor decides what is delivered, and a cursor advances only after a complete read. Each store has one change stream per process, shared by every waiter.

**Fluree** (`src/Fluree.ts`). All bus processes share one transaction server over HTTP, which serializes writers. Each message is one `/insert`, so one commit, and a cursor is the last commit `t` read. Reads are history queries over the `bus:json` assertions from the cursor to the head, in windows of 500 commits. The `/v1/fluree/events` SSE stream wakes readers, with a 15-second poll behind it and a catch-up read after every reconnect. Cursors live in `fluree-cursors/<ledger>/<first commit id>/`, so a replaced ledger starts subscribers over rather than skipping messages; a cursor ahead of the ledger fails loudly.

Each message is a node `urn:agent-bus:message:<id>` typed `bus:Message` or `bus:Presence` (`bus:` is `https://rawr.ai/ns/agent-bus#`), with `bus:id`, `bus:ts` (`xsd:dateTime`), `bus:from`, `bus:to`, `bus:subject`, `bus:body`, `bus:replyTo` (a link to the answered message), `bus:host`, `bus:cwd`, `bus:repo`, `bus:branch`, `bus:runtime` and `bus:status` for presence (whose owning session is in `bus:json`), and `bus:json`, the exact encoded message the bus reads back. The ledger's config graph enables inline full-text scoring on `bus:body` and `bus:subject`, so `bus_history` ranks stemmed matches (`deploy adapters` finds "Deploying the adapter") and `bus_query` can rank with `f:fulltext`. Fluree 4.2.4 applies that config at the ledger's first index, so for about a second after a ledger is created, text search finds nothing or fails.

**JSONL** (`src/Ledger.ts`). Writers append whole lines with `O_APPEND`; readers consume only newline-terminated lines from their cursor (a byte offset). File watching wakes readers, backed by a two-second poll. `bus_history` matches substrings; `bus_query` is not available.

## Known gaps

- `bus_read` and `bus_wait` mark messages read before the response is sent. If the response is lost (the caller dies mid-call), those messages are skipped for that address; they remain in `bus_history`.

## Next

- **Commit-window view** over `git log` per repo and branch.
- **A Claude Code Stop hook** that checks the bus when a turn ends, like the Codex one.
- **Waking idle Local desktop threads** through the desktop app's own coordination socket (undocumented), which keeps the app as the thread's writer.
