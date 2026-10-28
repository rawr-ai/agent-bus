# agent-bus

Contributor rules for agent-bus: where documentation goes, the toolkit, the invariants, project memory and verification. Users of the bus start at the [README](README.md); agents using it load the `agent-bus` skill.

## Documentation

The docs have three layers, each with fixed homes:
- **Reference:** [`docs/architecture/`](docs/architecture/) says what agent-bus does, one concern per page; [`docs/platforms/`](docs/platforms/README.md) holds the Codex, Claude Code and Fluree behaviour it rests on. The [overview](docs/overview.md) shows how the parts fit and names the page that owns each topic.
- **Entry points:** the [README](README.md) says what agent-bus is, why, and how to install it; [`docs/runbooks/`](docs/runbooks/) holds the procedures.
- **The skill:** `plugin/skills/agent-bus/` teaches agents to use the bus.

[Frames](docs/frames/README.md) and research are history, frozen at their paths: fix their links, never their decisions.

### Where a new fact goes

Place content by its kind first, then by the concern or task it serves; never by release or by runtime.

| A new… | goes to | never |
| --- | --- | --- |
| fact about how Codex, Claude Code or Fluree behaves | `docs/platforms/<platform>.md`, marked verified live, read in code or inferred, with the version it was observed on; plus a row in the findings register when an upgrade could change it | restated elsewhere; other pages link to it |
| rule, behaviour, reason or limit of agent-bus | the `docs/architecture/` page that owns the concern, in that page's fixed section | a second architecture page, the README or the overview |
| procedure an operator follows | `docs/runbooks/<task>.md` | inside reference pages, beyond a link |
| guidance for agents using the bus | the skill; a single call's contract goes in that tool's description | the MCP instructions, beyond their minimum protocol |
| plan, measurement, qualification or review of a release | that release's frame | current pages, except a verified fact or limit promoted to its owner |

- **A change usually has several facets:** the contract (`interfaces.md` and the tool description), the rule (its architecture page), agent guidance (the skill), the platform claim (platforms) and the procedure (a runbook). Update each home, not just the first.
- **Versions appear only in `docs/platforms/`,** except a binding requirement where it binds, and a frame's record of what its experiments ran on. A current page states constants from code and links to the platform page for anything measured.
- **A new page is for a new concern or task** that no page covers. When a page grows, improve its internal structure first.
- **Use the existing vocabulary:** address, session, join, run of joins, nudge, borrow, reconcile each keep one name.

### Page shapes

Every current page opens with a scope line: what it covers and where its neighbours are.
- **Architecture page:** `What it does` (the mechanism, with its diagram), `Rules` (numbered, so other pages can cite them), `Why` (the choice and the alternatives rejected), `Limits`, `Rests on` (linked platform claims), `History` (links to the frames that made it; never needed for current truth). A catalogue page, such as `interfaces.md`, keeps these headings: its catalogue goes under `What it does`, and its `Rules` are the surface's invariants.
- **Platform page:** claims marked with basis and version, listed in the findings register when version-sensitive. After upgrading a platform, recheck the installed-version table and the findings it lists ([upgrade](docs/runbooks/upgrade.md)).
- **Runbook:** `Before you start`, then the steps with literal commands and how to check each, then `If it fails` (linking [recover](docs/runbooks/recover.md)).

A release that designs and qualifies something writes a frame, which ends with a "Moved into current docs" checklist of the five facets above. Routine changes update the owner pages in their own PR. `bun run check` runs `scripts/check-docs.ts`, which checks links and anchors, scope lines, page shapes, the overview's topic table, and that current pages link frames only from their History footer (platform pages may cite a frame inline as a claim's evidence).

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

`bun run check` must pass before committing. It runs `typecheck`, `lint`, `test` and `check:docs`, each also a script of its own. `bun run lint:effect` (stricter Effect rules) and `bunx knip` (unused files, exports and dependencies) are advisory.

```sh
bun install                 # also clones the Effect source into .repos/effect
bun run check
bun run qualify:fluree      # after upgrading Fluree
bun src/bin.ts --help       # the CLI, from the checkout
```
