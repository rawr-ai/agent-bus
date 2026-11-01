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

## If it fails

- **No startup URL:** check that the production build exists, the configured ports are integers in range and the viewer port is unused. Rebuild from the same checkout. Startup errors deliberately omit paths and raw diagnostics.
- **Request refused:** use the exact printed `127.0.0.1` URL and port. Foreign/`null` Origin, a different Host and unsupported methods are refused; do not add permissive CORS or expose it on a network interface to work around this.
- **History or peers unavailable:** the viewer may be up while the bus or store is not. Check the existing bus with [operate](operate.md), then [recover](recover.md). Confirm `AGENT_BUS_PORT` points at the existing machine's endpoint. The viewer requires the selected stateless MCP revision; no fallback, inbox read or direct store query is a recovery path.
- **Some records omitted:** malformed records and duplicate identities are quarantined. Inspect the valid observation and its explicit omission count; do not read a short or all-omitted result as a complete archive or no historical messages.
- **Large or slow observation:** request bodies, input lengths, history/peer counts, MCP bytes, concurrency and time are bounded under [interfaces](../architecture/interfaces.md#viewer). A response over a bound fails rather than truncating message text. Do not remove a bound or increase arbitrary tool access as recovery.
- **Text search misses older content:** follow the [known Fluree limits](../platforms/fluree.md#full-text-search). Do not infer that a historical message never existed, start a second server or reindex production as a viewer repair.
- **Contributor full check fails at Fluree search:** verify which Fluree binary the test process selects. The [platform findings](../platforms/fluree.md#full-text-search) distinguish the qualified tool from older local behavior. Do not skip Fluree or merely increase a timeout to conceal an empty result.

Public hosting, core deployment and persistent installation are outside this runbook. Return to the owner for those decisions rather than expanding a local-viewer procedure.
