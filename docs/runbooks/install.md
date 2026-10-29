# Install

Use this to set up the bus host, add another machine, and register the MCP server and the Claude plugin. Upgrading an existing install is in [upgrade](upgrade.md); putting a new version into service is in [deploy](deploy.md).

Each step's expected result ends with how it was verified ([runbook shape](../../AGENTS.md#page-shapes)). The rehearsals ran on a disposable instance with its own directory, ports and LaunchAgent labels (the overrides in the installer's header), which behaves as the default install does. The commands here use the default values.

## Before you start

Install from the checkout that `serve` will run, which stays on a deployed `main` ([deploy](deploy.md#before-you-start)). The installer links `~/.local/bin/agent-bus` to it, so if you move the checkout later, rerun the installer.

What each machine needs:

| Needs | On | Why |
| --- | --- | --- |
| macOS and `bun`, at the version pinned in `package.json` | Every machine | The installer writes LaunchAgents and runs `serve` with Bun. It looks for `bun` on `PATH`, then in `~/.bun/bin` |
| The `fluree` CLI on `PATH` | The bus host only | The installer runs the Fluree server from it. Other machines run none ([topology](../architecture/topology.md#two-machine-roles)) |
| `~/.local/bin` on your shell's `PATH` | Every machine | `agent-bus` is the installer's link there |
| The Claude Code CLI, `claude` | Machines with Claude sessions | Registers the MCP server and installs the plugin |
| The Codex CLI, `codex`, and the ChatGPT desktop app | Machines with Codex threads | `codex` registers the MCP server. `serve` posts nudges through the desktop's bundled CLI, which has the queue methods |
| An SSH alias for the bus host with key authentication, and `scp` | The other machine only | The installer copies the token with `scp` and keeps the tunnel with `ssh`, both without prompts (`BatchMode`) |

Waking Codex threads has three more needs, which the installer doesn't set up:
- **A queue-capable Codex CLI, run by the user who owns the thread, with that user's Codex home, on the machine that owns it.** For a desktop SSH project that machine is the SSH host. `serve` runs the desktop's bundled CLI by default (`serve --codex` replaces it), with no `PATH` fallback ([why](../architecture/delivery.md#the-codex-wake)).
- **A Codex daemon, for borrows.** `serve` runs `codex app-server daemon start` when nothing listens on the daemon's socket, which needs a managed daemon package, or an invoking CLI that can install one. How the daemon starts, which one a desktop SSH project keeps running, and how it updates are in [platforms: Codex](../platforms/codex.md#the-daemon).
- **A daemon whose login is the one its turns should run under.** It keeps the login it started with, so after the owner changes the Codex login, restart it ([recover](recover.md)).

### Check the prerequisites

Run on the machine you are installing:

```sh
bun --version
fluree --version
command -v claude codex
ls /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
echo "$PATH" | tr ':' '\n' | grep -x "$HOME/.local/bin"
```

Expected: the Bun version in `packageManager` in `package.json`; a Fluree version (bus host only); a path for each CLI you will use; the bundled Codex path; and `~/.local/bin` echoed back. Fix anything missing first: with no `fluree`, the installer prints `fluree is not on PATH; install the Fluree CLI (docs/runbooks/install.md), then rerun` and exits with status 1 ([If it fails](#if-it-fails)). *Checked read-only 2026-10-28*; the installer's message *Rehearsed 2026-10-28*

## Install on the bus host

State lives in `~/.agent-bus`. An isolated bus for checks, which moves it with the installer's overrides, is in [operate](operate.md).

1. **Install the dependencies,** from the checkout:

   ```sh
   bun install
   ```

   Expected: Bun's package summary, and on the first run Effect's source cloned into `.repos/effect` (the `prepare` script). A rerun reports no changes. *Rehearsed 2026-10-28*

2. **Run the installer:**

   ```sh
   bun run install:launch-agents
   ```

   Expected on a first install, in about a second, with full paths:

   ```text
   created the Fluree signing key in ~/.agent-bus/fluree-key.json
   created the Fluree token in ~/.agent-bus/fluree-token
   loaded ai.rawr.agent-bus.fluree; log: ~/.agent-bus/fluree.log
   bus store: agent-bus:main at http://127.0.0.1:8095
   loaded ai.rawr.agent-bus; log: ~/.agent-bus/agent-bus.log
   ```

   Then the registration commands, which the next sections cover. *Rehearsed 2026-10-28*

3. **Check what it created:**

   ```sh
   ls -l ~/.local/bin/agent-bus ~/.agent-bus
   cat ~/.agent-bus/config.json
   ls ~/Library/LaunchAgents | grep ai.rawr.agent-bus
   ```

   | Created | Where | Note |
   | --- | --- | --- |
   | The launcher | `~/.local/bin/agent-bus`, a link to the checkout's `src/bin.ts` | What the Claude plugin's hook runs. The installer checks it runs under a launchd-style `PATH` from outside the checkout, and stops if a file that isn't a link is already there |
   | The signing key | `~/.agent-bus/fluree-key.json`, mode 0600 | The key the Fluree server trusts tokens from |
   | The token | `~/.agent-bus/fluree-token`, mode 0600 | The bearer token for Fluree's data and admin APIs. It has no subject and lasts 520 weeks ([connections](../architecture/connections.md#limits)) |
   | `config.json` | `~/.agent-bus/config.json` | `{ "fluree": { "url": "http://127.0.0.1:8095", "ledger": "agent-bus:main" } }`, written only if absent. `serve` won't start without it |
   | The Fluree project and storage | `~/.agent-bus/fluree/` | The ledger lives here |
   | Two LaunchAgents | `~/Library/LaunchAgents/ai.rawr.agent-bus.fluree.plist` and `ai.rawr.agent-bus.plist` | `RunAtLoad` and `KeepAlive`; loaded at once. `serve` runs as `bun --no-env-file src/bin.ts serve`, so a `.env` file in the state directory (its working directory) isn't loaded; a plist written by an earlier installer lacks the flag until the installer is rerun (read in the script, *Unverified* on a loaded job) |

   Expected: the link points into your checkout, the key and token show `-rw-------`, `config.json` names port 8095, and both plists are listed. Both servers listen on loopback only. *Rehearsed 2026-10-28*

4. **Check that both LaunchAgents run:**

   ```sh
   launchctl print gui/$(id -u)/ai.rawr.agent-bus | grep -E 'state =|pid ='
   launchctl print gui/$(id -u)/ai.rawr.agent-bus.fluree | grep -E 'state =|pid ='
   ```

   Expected: `state = running` and a `pid` for each. *Rehearsed 2026-10-28, checked read-only 2026-10-28*

5. **Check health and the log's start line:**

   ```sh
   curl -fsS http://127.0.0.1:8096/health
   curl -fsS http://127.0.0.1:8095/health
   tail -n 3 ~/.agent-bus/agent-bus.log
   ```

   Expected: `ok` from `serve`; `{"status":"ok", …}` from Fluree; and a log line `INFO (#…): Listening on http://127.0.0.1:8096`, which `serve` prints once it serves. Reading logs is in [operate](operate.md). *Rehearsed 2026-10-28, checked read-only 2026-10-28*

6. **Check that the token is enforced.** The installer does this itself before it starts `serve`. It asks Fluree about the ledger without a token (expecting 401) and with one (expecting 200), for up to half a minute, and stops with an error if the answers differ, which means another server holds the port. To check it yourself, with the token in a header file, not on a command line:

   ```sh
   probe=http://127.0.0.1:8095/v1/fluree/exists/agent-bus%3Amain
   curl -s -o /dev/null -w 'no token: %{http_code}\n' "$probe"
   curl -s -o /dev/null -w 'bad token: %{http_code}\n' -H 'Authorization: Bearer x.y.z' "$probe"
   curl -s -o /dev/null -w 'token: %{http_code}\n' \
     -H @<(printf 'Authorization: Bearer %s\n' "$(cat ~/.agent-bus/fluree-token)") "$probe"
   ```

   Expected: `no token: 401`, `bad token: 401`, `token: 200`. The `@<( … )` form needs `bash` or `zsh`. *Rehearsed 2026-10-28, checked read-only 2026-10-28*

   The installer's own refusal was rehearsed too: with a server that doesn't enforce the token already on the port, it printed "does not enforce the bus token (without: 200, with: 200)" after 33 s, exited 1 and left `serve` unloaded.

7. **Check the command line:**

   ```sh
   agent-bus --version
   agent-bus peers
   ```

   Expected: `agent-bus v…`, then the joined peers (none on a fresh bus). A failure here means the link or `serve` is broken. *Rehearsed 2026-10-28, checked read-only 2026-10-28*

### Rerun the installer

Rerunning is safe. It keeps the key, the token, `config.json` and every message, rewrites both plists and restarts both servers. It is therefore also how to apply a change to the installer itself. `serve`'s memory is lost, which costs at most one extra wake per address ([topology](../architecture/topology.md#where-state-lives)).

```sh
bun run install:launch-agents
```

Expected: the two `loaded …` lines and no `created …` line; the same checksums for `fluree-key.json`, `fluree-token` and `config.json` (`shasum`); new process ids; every earlier message still readable. A "Fluree events disconnected, reconnecting" warning in `serve`'s log during the restart is expected. *Rehearsed 2026-10-28*

## Register the MCP server

Every session on a machine shares that machine's `serve`. Register it once per runtime, with the port the installer printed (8096 by default):

```sh
claude mcp add --scope user --transport http agent-bus http://127.0.0.1:8096/mcp
codex mcp add agent-bus --url http://127.0.0.1:8096/mcp
```

Check each with the runtime's read-only command:

```sh
claude mcp get agent-bus
codex mcp get agent-bus
```

Expected: `Status: ✔ Connected` and the URL for Claude Code; `enabled: true` and the URL for Codex. A session picks the server up when it next starts. The `get` commands: *Checked read-only 2026-10-28*. The `add` commands change the owner's Claude and Codex configuration, so they were not run; their syntax is from `claude mcp add --help` and `codex mcp add --help`: *Unverified*

## Install the Claude plugin

Claude sessions are woken by the agent-bus plugin, which this repo serves as a local marketplace. Install it once per machine, after the installer, from the checkout `serve` runs:

```sh
claude plugin marketplace add "$PWD"
claude plugin install agent-bus@agent-bus
```

Check:

```sh
claude plugin marketplace list
claude plugin list
```

Expected: a marketplace `agent-bus` whose source is the checkout, and `agent-bus@agent-bus` with `Status: ✔ enabled`. Sessions get the plugin when they next start, or with `/reload-plugins` (that it loads the hook into a running session wasn't probed: [platforms: Claude Code](../platforms/claude-code.md#plugins)). The list commands: *Checked read-only 2026-10-28*. `marketplace add` and `install` change the owner's Claude configuration, so they were not run; their syntax is from `claude plugin --help`: *Unverified*

Check that the installed copy holds the skill as well as the manifest, in the newest cache directory (read-only):

```sh
cache=~/.claude/plugins/cache/agent-bus/agent-bus
newest=$cache/$(ls -t "$cache" | head -1)
ls "$newest/.claude-plugin/plugin.json" "$newest/skills/agent-bus/SKILL.md" "$newest/skills/agent-bus/references"
```

Expected: the manifest and `SKILL.md` listed, then `queries.md` and `runtimes.md`; the directory's name is the `Version` that `claude plugin list` shows. A plugin installed before the skill shipped has only the manifest, and `ls` says `No such file or directory` for the skill until the plugin is updated. *Rehearsed 2026-10-28* on a copy of `plugin/` laid out as the cache; the live cache was made before the skill shipped and correctly lacked it (*Checked read-only 2026-10-28*).

What to know about it:
- **The plugin is a hooks manifest and the agent skill:** `plugin/.claude-plugin/plugin.json` (the three hooks) and `plugin/skills/agent-bus/` (`SKILL.md` and `references/`, with `queries.md` and `runtimes.md`). Claude Code copies all of it into its cache ([platforms: Claude Code](../platforms/claude-code.md#plugins)). The hook runs the checkout, but the skill is read from the cache, so a change to the skill needs a plugin update.
- **Its hook runs the checkout,** through `~/.local/bin/agent-bus claude-wake`. A deploy therefore reaches the hook at once, with no plugin update ([delivery](../architecture/delivery.md#claude-code-sessions)).
- **The hook finds `bun`** in `~/.local/bin`, then `~/.bun/bin`, then on Claude Code's `PATH`, because hooks inherit Claude Code's environment, not your shell's.
- **It needs the same `AGENT_BUS_PORT` as `serve`,** or neither set.
- **Deploy `serve` before the plugin,** so the hook finds `bus_wake` ([deploy](deploy.md#when-the-plugin-changed)).

### After a change to the plugin

Only a change under `plugin/` or `.claude-plugin/` needs this:

```sh
claude plugin marketplace update agent-bus
claude plugin update agent-bus@agent-bus
```

Then repeat the cache check above: the new directory must hold `skills/agent-bus/SKILL.md` and `references/`. Sessions get the change when they next start, or with `/reload-plugins`: `claude plugin update --help` says a restart is required to apply it. *Unverified*: it would change the owner's installed plugin.

## Add another machine

Another machine runs its own `serve` and an SSH tunnel to the bus host's Fluree server, on the same local port. It runs no Fluree. Every step here runs on that machine, which this page has not been run on.

1. **Clone the repo on `main`, check [the prerequisites](#before-you-start)** (it needs no `fluree`), **and install the dependencies:**

   ```sh
   bun install
   ```

   *Unverified*

2. **Check that SSH works without prompts,** with the alias you will give the installer, as the account that owns `~/.agent-bus` on the bus host:

   ```sh
   ssh -o BatchMode=yes <ssh host of the bus host> ls .agent-bus/fluree-token
   ```

   Expected: the file name, with no password or host-key prompt. *Unverified*

3. **Run the installer with `--remote`:**

   ```sh
   bun run install:launch-agents -- --remote <ssh host of the bus host>
   ```

   Expected: it copies `~/.agent-bus/fluree-token` from the bus host with `scp` into a mode-0600 file, and stops if what arrived isn't a token. It loads `ai.rawr.agent-bus.tunnel` (log `~/.agent-bus/tunnel.log`), waits for Fluree through the tunnel, checks the token is enforced there, writes `config.json` if absent, and loads `ai.rawr.agent-bus`. The script is the bus host's, with the tunnel in place of Fluree. *Unverified*

4. **Check it:**

   ```sh
   launchctl print gui/$(id -u)/ai.rawr.agent-bus.tunnel | grep -E 'state =|pid ='
   launchctl print gui/$(id -u)/ai.rawr.agent-bus | grep -E 'state =|pid ='
   curl -fsS http://127.0.0.1:8096/health
   curl -fsS http://127.0.0.1:8095/health
   agent-bus peers
   ```

   Expected: both agents `running`, `ok`, a Fluree status through the tunnel, and the same peers as on the bus host. The token check (step 6 above) works unchanged through the tunnel. *Unverified*

5. **Register the MCP server and install the plugin,** with the commands above.

### `bun` on the other machine's remote shell

The other machine's non-interactive SSH `PATH` lacks `bun`, so a command run over SSH, say `ssh <host> bun install`, can fail to find it. Give the path (`ssh <host> '~/.bun/bin/bun --version'`) or put `~/.bun/bin` on the `PATH` that remote commands get. The installer is not affected: it runs on the machine itself, and finds Bun on the shell's `PATH` or in `~/.bun`. See also [recover](recover.md). The limit is recorded from earlier use, with no error message. *Unverified*

## If it fails

| What you see | What it means and what to do |
| --- | --- |
| `fluree is not on PATH; install the Fluree CLI (docs/runbooks/install.md), then rerun`, exit status 1 | `fluree` isn't on `PATH` (bus host). Check with `command -v fluree`, fix the `PATH`, rerun. *Rehearsed 2026-10-28* |
| `… exists and is not a link; move it aside and rerun` | A real file sits at `~/.local/bin/agent-bus`. Move it aside, rerun. *Rehearsed 2026-10-28* |
| `… does not run` | The link's target can't run under a launchd-style `PATH`. Check that `bun` is in `~/.bun/bin` or `~/.local/bin` and that `bun install` finished |
| `The Fluree server at … does not enforce the bus token` | Another server holds the Fluree port. Find it with `lsof -nP -iTCP:8095 -sTCP:LISTEN`, stop it by its pid, rerun. *Rehearsed 2026-10-28* |
| `Nothing answers at … ; see <log>` | A server didn't come up within 20 s. Read the log it names ([operate](operate.md)) |
| `could not copy the token from <host>` | The `scp` failed or the file isn't a token. Repeat step 2 of [Add another machine](#add-another-machine) |
| Installed, but sessions aren't woken or a Codex thread is stuck | [Recover](recover.md) |
