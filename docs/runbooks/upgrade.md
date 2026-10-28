# Upgrade

Use this after upgrading Codex, Claude Code, Fluree or the agent-bus plugin: what to recheck, and how running sessions pick up new guidance. Installed versions and the findings to recheck are in [platforms](../platforms/README.md).

## Before you start

## Restarting the Codex daemon after an upgrade

<!-- draft from phase 2: docs/frames/codex-wake.md, "Operations" item 1; docs/frames/load-on-mail.md, qualification and known limits; docs/frames/finish-swap.md. The facts behind these steps go to docs/platforms/codex.md. -->

- **A managed daemon restarts itself on an update.** A started daemon runs an update loop; a new version restarts it, which reloads its threads under the global `thread_unload_delay_secs`, not a borrow's 5 s ([platforms: Codex](../platforms/codex.md#the-daemon)).
- **To restart it yourself,** follow [operate](operate.md#the-codex-daemon-file-limit-and-restarts): stop an auto-started daemon with `kill -TERM`, then `codex app-server daemon start` from a shell with the open-file limit raised (`ulimit -S -n 10240`), and check the limit after every start (`lsof -p <pid>`).
- **A daemon restart unloads its threads.** A nudge waits in each thread's queue until `serve` borrows the thread again or the thread is reopened. In an earlier release the owner reopened each previously active daemon thread from the TUI or SSH project that ran it.
- **A daemon keeps the login it started with,** so restart it after the owner changes the Codex login.
- **Deploy order and restarts of `serve`** are in [deploy](deploy.md). `serve` restarts while a Claude hook waits are recovered by the hook; the daemon outlives `serve`'s restarts.

## Changing the Claude plugin

<!-- draft from phase 2: README.md, "Registering the MCP server" (plugin paragraphs) -->

After a change to `plugin/`, run:

```sh
claude plugin marketplace update agent-bus
claude plugin update agent-bus@agent-bus
```

Sessions get the change when they next start, or with `/reload-plugins`. Deploy `serve` first, so the hook finds `bus_wake`. The hook runs the checkout's code through `~/.local/bin/agent-bus`, so a change to `src/` reaches it at once, without a plugin update.

## After upgrading Fluree

<!-- draft from phase 2: README.md, "Commands"; docs/platforms/fluree.md -->

Rerun the qualification, which rechecks the claims [platforms: Fluree](../platforms/fluree.md) marks as verified by it (durable server, restart, index boundary):

```sh
bun run qualify:fluree
```

## If it fails
