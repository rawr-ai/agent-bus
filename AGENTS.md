# agent-bus

[README](README.md) owns commands, setup and the ledger format. [Overview](docs/overview.md) is the entry map: the system's shape, ownership policies, what is verified and the known gaps. `docs/architecture/` owns the rest of the architecture, one concern per page:
- [topology](docs/architecture/topology.md): machines, processes, ports, transports and where state lives;
- [Codex hosting](docs/architecture/codex-hosting.md): what agent-bus runs on Codex, and why `serve` uses its own short-lived app-server;
- [delivery](docs/architecture/delivery.md): how each kind of session is woken, and the delivery policies;

`docs/platforms/` owns the platform facts agent-bus rests on, each with its version and basis: [the index and versions](docs/platforms/README.md), [Codex](docs/platforms/codex.md), [Claude Code](docs/platforms/claude-code.md) and [Fluree](docs/platforms/fluree.md).

Update the page that owns a fact when it changes; link to it from elsewhere rather than repeating it. Keep platform behaviour (Codex, Claude Code, Fluree) apart from agent-bus's decisions, mark each platform claim verified live, read in code or inferred, and tag it with the version it was observed on. After upgrading a platform, recheck the version table and the findings it lists. [Connections](docs/connections.md) owns trust boundaries. Frames in `docs/frames/` are history: don't rewrite their decisions.

## Toolkit

- Effect work follows the `effect-ts` skill where it is installed (`.agents/skills`, local and untracked); research the vendored source in `.repos/effect` (pinned to the installed version by `scripts/prepare-effect.sh`). This repo uses stable Effect 4.0.6, where the skill's beta names have moved: `effect/unstable/ai` and `effect/unstable/cli` are `effect/ai` and `effect/cli`, `Schema.TaggedErrorClass` is `Schema.TaggedError`, and CLI flags are `Flag.String`, `Flag.Boolean`, `Flag.Int`, `Flag.Literals`. Trust the vendored source over the skill when they differ.
- Runtime, tests and packaging follow the `bun` skill where installed. Prefer Bun-native APIs (`Bun.file`, `Bun.spawn`, `WebSocket` over `ws+unix://`) at the edges and Effect services everywhere else.
- The only HTTP API is the MCP endpoint, served by `effect/ai`'s `McpServer.layerHttp`; the CLI reaches it with `McpClient`. oRPC is not used. If another HTTP API is added, follow the `orpc` and `effect-orpc` skills where installed, and confirm the provider profile before writing code.

## Invariants

- Storage goes through the `Ledger` service; change notifications only wake readers, and reading from a cursor decides delivery. A cursor advances only after a complete read.
- Fluree features follow the docs of the installed version (`fluree docs search`, `fluree docs get`), which are version-exact. Run `bun run qualify:fluree` after upgrading Fluree. Team Fluree Runtime advises on server topology, Team Fluree Platform on search and other capabilities.
- One `agent-bus serve` per machine is the only process that reads or writes the store for that machine's sessions. It writes the cursors of the peers that joined from its machine, and serializes joins, leaves, reads and deliveries per address through `Bus.deliver`.
- The servers listen on loopback. Keep Fluree's data and admin APIs behind the token, `serve` behind its Host check, and `bus_query` to one regenerated SELECT with no FROM or SERVICE.
- Never put credentials or raw tool responses in messages, logs or the ledger.

## Project memory

Decisions (with rationale and the alternatives rejected), constraints and costly traps live in Fluree memory, committed as `.fluree-memory/repo.ttl`. Recall before substantial work, from this checkout:

```sh
fluree --config .fluree/config.toml memory recall "specific keywords" --limit 5
```

When a decision, constraint or trap changes, `update` its memory instead of adding another; record new ones with `memory add --scope repo` and the right kind (`decision` with `--rationale` and `--alternatives`, `constraint` with `--severity`, otherwise `fact`), lowercase tags and repo-relative `--refs`. Store only what code, docs and Git can't show, phrased to stay true at HEAD: no progress, status, commit hashes or session notes. The repository is public, so repo memories carry no machine names, home paths or personal details; keep those in your own user-scope store. `fluree memory audit --all` checks the store. `.fluree/` (local config and storage) is ignored; `fluree init` recreates it.

## Verification

`bun run check` must pass before committing. `bun run lint:effect` is advisory.
