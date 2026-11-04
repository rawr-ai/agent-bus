# agent-bus

Contributor rules for agent-bus: where documentation goes, the toolkit, Git and Graphite, the invariants, project memory and verification. Users of the bus start at the [README](README.md); agents using it load the `agent-bus` skill.

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
| limit of a script, flag or procedure | that runbook's `If it fails`, and `interfaces.md` when it is a flag or setting | an architecture page's Rules |
| fact about another tool or the field | the README's dated comparison table | the research note, which stays frozen |

- **A change usually has several facets:** the contract (`interfaces.md` and the tool description), the rule (its architecture page), agent guidance (the skill), the platform claim (platforms) and the procedure (a runbook). Update each home, not just the first.
- **Versions appear only in `docs/platforms/`,** except a binding requirement where it binds, and a frame's record of what its experiments ran on. A current page states constants from code and links to the platform page for anything measured.
- **A new page is for a new concern, task or platform** that no page covers. When a page grows, improve its internal structure first. A fourth runtime, for example, gets a platform page, a section in delivery, one in the skill's runtimes reference, and a task in launch-agents.
- **Use the existing vocabulary:** address, session, join, run of joins, nudge, borrow, reconcile each keep one name.

### Page shapes

Every current page opens with a scope line: what it covers and where its neighbours are.
- **Architecture page:** `What it does` (the mechanism, with its diagram), `Rules` (numbered, so other pages can cite them), `Why` (the choice and the alternatives rejected), `Limits`, `Rests on` (linked platform claims), `History` (links to the frames that made it; never needed for current truth). A catalogue page, such as `interfaces.md`, keeps these headings: its catalogue goes under `What it does`, and its `Rules` are the surface's invariants.
- **Platform page:** claims marked with basis and version, listed in the findings register when version-sensitive. After upgrading a platform, recheck the installed-version table and the findings it lists ([upgrade](docs/runbooks/upgrade.md)).
- **Runbook:** `Before you start`, then the steps with literal commands and how to check each, then `If it fails` (linking [recover](docs/runbooks/recover.md)). Each step's expected result ends with how it was verified: *Rehearsed YYYY-MM-DD* (on a disposable instance), *Checked read-only YYYY-MM-DD* (on the running bus) or *Unverified* (with the reason, if it isn't obvious). A mark shared by every step of a section is stated once at its head. Observed detail is kept only when it differs from the expected result or adds a number worth knowing.

A release that designs and qualifies something writes a frame, which ends with a "Moved into current docs" checklist of the five facets above. Routine changes update the owner pages in their own PR. `bun run check` runs `scripts/check-docs.ts`, which checks links and anchors, scope lines, page shapes, the overview's topic table, and that current pages link frames only from their History footer (platform pages may cite a frame inline as a claim's evidence).

## Toolkit

- Effect work follows the `effect-ts` skill where it is installed (`.agents/skills`, local and untracked); research the vendored source in `.repos/effect` (pinned to the installed version by `scripts/prepare-effect.sh`). This repo uses stable Effect 4.1.2, where the skill's beta names have moved: `effect/unstable/ai` and `effect/unstable/cli` are `effect/ai` and `effect/cli`, `Schema.TaggedErrorClass` is `Schema.TaggedError`, and CLI flags are `Flag.String`, `Flag.Boolean`, `Flag.Int`, `Flag.Literals`. Trust the vendored source over the skill when they differ.
- Runtime, tests and packaging follow the `bun` skill where installed. Prefer Bun-native APIs (`Bun.file`, `Bun.spawn`, `WebSocket` over `ws+unix://`) at the edges and Effect services everywhere else.
- The core HTTP API is the MCP endpoint, served by `effect/ai`'s `McpServer.layerHttp`; the CLI reaches it with `McpClient`. The optional separate `viewer/` exposes three fixed native oRPC procedures over `bus_run_query`, backed by an explicit application-owned Effect runtime boundary, not an Effect-oRPC provider package. Its trust and observation rules are in [viewer](docs/architecture/viewer.md). For HTTP API work, follow the `orpc` and `effect-orpc` ownership gates where installed; confirm the exact native lane and any actual provider profile before writing code rather than assuming bridge compatibility.

## Git and Graphite

