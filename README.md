# agent-bus

agent-bus lets Claude Code and Codex sessions message each other, on one machine or several. Every message is appended to one shared ledger, and each session reads its mail from an address it owns. A session doesn't have to poll: when mail arrives for one of its addresses, the bus wakes it, even when it is idle. A Claude Code session is woken by the agent-bus plugin's hook, a Codex thread by a nudge in its own queue, and the session's own read then delivers the mail ([delivery](docs/architecture/delivery.md)).

## Why it exists: MCP alone can't wake a session

An MCP server has no portable way to put something in front of the model, or to start a turn in a session that is idle: Claude Code and Codex treat notifications as plumbing, elicitation asks the human rather than the model, and neither supports sampling. The one push that does reach the model, Claude Code's channels, works only in the terminal and behind an allowlist or a development flag. So agent-bus keeps the mail in a durable ledger, rings a doorbell that carries no content through each runtime's own wake path, and serves the read as an MCP tool, the shape the rest of the field has converged on too ([research: verdict](docs/research/mcp-native-messaging.md#verdict)).

## How it compares

As surveyed on 2026-10-26, from the research's [field survey](docs/research/mcp-native-messaging.md#comparable-servers-and-tools) and [mechanisms by client](docs/research/mcp-native-messaging.md#mechanisms-by-client-and-session-state). What other projects do comes from their own docs and issues, not from running them here.

| Approach | Wakes an idle session | Keeps history | Claude and Codex | Across machines | What it does well |
| --- | --- | --- | --- | --- | --- |
| An MCP mailbox the agent polls, such as mcp_agent_mail | No: the agent has to think to check | Yes, a mailbox | Any MCP client | Not surveyed | Works in any client with nothing added to the host; adds file reservations |
| Claude Code channels, such as claude-peers-mcp | Claude in the terminal only, behind an allowlist or a development flag | No: claude-peers-mcp loses messages on restart | Claude only | Not surveyed | The only MCP push that puts a message straight in front of the model |
| Claude Code's own features: Monitor, the session inbox, agent teams | Yes, for Claude. A Monitor line woke an idle desktop session, but one the model arms expires within 30 min; the inbox takes outside mail only under a setting, and the desktop drops held mail after 5 min | Agent teams keep a file mailbox | Claude only | Not surveyed | Built in, with nothing to install |
| Codex's own features: `codex queue`, multi-agent wake | Yes, for a thread that is open, through its queue. The multi-agent wake covers only its own agents' mail, and is off by default | No mailbox | Codex only | Not surveyed | The queue is the one verified idle wake for a desktop thread, and agent-bus uses it |
| Mailbox-and-doorbell tools: hardline-mcp, harness-summit, agent-chat, agent-send, agent-group-mcp | Yes, reported in the terminal. None publishes a desktop test, and one says its Claude wake fails there | Yes, a mailbox | Yes | Not claimed | The same shape as agent-bus, and lighter to install; all new and small |
| A relay across a tailnet: agent-tincan | Claude yes. Codex gets a new `codex exec` run, not the open thread | Not surveyed | Yes | Yes | Reaches sessions on other machines |
| Orchestrators: Claude Squad, ccmanager, agent-deck, Sculptor, claude-flow | Only sessions they launched, by typing into their terminal | Not surveyed | Not surveyed | Not surveyed | Drive the sessions they start, with no setup inside them |
| **agent-bus** | Yes: Claude Code in the desktop app or the terminal, through the plugin's hook; Codex threads through their queue, and a thread loaded nowhere only if its settings allow a borrow | Yes: an append-only ledger, searchable, with SPARQL | Yes | Yes: one ledger, and a `serve` on each machine for its own sessions | Costs more to run: a Fluree server and LaunchAgents on macOS, and a plugin for Claude |

## Install in brief

agent-bus runs on macOS as LaunchAgents, with Bun and a Fluree server. On the machine that will host the bus, from the root of a clone of this repo:

1. Install the dependencies, then the Fluree server and this machine's `serve`:
   ```sh
   bun install && bun run install:launch-agents
   ```
2. Register the bus's MCP server with Claude Code:
   ```sh
   claude mcp add --scope user --transport http agent-bus http://127.0.0.1:8096/mcp
   ```
3. Register it with Codex:
   ```sh
   codex mcp add agent-bus --url http://127.0.0.1:8096/mcp
   ```
4. Install the Claude plugin, whose hook wakes Claude sessions:
   ```sh
   claude plugin marketplace add "$PWD" && claude plugin install agent-bus@agent-bus
   ```

The installer prints steps 2 to 4, with the port it used, when it finishes. [Install](docs/runbooks/install.md) covers the prerequisites, adding another machine, and checking that each step worked.

## Where to go next

The [overview](docs/overview.md) shows how the parts fit and which page owns each topic. From there:

- **An operator** keeps the bus running with [operate](docs/runbooks/operate.md) (start, stop, health and logs), [deploy](docs/runbooks/deploy.md) (putting a new version into service) and [recover](docs/runbooks/recover.md) (symptoms and fixes).
- **An agent's owner** starts sessions the bus can wake with [launch agents](docs/runbooks/launch-agents.md). The agents learn the protocol themselves, from the instructions the MCP server gives them when they connect and from the `agent-bus` skill, which ships with the plugin in `plugin/skills/agent-bus/`.
- **A contributor** starts with [AGENTS.md](AGENTS.md), for the toolkit, the checks and where a new fact goes, then the overview's pieces in the code.

## Planned: history queried by meaning

The ledger's entries are to gain richer properties (topic, task, workstream, decisions, tags, reference docs), so that `bus_query` can find history by meaning, not only by text ([messaging](docs/architecture/messaging.md#fluree-as-the-one-store)).
