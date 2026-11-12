# Run the local viewer

Build, run, stop and recover the optional local browser viewer. Its observation and security rules are in [viewer](../architecture/viewer.md), its procedure contract and limits in [interfaces](../architecture/interfaces.md#viewer), and recovery of the existing bus in [recover](recover.md). This procedure never starts another `agent-bus serve` or changes a live checkout.

## Before you start

For a source build or a new viewer job, use a development checkout containing the viewer and the repository's pinned Bun. The existing machine's bus must already be running on loopback. Do not switch, edit or install dependencies in a retained primary checkout merely to try the viewer. Dependencies and builds belong in its dedicated development worktree. An existing owned viewer can move with a packaged release through [deploy](deploy.md#deploy-a-packaged-release), without rebuilding. That operation keeps its port, environment and logs; it does not install an absent viewer.

```sh
bun --version
bun --no-env-file install --frozen-lockfile --ignore-scripts
```

Expected: the pinned dependencies install without changing the lockfile. `--ignore-scripts` avoids unrelated preparation work; repository Effect source setup, if needed for contributor research, is a separate existing procedure. Do not disable a minimum-release-age policy to select a newer dependency. *Rehearsed 2026-11-01 in the isolated development worktree; lockfile unchanged.*

## Build and start

1. From the development checkout root, create the production artifacts. Do not rebuild over artifacts used by a running viewer; coordinate a deliberate stop and rebuild with its owner or use another suitable development checkout:

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

   Use an unused viewer port rather than stopping an unrelated process. When another process already holds the port on `127.0.0.1`, `0.0.0.0` or `[::]`, the viewer prints `Viewer port <port> is already in use on 127.0.0.1, 0.0.0.0 or [::]. Choose an unused port with AGENT_BUS_VIEWER_PORT.` and exits with status 1, leaving that process's traffic alone. The source entry is also available with `bun --no-env-file run viewer` after building assets. The outer `--no-env-file` matters: an ordinary `bun run` can load an environment file before a child command starts. This foreground command installs no service; a persistent viewer is an [optional operator choice](#run-as-a-user-launchagent). *Rehearsed 2026-11-01 with the cold compiled artifact and the actual local viewer; no bus service changed. The port refusal was rehearsed 2026-11-01 with the compiled artifact against a scratch holder on each address, which kept answering its own requests.*

3. Check actual data, not merely the HTML response. Wait for a successful independently timed history observation, choose an observed topic/address and read its context flow. Open a reply group and inspect each message's full Markdown/Source body, literal audience, reply reference and recorded origin. Cross-audience replies keep their actual recipients; unresolved targets remain explicit. Open Current peers and check its separate observation time. A successful zero-record response is valid; an unavailable region is not an empty success. The theme switch changes light/dark appearance without fetching messages. No send control or editable draft is available. *Checked read-only 2026-11-02:* a first-start compiled viewer on loopback against the installed bus showed nonempty history, context flow, full Source, literal audiences, theme change and independently observed peers in the native local browser. This checks operability, not customer adoption.

## Stop and rebuild

Use Control-C in the viewer terminal. Expected: it stops intake, interrupts active requests and awaits runtime cleanup without stopping the existing bus. Rebuild after browser-source changes, then restart the viewer; the product uses the same built assets in development and cold-artifact checks. *Rehearsed 2026-11-01 with the compiled artifact's SIGINT and SIGTERM handlers, clean exit and a rebuilt/restarted local viewer.*

## Run as a user LaunchAgent

This optional macOS procedure runs only the viewer, in the logged-in user's GUI domain. It does not outlive that domain, install the core bus, or make the viewer a standalone binary. Keep the approved Bun, the existing worktree and its complete `dist/viewer` artifact layout available and unchanged for the job's lifetime. Do not rebuild, reinstall, move or remove them under a running job. A dedicated installer is deferred until repeated installation warrants one. Foreground operation remains available for development.

The native bootstrap, attributed SIGTERM replacement, bootout and final bootstrap were observed on the running viewer on 2026-11-05; the core stayed up and the live browser lane proved message reading and peers. The plist writer below was not used in that operation, so this exact procedure remains *Unverified*. Stop on any unexpected result; retain the evidence and do not retry until green. If an owned job has started but fails qualification, boot out only that positively identified job to stop its KeepAlive attempts; if ownership is uncertain or bootout fails, stop and ask the owner. Do not stop a foreign process, change the core service, or run the core installer. Never print raw `launchctl` or `ps` environment output, environment values or raw tool responses.

1. For a new source-built job, in the logged-in user's shell, set `VIEWER_ROOT` to the absolute path of the retained artifact worktree, `VIEWER_CHECKOUT` to a current credential-free checkout with the live browser lane and its dependencies, and `VIEWER_BUN` to the absolute approved Bun executable. The verification checkout may differ from the artifact worktree. For an existing release-bound job, use [deploy](deploy.md#deploy-a-packaged-release), not this new-job writer. Do not build, install or mutate either checkout to run this check. Export the values for the plist writer, and check the approved Bun version and hash, the complete artifact layout and its hashes against the release receipt. Record the core bus PID, start time and health before proceeding ([operate](operate.md#check-that-the-bus-is-healthy)). Confirm the GUI domain exists, and that the viewer label, plist and port have no owner:

   ```sh
   export VIEWER_ROOT="/absolute/path/to/existing-worktree"
   export VIEWER_CHECKOUT="/absolute/path/to/current-verification-checkout"
   export VIEWER_BUN="/absolute/path/to/approved/bun"
   export VIEWER_LABEL=ai.rawr.agent-bus.viewer
   export VIEWER_PLIST="$HOME/Library/LaunchAgents/$VIEWER_LABEL.plist"
   export VIEWER_UID="$(id -u)"
   "$VIEWER_BUN" --version
   shasum -a 256 "$VIEWER_BUN"
   find "$VIEWER_ROOT/dist/viewer" -print
   find "$VIEWER_ROOT/dist/viewer" -type f -exec shasum -a 256 {} +
   launchctl print "gui/$VIEWER_UID" >/dev/null 2>&1
   launchctl print "gui/$VIEWER_UID/$VIEWER_LABEL" 2>&1 | awk '
     /^Could not find service / { print "state=absent"; found = 1 }
     $1 == "state" && $2 == "=" { print "state=present"; found = 1 }
     $1 == "pid" && $2 == "=" && $3 ~ /^[0-9]+$/ { print "pid=" $3; found = 1 }
     END { if (!found) print "state=unknown" }
   '
   test ! -e "$VIEWER_PLIST" && test ! -L "$VIEWER_PLIST"
   lsof -nP -iTCP:4317 -sTCP:LISTEN
   ```

   Expected: the approved executable and all built files match the receipt; the domain check succeeds; the exact label probe says `state=absent`; the plist test succeeds; and `lsof` finds no listener on any address (its no-match status is 1, not an inspection error). `state=unknown` or a probe error is not proof of absence. Confirm that both checkouts, executable and `dist/viewer/main.js` exist and that `~/.agent-bus` is an existing private directory owned by this user. An existing label, plist, listener or ambiguous inspection is a stop, not permission to replace it. For an intentional later change, first preserve and identify the previous *owned* job and plist for rollback; never adopt a foreign one.

2. Create the initial plist and private logs without overwriting existing files. The paths are passed as plist data, not shell code. `/usr/bin/python3` must be available; if it is not, stop rather than installing or substituting a runtime.

   ```sh
   (
   set -e
   /usr/bin/python3 - <<'PY'
   import os, plistlib
   home = os.environ['HOME']
   root, bun = os.environ['VIEWER_ROOT'], os.environ['VIEWER_BUN']
   if not (os.path.isabs(root) and os.path.isabs(bun)):
       raise SystemExit('worktree and Bun paths must be absolute')
   logs = [os.path.join(home, '.agent-bus', 'viewer.stdout.log'),
           os.path.join(home, '.agent-bus', 'viewer.stderr.log')]
   for path in logs:
       fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
       os.close(fd)
   job = {
       'Label': os.environ['VIEWER_LABEL'],
       'ProgramArguments': ['/usr/bin/env', '-i', f'HOME={home}',
           'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'AGENT_BUS_VIEWER_PORT=4317',
           'AGENT_BUS_PORT=8096', bun, '--no-env-file', os.path.join(root, 'dist/viewer/main.js')],
       'WorkingDirectory': root, 'RunAtLoad': True, 'KeepAlive': True,
       'ThrottleInterval': 10, 'Umask': 63,
       'StandardOutPath': logs[0], 'StandardErrorPath': logs[1],
   }
   fd = os.open(os.environ['VIEWER_PLIST'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
   with os.fdopen(fd, 'wb') as out:
       plistlib.dump(job, out)
   PY
   plutil -lint "$VIEWER_PLIST"
   launchctl bootstrap "gui/$VIEWER_UID" "$VIEWER_PLIST"
   )
   ```

   Expected: the plist and logs are private, lint succeeds and bootstrap starts the one owned viewer within 30 seconds. `env -i` is essential because the launchd domain may contain unrelated credentials. `ThrottleInterval` bounds restart frequency, not the total number of attempts. A partial write or bootstrap failure needs inspection, not automatic cleanup or repeated starts.

3. Verify the loaded label's PID is the approved Bun running the expected `dist/viewer/main.js` in the retained worktree, and is the sole `127.0.0.1:4317` listener. Compare the plist's exact native argument vector with step 2, including `/usr/bin/env -i` and its four assignments. This establishes the launch configuration and command contract, not a broad audit of the process environment. Compare the artifact hashes again. Confirm the unchanged core PID, start time and health. Inspect launchd's exact GUI-domain job only through an immediate strict filter; never emit unfiltered launchd or process environment output.

   ```sh
   launchctl print "gui/$VIEWER_UID/$VIEWER_LABEL" 2>/dev/null | awk '
     /^[[:space:]]*state = running$/ { state = $3 }
     /^[[:space:]]*pid = [0-9]+$/ { pid = $3 }
     END { if (state == "running" && pid ~ /^[0-9]+$/) {
       print "state=" state; print "pid=" pid
     } else exit 1 }
   '
   ```

   Set `VIEWER_PID` to the numeric PID from that result, then inspect the process, listener and configuration:

   ```sh
   ps -p "$VIEWER_PID" -o pid=,lstart=,comm=
   lsof -a -p "$VIEWER_PID" -d cwd
   lsof -nP -iTCP:4317 -sTCP:LISTEN
   /usr/bin/python3 - <<'PY'
   import os, plistlib
   try:
       with open(os.environ['VIEWER_PLIST'], 'rb') as source:
           job = plistlib.load(source)
       root, bun = os.environ['VIEWER_ROOT'], os.environ['VIEWER_BUN']
       expected = ['/usr/bin/env', '-i', f"HOME={os.environ['HOME']}",
           'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'AGENT_BUS_VIEWER_PORT=4317',
           'AGENT_BUS_PORT=8096', bun, '--no-env-file', os.path.join(root, 'dist/viewer/main.js')]
       matches = (job['Label'] == os.environ['VIEWER_LABEL']
           and job['ProgramArguments'] == expected and job['WorkingDirectory'] == root
           and job['RunAtLoad'] is True and job['KeepAlive'] is True
           and job['ThrottleInterval'] == 10 and job['Umask'] == 63)
   except (OSError, ValueError, KeyError):
       print('configuration=unavailable-or-mismatched')
       raise SystemExit(1)
   if not matches:
       print('configuration=unavailable-or-mismatched')
       raise SystemExit(1)
   print('configuration=matches')
   PY
   curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}\n' -H 'Host: foreign.invalid' http://127.0.0.1:4317/
   curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}\n' -H 'Origin: null' http://127.0.0.1:4317/
   curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}\n' -H 'Origin: https://foreign.invalid' http://127.0.0.1:4317/
   (cd "$VIEWER_CHECKOUT" && PATH="$(dirname "$VIEWER_BUN"):$PATH" "$VIEWER_BUN" --no-env-file run test:browser:live --url http://127.0.0.1:4317/)
   ```

   Expected: `ps` shows the approved Bun executable, the working directory is the retained worktree, the owned listener has that PID, and the configuration matches. Each foreign Host or Origin request returns 403. The real viewer reports actual history and peers observation metadata. The live browser receipt must have `historyObserved`, `messageReadingProved` and `peersObserved` true and `historyUnavailable` and `peersUnavailable` false; `passed` alone is insufficient. Run the browser lane from the current credential-free verification checkout through the existing tool launcher, not directly or against a synthetic endpoint.

4. Qualify recovery with only the positively identified owned PID. Set `VIEWER_PID` to that exact PID, send it one SIGTERM and verify within 30 seconds that the old PID is absent and launchd has replaced it with a different owned PID:

   ```sh
   kill -TERM "$VIEWER_PID"
   ```

   Repeat the identity, listener, launch-configuration, boundary and real-data checks from step 3. Then boot out the job:

   ```sh
   launchctl bootout "gui/$VIEWER_UID" "$VIEWER_PLIST"
   ```

   Verify within 30 seconds that the owned job, its process and listener are absent before bootstrapping the same plist once more:

   ```sh
   launchctl bootstrap "gui/$VIEWER_UID" "$VIEWER_PLIST"
   ```

   Verify startup within 30 seconds and repeat step 3; the final owned viewer remains running. At every boundary, confirm the core PID, start time and health are unchanged. Do not signal by name or kill a listener merely because it uses the port.

   To stop or roll back later, boot out only this verified owned job. If there was a prior owned configuration, restore its preserved plist and artifact binding and verify it before bootstrapping; the initial baseline above has no prior job. Never restore or remove a foreign job. If any stop or restore fails, leave its state explicit and use [recover](recover.md); do not repeatedly bootstrap it.

## Find and keep reading

1. Enter text and, optionally, an exact participant/address, then apply the search. Empty fields are absent; other whitespace and case remain literal. Apply opens all server result groups, not an intersection with the previously selected topic. Clear requests a fresh latest observation. Current peers can open an exact-address investigation when the address fits the input contract. Actual scope/time belongs to the displayed observation; a failed different search retains and labels previous criteria rather than claiming that old messages match. *Rehearsed 2026-11-01 against the synthetic endpoint; upstream arguments, failure scope and clear-to-latest checked.*
2. Automatic refresh is initially enabled. Pause stops scheduled observations, not manual Refresh. Hidden pages suppress scheduled work; resume or becoming visible requests once. History and peers fail/recover independently. Each observation shows the commit it was read at as "commit N" (the raw `t` is in its tooltip), and its window label says whether it holds all matching entries, all readable ones with a count of unreadable entries, the latest with older ones existing, or ranked matches. Read a conversation while the window changes: its reply tree is read again at each new commit, so it keeps entries the window dropped and gains new replies in place. Read a context flow while the window changes: if a displayed message would disappear, exactly one prior unit stays readable, frozen at its commit with its old criteria/time and a persistent outside-current-observation indicator. A conversation whose tree comes back from another ledger incarnation is frozen the same way. A retained unit is never merged into the current list. Select a context/conversation or use Read context to accept the current unit and start it at the top; ordinary Refresh does not discard the retained reading. Reload starts fresh criteria/pause state and does not recover it. *Rehearsed 2026-11-01 with the native browser's controlled production timer, including overlap, independent peers, pause, visibility, manual counts, a conversation followed to a new commit and flow eviction, focus, absolute/relative reading position, visible retained-state cue and explicit acceptance at scroll position zero; the synthetic endpoint speaks `bus_run_query` and keeps every entry behind its windows.*

## Open a pinned investigation

1. Open the link the agent gave you in the browser that reaches the viewer. Its fragment, `#investigation=…`, carries the agent's reference; nothing else in the address changes. The reference names evidence, not a machine: a compatible deployed viewer whose bus reads the same ledger incarnation can open it. If the address does not reach a viewer from your browser, keep the fragment and open it on one that does, then check that the ledger shown is the one the agent reported. The screen shows that reference's ledger, commit, catalogue version, participants and window before anything is read, then the page being read and the entries as they arrive, in the bus's order with their commits.
2. Read the status line before the entries. "Complete" means the bus reached the end of the window at that commit with nothing unreadable and nothing omitted. Any other line says why the reading stopped, and the entries shown are then only the start of the window, labelled partial with their counts; nothing is claimed about the rest. "Waiting" means the viewer is temporarily too busy to admit the page: another investigation page, a cancelled one whose handler has not yet settled, or live reads holding every slot. The page is retried by itself.
3. Cancel stops the reading and keeps what arrived, labelled as cancelled. Read again starts over from the first page. To read less, enter another From or To (exclusive) as a UTC instant and read that window; it opens as a link of its own at the same commit. The live viewer link in the header returns to live reading.

## Verify the viewer

Use the smallest relevant lane during development, then the full uncached check at the story boundary. Except for the explicitly opt-in live check below, the browser and workbench commands use synthetic data, not the running bus. Browsers use fresh temporary profiles. Their launcher refuses root dotenv names before invoking tools, allowlists inherited environment without provider credentials, disables telemetry/cloud and binds owned servers to loopback. Do not run these tools directly to bypass that boundary.

1. Check pure projection, conversation, Markdown-policy, resource and announcement behavior:

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

   Expected: the runner owns an ephemeral static server and fresh local Stagehand browsers, reports actual successful play phases, and closes them. A static build alone does not execute plays. Render-only and deliberately failing internal harness-oracle stories must be rejected when explicitly selected. For interactive component work, `bun --no-env-file run storybook` uses the fixed local development port and refuses a collision rather than taking another owner's server. Stop it with Control-C. *Build and twenty-two positive plays rehearsed 2026-11-01, including the App's empty, all-omitted, unavailable, timed-out, failed-refresh, arrival, followed-conversation, retained flow, replaced-ledger, older-entries/damage/moved-head, retained caveats, tree kept under its own criteria until explicitly accepted, earlier-commit freeze, selected message beyond the tree read, a withheld presence inside a tree and stopped states; real failure and no-play oracles correctly refused. Interactive local startup, a native exact-search play against that dev server and owned shutdown also rehearsed.*

3. Build and check connected production journeys:

   ```sh
   bun --no-env-file run nx run agent-bus:viewer-build
   bun --no-env-file run test:browser
   bun --no-env-file run test:browser:investigation
   bun --no-env-file run test:browser:pinned
   ```

   Expected: native Stagehand exercises the compiled viewer against a synthetic public endpoint, checks actual viewport, context/reply navigation, safe Markdown/theme and mobile focus, then closes its owned viewer, endpoint and browsers. The investigation lane adds real submitted arguments and refresh/failure/reading-continuity behavior. Its test-only clock intercepts the production interval instead of waiting through wall-clock delays; pure scheduler tests separately prove that interval. Browser and integration targets are uncached. This does not prove the existing bus's present availability. *Rehearsed 2026-11-01 for the initial three journeys and the separate investigation lane; current combined regression qualification is recorded at release closure.* The pinned lane opens a pinned investigation by link, refuses malformed and backward references without a read, cancels during the second page and checks the partial label and that the held upstream request ended, then reads again to completion with every page at the reference's commit. With `--capture-dir` set to a private absolute path outside the repository, it saves light, dark and 320-pixel screenshots of the cancelled and complete screens for a person to inspect; the narrow check is a resized desktop browser, not a device. It does not exercise busy, which the host and traversal tests cover, or what a real store holds. *Rehearsed 2026-11-04 with the screenshots inspected.*

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

   Expected: all core/storage, viewer, tooling and docs checks run, with no Nx wrapper or cached aggregate. Select the already qualified storage test tool explicitly when the shell has an older binary, as described below. Do not drop storage tests to make a UI loop faster. *Rehearsed 2026-11-01; 430 tests, types, lint and documentation passed, on a branch and on a detached HEAD.*

## If it fails

- **No startup URL:** `Viewer port … is already in use` means another process holds that port on `127.0.0.1`, `0.0.0.0` or `[::]`: choose another with `AGENT_BUS_VIEWER_PORT` rather than stopping it. Otherwise check that the production build exists and the configured ports are integers in range, and rebuild from the same checkout. Startup errors deliberately omit paths and raw diagnostics.
- **Request refused:** use the exact printed `127.0.0.1` URL and port. Foreign/`null` Origin, a different Host and unsupported methods are refused; do not add permissive CORS or expose it on a network interface to work around this.
- **History or peers unavailable:** the viewer may be up while the bus or store is not. Check the existing bus with [operate](operate.md), then [recover](recover.md). Confirm `AGENT_BUS_PORT` points at the existing machine's endpoint. The viewer requires the selected stateless MCP revision; no fallback, inbox read or direct store query is a recovery path.
- **Some records omitted:** malformed records and duplicate identities are quarantined. Inspect the valid observation and its explicit omission count; do not read a short or all-omitted result as a complete archive or no historical messages.
- **Large or slow observation:** request bodies, input lengths, history/peer counts, MCP bytes, concurrency and time are bounded under [interfaces](../architecture/interfaces.md#viewer). A response over a bound fails rather than truncating message text. Do not remove a bound or increase arbitrary tool access as recovery.
- **Text search misses older content:** follow the [known Fluree limits](../platforms/fluree.md#full-text-search). Do not infer that a historical message never existed, start a second server or reindex production as a viewer repair.
- **Contributor full check fails at Fluree search:** verify which Fluree binary the test process selects. The [platform findings](../platforms/fluree.md#full-text-search) distinguish the qualified tool from older local behavior. Do not skip Fluree or merely increase a timeout to conceal an empty result.
- **Tool refused before startup:** the isolated development checkout contains root dotenv names. Keep credential files in their actual owning environment; use a separate credential-free development checkout. Do not print, move or delete somebody else's files. The task dotenv switch alone does not prevent the parent tool from reading them.
- **Pinned reference refused:** the link's fragment is not a reference in the form the bus returns, or asks for presence kinds or backward order, which the viewer does not read. Nothing was read. Ask the agent for the link again from its forward message `history` result; do not edit the fragment by hand.
- **Pinned investigation stopped:** the status names the reason. At the 200-entry bound, narrow the window. Unreadable entries or records the viewer omitted stop the reading where they were met; report them with the reference rather than reading the partial entries as the window. "Too large" means the reference with a continuation would not fit the request body: ask for one with fewer participants. A different ledger, commit or set of criteria means the bus no longer answers for that reference, for example after a store was replaced. A page that does not answer within 12 seconds, or a bus that cannot be reached, stops it like any other read: check the bus, then read again.
- **Pinned investigation keeps waiting:** the viewer admits one investigation page at a time and only while a host slot is free, and a cancelled page holds its place until its handler settles. Another investigation tab, or many live viewers reading at once, can keep it waiting; closing other investigation tabs is one remedy. Do not raise the limits.
- **The viewer stopped:** an observation broke a display invariant, so the viewer replaced itself with an alert rather than a blank or partial page. Reload. If the same observation stops it again, keep the page's time and the history criteria and report it; the cause is deliberately not displayed, and the bus is unaffected.
- **Workbench build succeeds but plays fail:** inspect the native play verdict, rendered error and selected story. No-play, native exception and timeout are failures even if a terminal success event follows, and a story's first play on load is judged as well as its replay. Rebuild after story/config changes; do not replace this check with screenshots or build-only success.
- **The play check stops without a verdict:** its last line names the story and step, seconds in that step, a bounded classification of the error (its class, a library timeout's method and limit, or one of the runner's own constant assertion labels) and any signal received, never arbitrary error, page or tool text. An `open` or `first render` stop within a second of a fresh browser, with no signal, may match the transport failure tracked in [agent-bus#37](https://github.com/rawr-ai/agent-bus/issues/37), in which Stagehand loses its browser connection, but timing and step alone do not diagnose it: classify it so only when the retained diagnostics and Stagehand's sanitized drop record support that, and otherwise leave the cause open. To get the drop record, run with `--cdp-log` (`bun --no-env-file scripts/local-tool.ts storybook-plays --cdp-log`); every normal browser close also appears there. Report the stopped run with the others; do not retry until green.
- **A browser lane is unexpectedly slow:** inspect the bounded failing selector/play, startup and exact viewport separately. The normal representative lane is not a three-minute qualification job. Do not add sleeps, cloud/model fallback or global process cleanup. Close only the named owned session or process; preserve the user's browsers.

Public hosting and core deployment are outside this runbook. Return to the owner for those decisions rather than expanding a local-viewer procedure.