Graphite owns branch navigation and lifecycle, commits, stack topology, PR submission, merging and synchronization. Before this work, load the installed core `dev:graphite` skill (also exposed as `graphite`) from the available skill catalogue, then its relevant command, workflow and worktree references. It supplies generic guidance; this section owns repository policy. Confirm flags with `gt <command> --help`. Do not vendor the skill or patch its installed cache.

Develop in a dedicated worktree of the single canonical repository, under the shared `DEV/worktrees` root with an agent/project/purpose name; do not create per-project worktree roots or extra coordination clones. The primary checkout is live `serve`, hook and plugin source: keep it clean and detached at the exact approved deployed commit, never edit or switch it for development. This leaves `main` free for Graphite without activating source. Updating the deployed commit is an owner-controlled [deployment](docs/runbooks/deploy.md). Graphite metadata is shared across worktrees. Check whether the clone is initialized before running `gt ls`, which can initialize an uninitialized clone; use `gt init --trunk main` for deliberate first setup. Initialization and branch tracking change metadata, not deployed source. Do not reinitialize an existing repository or reset its metadata to fix an ordinary stack problem.

- **Inspect scope first:** `git status --short --branch`, `git worktree list --porcelain`, `gt ls` and `gt trunk`. Check affected branches' ownership and dirty state before mutations. Independent work starts from `main`; dependent branches stack on their actual source dependency. Keep one coherent change per branch, with readable commits; a checkpoint or review correction need not create another branch.
- **Create and commit through Graphite:** use `gt create <branch> --onto <parent>` in the development worktree. Import an existing branch with `gt track <branch> --parent <parent>`. Stage only intended files with `git add`, run `bun run check`, then use `gt modify --commit -m "type(scope): change"`. `gt modify` automatically restacks descendants, even when adding a commit: inspect and coordinate their ownership first.
- **Keep topology scoped:** use native `gt move`, `gt reorder`, `gt fold` or `gt split` when the change needs them. Restack only your affected scope with `gt restack --upstack` or `--only`; coordinate branches owned by another agent, including those checked out elsewhere. Resolve Graphite conflicts, stage resolutions, then `gt continue`; use `gt abort` to abandon that operation.
- **Publish through Graphite:** include `--ai` on every submission. Use `gt submit --stack --ai` for affected stacks, adding `--draft` for draft PRs or `--update-only` for existing PRs. Inspect `--dry-run` when scope is uncertain; preserve hooks and normal lease protection. Use `gt merge` for the intended trunk-to-current PR sequence and verify every PR actually merged before cleanup.
- **Coordinate synchronization:** use `gt sync --no-restack` in parallel workflows, then let each owner restack their affected branches. Before submit, sync or get, verify the live primary is detached at its approved deployed commit: even a submit dry run can advance local trunk. These commands can also clean up merged or closed branches, so coordinate affected ownership. They are not deployment primitives: the [deploy runbook](docs/runbooks/deploy.md#deploy-a-new-version) activates an exact reviewed commit with fast-forward-only refusal. Never rewrite or remove another owner's stack or worktree as incidental cleanup.

Git remains available for inspection, staging, worktree mechanics and plumbing that does not change tracked branch history or Graphite metadata, plus explicit Graphite-directed conflict recovery and the deployment runbook's pinned activation, rollback and recovery. Do not use `git commit`, `git push`, `git rebase` or `git merge` as ordinary substitutes for Graphite. Finish with a clean, committed worktree and verify the resulting stack.

## Invariants

- Storage goes through the `Ledger` service; change notifications only wake readers, and reading from a cursor decides delivery. A cursor advances only after a complete read.
- Fluree features follow the docs of the installed version (`fluree docs search`, `fluree docs get`), which are version-exact. Run `bun run qualify:fluree` after upgrading Fluree. Team Fluree Runtime advises on server topology, Team Fluree Platform on search and other capabilities.
- One `agent-bus serve` per machine is the only process that reads or writes the store for that machine's sessions. It writes the cursors of the peers that joined from its machine, and serializes joins, leaves, reads and deliveries per address through `Bus.deliver`.
- The servers listen on loopback. Keep Fluree's data and admin APIs behind the token and `serve` behind its Host check. Queries go only through `QueryGateway`: pinned to one commit, SELECT-only for raw SPARQL, and never claiming completeness past a cap or unchecked damage ([connections](docs/architecture/connections.md#rules)).
- Never put credentials or raw tool responses in messages, logs or the ledger.

## Project memory

Decisions (with rationale and the alternatives rejected), constraints and costly traps live in Fluree memory, committed as `.fluree-memory/repo.ttl`. Recall before substantial work, from this checkout:

```sh
fluree --config .fluree/config.toml memory recall "specific keywords" --limit 5
```

When a decision, constraint or trap changes, `update` its memory instead of adding another; record new ones with `memory add --scope repo` and the right kind (`decision` with `--rationale` and `--alternatives`, `constraint` with `--severity`, otherwise `fact`), lowercase tags and repo-relative `--refs`. Store only what code, docs and Git can't show, phrased to stay true at HEAD: no progress, status, commit hashes or session notes. The repository is public, so repo memories carry no machine names, home paths or personal details; keep those in your own user-scope store. `fluree memory audit --all` checks the store. `.fluree/` (local config and storage) is ignored; `fluree init` recreates it.

## Verification

`bun test` cannot detect type errors or discarded Effects. After each coherent edit batch, run `bun run check:fast` with the Bun pinned in `package.json`, resolve introduced failures, then continue. Put that Bun first on `PATH` in the command's shell: an absolute `bun run` invocation alone does not select it for nested package scripts.

Use the repository's domain stewards when their judgment is relevant, in both Codex and Claude. Canonical definitions live in `.codex/agents/`, with native Claude counterparts in `.claude/agents/`; select the named role and supply the task's outcome and context rather than copying its foundation into a generic agent. [Stewards](docs/runbooks/stewards.md) describes native invocation, available domains and maintenance.

Every lane touching code and writing tests invokes `agent-bus-testing-design-steward` early enough to shape meaningful coverage, and re-engages it when material assumptions or implementation change. Implementation owns production decisions and integrated checks; resolve findings or explicitly decline them with a reason, not a second approval chain. Invocation is not itself qualification or adoption.

Tests and qualifiers clean up after themselves however they end. A long-lived child they start, such as a throwaway Fluree server, runs through `spawnSupervised` (`test/supervised.ts`): once its parent process has ended by any means, SIGKILL and harness timeouts included, its running supervisor sends it SIGTERM and, after a five-second grace period, SIGKILL. The child's own descendants are not tracked, and a supervisor killed alone orphans its child. `test/supervised.test.ts` checks this; route any new long-lived child through it rather than relying on `afterAll` or `finally`. A test registers each process it spawns with `ownership()` (`test/processes.ts`) before awaiting anything from it, and a fixture that never exits on its own calls `exitWithParent()`. Never clear leftovers by pattern: signal only pids you started.

`bun run check` must pass before committing. It runs `typecheck`, `lint`, `test`, `check:docs` and `check:stewards`, each also a script of its own. `bun run lint:effect` (stricter Effect rules) and `bunx knip` (unused files, exports and dependencies) are advisory.

Nx schedules and caches the early loop; the mandatory full check remains uncached and does not require Nx. Typechecking uses the Effect-enhanced native compiler for all five project scopes. Effect errors, including floating Effects, block the check; warnings remain visible and advisory. The legacy TypeScript package supplies the JavaScript compiler API to tools such as Nx, not a fallback checker. Configuration or a running LSP alone is not evidence that an agent received useful diagnostics.

After compiler or lint-tool upgrades, run `bun run qualify:toolchain`. It checks the actual inherited configurations against stock and Effect-enhanced native compilers, valid and invalid controls, corrected code, and an upstream advisory rule without the retired patch. Its explicit executable paths run with no fallback tools on `PATH`; it is qualification, not another task scheduler.

Viewer changes use the [viewer verification lanes](docs/runbooks/viewer.md#verify-the-viewer): direct Bun pure tests for the tight loop, production-component Storybook plays for UI, native local Stagehand for representative connected journeys, and Nx for deterministic local check/build reuse. Never cache browser, integration, live-data or full qualification outcomes. The root tool launcher refuses dotenv before invocation and strips provider/cloud credentials; use the package commands rather than bypassing it. Browser tests have their own [instructions](tests/browser/AGENTS.md). Load the ignored local `agent-bus-workbench` skill where installed; it routes the actual workbench and upstream Browse skill, not the generic resource's older Stagehand API. No upstream skill cache is vendored or edited by this repository.

```sh
bun install                 # also clones the Effect source into .repos/effect
bun run check
bun run qualify:fluree      # after upgrading Fluree
bun src/bin.ts --help       # the CLI, from the checkout
```
