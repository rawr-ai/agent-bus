# Research: can MCP, or an existing server, wake agent sessions more simply?

Asked by the owner on 2026-10-26: does the MCP protocol, or an existing agent-to-agent MCP server, offer a simpler way to do what agent-bus does? The focus is waking, or delivering live to, a session that is idle or mid-turn. Or is our approach the right one?

Scope: Claude Code 2.1.310 (desktop Code tab and terminal), the Codex CLI and desktop app at 0.164.0-alpha.11.1 (desktop 26.1021.31345), and the MCP spec through 2026-07-28.

Evidence marks:
- **V**: verified, from spec text, source code, the installed binaries, or a test run on this machine.
- **R**: reported, in docs, issues or READMEs that weren't run here.
- **I**: inferred.

## Verdict

**MCP has no portable way for a server to put something in front of the model, or to start a turn in an idle session. agent-bus's shape is right:**
- a durable mailbox;
- a content-free doorbell sent through each runtime's own wake path;
- an MCP tool to read the mail.

This is also where the rest of the field has converged since August 2026.

The simplification is in how many doorbells we keep, not in replacing them with MCP:
- **Codex:** collapse onto the `codex queue` nudge, and retire the daemon deliverer and probably the `Stop` hook.
- **Claude:** keep a child-process wake, but have the host arm it instead of the model re-arming `agent-bus wait` after every wake.

Why MCP can't do it:
- **Notifications are client plumbing.**
  - Codex only logs every server notification (V).
  - Claude Code uses the `list_changed` notifications to refresh its lists and shows nothing to the model (V).
- **Elicitation asks the human, not the model** (V).
- **Sampling** is unsupported in both clients and deprecated in 2026-07-28 (V).
- **The one MCP push that reaches the model is Claude Code's proprietary channels.** They are terminal-only and gated by an allowlist or a dev flag (V). Effect's MCP server can't send them (V).

## Mechanisms by client and session state

Each cell gives three answers, in order:
1. Does the client receive it?
2. Does the model see it?
3. Does an idle session get a new turn?

"Mid-turn" says what happens when the session is busy.

