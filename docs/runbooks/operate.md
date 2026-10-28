# Operate

Use this to start, stop and restart `serve`, check its health, read its logs, and run an isolated bus for checks. Where each process runs is in [topology](../architecture/topology.md).

## Before you start

## Logs and LaunchAgents

<!-- draft from phase 2: docs/architecture/topology.md, "Processes"; commands from scripts/install-launch-agents.sh. No source gives a restart command other than rerunning the installer or its bootout and bootstrap pair; phase 3 verifies these. -->

| Process | LaunchAgent label | Runs on | Log |
| --- | --- | --- | --- |
| Fluree server | `ai.rawr.agent-bus.fluree` | Bus host | `~/.agent-bus/fluree.log` |
| SSH tunnel | `ai.rawr.agent-bus.tunnel` | Other machines | `~/.agent-bus/tunnel.log` |
| `agent-bus serve` | `ai.rawr.agent-bus` | Every machine | `~/.agent-bus/agent-bus.log` |
| Codex daemon (not a LaunchAgent; Codex starts it) | — | Any machine with Codex | `~/.codex/app-server-control/app-server.log` |

The plists are in `~/Library/LaunchAgents/<label>.plist`. Each LaunchAgent has `KeepAlive` (restarted at most every 10 s) and sets `AGENT_BUS_DIR` and `AGENT_BUS_PORT`. `serve`'s Codex app-server and the `claude-wake` hook write no log of their own: a failed Codex app-server's error goes into `serve`'s log.

Read a log:

```sh
tail -n 50 ~/.agent-bus/agent-bus.log
```

Check a LaunchAgent, and the health endpoints (`serve` on 8096; Fluree on 8095 on the bus host):

```sh
launchctl print gui/$(id -u)/ai.rawr.agent-bus
curl -fsS http://127.0.0.1:8096/health
curl -fsS http://127.0.0.1:8095/health
```

Restart one by running the installer again (rerunning it is safe: existing config, credentials and messages are kept), or by its own steps, which the installer takes:

```sh
launchctl bootout gui/$(id -u)/ai.rawr.agent-bus
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.rawr.agent-bus.plist
```

`bootout` returns before the old job is gone, and bootstrapping over it fails (error 5): wait until `launchctl print gui/$(id -u)/<label>` fails first. The installer waits up to about ten seconds for that.

## The Codex unload setting

<!-- draft from phase 2: docs/architecture/codex-hosting.md, "The unload delay the owner chose" -->

The owner set `thread_unload_delay_secs = 300` in `~/.codex/config.toml` on both machines. It is a deliberate configuration, chosen so threads left on the daemon are freed in 5 minutes rather than 30 (Codex's default is 1800). To change it, edit that line, a top-level key in whole seconds; [platforms: Codex](../platforms/codex.md#how-long-a-thread-stays-loaded) says how the setting applies.

The trade-off for the bus:
- **Waking doesn't depend on it.** A thread that has unloaded is borrowed again when mail comes, and each borrow carries its own 5 s release.
- **It governs threads a human loads** in the TUI or an SSH project: how long the daemon keeps them after the last client leaves. A borrow cuts that short for a thread already idle and left (to about 5 s after the borrowed turn), but not while a client is attached.
- **It applies after a daemon restart or update,** which reloads threads under the global delay, not a borrow's.
- The desktop's hold is driven by its UI, not by this setting.

That the setting takes effect without a restart was read in code, not tested.

## The Codex daemon: file limit and restarts

<!-- draft from phase 2: docs/frames/codex-wake.md, "Operations" items 1, 3 and 4; docs/frames/load-on-mail.md; docs/frames/one-codex-route.md ("Operating the daemon"). The facts behind these steps go to docs/platforms/codex.md. -->

- **The open-file limit.** The daemon inherits the open-file limit of whatever started it, so a daemon can hit `Too many open files`. Restart it from a login shell with the limit raised (`ulimit -S -n 10240`), once its loaded threads are accounted for, because a restart drops them. After every start, check the limit: a child process's `getrlimit`, or `lsof -p <pid>` counts. (The daemon raises its own soft limit to 4096 when started as a managed daemon: [platforms: Codex](../platforms/codex.md#the-daemon).)
- **Restarting.** The CLI's `codex app-server daemon restart` refuses daemons it auto-started. Stop those with `kill -TERM`, then run `codex app-server daemon start` from a shell with the raised limit. Keep the daemon's own `start` and `restart` management; don't add a competing launchd job. Qualify `codex app-server daemon bootstrap` before relying on it for restarts after a reboot: nothing starts the daemon at boot, and the CLI, SSH proxies and `serve` start it on first use.
- **A restart interrupts every daemon-hosted thread.** `serve`, the desktop app's SSH projects and the CLI all share the daemon. A restart unloads its threads; their nudges wait in their queues until `serve` borrows the thread again or it is reopened.
- **Open each thread from one place.** Both the desktop's and the daemon's app-server read the same `~/.codex`, so a thread id opens under either, but only one can be its writer: a thread the daemon holds shows "open in another app" in a Local window until the daemon unloads it.
- **Recovering a thread the daemon holds today:** `codex resume --remote unix:// <thread uuid>` attaches to it, with no restart needed. Never archive or delete a thread to release it.
- **Stopping.** `codex app-server daemon stop` stops a daemon the managed lifecycle started. It does not stop one a desktop SSH project started ([platforms: Codex](../platforms/codex.md#the-daemon)).

## Checking with MCP Inspector

<!-- draft from phase 2: README.md, "Checking with MCP Inspector" (this is the isolated bus for checks) -->

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

## If it fails
