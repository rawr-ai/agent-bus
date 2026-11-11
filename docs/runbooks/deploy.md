# Deploy

Use this to put a reviewed packaged release or source version into service, verify its bindings and roll back. Restarting alone is in [operate](operate.md); the first source install is in [install](install.md).

For end-to-end release ownership, commission the native `agent-bus-release-operations-steward` as described in [stewards](stewards.md#commission-release-operations). It covers readiness, integration and distribution as well as this runbook's activation, verification and recovery, through post-release communication and retirement.

## Before you start

The primary checkout stays clean and detached at its approved retained commit, never used for development. It supplies live code only in a source installation; a packaged installation runs immutable release files and retains the checkout for source rollback. Git/Graphite synchronization activates neither. Coordinate with the deployment owner before changing any installed binding, primary or shared branch metadata. Activation is single-operator.

A launcher change reaches a newly started hook immediately, but reaches `serve` only on restart; an already-waiting hook retains its loaded code and runtime until it rearms. Restarting `serve` loses its in-memory wake state and held search rankings (a search in progress must start again), not the ledger. Plugin changes require a separate cache refresh ([When the plugin changed](#when-the-plugin-changed)). Never restart another owner's session to force adoption.

**Rehearsed 2026-11-02:** the source, frozen-dependency, launcher and launchd transition and complete cohort rollback passed on a disposable same-path installation, including an old waiting hook to the new server and a new waiting hook to the restored server. Configuration, credentials and the Fluree process were unchanged; all owned jobs and processes were removed. A rehearsal alone is not a release decision. The existing [end-to-end check](#check-the-bus-end-to-end) uses a stand-in hook and is not a real session wake.

**Observed live 2026-11-02:** the query and viewer release was activated on both machines with clean, detached primaries and source-only `serve` restarts. The pinned runtime cohort, Fluree, configuration and credentials were preserved. The [query tools](#query-tools) check and controlled delivery checks passed on both endpoints. A real idle Claude wake passed on each host: one was independently observed, the other established by a correlated participant receipt, not independent process output. A separate fresh-session probe on the latter host ended before join because a prerequisite was unmet. The existing tunnel on one host was reconnected separately with owner approval to resolve pre-existing latency; no network configuration changed. A live rollback was not needed and remains unverified.

The activation decision must name the exact reviewed source commit and tree, candidate and previous installed bindings, runtime/dependency identities, affected services, checks and complete rollback. For a release, record its absolute root and manifest sha256 outside the release; its source identity is not necessarily the checkout's HEAD. Review the full deployed-to-candidate delta, including whether the separate viewer entrypoint can be exposed. The [query tools' check and rollback constraint](#query-tools) applies to every server and rollback: one machine's upgrade says nothing about another's. Preserve state, credentials, cursors and `installation-id`; a release never initializes an established installation's missing identity ([recover](recover.md#the-installation-identity-is-missing-or-invalid)).

## Deploy a packaged release

This lane needs an established installation and its valid delivery identity. First provisioning still follows [install](install.md). The release carries its own runtime, bundles and installer; the destination needs no build, dependency install or checkout change. Retain previous releases, runtimes, source dependencies and recorded launcher/viewer bindings for rollback. Never edit a sealed release or remove one named by a running process or rollback record.

The binding mechanism, source/release transitions and complete rollback have been rehearsed under disposable launchd jobs. These newly written manual steps remain *Unverified as an exact operator sequence*; their individual mechanisms have qualification and rehearsal coverage. Do not equate that with live client proof. *Observed live 2026-11-11:* both installations' CLI/server/plugin bindings agreed on one release; the existing viewer on one installation agreed too. A fresh native desktop session there loaded the skill and handled an independently sent idle wake/read, and its viewer rendered six pinned rows. An existing Claude session on the other installation handled its installed-hook wake/read. **A fresh Claude session's skill loading and idle-start wake on that installation remain Unverified.** This is not a claim that all release checks are complete.

1. **Pin and bootstrap-check the artifact.** Build from the reviewed commit in a development worktree if needed, using the approved Bun first on `PATH`:

   ```sh
   "$approved_bun" --no-env-file scripts/release.ts build \
     --bun "$approved_bun" --out "$releases" --commit "$candidate"
   ```

   Record the printed id and manifest digest in the release decision. Copy the complete read-only directory, preserving modes. Set `R` to its absolute destination root and `D` to that externally recorded digest, not a freshly trusted value read from the candidate. Before executing any bundled code, use system tools:

   ```sh
   ls -ld "$R" "$R/runtime" "$R/app" "$R/manifest.json" \
     "$R/runtime/bun" "$R/app/release.js" "$R/app/bunfig.toml" \
     "$R/app/install-launch-agents.sh"
   shasum -a 256 "$R/manifest.json"
   grep -A1 -E '"path": "(runtime/bun|app/release.js|app/bunfig.toml|app/install-launch-agents.sh)"' "$R/manifest.json"
   shasum -a 256 "$R/runtime/bun" "$R/app/release.js" \
     "$R/app/bunfig.toml" "$R/app/install-launch-agents.sh"
   ```

   Expected: manifest digest equals `D`, and each listed file hash equals its entry in that anchored manifest; root, runtime, app and bootstrap files are real directories/regular files, not links. Stop on any mismatch before running them. Then verify the complete cohort:

   ```sh
   "$R/runtime/bun" --no-env-file --config="$R/app/bunfig.toml" \
     "$R/app/release.js" verify "$R" --expect "$D"
   ```

   Expected: exit 0 and `ok: true`; exact file set, hashes, modes, runtime and embedded release identities match.

2. **Preserve and inspect the previous cohort.** Record the launcher binding, owned `serve` plist/process, stable marketplace and client versions, any installed viewer and its previous plist, plus state/configuration identity. Use the status command in step 5 and the existing health/query/delivery checks before changing anything. Keep the source primary detached and unchanged for a release activation. Stop on foreign ownership or an unknown binding. *Checked read-only 2026-11-11* for the paired activation's release agreement; a new candidate still needs its own baseline.

3. **Bind the launcher and restart only `serve`:**

   ```sh
   /bin/sh "$R/app/install-launch-agents.sh" --release "$R" --expect "$D"
   ```

   Expected: launcher selects R's own Bun, sealed config and `app/cli.js`; the existing owned serve plist, Fluree, tunnel, configuration, credentials and identity remain unchanged. Release mode cannot combine with `--bun`, `--remote` or `--runtime-only`. Run the restart, query-tools and end-to-end checks below before advancing guidance. If first upgrading hostname routing, use [the paired transition](#switch-to-stable-native-delivery), not independent restarts.

4. **Move an existing viewer, then select and refresh plugins:**

   ```sh
   "$R/runtime/bun" --no-env-file --config="$R/app/bunfig.toml" \
     "$R/app/release.js" viewer "$R" --expect "$D"
   "$R/runtime/bun" --no-env-file --config="$R/app/bunfig.toml" \
     "$R/app/release.js" plugin "$R" --expect "$D" \
     --marketplace "$HOME/.local/share/agent-bus/marketplace"
   ```

   Expected: an owned viewer keeps its port, environment and logs and runs R's viewer; an absent viewer stays absent. The real marketplace directory's `plugin` link names R. Use [first marketplace migration](install.md#select-the-plugin-marketplace) once when leaving source; otherwise use [the steady-state refresh](#when-the-plugin-changed). Never replace a foreign job or marketplace.

5. **Verify agreement and real behavior on every affected installation.** Use absolute native client executable paths for the intended client homes:

   ```sh
   "$R/runtime/bun" --no-env-file --config="$R/app/bunfig.toml" \
     "$R/app/release.js" status --claude "$CLAUDE_BIN" --codex "$CODEX_BIN"
   agent-bus --version
   ```

   Expected: JSON `agree: true`, all applicable surface identities name R, no pending viewer start, and CLI reports R's embedded identity. **Status exit 0 alone is not success.** Missing inspection is unknown, not absence; use `none` only to exclude an intentionally unused client. Repeat health/query/delivery checks, real owned native wake/read and fresh skill discovery, and an existing viewer's pinned real-data check. Installed agreement alone proves none of those. Record results individually, including missing proof. *Checked read-only 2026-11-11* for paired release agreement; live behavioral proof is bounded by the receipt above.

### Release rollback and partial failure

Verify the previous release against its retained external digest before using it. Review overlap compatibility: waiting hooks and loaded guidance from the newer release must work with or be refused safely by the older server, which must decode newer stored entries and retain public-query guarding. Include any [connected hosted peer](#when-a-hosted-peer-is-connected) in the rollback record, holding its attributed host stopped before a downgrade when the previous Bus cannot satisfy its contract. On downgrade, move guidance first: select the previous marketplace link and refresh clients, restore/rebind an existing viewer, then bind the launcher to the previous release with the same installer command. Repeat step 5 and all applicable checks. Keep newer release files while an old process still uses them. The source → release A → B → A → source mechanism is rehearsed; live rollback remains *Unverified*.

To return to source, first migrate the clients back to the recorded primary marketplace using [install's remove-and-add procedure](install.md#select-the-plugin-marketplace), not a release marketplace link pointed at an unversioned source plugin. Restore the viewer with the trusted release tool's `viewer-restore --from "$record"`, using its recorded source plist. Restore the approved clean, detached source and frozen dependencies with its exact Bun as in [the source lane](#deploy-a-new-version), then use the retained upgraded installer:

```sh
AGENT_BUS_REPO="$primary" /bin/sh "$R/app/install-launch-agents.sh" \
  --runtime-only --bun "$previous_bun"
```

Expected: source launcher, server, viewer and source plugins match the recorded previous cohort; state and delivery identity remain intact. Verify those identities and behavior through the source lane: release status's `agree` is release-specific and is not a source-success criterion. An older installer may refuse the release launcher, so do not substitute it. The manual sequence's shared verification mark above applies; this is not live rollback evidence.

If a step fails, inspect `status` per surface and re-run only the failed owned step for the named target, or restore every changed surface in downgrade order. An unfinished viewer start leaves a marker and the viewer stopped: re-run `viewer` or `viewer-restore`, never remove the marker to claim success. If no coherent state can be restored, disable and boot out only the positively identified owned serve/viewer jobs (`launchctl disable gui/$(id -u)/<label>`, then `launchctl bootout gui/$(id -u)/<label>`). They stay stopped across login; enable and bootstrap only after reviewed repair. A held failure is not successful rollback. *Unverified for live recovery; split-binding recovery and guarded stop were exercised in the disposable rehearsal.*

## Deploy a new version

This is the supported **source-binding lane**, including source rollback. For an installation already bound to a package, use [the release lane](#deploy-a-packaged-release) instead; do not advance its retained primary merely to activate a release.

1. **Identify the primary explicitly** from the deployment record, not from `readlink`: the launcher may be a regular managed file. In that checkout record `git status --short --branch`, `git rev-parse HEAD`, `git rev-parse HEAD^{tree}`, the running `serve` process and its launcher/runtime binding. Stop if the tree is dirty, attached to a branch, or its identity differs from the approved record. Preserve both old source and exact runtime for rollback. *Observed live 2026-11-05* on both machines.

2. **Check the existing service** with [the query tools' check](#query-tools), [the restart check](#check-that-serve-restarted) and [the end-to-end check](#check-the-bus-end-to-end) on each machine. Record results and arrange an owned real Claude participant for the later wake check. The query check was *Checked read-only 2026-11-02* on both installed endpoints after activation; the preceding release used the containment check instead. The end-to-end command was *Observed live 2026-11-01*.

3. **Review, merge and pin the candidate.** Coordinate the release decision with the accountable deployment owner, verify the intended PR sequence merged through Graphite, fetch remote `main`, and confirm the reviewed candidate is on it and descends from the recorded previous commit. Compare its exact commit and tree with the release decision, and inspect the full delta before activating. A newer remote head is not automatically the reviewed candidate. Routine release decisions may be made by agents through their review loops; no standing human prompt is required. *Observed live 2026-11-02.*

4. **Activate the pinned source only in a clean, detached primary**, after the reviewed compatibility and rollback rehearsal. Set `candidate` to the exact approved commit and `previous` to the recorded deployed commit:

   ```sh
   git merge-base --is-ancestor "$previous" "$candidate"
   git merge --ff-only "$candidate"
   git rev-parse HEAD HEAD^{tree}
   ```

   Expected: the ancestry check succeeds, fast-forward succeeds, and both printed identities match the reviewed release decision. Stop on any mismatch. *Observed live 2026-11-05* on both machines' clean, detached primaries; a live rollback (step 8) remains *Unverified*.

5. **Install the reviewed locked dependencies with the approved absolute Bun executable**, after checking its version and identity. In the primary:

   ```sh
   "$approved_bun" install --frozen-lockfile --ignore-scripts
   ```

   Expected: the locked install completes without changing the lockfile. The development-only Effect vendor preparation is not needed by the running server. A frozen-lockfile mismatch is a failure, not permission to update the lock. *Rehearsed 2026-11-02* for both selected and previous cohorts on the disposable installation.

6. **Apply the reviewed service change.** On the first upgrade from hostname routing, use [the cohort procedure](#switch-to-stable-native-delivery) instead of restarting the machines separately. Otherwise, if only source changed and the existing launcher and service configuration remain correct, restart just `serve` with `launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus`. If the runtime binding changes, use the retained, qualified upgraded installer, not the old whole installer:

   ```sh
   AGENT_BUS_REPO="$primary" "$retained_installer" --runtime-only --bun "$approved_bun"
   ```

   Here `primary`, `retained_installer` and `approved_bun` are absolute paths recorded in the decision. This mode updates the launcher and restarts `serve`, not Fluree, the tunnel or credentials. It keeps an existing owned `serve` plist unchanged and waits on that job's own port; it refuses another shape under the label, or an `AGENT_BUS_PORT` or `AGENT_BUS_DIR` that disagrees with the job's. Inspect other installer changes individually: run a full installer only when separately justified and approved, because it reprovisions service configuration and restarts Fluree or the tunnel. *Rehearsed 2026-11-02* on the disposable installation: old symlink adoption, exact managed arguments and unchanged Fluree, configuration and credentials.

7. **Verify the activated pair on each machine.** Confirm exact source commit and tree, installed dependency and Bun identities, launcher contents, LaunchAgent arguments, and the running process entrypoint and start time. Run the restart, query tools and end-to-end checks, then verify a real Claude wake through an owned participant. Do not restart another owner's session to force its hook to rearm. Refresh the plugin only if its source changed. Record every result and its basis; a stand-in hook or a health response alone is insufficient. *Observed live 2026-11-02:* identities, query checks and controlled delivery passed on both; real wakes passed with independent observation on one and a correlated participant receipt on the other.

8. **On failure, restore the complete approved previous state.** Only use a previous source that keeps queries refused or validated, and public response projection; otherwise keep the affected `serve` stopped and prepare a reviewed repair. Confirm the primary is clean and detached, switch it explicitly to the recorded previous commit, verify its commit and tree, and use its exact old Bun to install its frozen dependencies. Then run the retained upgraded installer with `AGENT_BUS_REPO="$primary" --runtime-only --bun "$previous_bun"`, and repeat the identity, query tools, delivery and real-wake checks. Do not use `git reset --hard`, rely on a mutable `PATH`, or run the old whole installer against the new managed launcher. Refresh a changed plugin as needed. *Rehearsed 2026-11-02*, with the containment check in place of the query tools check: complete source/dependency/runtime rollback under launchd at the same disposable canonical path, with a waiting candidate hook waking against the old server. A live-primary rollback remains *Unverified*.

## When a hosted peer is connected

For an existing approved hosted connection, include the private host in the release and rollback record. Its [separate version binding](../architecture/interfaces.md#release-tools) is not covered by release `status`. A routine rebind inside the existing exposure and identity scope follows that commission; a change to exposure, subject, grant, resource or permissions needs its own decision. The following sequence is *Unverified as an operator procedure*; the binding behavior was checked in [service configuration](../../src/private-web/service.ts) and [per-exchange admission](../../src/private-web/peer.ts), not exercised live by this documentation change.

1. **Record the owned host and its previous binding.** Identify its actual process/service, bundle and runtime, private configuration, selected Bus port/version, connector and tunnel ownership. Set `private_config` to the actual absolute configuration path in that owned service's arguments. Preserve the previous configuration in a protected private backup, along with OAuth, grant, session-key and token-storage state. From a trusted development worktree with frozen dependencies and the pinned Bun first on `PATH`, inspect only the selected non-secret binding:

   ```sh
   bun --no-env-file -e '
   import { decodeServiceConfig, readPrivateJson } from "./src/private-web/service.ts";
   try {
     const c = decodeServiceConfig(readPrivateJson(process.argv[1]));
     console.log(JSON.stringify({ binding: c.binding, source: c.sources[c.binding] }));
   } catch {
     console.error("Private binding inspection failed.");
     process.exitCode = 1;
   }
   ' "$private_config"
   ```

   Expected: the selected loopback source agrees with the recorded installation. Keep complete configuration and secrets out of output and public records. Establish the installation's actual restart command and previous bundle before changing anything; there is no generic managed private-host label in the public installer.

2. **Coordinate the Bus transition and private rebind.** Review host compatibility with both the selected and rollback Bus, including the [peer's read byte-admission check](../../src/private-web/peer.ts). Follow the source or package lane above and verify that the target advertises the exact MCP version in the authorized release record. Then update the selected source's `expectedBusVersion` to that recorded identity, preserving unrelated configuration and all identity material. Use the installation's protected structured-config procedure with atomic same-directory replacement, leaving a regular file owned by the current OS user at mode `0600`; retain its protected previous backup. Restart only the attributed private host through its recorded service command. A transition window can refuse hosted exchanges until both identities agree; arrange it with participants rather than claiming uninterrupted service. Keep an existing tunnel unchanged unless the release specifically owns a required change. Expected: the verified Bus target, configuration and restarted private host agree in that order; core release agreement alone does not prove this.

3. **Check the actual hosted consumer and retain complete rollback.** Use an owned native participant and the intended hosted conversation for a fresh correlated exchange, checking that the hosted side reads the native participant's reply from its own inbox. Label what was observed separately from health, identity and fixture results; shared-history visibility and interactive participation do not establish automatic wake, token-refresh behavior or large-result handling. Clean up temporary participants. If the transition fails, restore the compatible Bus cohort, prior selected-source configuration and any changed private bundle through the recorded commands, preserving OAuth and session state, then repeat the actual-client check. When the previous Bus cannot satisfy the retained host's contract, hold the attributed hosted front stopped before downgrading and report it as unavailable rather than claiming a compatible restoration. Expected: the recorded target or restored coherent state is demonstrated; otherwise report the held state and missing evidence. [Fixture qualification](qualify-private-peer.md) does not substitute for this client proof.

## Query tools

For every deployment or rollback, enumerate every `serve` that can front the shared ledger. Each must run a commit that either refuses public queries (public-query containment) or validates them ([connections rule 6](../architecture/connections.md#rules)); a commit from before containment runs SPARQL unvalidated. No Fluree credential change, reindex, migration or rejoin is needed. Do not widen credentials or change governance to make a query succeed. Refresh cached tool and skill guidance as described in [upgrade](upgrade.md#refreshing-guidance-in-running-sessions). This check is about the endpoint: a session that connected before the restart keeps the tool list it was given, so it says nothing about what running sessions can call.

From a credential-free verification worktree with its frozen dependencies and approved Bun, verify each machine's local endpoint with this bounded check. A release needs no source dependencies to run; this SDK-based check uses the verification worktree, not the retained primary or release directory. It reads the ledger head, runs one pinned query and one forbidden one, prints no result data and changes no bus state:

```sh
bun --no-env-file -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "query-tools-check", version: "1" });
const fail = (what) => { throw new Error(`Query tools check failed: ${what}.`); };
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.env.AGENT_BUS_PORT ?? 8096}/mcp`)));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["bus_queries", "bus_run_query", "bus_query"]) if (!names.includes(name)) fail(`${name} is not listed`);
  const listing = await client.callTool({ name: "bus_queries", arguments: {} });
  const head = listing.structuredContent?.headT;
  if (listing.isError === true || !Number.isInteger(head)) fail("bus_queries gave no head");
  const pinned = await client.callTool({ name: "bus_query", arguments: {
    query: "SELECT ?id WHERE { ?m a bus:Message ; bus:id ?id } LIMIT 1", t: head
  } });
  if (pinned.isError === true || pinned.structuredContent?.t !== head) fail("a pinned bus_query did not answer at its t");
  const forbidden = await client.callTool({ name: "bus_query", arguments: {
    query: "SELECT * WHERE { SERVICE <urn:example> { ?s ?p ?o } }"
  } });
  const text = forbidden.content?.[0]?.text ?? "";
  if (forbidden.isError !== true || !text.startsWith("SERVICE is not allowed")) fail("a SERVICE query was not refused");
  console.log("PASS: pinned query answers, forbidden query refused");
} finally {
  await client.close();
}
'
```

Expected: `PASS: pinned query answers, forbidden query refused` on every machine, then the existing end-to-end message check passes. Record which exact reviewed commit each restarted process runs. *Rehearsed 2026-11-01 and 2026-11-02* against a disposable `serve` and authenticated throwaway Fluree; *Checked read-only 2026-11-02* against both installed endpoints. The query contract itself is checked on disposable servers by `test/query.test.ts` and `bun run qualify:fluree`.

If an endpoint fails the check, treat rollout as incomplete and keep that `serve` stopped until a reviewed repair is ready, or roll it back to a commit that keeps queries refused or validated. Stopping `serve` interrupts that machine's delivery and hooks, but preserves the ledger and cursors. After any rollback, rerun the end-to-end check on each affected machine; a commit with the refusal answers `bus_query` with "Public SPARQL queries are disabled while the public-data boundary is being qualified. Use bus_history or bus_peers." rather than passing this check.

## Check that `serve` restarted

Run after every restart and rollback. It only reads.

```sh
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8096/health && break; sleep 1; done; echo
tail -n 2 ~/.agent-bus/agent-bus.log
launchctl print gui/$(id -u)/ai.rawr.agent-bus | grep -E 'state =|pid =|agent-bus'
ps -o lstart= -p "$(launchctl print gui/$(id -u)/ai.rawr.agent-bus | awk '/pid =/{print $3}')"; date
```

Expected: `ok`; a recent `Listening on http://127.0.0.1:8096` line, `state = running`, a pid and a recent process start time. Inspect the launcher's exact runtime and source binding and the running process separately; this check alone does not prove their identity. The revised launcher and process identity were *Rehearsed 2026-11-02* on a disposable launchd installation.

## Check the bus end to end

Run before a deploy, after it and after a rollback. It is self-contained: every run uses its own test addresses and a fresh stand-in for a Claude hook. Every call ends after 5 seconds, every wait after 30, and the whole check after 90 seconds (it can run about 10 seconds past that, finishing a call and its cleanup). It reports after it has cleaned up: `PASS` and exit 0, or `FAIL:` with the reason and exit 1. If the bus can't be reached to leave the test addresses, it says which are still joined, keeps its temporary directory, and prints the command that leaves them later: run the same block with `LEAVE_RUN=<number> ` in front of `sh`.

The stand-in is the plugin's hook command, `agent-bus claude-wake`, fed the input Claude Code gives a hook. It shows that a hook can reach `serve`, that `serve` marks it `hooked`, and that mail wakes it. The CLI can't read, so every call except the hook goes through the MCP endpoint with `curl`, which also bounds each call.

```sh
sh <<'EOF'
port=${AGENT_BUS_PORT:-8096}
url=http://127.0.0.1:$port/mcp
deadline=$(( $(date +%s) + 90 ))
run=${LEAVE_RUN:-$(date +%s)$$}
recv=deploy-check/r$run send=deploy-check/s$run
work=$(mktemp -d)
hook= sid= msg= problems= jr=0 js=0
rpc() { curl -s --max-time 5 -X POST "$url" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $sid" -d "$1"; }
call() { rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }
open_session() {
  sid=$(curl -s --max-time 5 -i -X POST "$url" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-check","version":"1"}}}' | awk 'tolower($1)=="mcp-session-id:"{print $2}' | tr -d '\r')
  [ -z "$sid" ] || rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
}
late() { [ "$(date +%s)" -ge "$deadline" ]; }
# until_ok REASON COMMAND...: retry for up to 30 s, and never past the 90 s deadline
until_ok() {
  reason=$1; shift; n=0
  while ! "$@"; do
    n=$((n+1)); if [ $n -ge 30 ] || late; then msg=$reason; return 1; fi; sleep 1
  done
}
healthy() { curl -fs --max-time 2 "http://127.0.0.1:$port/health" >/dev/null; }
hooked() { call bus_join "$join" | grep -q '"hooked":true'; }
hook_ended() { ! kill -0 "$hook" 2>/dev/null; }
leave() { # leave ADDRESS SESSION
  [ -n "$sid" ] || open_session
  [ -n "$sid" ] || return 1
  call bus_leave "{\"address\":\"$1\",\"session\":\"$2\"}" | grep -q '"isError":false\|has not joined'
}
body() {
  until_ok "serve does not answer on port $port" healthy || return 1
  open_session; [ -n "$sid" ] || { msg="no MCP session"; return 1; }
  join="{\"address\":\"$recv\",\"runtime\":\"claude\",\"session\":\"$run-r\",\"cwd\":\"/tmp\"}"
  call bus_join "$join" | grep -q cursor || { msg="join was refused"; return 1; }
  jr=1
  echo "{\"session_id\":\"$run-r\"}" | agent-bus claude-wake >"$work/hook.out" 2>"$work/hook.err" &
  hook=$!
  until_ok "the hook never called serve (hooked stayed unset)" hooked || return 1
  call bus_join "{\"address\":\"$send\",\"runtime\":\"other\",\"session\":\"$run-s\",\"cwd\":\"/tmp\"}" | grep -q cursor || { msg="sender join failed"; return 1; }
  js=1
  call bus_publish "{\"from\":\"$send\",\"session\":\"$run-s\",\"to\":[\"$recv\"],\"body\":\"deploy check\"}" | grep -q '"isError":false' || { msg="publish failed"; return 1; }
  until_ok "the hook did not wake" hook_ended || return 1
  wait "$hook"; [ $? -eq 2 ] || { msg="the hook exited with the wrong status"; return 1; }
  call bus_read "{\"address\":\"$recv\",\"session\":\"$run-r\"}" | grep -q '"body":"deploy check"' || { msg="the message was not read"; return 1; }
}
cleanup() {
  [ -z "$hook" ] || kill "$hook" 2>/dev/null
  if [ -n "${LEAVE_RUN:-}" ]; then jr=1 js=1; fi
  if [ $jr = 1 ]; then leave $recv $run-r || problems="$problems $recv"; fi
  if [ $js = 1 ]; then leave $send $run-s || problems="$problems $send"; fi
  if [ -n "$problems" ]; then
    echo "Still joined:$problems"
    echo "Leave them later with: LEAVE_RUN=$run sh <<'EOF' ... EOF (this same block)"
    echo "Temporary files kept in $work"
  else
    mv "$work" ~/.Trash/deploy-check-$run || echo "Could not move $work to the Trash"
  fi
}
status=PASS
if [ -z "${LEAVE_RUN:-}" ]; then body || status=FAIL; fi
cleanup
if [ $status = PASS ] && [ -z "$problems" ]; then echo PASS; exit 0; fi
echo "FAIL: ${msg:-cleanup incomplete}"; exit 1
EOF
```

Expected: `PASS` and exit status 0, in a few seconds. Afterwards `agent-bus peers` lists neither test address. *Rehearsed 2026-10-28*, on repeated runs and with `serve` stopped (`FAIL: serve does not answer on port …` after 30 s, exit 1). Rehearsed with `serve` frozen mid-run (`kill -STOP`): `FAIL: the hook never called serve …` after 95 s, with the joined address named and the leave command printed; after `kill -CONT`, `LEAVE_RUN=<number>` left it and printed `PASS`.

*Observed live 2026-11-01:* this canonical end-to-end command returned `PASS` on both installed endpoints after their activation and restart at `0202499`. It exercises the stand-in hook described above, not a real Claude session.

That a hook already waiting before the restart calls `serve` again by itself (it retries every five seconds) was seen once, with an earlier form of this check: `hooked` was true 6 s after the restart. *Unverified* in a real Claude session: from a joined session, call `bus_join` again with its own address and session after the restart, and expect `hooked: true` within about ten seconds.

## Switch to stable native delivery

Only for the first upgrade from hostname-based wake routing. Do not repeat it on a network change or ordinary restart. Record the state directory, approved source and exact Bun on each machine. Remove any manually supplied `serve --host` argument before starting the new server; the managed LaunchAgent never used it. Arrange a one-time ordinary renewal with the owners of live native addresses. Do not rely on bus wakes to reach those owners during this transition.

1. After the approved source and locked dependencies are in place, initialize each machine's state using its own approved Bun and source. Do not copy the ID between machines. For the default state directory:

   ```sh
   AGENT_BUS_DIR="$HOME/.agent-bus" "$approved_bun" --no-env-file "$primary/src/bin.ts" initialize-installation
   test -f "$HOME/.agent-bus/installation-id"
   ```

   Expect both commands to succeed without printing the ID. Rerunning the first does not replace it. For a nondefault setup, use the state directory recorded for that `serve`. *Observed live 2026-11-08* on both installations: distinct IDs were initialized without printing either value.

2. [Stop](operate.md#stop-and-start-serve-fluree-or-the-tunnel) every old `serve` before starting the upgraded cohort; keep Fluree and the tunnel running. Start and verify the approved `serve` on each machine. Do not rely on native delivery during a mixed rollout: old servers still match descriptive hostnames, and new servers cannot wake hostname-only joins. *Observed live 2026-11-08* on the paired cohort: both old jobs were unloaded before either new job started, and Fluree and the tunnel stayed running.

3. Have each live native owner call `bus_join` once from its original session and machine, using its existing address and normal session and working directory fields (including its own `codexThreadId` for Codex). Omit topics and associations to keep them; resupply a note if it should be kept. Do not leave, replay, or take over. With its local cursor intact, the session keeps its unread position and run. An owner can still read before renewal. Prompt a dormant owner in its native client only when it needs native wake again, rather than acting on its behalf. *Observed live 2026-11-08* for the two qualifying owners, one Codex and one Claude. This does not attest every legacy address.

4. Confirm a fresh direct test message wakes a real Codex thread and a real Claude session, and that each owner reads the intended message. A health check, stand-in hook, or queued nudge alone does not qualify a native turn. *Observed live 2026-11-08*: a separate native Codex turn handled a genuine direct handoff, and a separate installed-hook turn woke an idle Claude session, which read the exact direct message. Both followed the owner's own renewal ([paired activation receipt](https://github.com/rawr-ai/agent-bus/pull/61#issuecomment-6730212997)).

For rollback, keep `installation-id` in place. The previous server can read retained messages but returns to hostname-based wake routing; repeat the old-version wake checks, and have an affected owner renew from its original session if needed. Never reset a cursor to repair wake routing. If the local identity is missing or damaged, follow [recovery](recover.md#the-installation-identity-is-missing-or-invalid).

## Inactivity and mutes: every `serve` first

Do-not-disturb is honoured per machine, because each `serve` wakes only its own joins ([delivery](../architecture/delivery.md#when-unread-mail-doesnt-wake-inactivity-and-mutes)). A `serve` from before `bus_activity` ignores command nodes and wakes its joins as it always did, which errs toward contact and loses nothing. So the release that brings `bus_activity` has no write-order prerequisite, but its guidance does:
1. Deploy and check every `serve` that fronts the shared ledger, as above.
2. Only then refresh the plugin (next section) and the Codex skill, whose guidance tells agents to go inactive instead of leaving. Until every `serve` runs the release, don't promise do-not-disturb to anyone.

Rolling back to an earlier release from the orientation release onwards is allowed: addresses read as active and unmuted there, and the command nodes stay in the ledger. Rolling forward again restores activity and mutes from them, unless a leave, takeover or another session's join has reset the address since. Rollback targets from before the orientation release are unverified. Never add a message `kind` to carry activity: an earlier `serve` fails to decode the whole read window that holds it.

## When the plugin changed

A change under `plugin/` or `.claude-plugin/` isn't delivered by a source fast-forward or launcher swap. For a release, first select the verified release's stable marketplace link in the release lane above. After the [one-time marketplace migration](install.md#select-the-plugin-marketplace), the native refresh commands are the same for both bindings. Run them after verifying the new `serve`, so it already has the commands and tools the new hook expects:

```sh
claude plugin marketplace update agent-bus
claude plugin update agent-bus@agent-bus
claude plugin list
```

Expected: `claude plugin list` shows `agent-bus@agent-bus` enabled at the selected version. Sessions get the change when they next start, or with `/reload-plugins`. A source-only code change needs no plugin refresh; every release link change does, because its manifests carry that release's identity. *Done 2026-10-29* for the source docs-consolidation deploy; release inventory agreement *Checked read-only 2026-11-11*.

Then check that the installed copy holds what the selected source or release's `plugin/` holds, the hooks manifest and the agent skill, in the cache directory named by its reported version (read-only):

```sh
cache=~/.claude/plugins/cache/agent-bus/agent-bus
newest=$cache/$(claude plugin list | awk '/agent-bus@agent-bus/{f=1} f&&/Version:/{print $2; exit}')
ls "$newest/.claude-plugin/plugin.json" "$newest/skills/agent-bus/SKILL.md" "$newest/skills/agent-bus/references"
```

Expected: the manifest and `SKILL.md` listed, then `queries.md` and `runtimes.md`; the directory is the one named by the `Version` that `claude plugin list` shows. Don't pick the newest directory by time: an update writes an `.orphaned_at` marker into the old one, which makes it the newest. A cache made before the skill shipped has only the manifest, and `ls` then says `No such file or directory` for the skill: update the plugin. *Rehearsed 2026-10-28* on a copy of `plugin/` laid out as the cache; the live cache, made before the skill shipped, correctly lacked it (*Checked read-only 2026-10-28*).

Also refresh the Codex plugin on every machine and Codex home with participants, following [the native installation and discovery check](install.md#install-the-codex-skill-plugin). MCP registration alone does not deliver the skill. Notify active participants of the changed guidance and its source path; do not equate an installed cache with a refresh of already-loaded threads. *Observed live 2026-11-01:* native refresh repaired a manifest-only installation on one machine and installed the missing plugin on the other. Source equality and fresh prompt discovery were *Checked read-only 2026-11-01* on both.

## Recover a diverged primary checkout

Stop if the primary is dirty, attached, divergent or its deployed identity is uncertain. Preserve unfamiliar work without overwriting it and contact its actual owner when ownership or intent is unclear. A merge-base or reflog can help investigate, but neither proves the reviewed release decision. Do not select current `main` or an arbitrary older commit as a recovery target. Only after identifying the exact reviewed source and runtime and ensuring public-query containment, use the complete rollback in [Deploy a new version](#deploy-a-new-version). *Unverified* for the revised procedure.

## If it fails

| Symptom | Action |
| --- | --- |
| Dirty, attached or divergent primary, or unexpected source identity | Stop and [recover the checkout](#recover-a-diverged-primary-checkout); preserve the work. |
| Foreign or modified launcher refused | Stop before replacing it. Establish ownership and resolve it explicitly; do not bypass the installer check. |
| Release verification fails, `agree` is false/unknown, or a viewer start is pending | Do not advance guidance or delete markers. Follow [release rollback and partial failure](#release-rollback-and-partial-failure); status exit 0 is not agreement. |
| Native release checks pass but a connected hosted peer refuses calls | Check the selected private source's exact version and attributed host binding; follow [the hosted transition](#when-a-hosted-peer-is-connected). Preserve identity material and resolve the affected operation rather than widening access. |
| Launcher or plist rename or launchd bootstrap fails | The two file replacements are atomic individually, not together. Inspect both files and the job, then rerun the qualified narrow installer for the intended source and runtime or complete the approved rollback; do not assume either pair is active. *Unverified* on launchd. |
| Health, process identity, query tools or delivery fails | Keep the affected `serve` stopped if query guarding is uncertain; otherwise use the complete approved rollback above. Consult [operate](operate.md) and [recover](recover.md) for diagnosis. |
