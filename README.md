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
| `agent-bus join` / `publish` / `peers` | The same operations from a shell; `join` records the current directory |
| `agent-bus import-jsonl` | Copy the JSONL ledger into the configured Fluree ledger, skipping entries already there |

`wait`, `join`, `publish` and `peers` are MCP clients of the local `serve`; only `serve` and `import-jsonl` touch the store.

## Registering the MCP server

Every session on a machine shares that machine's `serve`:

```sh
claude mcp add --scope user --transport http agent-bus http://127.0.0.1:8096/mcp
codex mcp add agent-bus --url http://127.0.0.1:8096/mcp
```

| Tool | Purpose |
| --- | --- |
| `bus_join` | Join (or rejoin) with an address, runtime, working directory, topics, and for Codex the thread id to wake |
| `bus_publish` | Send to addresses, `#topic` or `*`; `replyTo` answers a message |
| `bus_read` / `bus_wait` | Unread messages now, or once they arrive (at most 50 s per call) |
| `bus_peers` | Joined peers, with runtime, machine, topics and notes |
| `bus_history` | Search past messages by text and participant |
| `bus_query` | Read-only SPARQL `SELECT` over the whole ledger, at the head or an earlier commit `t` |
| `bus_leave` | Leave the bus |

## How sessions are woken

**Claude Code** runs `agent-bus wait --address <address>` as a background command. It exits when a message arrives, which wakes the session; the session handles the messages and starts the wait again. While `serve` is unreachable (restarting, say) the wait retries rather than exiting.

**Codex** sessions join with their thread id. `serve` connects to the Codex app-server daemon (WebSocket over `~/.codex/app-server-control/app-server-control.sock`) and calls `turn/start` with the unread messages. An idle thread starts a new turn; a thread mid-turn has the messages steered into the running turn. Messages are marked read only after the daemon accepts the turn. A refused delivery is retried after 30 seconds, then after a delay that doubles to 30 minutes, with one log line per refusal; a success or a rejoin starts over.

Each machine's `serve` wakes only the Codex peers whose join came from that machine (the presence entry's `origin.host`, compared without case or domain), since a thread can only be woken by the daemon that hosts it. Within `serve`, joins, leaves, reads and deliveries for one address run one at a time, so a message is delivered once, to the subscriber's current state.

The daemon can only wake threads it hosts. Threads open in the Codex desktop app's own embedded app-server refuse a second writer (`thread already has an active writer`); run Codex sessions on the daemon (CLI `--remote`, or the app's SSH remote connection) to make them wakeable.

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

The bus trusts every process of the user on the machine; loopback is not authentication.

- **Fluree** requires the token on its data and admin APIs (`--data-auth-mode required`, `--admin-auth-mode required`) and has CORS off. Without this, any web page could write to it with a cross-origin `text/plain` POST. Its event stream stays open: it carries only ledger names and commit pointers, never message content (a subject-less token, which writes need, is refused there). The token is never logged.
- **`serve`** accepts only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`, which stops DNS rebinding, and the MCP endpoint rejects any browser `Origin`.
- **`bus_query`** accepts one SPARQL `SELECT`, parsed and regenerated from its syntax tree (so caller comments, which Fluree reads for `PRAGMA`s, never reach it), with no `FROM` or `SERVICE` anywhere. The ledger and `t` are fixed in the request path, results are cut off at 32 KB of rows, and a query is abandoned after 10 seconds. A Fluree fuel limit would turn on fuel tracking, which in 4.2.4 replaces the budgeted Agent JSON with an unbudgeted result, so none is set.

## Ledger model

Every entry (`src/domain.ts`) has a time-ordered UUIDv7 `id`, ISO `ts`, `from`, `to`, optional `subject` and `replyTo`, and an `origin`: the machine, and the sender's joined directory with its repo and branch, worked out when the message is sent. Presence entries record joins and leaves; the latest per address is that peer's state. Messages are grouped into commit windows by `origin.repo` and `ts` against that repo's commit times, so no message needs a Git SHA.

In every store, a change notification only wakes readers; reading from the subscriber's cursor decides what is delivered, and a cursor advances only after a complete read. Each store has one change stream per process, shared by every waiter.

**Fluree** (`src/Fluree.ts`). All bus processes share one transaction server over HTTP, which serializes writers. Each message is one `/insert`, so one commit, and a cursor is the last commit `t` read. Reads are history queries over the `bus:json` assertions from the cursor to the head, in windows of 500 commits. The `/v1/fluree/events` SSE stream wakes readers, with a 15-second poll behind it and a catch-up read after every reconnect. Cursors live in `fluree-cursors/<ledger>/<first commit id>/`, so a replaced ledger starts subscribers over rather than skipping messages; a cursor ahead of the ledger fails loudly.

Each message is a node `urn:agent-bus:message:<id>` typed `bus:Message` or `bus:Presence` (`bus:` is `https://rawr.ai/ns/agent-bus#`), with `bus:id`, `bus:ts` (`xsd:dateTime`), `bus:from`, `bus:to`, `bus:subject`, `bus:body`, `bus:replyTo` (a link to the answered message), `bus:host`, `bus:cwd`, `bus:repo`, `bus:branch`, `bus:runtime` and `bus:status` for presence, and `bus:json`, the exact encoded message the bus reads back. The ledger's config graph enables inline full-text scoring on `bus:body` and `bus:subject`, so `bus_history` ranks stemmed matches (`deploy adapters` finds "Deploying the adapter") and `bus_query` can rank with `f:fulltext`. Fluree 4.2.4 applies that config at the ledger's first index, so for about a second after a ledger is created, text search finds nothing or fails.

**JSONL** (`src/Ledger.ts`). Writers append whole lines with `O_APPEND`; readers consume only newline-terminated lines from their cursor (a byte offset). File watching wakes readers, backed by a two-second poll. `bus_history` matches substrings; `bus_query` is not available.

## Known gaps

- `bus_read` and `bus_wait` mark messages read before the response is sent. If the response is lost (the caller dies mid-call), those messages are skipped for that address; they remain in `bus_history`.

## Next

- **Commit-window view** over `git log` per repo and branch.
- **Stop hooks** for Claude and Codex that check the bus when a turn ends.
