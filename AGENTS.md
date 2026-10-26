# agent-bus

[README](README.md) owns commands, the delivery model and the ledger format.

## Toolkit

- Effect work follows the `effect-ts` skill where it is installed (`.agents/skills`, local and untracked); research the vendored source in `.repos/effect` (pinned to the installed version by `scripts/prepare-effect.sh`). This repo uses stable Effect 4.0.6, where the skill's beta names have moved: `effect/unstable/ai` and `effect/unstable/cli` are `effect/ai` and `effect/cli`, `Schema.TaggedErrorClass` is `Schema.TaggedError`, and CLI flags are `Flag.String`, `Flag.Boolean`, `Flag.Int`, `Flag.Literals`. Trust the vendored source over the skill when they differ.
- Runtime, tests and packaging follow the `bun` skill where installed. Prefer Bun-native APIs (`Bun.file`, `Bun.spawn`, `WebSocket` over `ws+unix://`) at the edges and Effect services everywhere else.
- The only HTTP API is the MCP endpoint, served by `effect/ai`'s `McpServer.layerHttp`; the CLI reaches it with `McpClient`. oRPC is not used. If another HTTP API is added, follow the `orpc` and `effect-orpc` skills where installed, and confirm the provider profile before writing code.

## Invariants

- Storage goes through the `Ledger` service; change notifications only wake readers, and reading from a cursor decides delivery. A cursor advances only after a complete read.
- Fluree features follow the docs of the installed version (`fluree docs search`, `fluree docs get`), which are version-exact. Run `bun run qualify:fluree` after upgrading Fluree. Team Fluree Runtime advises on server topology, Team Fluree Platform on search and other capabilities.
- One `agent-bus serve` per machine is the only process that reads or writes the store for that machine's sessions (apart from the offline `import-jsonl`). It writes the cursors of the peers that joined from its machine, and serializes joins, leaves, reads and deliveries per address through `Bus.deliver`.
- The servers listen on loopback. Keep Fluree's data and admin APIs behind the token, `serve` behind its Host check, and `bus_query` to one regenerated SELECT with no FROM or SERVICE.
- Never put credentials or raw tool responses in messages, logs or the ledger.

## Verification

`bun run check` must pass before committing. `bun run lint:effect` is advisory.
