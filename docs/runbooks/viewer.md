# Run the local viewer

Build, run, stop and recover the optional local browser viewer. Its observation and security rules are in [viewer](../architecture/viewer.md), its procedure contract and limits in [interfaces](../architecture/interfaces.md#viewer), and recovery of the existing bus in [recover](recover.md). This procedure never starts another `agent-bus serve` or changes a live checkout.

## Before you start

Use a development checkout containing the viewer and the repository's pinned Bun. The existing machine's bus must already be running on loopback. Do not switch, edit or install dependencies in a live primary checkout merely to try the viewer. Dependencies and builds belong in its dedicated development worktree.

```sh
bun --version
bun --no-env-file install --frozen-lockfile --ignore-scripts
```

Expected: the pinned dependencies install without changing the lockfile. `--ignore-scripts` avoids unrelated preparation work; repository Effect source setup, if needed for contributor research, is a separate existing procedure. Do not disable a minimum-release-age policy to select a newer dependency. *Rehearsed 2026-11-01 in the isolated development worktree; lockfile unchanged.*

## Build and start

1. From the development checkout root, create the production artifacts:

   ```sh
   bun --no-env-file run viewer:build
   ```

   Expected: `dist/viewer/main.js`, browser assets and their manifest are built; the browser graph contains no core/server runtime imports. No source maps or environment values are embedded. *Rehearsed 2026-11-01; production build and browser graph check passed.*

2. Run the built server, keeping this terminal open:

   ```sh
   bun --no-env-file dist/viewer/main.js
   ```

   Expected: it prints the local URL, normally `http://127.0.0.1:4317/`. Open that exact URL, not `localhost`, a LAN address or a different port. Existing bus port defaults to `8096`; explicit port settings are server-owned:

   ```sh
   AGENT_BUS_VIEWER_PORT=4318 AGENT_BUS_PORT=8096 bun --no-env-file dist/viewer/main.js
   ```

   Use an unused viewer port rather than stopping an unrelated process. The source entry is also available with `bun --no-env-file run viewer` after building assets. The outer `--no-env-file` matters: an ordinary `bun run` can load an environment file before a child command starts. No LaunchAgent or persistent service is installed. *Rehearsed 2026-11-01 with the cold compiled artifact and the actual local viewer; no bus service changed.*

3. Check actual data, not merely the HTML response. Wait for a successful independently timed history observation, choose an observed topic/address and read its context flow. Open a reply group and inspect each message's full Markdown/Source body, literal audience, reply reference and recorded origin. Cross-audience replies keep their actual recipients; unresolved targets remain explicit. Open Current peers and check its separate observation time. A successful zero-record response is valid; an unavailable region is not an empty success. The theme switch changes light/dark appearance without fetching messages. No send control or editable draft is available. *Checked read-only 2026-11-01: successful history, observed context flow, full unclamped Source, literal audiences, theme change and separately observed peers passed in the native local browser.*

## Stop and rebuild

Use Control-C in the viewer terminal. Expected: it stops intake, interrupts active requests and awaits runtime cleanup without stopping the existing bus. Rebuild after browser-source changes, then restart the viewer; the product uses the same built assets in development and cold-artifact checks. *Rehearsed 2026-11-01 with the compiled artifact's SIGINT and SIGTERM handlers, clean exit and a rebuilt/restarted local viewer.*

## Find and keep reading

1. Enter text and, optionally, an exact participant/address, then apply the search. Empty fields are absent; other whitespace and case remain literal. Apply opens all server result groups, not an intersection with the previously selected topic. Clear requests a fresh latest observation. Current peers can open an exact-address investigation when the address fits the input contract. Actual scope/time belongs to the displayed observation; a failed different search retains and labels previous criteria rather than claiming that old messages match. *Rehearsed 2026-11-01 against the synthetic endpoint; upstream arguments, failure scope and clear-to-latest checked.*
2. Automatic refresh is initially enabled. Pause stops scheduled observations, not manual Refresh. Hidden pages suppress scheduled work; resume or becoming visible requests once. History and peers fail/recover independently. Read a conversation or context flow while the window changes: if a displayed message would disappear, exactly one prior unit stays readable with its old criteria/time and a persistent outside-current-observation indicator. It is never merged into the current list. Select a context/conversation or use Read context to accept the current unit and start it at the top; ordinary Refresh does not discard the retained reading. Reload starts fresh criteria/pause state and does not recover it. *Rehearsed 2026-11-01 with the native browser's controlled production timer, including overlap, independent peers, pause, visibility, manual counts, conversation and flow eviction, focus, absolute/relative reading position, visible retained-state cue and explicit acceptance at scroll position zero.*

## Verify the viewer

Use the smallest relevant lane during development, then the full uncached check at the story boundary. The browser and workbench commands below use synthetic data, not the running bus, credentials or a user's browser profile. Their launcher refuses root dotenv names before invoking tools, allowlists inherited environment, disables telemetry/cloud and binds owned servers to loopback. Do not run these tools directly to bypass that boundary.

1. Check pure projection, conversation, Markdown-policy and resource behavior:

   ```sh
   bun --no-env-file run test:viewer:unit
   bun --no-env-file run check:fast
   ```

   Expected: direct focused Bun tests run first; the second command runs locally cached types, lint and pure tests. A cache hit is reuse of a deterministic check, not a new browser or live observation. Direct tests remain useful when they cost less than Nx startup. *Rehearsed 2026-11-01; fresh execution and three unchanged local cache hits checked.*

2. Build the component workbench, then execute its authored plays:

   ```sh
   bun --no-env-file run nx run agent-bus:storybook-build
   bun --no-env-file run test:storybook
   ```

   Expected: the runner owns an ephemeral static server and fresh local Stagehand browsers, reports actual successful play phases, and closes them. A static build alone does not execute plays. Render-only and deliberately failing internal harness-oracle stories must be rejected when explicitly selected. For interactive component work, `bun --no-env-file run storybook` uses the fixed local development port and refuses a collision rather than taking another owner's server. Stop it with Control-C. *Build and eight positive plays rehearsed 2026-11-01; real failure and no-play oracles correctly refused. Interactive local startup, a native exact-search play against that dev server and owned shutdown also rehearsed.*

3. Build and check connected production journeys:

   ```sh
   bun --no-env-file run nx run agent-bus:viewer-build
   bun --no-env-file run test:browser
   bun --no-env-file run test:browser:investigation
   ```

   Expected: native Stagehand exercises the compiled viewer against a synthetic public endpoint, checks actual viewport, context/reply navigation, safe Markdown/theme and mobile focus, then closes its owned viewer, endpoint and browsers. The investigation lane adds real submitted arguments and refresh/failure/reading-continuity behavior. Its test-only clock intercepts the production interval instead of waiting through wall-clock delays; pure scheduler tests separately prove that interval. Browser and integration targets are uncached. This does not prove the existing bus's present availability. *Rehearsed 2026-11-01 for the initial three journeys and the separate investigation lane; current combined regression qualification is recorded at release closure.*

   To check the already running real viewer explicitly, use `bun --no-env-file run test:browser:live --url http://127.0.0.1:4317/`. It emits only structural flags/counts, not message content, and does not start or stop the existing viewer or bus. Successful empty history is labeled as not proving message reading; unavailable history fails. *Checked read-only 2026-11-01; actual context/body/audience/theme and independent peer observation passed.*

4. Qualify cache behavior after changing task inputs, outputs or tool identity:

   ```sh
   bun --no-env-file run qualify:viewer-cache
   ```

   Expected: a disposable source copy demonstrates misses, hits, byte-for-byte artifact restoration, relevant-change failures, independent reuse, affected-project selection and dotenv refusal. It deletes only its own temporary copy. A single root project has coarse affected selection; target inputs decide reuse. *Rehearsed 2026-11-01 on disposable source; all initial cache experiments passed.*

5. At completion, run the existing full check and actual local-data reading step above:

   ```sh
   bun --no-env-file run check
   ```

   Expected: all core/storage, viewer, tooling and docs checks run, with no Nx wrapper or cached aggregate. Select the already qualified storage test tool explicitly when the shell has an older binary, as described below. Do not drop storage tests to make a UI loop faster. *Rehearsed 2026-11-01; 427 tests, types, lint and documentation passed using the qualified test tool, with later explicit-navigation changes checked by types and the native browser lane.*

## If it fails

- **No startup URL:** check that the production build exists, the configured ports are integers in range and the viewer port is unused. Rebuild from the same checkout. Startup errors deliberately omit paths and raw diagnostics.
- **Request refused:** use the exact printed `127.0.0.1` URL and port. Foreign/`null` Origin, a different Host and unsupported methods are refused; do not add permissive CORS or expose it on a network interface to work around this.
- **History or peers unavailable:** the viewer may be up while the bus or store is not. Check the existing bus with [operate](operate.md), then [recover](recover.md). Confirm `AGENT_BUS_PORT` points at the existing machine's endpoint. The viewer requires the selected stateless MCP revision; no fallback, inbox read or direct store query is a recovery path.
- **Some records omitted:** malformed records and duplicate identities are quarantined. Inspect the valid observation and its explicit omission count; do not read a short or all-omitted result as a complete archive or no historical messages.
- **Large or slow observation:** request bodies, input lengths, history/peer counts, MCP bytes, concurrency and time are bounded under [interfaces](../architecture/interfaces.md#viewer). A response over a bound fails rather than truncating message text. Do not remove a bound or increase arbitrary tool access as recovery.
- **Text search misses older content:** follow the [known Fluree limits](../platforms/fluree.md#full-text-search). Do not infer that a historical message never existed, start a second server or reindex production as a viewer repair.
- **Contributor full check fails at Fluree search:** verify which Fluree binary the test process selects. The [platform findings](../platforms/fluree.md#full-text-search) distinguish the qualified tool from older local behavior. Do not skip Fluree or merely increase a timeout to conceal an empty result.
- **Tool refused before startup:** the isolated development checkout contains root dotenv names. Keep credential files in their actual owning environment; use a separate credential-free development checkout. Do not print, move or delete somebody else's files. The task dotenv switch alone does not prevent the parent tool from reading them.
- **Workbench build succeeds but plays fail:** inspect the native play verdict, rendered error and selected story. No-play, native exception and timeout are failures even if a terminal success event follows. Rebuild after story/config changes; do not replace this check with screenshots or build-only success.
- **A browser lane is unexpectedly slow:** inspect the bounded failing selector/play, startup and exact viewport separately. The normal representative lane is not a three-minute qualification job. Do not add sleeps, cloud/model fallback or global process cleanup. Close only the named owned session or process; preserve the user's browsers.

Public hosting, core deployment and persistent installation are outside this runbook. Return to the owner for those decisions rather than expanding a local-viewer procedure.
