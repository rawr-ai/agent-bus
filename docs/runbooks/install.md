# Install

Use this to set up the bus host, add another machine, and register the MCP server and the Claude plugin. Upgrading an existing install is in [upgrade](upgrade.md).

## Before you start

## Machine prerequisites

<!-- draft from phase 2: docs/architecture/codex-hosting.md, "What waking needs from each machine" -->

- **`serve` has to reach the thread's queue.** It needs a queue-capable Codex CLI (`serve --codex`, by default the desktop's bundled one, `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`), run as the same user with the same Codex home, on the machine that owns the thread. For a desktop SSH project, that is the SSH host. There is no `PATH` fallback: `serve` runs under launchd's `PATH`, and another CLI's protocol could differ. The queue methods are experimental, and the bundled CLI is the same build as the desktop that reads the queue.
- **A daemon.** `serve` borrows through the daemon, and runs `codex app-server daemon start` when nothing listens on its socket, which needs a managed daemon package (or the invoking CLI to install one). [Platforms: Codex](../platforms/codex.md#the-daemon) has how the daemon starts, outlives its starter and updates itself. On the bus host, a desktop SSH project from another machine keeps a daemon running, though not the managed one, so `serve` rarely starts it there, and that daemon doesn't take the managed package's updates (inferred).
- **The daemon's login is the one its turns run under.** It keeps the login it started with, so after the owner changes the Codex login, borrowed turns run as the old user until the daemon restarts ([platforms: Codex](../platforms/codex.md#the-daemon)). See [recover](recover.md).

## The other machine's SSH PATH lacks bun

<!-- draft from phase 2: docs/overview.md, "Open gaps and limits" (status "Operations"; the row is removed from the overview in phase 2) -->

The other machine's non-interactive SSH `PATH` lacks `bun`: remote commands need `~/.bun/bin`. The same limit is in [recover](recover.md).

## Install on the bus host and on another machine

<!-- draft from phase 2: README.md, "Commands" and "Setup and other machines" -->

State lives in `~/.agent-bus` (`AGENT_BUS_DIR` overrides it). `config.json` names the Fluree ledger, and `serve` won't start without it:

```json
{ "fluree": { "url": "http://127.0.0.1:8095", "ledger": "agent-bus:main" } }
```

```sh
bun install                      # also clones the Effect source into .repos/effect
bun run install:launch-agents    # on the bus host: Fluree server + agent-bus serve, as LaunchAgents
bun run install:launch-agents -- --remote <ssh host of the bus host>   # on another machine
```

`install:launch-agents` first links `~/.local/bin/agent-bus` to this checkout's `src/bin.ts`, for the Claude Code plugin's hook, and checks that the link runs. On the bus host, it then runs a dedicated Fluree server on `127.0.0.1:8095` (`ai.rawr.agent-bus.fluree`, project and storage in `~/.agent-bus/fluree`) and `agent-bus serve`. On first install it creates a signing key (`fluree-key.json`) and a token (`fluree-token`), both readable only by you, and writes `config.json` if there is none. Rerunning it is safe.

Both servers listen on loopback only. Another machine clones this repo and runs `install:launch-agents -- --remote <ssh host>`: it copies the token, keeps an SSH tunnel to the Fluree server on the same local port (`ai.rawr.agent-bus.tunnel`), and runs its own `serve` for its own sessions. [Topology](../architecture/topology.md) shows both machine roles, every process and where each piece of state lives.

From `scripts/install-launch-agents.sh`, which the commands above run: an existing `~/.local/bin/agent-bus` that is not a link stops the install ("move it aside and rerun"); the script needs `fluree` on the bus host's `PATH`; `AGENT_BUS_DIR`, `AGENT_BUS_FLUREE_PORT` (8095) and `AGENT_BUS_PORT` (8096) override its defaults; and `--remote` takes an ssh host alias for the bus host and copies `~/.agent-bus/fluree-token` from it with `scp`.

## Registering the MCP server

<!-- draft from phase 2: README.md, "Registering the MCP server" -->

Every session on a machine shares that machine's `serve`:

```sh
claude mcp add --scope user --transport http agent-bus http://127.0.0.1:8096/mcp
codex mcp add agent-bus --url http://127.0.0.1:8096/mcp
```

The installer prints these commands, with the port it used, when it finishes.

## Installing the Claude plugin

<!-- draft from phase 2: README.md, "Registering the MCP server" (the plugin paragraphs) and the installer's closing output -->

Claude sessions are woken by the agent-bus plugin, which this repo serves as a local marketplace. Install it once per machine, after the installer, from the checkout `serve` runs:

```sh
claude plugin marketplace add <agent-bus checkout>
claude plugin install agent-bus@agent-bus
```

The plugin (`plugin/`) is only a manifest, which Claude Code copies into its cache. Its hook runs `~/.local/bin/agent-bus claude-wake`, the installer's link to the checkout's `src/bin.ts`. So the hook runs the checkout's code with its dependencies, and picks up a deploy at once. After a change to `plugin/`, run `claude plugin marketplace update agent-bus` and `claude plugin update agent-bus@agent-bus`. Hooks inherit Claude Code's environment rather than your shell's, so the hook looks for `bun` in `~/.local/bin`, then `~/.bun/bin`, then on that `PATH`. It needs the same `AGENT_BUS_PORT` as `serve` (or neither set). Sessions get it when they next start, or with `/reload-plugins`. Deploy `serve` first, so the hook finds `bus_wake`.

## If it fails
