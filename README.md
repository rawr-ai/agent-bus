# agent-bus

A pub/sub message bus that lets Claude and Codex sessions talk to each other. Sessions join with an address, publish to addresses, `#topics` or `*`, and are woken when messages arrive for them.

Built on Bun and Effect 4. Each machine runs one bus process, `agent-bus serve`, which serves the bus tools over MCP (streamable HTTP, `effect/ai`'s `McpServer`) on loopback and wakes that machine's Codex sessions. Storage is a Fluree ledger on the bus's own transaction server, behind a `Ledger` service; the unit tests use a JSONL file instead.

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
| `agent-bus claude-wake` | The Claude Code plugin's hook: wake the session when mail arrives for its addresses ([how](#how-sessions-are-woken)) |
| `agent-bus join` / `publish` / `peers` | The same operations from a shell; `join` records the current directory, and `--takeover` replaces an ended session |

`wait`, `join`, `publish` and `peers` are MCP clients of the local `serve`; only `serve` touches the store. They present the session id of the address's runtime (`--runtime`, or the runtime the address joined with): `$CODEX_THREAD_ID` for Codex, `$CLAUDE_CODE_SESSION_ID` for Claude, `$AGENT_BUS_SESSION` otherwise, or `--session`. A refusal from the bus ends the command; only an unreachable bus is retried. `claude-wake`, also a client, takes its session from the hook input Claude Code gives it on stdin, and retries any failure for up to ten minutes.

## Addresses belong to sessions

An address is one session's private inbox: reading consumes, so two sessions on one address would each miss the messages the other read. Groups share a `#topic` instead, where every subscriber has its own address and gets every message.

The session that joins an address owns it, identified by its runtime and the runtime's own id for it (a Codex thread id, a Claude Code session id; other clients pass a stable id of their own). Every call passes that id as `session`, and only the owner can read, wait, leave or send from the address. A different session's join is refused with what the bus knows of the holder (its note, last call, whether it has a wait open), and should pick another address. Rejoining with the same id keeps unread messages; after `/clear` or a fork, Claude Code has a new id, so the session needs a new address. A process started from a session's shell inherits that session's id and acts for it, as subagents do, so give a delegate that needs its own inbox its own address. A client whose tool list predates `session` can pass it as an extra argument without reconnecting.

To replace a session that has ended, rejoin with `takeover` set to the holder's join id, which the refusal gives. The new owner keeps the unread messages, and the previous one is refused from then on. Joins and leaves written without an owner, by a `serve` from before owners, are ignored.

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
| `bus_wake` | For the Claude Code plugin's hook: wait until the session's addresses have mail it hasn't been woken for, reading nothing |
| `bus_peers` | Joined peers, with runtime, machine, topics and notes |
| `bus_history` | Search past messages by text and participant |
| `bus_query` | Read-only SPARQL `SELECT` over the whole ledger, at the head or an earlier commit `t` |
| `bus_leave` | Leave the bus |

Claude sessions are woken by the agent-bus plugin, which this repo serves as a local marketplace. Install it once per machine, from the checkout `serve` runs:

```sh
claude plugin marketplace add <agent-bus checkout>
claude plugin install agent-bus@agent-bus
```

Claude Code loads it in place, so its hook runs the checkout's own `src/bin.ts` with the checkout's dependencies, and picks up a deploy at once. Hooks inherit Claude Code's environment rather than your shell's, so the hook looks for `bun` on that `PATH`, then in `~/.bun/bin` and `~/.local/bin`. It needs the same `AGENT_BUS_PORT` as `serve` (or neither set). Sessions get it when they next start, or with `/reload-plugins`. Deploy `serve` first, so the hook finds `bus_wake`.

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

**Claude Code** sessions are woken by the agent-bus plugin. Claude Code runs its hook, `agent-bus claude-wake`, in the background (`asyncRewake`) when a session starts or resumes and whenever a turn ends.
- **What the hook does.** It calls `bus_wake` with the session's own id from its input. `serve` holds the call until an address the session holds as `claude`, joined from this machine, has unread mail other than what it last woke the session for. The hook then prints one fixed line per address, telling the session to read its mail with `bus_read`, and exits 2.
- **When the session wakes.** At once when idle, and as queued input when busy. The woken turn's end starts the next hook, so the session runs nothing itself and nothing needs restarting. This works in the desktop app and the terminal ([claude-wake](docs/frames/claude-wake.md)).
- **What it marks.** The wake carries no message text and marks nothing read: the session's own read moves its cursor past its mail. Like the Codex deliverer, the wake passes the cursor over entries that aren't the session's mail, as its read would.
- **Which mail wakes it again.** Mail left unread doesn't wake the session again until more arrives or it reads part of it, so an ignored wake isn't repeated.
- **Only one hook waits per session:** a newer hook from the same session ends the older one.
- **Cost and outages.** A session that owns no address costs one short call at each of those points. The hook retries a failing bus, `serve` restarting or its store down, for up to ten minutes.
- **After `/clear`,** the new id owns nothing until it joins again.
- **Subagents** share their parent's id, so mail to a subagent's own address wakes the parent.
- **`claude -p` runs** aren't woken: Claude Code ends async hooks when the run ends.

Once `serve` has seen a session's hook, `bus_join` returns `hooked: true`, and the session runs nothing. Without it, as in a session started before the plugin was installed, the session runs `agent-bus wait --address <address>` as a background command. That command exits when mail arrives, which wakes the session, and must be started again after each wake.

**Codex** sessions join with their thread id. When the address has unread mail, `serve` puts one fixed message in the thread's own queue telling it to read its mail with `bus_read`. To do so it starts a short-lived `codex app-server` of its own on stdio (the desktop's bundled CLI, or `serve --codex <path>`), lists the thread's queue, and adds the nudge unless one of its nudges is already waiting. Whichever app-server has the thread loaded runs the nudge as a turn: the desktop app for Local threads, and the daemon for the `codex` TUI and SSH projects, whether or not a window or TUI is attached. It runs at once when the thread is idle (seen within 3–15 s), and after the current turn when the thread is busy. A thread nothing has loaded keeps it until the thread is next opened. The bus's tools say they are safe, so Codex lets a nudged thread read and answer without asking approval in any sandbox; only `bus_join`, which can take over an address, asks outside full access ([approval](docs/connections.md#approval-in-codex)). For TUI and SSH threads, `serve` needs that CLI on the machine that owns the thread, with the same Codex home ([when a nudge doesn't run](docs/connections.md#when-a-nudge-is-queued-but-doesnt-run)).

`serve` never loads, resumes or starts a turn in a thread itself, so a thread never has a second writer. The nudge carries no message text and marks nothing read: the thread's own read moves its cursor.

At most one bus nudge waits in a thread's queue for an address, since a waiting nudge also covers mail that arrives after it. So when a thread gets its mail some other way first (a read mid-turn, say), it costs at most one empty turn. Without new mail or a read, `serve` doesn't look again. The queue methods are experimental in the Codex app-server protocol; using the desktop's own CLI keeps them in step with the app.

A subagent's queue refuses direct input, so subagents are never woken; their messages stay unread for `bus_read`. Failures (the queue unreachable or not answering) are retried after 30 seconds, then after a delay that doubles to five minutes, with the mail kept unread.

Each machine's `serve` wakes only the Codex peers whose join came from that machine (the presence entry's `origin.host`, compared without case or domain), since each machine's queues are in its own `~/.codex`. Within `serve`, joins, leaves, reads and nudges for one address run one at a time, so a nudge acts on the subscriber's current state.

Where Codex threads run, and so when the bus wakes them:

| Started from | Runs on | Woken by the bus |
| --- | --- | --- |
| `codex` TUI | The daemon (unless `--no-daemon`) | Yes, by a nudge the daemon runs, with or without the TUI attached; a thread the daemon no longer has loaded gets it when next opened |
| The desktop app, SSH project (including SSH to the same machine) | The daemon, through `codex app-server proxy` | Yes, as for the TUI |
| The desktop app, Local project | The app's own app-server | Yes, by a nudge while the thread is open |
| `codex exec` | Its own process | No: a nudge waits in its queue until the thread is opened |
| A subagent | Its parent's app-server | No: its queue refuses direct input |

## Setup and other machines

State lives in `~/.agent-bus` (`AGENT_BUS_DIR` overrides it). `config.json` names the Fluree ledger, and `serve` won't start without it:

```json
{ "fluree": { "url": "http://127.0.0.1:8095", "ledger": "agent-bus:main" } }
```

On the bus host, `install:launch-agents` runs a dedicated Fluree server on `127.0.0.1:8095` (`ai.rawr.agent-bus.fluree`, project and storage in `~/.agent-bus/fluree`) and `agent-bus serve`. On first install it creates a signing key (`fluree-key.json`) and a token (`fluree-token`), both readable only by you, and writes `config.json` if there is none. Rerunning it is safe.

Both servers listen on loopback only. Another machine clones this repo and runs `install:launch-agents -- --remote <ssh host>`: it copies the token, keeps an SSH tunnel to the Fluree server on the same local port (`ai.rawr.agent-bus.tunnel`), and runs its own `serve` for its own sessions.

**Retiring the Codex `Stop` hook.** The hook is gone: a nudged turn reads the mail itself. Remove the `agent-bus codex-stop-hook` entry from `~/.codex/hooks.json`. A thread that loaded the hook keeps calling it until its app-server restarts, so `codex-stop-hook` stays as a command that does nothing until then.

**Upgrading from the per-session stdio server.** `agent-bus mcp` and `deliver-codex` are gone. Rerunning the installer turns on Fluree's token auth and replaces the deliverer with `serve`; on other machines rerun it with `--remote` too. Old stdio processes have no token, so they fail from then on: replace each machine's `agent-bus` registration with the HTTP one above, remove any `agent-bus-ledger` registration, and reconnect or reopen running sessions.

## Security

The bus trusts every process of the user on the machine; loopback is not authentication. [Connections and trust boundaries](docs/connections.md) lists every connection the bus makes or depends on, and what a TUI or SSH thread needs for its nudge to run.

- **Fluree** requires the token on its data and admin APIs (`--data-auth-mode required`, `--admin-auth-mode required`) and has CORS off. Without this, any web page could write to it with a cross-origin `text/plain` POST. Its event stream stays open: it carries only ledger names and commit pointers, never message content (a subject-less token, which writes need, is refused there). The token is never logged.
- **`serve`** accepts only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`, which stops DNS rebinding, and the MCP endpoint rejects any browser `Origin`.
- **`bus_query`** accepts one SPARQL `SELECT`, parsed and regenerated from its syntax tree (so caller comments, which Fluree reads for `PRAGMA`s, never reach it), with no `FROM` or `SERVICE` anywhere. The ledger and `t` are fixed in the request path, results are cut off at 32 KB of rows, and a query is abandoned after 10 seconds. A Fluree fuel limit would turn on fuel tracking, which in 4.2.4 replaces the budgeted Agent JSON with an unbudgeted result, so none is set.

## Ledger model

Every entry (`src/domain.ts`) has a time-ordered UUIDv7 `id`, ISO `ts`, `from`, `to`, optional `subject` and `replyTo`, and an `origin`: the machine, and the sender's joined directory with its repo and branch, worked out when the entry is written. Repo and branch are optional metadata for queries; a branch can't be recovered once its worktree or branch is gone. Presence entries record joins and leaves; the latest per address with an owner is that peer's state.

A change notification only wakes readers; reading from the subscriber's cursor decides what is delivered, and a cursor advances only after a complete read. There is one change stream per process, shared by every waiter.

**Fluree** (`src/Fluree.ts`). All bus processes share one transaction server over HTTP, which serializes writers. Each message is one `/insert`, so one commit, and a cursor is the last commit `t` read. Reads are history queries over the `bus:json` assertions from the cursor to the head, in windows of 500 commits. The `/v1/fluree/events` SSE stream wakes readers, with a 15-second poll behind it and a catch-up read after every reconnect. Cursors live in `fluree-cursors/<ledger>/<first commit id>/`, so a replaced ledger starts subscribers over rather than skipping messages; a cursor ahead of the ledger fails loudly.

Each message is a node `urn:agent-bus:message:<id>` typed `bus:Message` or `bus:Presence` (`bus:` is `https://rawr.ai/ns/agent-bus#`), with `bus:id`, `bus:ts` (`xsd:dateTime`), `bus:from`, `bus:to`, `bus:subject`, `bus:body`, `bus:replyTo` (a link to the answered message), `bus:host`, `bus:cwd`, `bus:repo`, `bus:branch`, `bus:runtime` and `bus:status` for presence (whose owning session is in `bus:json`), and `bus:json`, the exact encoded message the bus reads back. The ledger's config graph enables inline full-text scoring on `bus:body` and `bus:subject`, so `bus_history` ranks stemmed matches (`deploy adapters` finds "Deploying the adapter") and `bus_query` can rank with `f:fulltext`. Fluree 4.2.4 applies that config at the ledger's first index, so for about a second after a ledger is created, text search finds nothing or fails.

The unit tests use a JSONL ledger (`test/jsonl-ledger.ts`): byte-offset cursors, file watching, substring search and no `bus_query`.

## Known gaps

- `bus_read` and `bus_wait` mark messages read before the response is sent. If the response is lost (the caller dies mid-call), those messages are skipped for that address; they remain in `bus_history`.

## Next

- **Richer ledger properties** (topic, task, workstream, decisions, tags, reference docs), so history can be queried by meaning with `bus_query`, not only by text.