| Mechanism | Claude Code terminal | Claude Code desktop | Codex desktop and CLI (0.164) |
| --- | --- | --- | --- |
| `notifications/resources/updated` (subscriptions) | Not supported; #7252 closed as not planned (R). Model: no. Idle wake: no | Same | Logged only; Codex never sends `resources/subscribe` (V, `logging_client_handler.rs`, binary strings). Model: no. Idle wake: no |
| `*/list_changed` | Refreshes the tool, prompt and resource lists (V, binary). Model: only through the new list. Idle wake: no | Same | Bumps a counter; the re-fetch sits behind the off-by-default `mcp_tool_list_changed` flag (V). Idle wake: no |
| `notifications/message` (logging) | Received, not shown to the model (R, #33679). Idle wake: no | Same | Logged (V). Model: no. Idle wake: no |
| `notifications/progress` | Resets the call's idle timeout and shows in `/tasks` (R). Model: no. Idle wake: no | Same | Logged; `item/mcpToolCall/progress` is defined but never sent (V). Idle wake: no |
| Elicitation | Asks the human in a form, interactive sessions only (R, docs since 2.1.76). The model sees only the later tool result. Idle wake: no | Form request goes to the user (R). Idle wake: no | TUI form, or `mcpServer/elicitation/request` to the desktop; declined under approval policy `never` (V). Idle wake: no |
| Sampling | Not supported (R, #1785 open) | Same | Not advertised; the SDK answers "method not found" (V) |
| Long-running tool call / SSE | A call past 2 min moves to the background, and its result arrives as a task notification (R). Mid-turn only; whether it wakes an idle session is undocumented (I: likely) | Same | 300 s default timeout. A blocking wait tool holds the turn open and delays steering (V). Mid-turn only |
| MCP tasks (2025-11-25, an extension in 2026-07-28) | Public beta from 2.1.304; the docs say an idle Claude "starts on it unprompted" when a result arrives (R, contradicted by a 2026-10-09 blog post). Only for a task the model started | Untested (I: same as terminal) | Not supported; #48617 open (V) |
| **Claude channels** (`notifications/claude/channel`) | Enqueued as a prompt (`priority: "next"`), so the model sees it and **an idle session starts a turn** (V, binary; R, docs). Needs: `--channels` with an allowlisted plugin, or `--dangerously-load-development-channels`; first-party auth; a 2025-era connection (V) | **Not usable.** No flag in the Code tab (V: no desktop session runs with `--channels`); the SDK's `channel_enable` accepts only marketplace plugins (V). Requests #86800 and #98369 are open (R) | n/a |
| Claude background command exit (`agent-bus wait` today) | Model sees it; **idle session gets a turn** (V, agent-bus in use) | Same (V) | n/a |
| Claude `Monitor`, one event per stdout line | **Idle session gets a turn** (R) | **V:** a line emitted with this session idle started a turn, 2026-10-26. A model-armed monitor expires after at most 30 min | n/a |
| Claude plugin `monitors` (manifest) | The host arms them at session start (`when: "always"`), and they "run for the session lifetime" (V, manifest schema in binary). Model sees each line; idle wake: I, yes, as for Monitor | Untested in desktop (I) | n/a |
| Claude `asyncRewake` hook (exit code 2) | "Wakes the model" even when idle (V, schema; R, docs) | Untested; agent-group-mcp says its hook wake fails in desktop (R) | n/a |
| Claude inbox socket and `SendMessage` (2.1.224+) | Idle session starts a turn; busy session reads between tool calls (R, docs) | Socket bound in desktop sessions (V). Mail from outside the session is subject to `crossSessionInbound` and a permission-mode match. Desktop can't show the hold dialog, so held mail is dropped after `dialogExpiry` (5 min) (V, binary; R, docs). A send from this session to another desktop session came back "queued … runs it when that clears" (V) | n/a |
| Codex `Stop` hook | n/a | n/a | Continues the current turn at its end (V). Never starts a turn on an idle thread (V) |
| Codex `turn/steer` | n/a | n/a | Mid-turn only; "no active turn to steer" when idle (V) |
| Codex `turn/start` through the daemon | n/a | n/a | Starts or steers turns, but only on threads the daemon hosts; a desktop Local thread is refused ("active writer") (V, agent-bus frames) |
| **Codex `codex queue` / `thread/queue/add`** | n/a | n/a | **Idle open thread starts a turn in 2–6 s** (V, agent-bus spike). The app-server polls the queue every 10 s and drains it after each turn; an unopened thread waits (V, source). Experimental since 0.149, not on developers.openai.com (R) |
| Codex multi-agent `wake_on_agent_messages` | n/a | n/a | Flag added in 0.164, off by default; covers its own agent mail only (V) |

### Protocol drift worth knowing

- **2026-07-28 drops the unsolicited path.** That revision removes the GET stream, sessions and initialize. Change notifications move to an explicit `subscriptions/listen` stream (V, spec changelog; V, the client SDK in the Claude binary).
- **Claude Code refuses channels on a 2026-07-28 connection:** "no unsolicited notification path" (V, binary). It asks stdio servers for 2026-07-28 by default from 2.1.292 (R).
- **Codex pins 2025-06-18.** 2026-07-28 sits behind an off-by-default flag (V).
- **Events/Triggers isn't a proposal yet.** A standard events or webhooks mechanism exists only as a working-group sketch, now the Tasks and Events WG (R). Nothing in the spec is coming soon that would wake an agent.

## Comparable servers and tools

| Project | Delivery | Wakes idle sessions | Limits |
| --- | --- | --- | --- |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) (Python, deprecated) / [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) | Mailbox the agent polls, plus file reservations | No | Codex discarded its reminder output (#273); reminders counted mail already read (#274) (R) |
| [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) | Claude channels | Claude terminal only | Claude-only; messages marked delivered without acknowledgement, and lost on restart (#50, #81, #37) (R); idle since April |
| [hardline-mcp](https://github.com/sushiHex/hardline-mcp) | SQLite mailbox plus a content-free notice. Claude: its own inbox socket, then channel, then Monitor. Codex: `codex queue`, or `turn/steer` mid-turn. Receipts | Yes (R, terminal); no desktop claim | 1★, weeks old; woken turns stop at a permission prompt unless its tools are allowlisted |
| [harness-summit](https://github.com/anthonyleung-dev/harness-summit) | Claude: `SessionStart` + `FileChanged` hooks. Codex: `codex queue`. Notices carry no body | Yes (R) | New and small |
| [agent-chat (agent-dojo)](https://github.com/dimokol/agent-dojo/tree/main/plugins/agent-chat) | Claude session socket; `codex queue` | Yes, about 5 s (R) | Needs CLAUDE.md and AGENTS.md lines, or a woken agent may stop |
| [agent-send](https://github.com/sanvithreddyy/agent-send) (CLI) | Claude `asyncRewake` hook; `codex queue` | Yes (R) | Claims `codex queue` can't reach a host's private app-server; our spike contradicts this for the desktop app |
| [agent-group-mcp](https://github.com/zb-ss/agent-group-mcp) | `asyncRewake` watcher; `codex queue` | Claude terminal only (R) | Caps wakes at 20 per agent per hour; says the hook wake fails in desktop |
| [agent-tincan](https://github.com/mvanhorn/agent-tincan) (362★) | Relay across a tailnet; Claude channel or socket | Claude yes; Codex gets a new `codex exec` run, not the open thread | Cross-machine, heavier |
| Claude agent teams | File mailbox under `~/.claude/teams` | Claude only | Experimental, one team, interactive only (R) |
| Orchestrators (Claude Squad, ccmanager, agent-deck, Sculptor, claude-flow) | Type into tmux or a PTY they spawned | Only sessions they launched | Can't reach a desktop session you opened; typing into panes is an injection risk |
| Protocols: [ACP](https://agentclientprotocol.com/protocol/prompt-turn), [A2A](https://github.com/a2aproject/A2A) | ACP: the client starts `session/prompt` in an agent it spawned. A2A: networked agents | No, for an open desktop session | Not built for this |

What the field shows:
- **No project reliably wakes both an idle Claude desktop session and an idle Codex desktop thread.** No project publishes a desktop-specific live test (R).
- **The current generation (August–October 2026) has the same shape as agent-bus.** It pairs a durable mailbox with a content-free doorbell through each runtime's native path, which means `codex queue` and Claude's socket, hooks or Monitor.
- **The failures reported are the ones agent-bus already designs against:**
  - agents that never poll;
  - "delivered" without a read;
  - mail lost on restart;
  - woken turns that stop;
  - wake loops;
  - prompt injection through notice bodies.

## Recommendations for agent-bus

### Keep

- **The ledger, per-address cursors, ownership, and "waking is separate from delivery".** This is the part every lighter tool gets wrong (false delivery, loss on restart).
- **Content-free nudges with an MCP read** (queue-wake decision 4). This is now common practice, and it avoids injection and bloat.
- **The `codex queue` nudge** (shipped in 3d10fca after this was written, as list-then-add through the app-server's queue methods). It is the only verified idle wake for desktop Local threads, and the same route the field uses.
- **Effect's MCP server, for now.**
  - Its server notifications are a closed set: anything outside it maps to `undefined` and is dropped (V, `effect/dist/ai/McpServer.js`). So it can't send `notifications/claude/channel`.
  - Channels are unusable in desktop anyway.
  - A private archive MCP server of the owner's uses the official `@modelcontextprotocol/sdk` 1.32.1, but only for tools over stdio and OAuth HTTP. It has no notifications either, so it shows no capability we lack.
  - Switch to the official SDK only if agent-bus adopts channels, or needs 2026-07-28 `subscriptions/listen` or extensions.

### Drop or simplify

1. **The daemon deliverer, `turn/start` and resume (overview question 1).**
   - The app-server that has a thread loaded drains the shared queue, whether that is the desktop or the daemon (V for the desktop; I for the daemon, from source).
   - So one `codex queue` route could serve the TUI and SSH threads as well. That removes `codexHost`, the guard, resume and unsubscribe.
   - Cost: about 10 s of latency, and no mid-turn steering. Busy threads get their mail when the turn ends, as with the hook.
   - Verify one daemon-hosted thread first.
2. **The Codex `Stop` hook (overview question 7).** It becomes optional once the queue drains after every turn. Keep it only if instant end-of-turn delivery matters more than one possible empty nudge turn.
3. **Re-arming `agent-bus wait` by hand (overview question 8).** Ship a Claude plugin whose `monitors` entry the host arms at session start and keeps for the session lifetime.
   - Its command would be a streaming `agent-bus watch` that prints one content-free line per arrival, for every address that `$CLAUDE_CODE_SESSION_ID` owns. That ends "a forgotten restart silently stops delivery".
   - Verify two things in the desktop app first: that plugin monitors arm, and that a line wakes an idle session. The model-armed Monitor already passed the second test.
   - Prefer this to the planned Claude `Stop` hook, which can't wake an idle session.

### Don't build

- **A channels route.** It is terminal-only, behind an allowlist or dev flag, refused on 2026-07-28 connections, and Effect can't emit it.
- **Elicitation, sampling or resource subscriptions as a wake.** None reaches the model or starts a turn.
- **Posting into Claude's inbox socket from `serve`.** Mail from outside the session is subject to `crossSessionInbound` and the permission-mode match, and desktop drops held mail after 5 minutes. A child process of the session (a wait, a Monitor or a plugin monitor) is the reliable sender. Revisit if an `accept` setting is acceptable to the owner.

### Watch

- MCP tasks in Claude Code. A `bus_wait` that returned a task would wake an idle Claude natively, but it is beta, Claude-only and needs re-arming.
- The MCP Tasks and Events working group.
- `codex queue` leaving experimental status. It is undocumented and could change; pin and test it on every Codex upgrade.

### Test with the official MCP tooling (separate from the wake question)

- **The gap:** `test/bus.test.ts` exercises `serve` only through Effect's own `McpClient`, plus raw-fetch checks of the handshake and headers. Client and server share one library, so a spec deviation in Effect passes.
- **The archive server already does better:** its tests connect the official SDK `Client` over stdio and streamable HTTP, then assert tool schemas, annotations, structured content and auth refusals.
- **For agent-bus, add:**
  1. Wire tests that use `@modelcontextprotocol/sdk` (1.32.2) `Client` with `StreamableHTTPClientTransport` against a test `serve`, for every bus tool. These would have caught the `bus_leave` "no structured content" bug.
  2. [MCP Inspector](https://github.com/modelcontextprotocol/inspector) (`@modelcontextprotocol/inspector`, 2.12.0) in qualification, including its CLI mode against `http://127.0.0.1:8096/mcp`.
  3. `@modelcontextprotocol/conformance` (0.1.16), if it covers streamable-HTTP servers. Neither 2 nor 3 was installed or run here.

## Sources

**Spec:**
- [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): transports, [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), [elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation), [sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling), [tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks).
- [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
- [Triggers and events WG](https://modelcontextprotocol.io/community/working-groups/triggers-events).

**Claude Code:**
- Docs: [channels](https://code.claude.com/docs/en/channels), [channels reference](https://code.claude.com/docs/en/channels-reference), [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), [hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp), [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool).
- [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
- Issues: [#7252](https://github.com/anthropics/claude-code/issues/7252), [#1785](https://github.com/anthropics/claude-code/issues/1785), [#33679](https://github.com/anthropics/claude-code/issues/33679), [#86800](https://github.com/anthropics/claude-code/issues/86800), [#98369](https://github.com/anthropics/claude-code/issues/98369).
- The 2.1.310 binary on this machine.

**Codex**, at tag `rust-v0.164.0-alpha.11.1`:
- Source: [logging_client_handler.rs](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/rmcp-client/src/logging_client_handler.rs), [client_capabilities.rs](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/codex-mcp/src/client_capabilities.rs), [elicitation.rs](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/codex-mcp/src/elicitation.rs), [queue service](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/ext/queue/src/service.rs), [queue_cmd.rs](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/cli/src/queue_cmd.rs), [stop hook](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/hooks/src/events/stop.rs), [features](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/features/src/lib.rs).
- Issues: [#16159](https://github.com/openai/codex/issues/16159), [#48617](https://github.com/openai/codex/issues/48617), [#4929](https://github.com/openai/codex/issues/4929).
- The installed binary and `codex queue --help`.

**agent-bus:** [overview](../overview.md), [queue-wake frame](../frames/queue-wake.md), [desktop-wake spike](../frames/desktop-wake-spike.md), `test/bus.test.ts`, `node_modules/effect/dist/ai/McpServer.js` (4.0.6).

**Archive MCP:** a private archive MCP server of the owner's (its host, remote-host and test files).

**Live test, 2026-10-26:**
- A Monitor with `sleep 75; echo …` was armed in this Claude desktop session.
- The session ended its turn at 22:16:12.
- The line arrived at 22:17:23 and started a turn with no human input.
