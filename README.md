# agent-bus

A pub/sub message bus that lets Claude and Codex sessions talk to each other. Sessions join with an address, publish to addresses, `#topics` or `*`, and are woken when messages arrive for them.

Built on Bun and Effect 4. Each machine runs one bus process, `agent-bus serve`, which serves the bus tools over MCP (streamable HTTP, `effect/ai`'s `McpServer`) on loopback and wakes that machine's Codex sessions. Storage is a Fluree ledger on the bus's own transaction server, behind a `Ledger` service; the unit tests use a JSONL file instead.

The [overview](docs/overview.md) maps the system and links to the architecture: [topology](docs/architecture/topology.md) (machines, processes and stores), [messaging](docs/architecture/messaging.md) (addresses, ownership and the ledger) and [delivery](docs/architecture/delivery.md) (how each kind of session is woken). Platform facts, with their versions, are in [platforms](docs/platforms/README.md): [Codex](docs/platforms/codex.md), [Claude Code](docs/platforms/claude-code.md) and [Fluree](docs/platforms/fluree.md).

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
| `agent-bus claude-wake` | The Claude Code plugin's hook: wake the session when mail arrives for its addresses ([how](#how-sessions-are-woken)) |
| `agent-bus join` / `publish` / `peers` | The same operations from a shell; `join` records the current directory, and `--takeover` replaces an ended session |

`join`, `publish` and `peers` are MCP clients of the local `serve`; only `serve` touches the store. They present the session id of the address's runtime (`--runtime`, or the runtime the address joined with): `$CODEX_THREAD_ID` for Codex, `$CLAUDE_CODE_SESSION_ID` for Claude, `$AGENT_BUS_SESSION` otherwise, or `--session`. A refusal from the bus, or an unreachable bus, ends the command with its message. `claude-wake`, also a client, takes its session from the hook input Claude Code gives it on stdin, and retries any failure for up to ten minutes.

## Addresses belong to sessions

An address is one session's private inbox: reading consumes, so two sessions on one address would each miss the messages the other read. Groups share a `#topic` instead, where every subscriber has its own address and gets every message.

The session that joins an address owns it, identified by its runtime and the runtime's own id for it (a Codex thread id, a Claude Code session id; other clients pass a stable id of their own). Every call passes that id as `session`, and only the owner can read, wait, leave or send from the address. A different session's join is refused with what the bus knows of the holder (its note, last call, whether it has a wait open), and should pick another address. Rejoining with the same id keeps unread messages; after `/clear` or a fork, Claude Code has a new id, so the session needs a new address. A process started from a session's shell inherits that session's id and acts for it, as subagents do, so give a delegate that needs its own inbox its own address. A client whose tool list predates `session` can pass it as an extra argument without reconnecting.

To replace a session that has ended, call `bus_takeover` (or `agent-bus join --takeover`) with the holder's join id, which the refusal gives. The new owner keeps the unread messages, and the previous one is refused from then on. Joins and leaves written without an owner, by a `serve` from before owners, are ignored.

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
| `bus_takeover` | Replace a session that has ended, naming the holder's join id; only when the human says so |
| `bus_publish` | Send to addresses, `#topic` or `*`; `replyTo` answers a message |
| `bus_read` / `bus_wait` | Unread messages now, or once they arrive (at most 50 s per call) |
| `bus_wake` | For the Claude Code plugin's hook: wait until the session's addresses have mail it hasn't been woken for, reading nothing |
| `bus_peers` | Joined peers, with runtime, machine, topics and notes |
| `bus_history` | Search past messages by text and participant |
| `bus_query` | Read-only SPARQL `SELECT` over the whole ledger, at the head or an earlier commit `t` |
| `bus_leave` | Leave the bus |

Claude sessions are woken by the agent-bus plugin, which this repo serves as a local marketplace. Install it once per machine, after the installer, from the checkout `serve` runs:

```sh
claude plugin marketplace add <agent-bus checkout>
claude plugin install agent-bus@agent-bus
```

The plugin (`plugin/`) is only a manifest, which Claude Code copies into its cache. Its hook runs `~/.local/bin/agent-bus claude-wake`, the installer's link to the checkout's `src/bin.ts`. So the hook runs the checkout's code with its dependencies, and picks up a deploy at once. After a change to `plugin/`, run `claude plugin marketplace update agent-bus` and `claude plugin update agent-bus@agent-bus`. Hooks inherit Claude Code's environment rather than your shell's, so the hook looks for `bun` in `~/.local/bin`, then `~/.bun/bin`, then on that `PATH`. It needs the same `AGENT_BUS_PORT` as `serve` (or neither set). Sessions get it when they next start, or with `/reload-plugins`. Deploy `serve` first, so the hook finds `bus_wake`.

## Checking with MCP Inspector

The official [MCP Inspector](https://github.com/modelcontextprotocol/inspector) reaches `serve` as any other client does. Its CLI mode lists and calls the tools. Calls write the ledger and consume messages, so point it at a throwaway bus rather than the machine's on 8096:

```sh
fluree server run --memory --listen-addr 127.0.0.1:18095 &   # a throwaway Fluree, no auth
dir=$(mktemp -d)
echo '{ "fluree": { "url": "http://127.0.0.1:18095", "ledger": "check:main" } }' > "$dir/config.json"
AGENT_BUS_DIR=$dir AGENT_BUS_PORT=8196 bun src/bin.ts serve &   # stop both with kill %1 %2
npx @modelcontextprotocol/inspector@2.12.0 --cli http://127.0.0.1:8196/mcp --method tools/list
npx @modelcontextprotocol/inspector@2.12.0 --cli http://127.0.0.1:8196/mcp --method tools/call \
  --tool-name bus_join --tool-arg address=claude/check runtime=claude session=check cwd=$PWD
```

The CLI prints each result as JSON and exits with status 5 when a tool returns `isError`. `test/mcp-official.test.ts` makes the same kind of calls with the official TypeScript SDK on every `bun run check`.

## How sessions are woken

A wake only tells a session that mail is waiting; its own read delivers the mail ([why](docs/architecture/delivery.md#waking-is-separate-from-delivery)).

- **Claude Code** sessions with the agent-bus plugin are woken by its hook, `agent-bus claude-wake`, which Claude Code runs in the background (`asyncRewake`) at session start and every turn end. It waits in `bus_wake` until the session's addresses have new mail, then wakes the session, in the desktop app and the terminal.
- **Codex** threads join with their thread id. `serve` puts one nudge in the thread's own queue, through a short-lived `codex app-server` of its own, and whichever app-server has the thread loaded (the desktop app's, or the daemon's) runs it as a turn. For a thread loaded nowhere, `serve` asks the machine's daemon to borrow it: the daemon runs the nudge and lets the thread go 5 s after it goes idle. The writer lock refuses the borrow while another process holds the thread, so a thread never has a second writer. Only threads stored with approval `never` and permissions a resume keeps are borrowed.

[Delivery](docs/architecture/delivery.md#how-each-kind-of-session-receives-mail) says which kinds of session are woken and when, and gives the policies; [platforms: Codex](docs/platforms/codex.md) covers the app-servers and which threads run where, and [install](docs/runbooks/install.md) what waking needs from each machine.

## Setup and other machines

State lives in `~/.agent-bus` (`AGENT_BUS_DIR` overrides it). `config.json` names the Fluree ledger, and `serve` won't start without it:

```json
{ "fluree": { "url": "http://127.0.0.1:8095", "ledger": "agent-bus:main" } }
```

`install:launch-agents` first links `~/.local/bin/agent-bus` to this checkout's `src/bin.ts`, for the Claude Code plugin's hook, and checks that the link runs. On the bus host, it then runs a dedicated Fluree server on `127.0.0.1:8095` (`ai.rawr.agent-bus.fluree`, project and storage in `~/.agent-bus/fluree`) and `agent-bus serve`. On first install it creates a signing key (`fluree-key.json`) and a token (`fluree-token`), both readable only by you, and writes `config.json` if there is none. Rerunning it is safe.

Both servers listen on loopback only. Another machine clones this repo and runs `install:launch-agents -- --remote <ssh host>`: it copies the token, keeps an SSH tunnel to the Fluree server on the same local port (`ai.rawr.agent-bus.tunnel`), and runs its own `serve` for its own sessions. [Topology](docs/architecture/topology.md) shows both machine roles, every process and where each piece of state lives.

## Security

The bus trusts every process of the user on the machine; loopback is not authentication. [Connections and trust boundaries](docs/architecture/connections.md) lists every connection the bus makes or depends on, and what protects it.

- **Fluree** requires the token on its data and admin APIs (`--data-auth-mode required`, `--admin-auth-mode required`) and has CORS off. Without this, any web page could write to it with a cross-origin `text/plain` POST. Its event stream stays open: it carries only ledger names and commit pointers, never message content (a subject-less token, which writes need, is refused there). The token is never logged.
- **`serve`** accepts only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`, which stops DNS rebinding, and the MCP endpoint rejects any browser `Origin`.
- **`bus_query`** accepts one SPARQL `SELECT`, parsed and regenerated from its syntax tree (so caller comments, which Fluree reads for `PRAGMA`s, never reach it), with no `FROM` or `SERVICE` anywhere. The ledger and `t` are fixed in the request path, results are cut off at 32 KB of rows, and a query is abandoned after 10 seconds. A Fluree fuel limit would replace the budgeted Agent JSON with an unbudgeted result ([platforms: Fluree](docs/platforms/fluree.md#query-limits)), so none is set.

## Ledger model

Every entry (`src/domain.ts`) has a time-ordered UUIDv7 `id`, ISO `ts`, `from`, `to`, optional `subject` and `replyTo`, and an `origin`: the machine, and the sender's joined directory with its repo and branch, worked out when the entry is written. Repo and branch are optional metadata for queries; a branch can't be recovered once its worktree or branch is gone. Presence entries record joins and leaves; the latest per address with an owner is that peer's state.

A change notification only wakes readers; reading from the subscriber's cursor decides what is delivered, and a cursor advances only after a complete read. There is one change stream per process, shared by every waiter.

**Fluree** (`src/Fluree.ts`). All bus processes share one transaction server over HTTP, which serializes writers. Each message is one `/insert`, so one commit, and a cursor is the last commit `t` read. Reads are history queries over the `bus:json` assertions from the cursor to the head, in windows of 500 commits. The `/v1/fluree/events` SSE stream wakes readers, with a 15-second poll behind it and a catch-up read after every reconnect. Cursors live in `fluree-cursors/<ledger>/<first commit id>/`, so a replaced ledger starts subscribers over rather than skipping messages; a cursor ahead of the ledger fails loudly.

Each message is a node `urn:agent-bus:message:<id>` typed `bus:Message` or `bus:Presence` (`bus:` is `https://rawr.ai/ns/agent-bus#`), with `bus:id`, `bus:ts` (`xsd:dateTime`), `bus:from`, `bus:to`, `bus:subject`, `bus:body`, `bus:replyTo` (a link to the answered message), `bus:host`, `bus:cwd`, `bus:repo`, `bus:branch`, `bus:runtime` and `bus:status` for presence (whose owning session is in `bus:json`), and `bus:json`, the exact encoded message the bus reads back. The ledger's config graph enables inline full-text scoring on `bus:body` and `bus:subject`, so `bus_history` ranks stemmed matches (`deploy adapters` finds "Deploying the adapter") and `bus_query` can rank with `f:fulltext`. For about a second after a ledger is created, text search finds nothing or fails ([platforms: Fluree](docs/platforms/fluree.md#full-text-search)).

The unit tests use a JSONL ledger (`test/jsonl-ledger.ts`): byte-offset cursors, file watching, substring search and no `bus_query`.

## Known gaps

- `bus_read` and `bus_wait` mark messages read before the response is sent. If the response is lost (the caller dies mid-call), those messages are skipped for that address; they remain in `bus_history`.

## Next

- **Richer ledger properties** (topic, task, workstream, decisions, tags, reference docs), so history can be queried by meaning with `bus_query`, not only by text.
