# Deploy

Use this to put a new version of agent-bus into service: the primary-checkout rule, fast-forward, restart, verify and roll back. Restarting alone is in [operate](operate.md); the first install is in [install](install.md).

## Before you start

The primary checkout stays clean and detached at the exact approved deployed commit. It is live source for `serve` and the Claude hook, not a development worktree. Never edit or switch it for development. Graphite owns development and merging; the commands below are the narrow activation and rollback exception. Coordinate with the deployment owner before changing any primary or shared branch metadata.

A source change reaches a newly started hook immediately, but reaches `serve` only on restart; an already-waiting hook retains its loaded code and runtime until it rearms. Restarting `serve` loses its in-memory wake state and held search rankings (a search in progress must start again), not the ledger. Plugin changes require a separate cache refresh ([When the plugin changed](#when-the-plugin-changed)).

**Rehearsed 2026-11-02:** the source, frozen-dependency, launcher and launchd transition and complete cohort rollback passed on a disposable same-path installation, including an old waiting hook to the new server and a new waiting hook to the restored server. Configuration, credentials and the Fluree process were unchanged; all owned jobs and processes were removed. A rehearsal alone is not a release decision. The existing [end-to-end check](#check-the-bus-end-to-end) uses a stand-in hook and is not a real session wake.

**Observed live 2026-11-02:** the query and viewer release was activated on both machines with clean, detached primaries and source-only `serve` restarts. The pinned runtime cohort, Fluree, configuration and credentials were preserved. The [query tools](#query-tools) check and controlled delivery checks passed on both endpoints. A real idle Claude wake passed on each host: one was independently observed, the other established by a correlated participant receipt, not independent process output. A separate fresh-session probe on the latter host ended before join because a prerequisite was unmet. The existing tunnel on one host was reconnected separately with owner approval to resolve pre-existing latency; no network configuration changed. A live rollback was not needed and remains unverified.

The activation decision must name the exact merged source commit and tree, each machine's previous source and Bun executable, the new executable, frozen dependencies, affected services, checks and rollback. Review the full deployed-to-candidate delta, including whether the separate viewer entrypoint can be exposed. The [query tools' check and rollback constraint](#query-tools) applies to every server and rollback: every `serve` fronting the shared ledger answers queries against it, so one machine's upgrade says nothing about another's.

## Deploy a new version

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

## Query tools

For every deployment or rollback, enumerate every `serve` that can front the shared ledger. Each must run a commit that either refuses public queries (public-query containment) or validates them ([connections rule 6](../architecture/connections.md#rules)); a commit from before containment runs SPARQL unvalidated. No Fluree credential change, reindex, migration or rejoin is needed. Do not widen credentials or change governance to make a query succeed. Refresh cached tool and skill guidance as described in [upgrade](upgrade.md#refreshing-guidance-in-running-sessions). This check is about the endpoint: a session that connected before the restart keeps the tool list it was given, so it says nothing about what running sessions can call.

From each machine's activated checkout, verify its local endpoint with this bounded check. It reads the head commit, runs one pinned query and one forbidden one, prints no result data and changes no bus state:

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

   Expect both commands to succeed without printing the ID. Rerunning the first does not replace it. For a nondefault setup, use the state directory recorded for that `serve`. *Rehearsed 2026-11-08* with a disposable state directory; production activation is unverified.

2. [Stop](operate.md#stop-and-start-serve-fluree-or-the-tunnel) every old `serve` before starting the upgraded cohort; keep Fluree and the tunnel running. Start and verify the approved `serve` on each machine. Do not rely on native delivery during a mixed rollout: old servers still match descriptive hostnames, and new servers cannot wake hostname-only joins. *Unverified on the installed cohort.*

3. Have each live native owner call `bus_join` once from its original session and machine, using its existing address and normal session and working directory fields (including its own `codexThreadId` for Codex). Omit topics and associations to keep them; resupply a note if it should be kept. Do not leave, replay, or take over. With its local cursor intact, the session keeps its unread position and run. An owner can still read before renewal. Prompt a dormant owner in its native client only when it needs native wake again, rather than acting on its behalf. *Rehearsed 2026-11-08* with disposable owners; installed native renewals are unverified.

4. Confirm a fresh direct test message wakes a real Codex thread and a real Claude session, and that each owner reads the intended message. A health check, stand-in hook, or queued nudge alone does not qualify a native turn. *Unverified on the installed cohort.*

For rollback, keep `installation-id` in place. The previous server can read retained messages but returns to hostname-based wake routing; repeat the old-version wake checks, and have an affected owner renew from its original session if needed. Never reset a cursor to repair wake routing. If the local identity is missing or damaged, follow [recovery](recover.md#the-installation-identity-is-missing-or-invalid).

## Inactivity and mutes: every `serve` first

Do-not-disturb is honoured per machine, because each `serve` wakes only its own joins ([delivery](../architecture/delivery.md#when-unread-mail-doesnt-wake-inactivity-and-mutes)). A `serve` from before `bus_activity` ignores command nodes and wakes its joins as it always did, which errs toward contact and loses nothing. So the release that brings `bus_activity` has no write-order prerequisite, but its guidance does:
1. Deploy and check every `serve` that fronts the shared ledger, as above.
2. Only then refresh the plugin (next section) and the Codex skill, whose guidance tells agents to go inactive instead of leaving. Until every `serve` runs the release, don't promise do-not-disturb to anyone.

Rolling back to an earlier release from the orientation release onwards is allowed: addresses read as active and unmuted there, and the command nodes stay in the ledger. Rolling forward again restores activity and mutes from them, unless a leave, takeover or another session's join has reset the address since. Rollback targets from before the orientation release are unverified. Never add a message `kind` to carry activity: an earlier `serve` fails to decode the whole read window that holds it.

## When the plugin changed

A change under `plugin/` or `.claude-plugin/` isn't deployed by the fast-forward. Claude Code copies the plugin into its cache, so the change reaches sessions only after `claude plugin update` and a restart of each session ([platforms: Claude Code](../platforms/claude-code.md#plugins)). Run this after verifying the new `serve`, so it already has `bus_wake` for the new hook to find:

```sh
claude plugin marketplace update agent-bus
claude plugin update agent-bus@agent-bus
claude plugin list
```

Expected: `claude plugin list` shows `agent-bus@agent-bus` enabled at a new version. Sessions get the change when they next start, or with `/reload-plugins`. A change to `src/` alone needs none of this. *Done 2026-10-29* at the docs-consolidation deploy: the update printed `updated from … to …`, and the list showed the new version enabled.

Then check that the installed copy holds what the checkout's `plugin/` holds, the hooks manifest and the agent skill, in the newest cache directory (read-only):

```sh
cache=~/.claude/plugins/cache/agent-bus/agent-bus
newest=$cache/$(claude plugin list | awk '/agent-bus@agent-bus/{f=1} f&&/Version:/{print $2; exit}')
ls "$newest/.claude-plugin/plugin.json" "$newest/skills/agent-bus/SKILL.md" "$newest/skills/agent-bus/references"
```

Expected: the manifest and `SKILL.md` listed, then `queries.md` and `runtimes.md`; the directory is the one named by the `Version` that `claude plugin list` shows. Don't pick the newest directory by time: an update writes an `.orphaned_at` marker into the old one, which makes it the newest. A cache made before the skill shipped has only the manifest, and `ls` then says `No such file or directory` for the skill: update the plugin. *Rehearsed 2026-10-28* on a copy of `plugin/` laid out as the cache; the live cache, made before the skill shipped, correctly lacked it (*Checked read-only 2026-10-28*).

Also refresh the Codex plugin on every machine and Codex home with participants, following [the native installation and discovery check](install.md#install-the-codex-skill-plugin). MCP registration alone does not deliver the skill. Notify active participants of the changed guidance and its source path; do not equate an installed cache with a refresh of already-loaded threads. *Observed live 2026-11-01:* native refresh repaired a manifest-only installation on one machine and installed the missing plugin on the other. Source equality and fresh prompt discovery were *Checked read-only 2026-11-01* on both.

## Recover a diverged primary checkout

Stop if the primary is dirty, attached, divergent or its deployed identity is uncertain. Preserve unfamiliar work without overwriting it and consult the deployment owner. A merge-base or reflog can help investigate, but neither proves the reviewed release decision. Do not select current `main` or an arbitrary older commit as a recovery target. Only after identifying the exact reviewed source and runtime and ensuring public-query containment, use the complete rollback in [Deploy a new version](#deploy-a-new-version). *Unverified* for the revised procedure.

## If it fails

| Symptom | Action |
| --- | --- |
| Dirty, attached or divergent primary, or unexpected source identity | Stop and [recover the checkout](#recover-a-diverged-primary-checkout); preserve the work. |
| Foreign or modified launcher refused | Stop before replacing it. Establish ownership and resolve it explicitly; do not bypass the installer check. |
| Launcher or plist rename or launchd bootstrap fails | The two file replacements are atomic individually, not together. Inspect both files and the job, then rerun the qualified narrow installer for the intended source and runtime or complete the approved rollback; do not assume either pair is active. *Unverified* on launchd. |
| Health, process identity, query tools or delivery fails | Keep the affected `serve` stopped if query guarding is uncertain; otherwise use the complete approved rollback above. Consult [operate](operate.md) and [recover](recover.md) for diagnosis. |
