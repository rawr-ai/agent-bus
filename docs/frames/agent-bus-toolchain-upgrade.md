# Current Toolchain Upgrade

This release record covers the independent toolchain upgrade and its qualification, not the parked query, viewer feature or process work. Current runtime contracts and procedures live in [interfaces](../architecture/interfaces.md), [topology](../architecture/topology.md), [Bun](../platforms/bun.md), and the [runbooks](../runbooks/deploy.md).

## Decision and Scope

The owner accepted implementation on 2026-11-02; merge and paired activation remain separate, unapproved decisions. Start from trunk plus the native-steward prerequisite, upgrade and qualify that substrate first, then reconcile the preserved product stack and return to process ownership. A bump atop the entire pending stack would not independently qualify the substrate; replacing a shared Bun immediately would change the live service before proving it.

The selected cohort is Bun and types 1.4.4 (development executable 1.4.4+38afee6c8), Effect and platform packages 4.1.2, TypeScript 7.0.2 through the Effect-enhanced compiler 0.63.0, oRPC client and server 1.16.1, Biome 2.6.4 and advisory linteffect 0.1.0. An explicit TypeScript 6.0.2 compatibility alias supplies the JavaScript compiler API to Nx, not a fallback checker. Existing optional viewer code is part of source accounting, not approval to deploy a real-data viewer. Public SPARQL remains refused.

Outside this release: pending query and viewer features, topics and bulletin design, expanded process-lifetime ownership, a process registry, network isolation, a new browser framework, blanket dependency upgrades, a new packaging architecture and a custom LSP bridge. The original product and process work remains parked, not abandoned.

Reframe if a selected target cannot preserve a material bus or MCP contract without changing product architecture, if native compilation requires a separate workspace migration rather than a compatibility API, or if independent activation violates the no-interim-viewer boundary. Two successive compatibility expansions outside the named stack, or two qualification rounds suppressing rather than resolving the same discrepancy, require joint scope review.

## Implementation Evidence

- All five enhanced type projects passed after adding browser CSS ambient types. The launcher derives the native compiler version once; Nx owns its task graph and cache, while the full uncached check does not require Nx. Actual Nx project inspection resolved under the API alias. Warnings remain visible and advisory; floating Effects and errors block.
- The first integrated development check passed 444 tests / 3,548 assertions, types, Biome, 60 Markdown files and steward parity. A fresh cold-cache frozen install passed without an age exception, loaded native Effect and its Bun platform, and matched the installed upstream advisory rule bytes. These are development checks, not live activation.
- `qualify:toolchain` passed stock native type-error controls, typed Effect negative controls and corrections for all five inherited configurations, plus the upstream advisory rule. It also passed with an empty child `PATH`, excluding a hidden Node fallback. Configuration inheritance is real TypeScript `extends`; `--showConfig` omits plugin configuration and was not an adequate control source. The enhanced identity includes its own build suffix, distinct from stock TypeScript.
- Four official-client MCP regressions passed 67 assertions on the new stack: pending wait cancellation, session deletion with cursor preservation, result encoding and error bodies. They do not promise cancellation can undo an already-completed read.
- Effect vendor preparation verifies the installed version against the declared pin and exact tag commit, refuses dirty or unexpected-origin state, and updates an existing checkout. The 4.0.6 to 4.1.2 update and idempotent rerun passed.
- The installer writes one managed launcher for the exact Bun and source entry; the same launcher serves the CLI, hook and `serve`. Its narrow runtime-only mode changes neither Fluree, tunnel nor credentials. Fourteen focused fixture tests with 101 assertions passed, including the real manifest hook command under a decoy `PATH`; launchd and a real wake have not been rehearsed.
- The Bun TOML literal oracle passed, and seven renderer tests with 106 assertions included ninth-role parity. The parser change and its effect on generated adapters are recorded in [Bun](../platforms/bun.md). Biome's Markdown formatter is disabled to preserve frozen history and generated frontmatter; the docs checker remains responsible for documentation.
- A separate native-bench prerequisite passed 425 tests and 3,373 assertions on Bun 1.3.14. It is not qualification of the new cohort.
- The owner additionally requested an enduring simplicity steward. Native steward-designer authorship, independent prompt review and a real native simplicity source commission produced its checked-in Codex and Claude definitions. It is a principal partner, not another scheduler, audit gate or mandatory reviewer; the typecheck commission retained the small launcher and removed redundant identity preflight.

## Remaining Qualification and Activation

The exact final-candidate mandatory recheck, real-agent consumption trials, Nx cache invalidation, viewer and Storybook builds and browser lanes, remaining oRPC behavior, disposable Fluree adapter, CLI startup, crossing old/new wake clients, launchd rehearsal and bounded long-poll soak remain to be completed. Record actual outcomes and resource cleanup; no current result establishes universal stability or another platform's process behavior.

Before activation, review the exact merged commit and tree, source delta from each deployed checkout, dependencies, selected executable and previous runtime on each machine. Verify the exact `serve` surface excludes the separate viewer entrypoint. Qualify launcher identity, minimal-environment hook and crossing-client behavior, then obtain a separate activation decision. After approval, verify both machines' source, runtime, dependencies and running entrypoints, containment, delivery and a real Claude wake on each. Rollback restores source, locked dependencies, runtime binding and `serve`; a source-only rollback is incomplete. No activation or service change has been performed by this release record.

## Moved into current docs

| Facet | Disposition |
| --- | --- |
| Contract | Launcher and installer contract in [interfaces](../architecture/interfaces.md); no MCP tool contract changed. |
| Rule | Runtime binding in [topology](../architecture/topology.md). |
| Agent guidance | No bus-user skill change required; contributor diagnostic guidance is separate. Actual agent consumption remains pending. |
| Platform claim | Development parser observation in [Bun](../platforms/bun.md); installed table remains unchanged pending activation. |
| Procedure | [Install](../runbooks/install.md), [deploy](../runbooks/deploy.md) and [upgrade](../runbooks/upgrade.md) updated; actual launchd, wake and rollback rehearsal remains pending. |
