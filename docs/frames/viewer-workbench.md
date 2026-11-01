# Frame: viewer workbench and fast verification

This frame records the viewer's verification-harness change. Product work remains in the [viewer release frame](agent-bus-viewer-release.md); current commands belong to the [viewer runbook](../runbooks/viewer.md).

Opened 2026-11-01 after the owner required Stagehand for browser testing, Storybook for UI testing, Nx for caching, and substantial reuse from OPA. This is a Tier 3 harness change inside the accepted viewer workstream, not permission to change core deployment, networking or storage.

## Decision

Use three separate evidence lanes. Pure model and contract tests remain direct Bun tests. Storybook imports production React components with fixed synthetic state and executes authored interactions. A few deterministic native Stagehand journeys exercise the compiled viewer and synthetic public MCP endpoint. Static workbench builds, authored plays, rendered visual review and real-bus observations prove different things; none substitutes for another.

OPA's actual adopted workbench and browser patterns are the source of the Storybook/Stagehand design. Its cache frame records an isolated Nx experiment, not production adoption. Borrow its explicit input/output ownership and invalidation experiments, not an invented deployed Nx graph. Keep the existing single package, Bun runner and production build; no framework generator, workspace conversion, cloud cache or provider integration is needed.

The qualification candidate pins Stagehand 4.3.0, Storybook and its React-Vite renderer 10.6.3, Vite 7.3.1 and Nx 24.0.2. Existing release-age policy admitted these packages. Upstream Browse CLI and its bundled skill are installed globally for agent-led exploration; project-specific routing stays in an ignored local skill. Do not vendor upstream skills or treat the older installed Stagehand v3 resource as authority for the v4 API.

## Discrete Gates

1. **Own the lanes:** extract the real App behind a typed injected client; separate bootstrap from stories; add synthetic component states and native play verdicts. Terra owns composition, Sol owns the deterministic browser runner, programme lead owns tool/config integration.
2. **Prove execution:** build the production viewer and workbench; execute selected plays and representative desktop/mobile journeys. Refuse missing plays, false wait results, native errors, wrong viewports, cloud/model fallback and unowned browser profiles. Close each owned browser/server on success and failure.
3. **Prove reuse:** inspect the resolved Nx targets, measure direct/cold/warm runs, restore owned build outputs and falsify hashes with relevant changes in disposable source. Cache no integration, browser, live-bus or full qualification result. Keep tiny direct tests where Nx invocation costs more than their execution.
4. **Close the story:** qualify context-first reading, dark mode and safe Markdown through these lanes; run the full uncached repository check with the explicitly selected qualified storage test tool. Record timings, limitations, current commands and a clean Graphite commit. Search and reliable automatic refresh remain subsequent first-release stories.

## Environment And Performance

No browser or workbench receives real bus fixtures, account state or provider credentials. Browser tests use fresh isolated local Chrome and native Stagehand control without inference. Only explicit loopback destinations are admitted. No Tailscale publication or deployment is part of this change.

Nx's CLI reads root dotenv before its task-level dotenv switch. The application-owned launcher refuses root dotenv names before invoking either tool and passes a small allowlisted environment. Storybook also disables Vite dotenv loading. A switch alone is not a no-env guarantee. Never relocate, print or delete user credential files to make a tool run.

Performance budgets are investigation triggers, not invented measurements: pure viewer tests should remain subsecond; a warm cached static check/build should complete near invocation cost; the representative local browser lane should complete within 30 seconds on this machine. Each browser wait has a smaller explicit deadline. A repeated three-minute normal run fails the harness expectation and requires diagnosis, not a larger timeout. First install and first static workbench build are measured separately. Full core/storage qualification remains distinct from the UI edit loop and is never hidden behind a cache hit.

## Qualification

The integrated production-component workbench executes five authored plays, including hostile/large Markdown, dark mobile rendering, cross-audience reading and keyboard navigation. Native channel qualification rejects an actual intentional play exception even when a later terminal event reports success; it also rejects a render-only story. Pure event-verdict tests protect ordering, timeout, wrong-story and failure-after-success behavior.

Actual checks found two useful defects rather than merely rendering screenshots: the initial Vite transform caused every story to throw despite terminal success, and a keyboard test asserted before the application's scheduled focus transition. Automatic JSX configuration and an awaited, unchanged focus assertion repaired those distinct causes. Render-only success was never accepted as UI proof. A rendered visual pass also found low-contrast small light-theme labels; the corrected token exceeds 5.17:1 on the selected surface while preserving the separate dark token.

An independent exact-model Sonnet high source review supported the omitted implicit root-Vite configuration risk and raised a lint/hash mismatch for ignored local skills. The workbench now uses a dedicated Vite config and inline PostCSS configuration; a disposable experiment proves throwing root Vite and PostCSS configs do not execute. Biome and Nx both exclude local Claude skills. The review's claim that the viewer imported core source was rejected after inspecting the actual dependency graph, not repaired as though it were true. Configured effort was requested, not independently attested by the backend.

Measured on the development machine, not promised as cross-machine benchmarks:

| Lane | Actual result | Elapsed |
| --- | --- | ---: |
| Focused viewer tests | 139 tests, 930 assertions | 95 ms |
| Fresh fast-check graph | Types, lint, pure tests | 8.4 s |
| Unchanged fast-check graph | Three local cache hits | 0.39 s |
| Connected native browser | Three synthetic journeys, clean owned shutdown | 3.29 s |
| Component plays | Five actual native play verdicts | About 10 s |
| Real negative play oracles | Both correctly refused | 2.28 s |
| Disposable Storybook build | Cold miss / warm hit / exact output restoration | 4.12 s / 0.34 s / 0.35 s |
| Full uncached repository tests | 412 tests, 3,187 assertions | 42.44 s, excluding types/lint |

All seventeen disposable cache experiments passed, including injected model failure, correct prior-result reuse, CSS independence, lock/schema invalidation, exact viewer and Storybook output restoration, coarse affected-project selection and pre-CLI dotenv refusal. The actual resolved graph has one root project; this is not a claim of fine-grained affected-project pruning. A cache hit is not live evidence. Direct tiny tests and the production Bun build remain available rather than forcing Nx startup onto every edit.

Full root/server/browser/workbench/browser-harness types, lint and 48 documentation pages passed. The full core/storage test run used only an explicit command-local qualified Fluree tool selection; no installed service or global tool changed. Production graph qualification excludes server, core and test-workbench code. Fresh native browsers and fixture servers close after each lane; one redundant overlapping browser run failed before a journey and remains an unproven startup/load cause, not a claimed fixed product bug. The final isolated supported command and an independent repeated connected run passed.

Current context reading, dark appearance and safe Markdown are the product story this harness admits. Search, automatic freshness and independent final rendered review remain first-release work, not silently removed by these receipts.

After the final production rebuild and parent-owned restart, the explicit native live check passed in 1.15 seconds: successful nonempty history, a real literal context flow, unclamped Source and audience DOM, actual theme change and separately observed peers. Only structural booleans/counts were retained. The linked programme thread was rechecked using a bounded record-evidence fallback; its latest handover-adoption closure explicitly leaves deployed bus behavior unchanged, so it does not change this viewer contract.

## Moved into current docs

- [x] Contract: no new public procedure; preserve the two read-only viewer procedures.
- [x] Rule: observation and production/browser dependency boundaries remain in the viewer reference.
- [x] Agent guidance: AGENTS routes the local workbench skill and verification lanes.
- [x] Platform claim: exact tool APIs are qualification evidence here, not a new external-platform guarantee.
- [x] Procedure: current commands and failure handling are in the viewer runbook.
