# Deploy

Use this to put a reviewed packaged release or source version into service, verify its bindings and roll back. Restarting alone is in [operate](operate.md); the first source install is in [install](install.md).

For end-to-end release ownership, commission the native `agent-bus-release-operations-steward` as described in [stewards](stewards.md#commission-release-operations). It covers readiness, integration and distribution as well as this runbook's activation, verification and recovery, through post-release communication and retirement.

## Before you start

The primary checkout stays clean and detached at its approved retained commit, never used for development. It supplies live code only in a source installation; a packaged installation runs immutable release files and retains the checkout for source rollback. Git/Graphite synchronization activates neither. Coordinate with the deployment owner before changing any installed binding, primary or shared branch metadata. Activation is single-operator.

A launcher change reaches a newly started hook immediately, but reaches `serve` only on restart; an already-waiting hook retains its loaded code and runtime until it rearms. Restarting `serve` loses its in-memory wake state and held search rankings (a search in progress must start again), not the ledger. Plugin changes require a separate cache refresh ([When the plugin changed](#when-the-plugin-changed)). Never restart another owner's session to force adoption.

**Rehearsed 2026-11-02:** the source, frozen-dependency, launcher and launchd transition and complete cohort rollback passed on a disposable same-path installation, including an old waiting hook to the new server and a new waiting hook to the restored server. Configuration, credentials and the Fluree process were unchanged; all owned jobs and processes were removed. A rehearsal alone is not a release decision. The existing [end-to-end check](#check-the-bus-end-to-end) uses a stand-in hook and is not a real session wake.

**Observed live 2026-11-02:** the query and viewer release was activated on both machines with clean, detached primaries and source-only `serve` restarts. The pinned runtime cohort, Fluree, configuration and credentials were preserved. The [query tools](#query-tools) check and controlled delivery checks passed on both endpoints. A real idle Claude wake passed on each host: one was independently observed, the other established by a correlated participant receipt, not independent process output. A separate fresh-session probe on the latter host ended before join because a prerequisite was unmet. The existing tunnel on one host was reconnected separately with owner approval to resolve pre-existing latency; no network configuration changed. A live rollback was not needed and remains unverified.

The activation decision must name the exact reviewed source commit and tree, candidate and previous installed bindings, runtime/dependency identities, affected services, checks and complete rollback. For a release, record its absolute root and manifest sha256 outside the release; its source identity is not necessarily the checkout's HEAD. Review the full deployed-to-candidate delta, including whether the separate viewer entrypoint can be exposed. The [query tools' check and rollback constraint](#query-tools) applies to every server and rollback: one machine's upgrade says nothing about another's. Preserve state, credentials, cursors and `installation-id`; a release never initializes an established installation's missing identity ([recover](recover.md#the-installation-identity-is-missing-or-invalid)).

Crossing between legacy and exact cursor filenames in retained file-based releases requires [the stopped-bus transition](#change-the-cursor-format). Moving from exact files to ledger positions instead requires [the paired import](#import-file-positions-into-the-ledger). Neither uses the ordinary bind-and-restart or rollback step.

## Deploy a packaged release

This lane needs an established installation and its valid delivery identity. First provisioning still follows [install](install.md). The release carries its own runtime, bundles and installer; the destination needs no build, dependency install or checkout change. Retain previous releases, runtimes, source dependencies and recorded launcher/viewer bindings for rollback. Never edit a sealed release or remove one named by a running process or rollback record.

The binding mechanism, source/release transitions and complete rollback have been rehearsed under disposable launchd jobs. These newly written manual steps remain *Unverified as an exact operator sequence*; their individual mechanisms have qualification and rehearsal coverage. Do not equate that with live client proof. *Observed live 2026-11-11:* both installations' CLI/server/plugin bindings agreed on one release; the existing viewer on one installation agreed too. A fresh native desktop session there loaded the skill and handled an independently sent idle wake/read, and its viewer rendered six pinned rows. An existing Claude session on the other installation handled its installed-hook wake/read; a [fresh interactive CLI session](../platforms/claude-code.md#plugins) later loaded the skill and handled an idle wake/read there too; **a fresh desktop Code-tab session there remains Unverified.** This is not a claim that all release checks are complete.

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

For an exact-to-legacy rollback to a verified package, complete the [held cursor export and binding](#change-the-cursor-format) and verify its fresh `exported` receipt before permitting the legacy server to start. The current installer refuses a target without exact layout support while this installation has an active exact directory. Do not use an older installer or manually replace the launcher to bypass this refusal. Rollback across this boundary to a source target is unavailable.

Verify the previous release against its retained external digest before using it. Review overlap compatibility: waiting hooks and loaded guidance from the newer release must work with or be refused safely by the older server, which must decode newer stored entries and retain public-query guarding. Include any [connected hosted peer](#when-a-hosted-peer-is-connected) in the rollback record, holding its attributed host stopped before a downgrade when the previous Bus cannot satisfy its contract. On downgrade, move guidance first: select the previous marketplace link and refresh clients, restore/rebind an existing viewer, then bind the launcher to the previous release. Use the ordinary installer only for same-format rollback; otherwise follow the held binding above. Repeat step 5 and all applicable checks. Keep newer release files while an old process still uses them. The source → release A → B → A → source mechanism is rehearsed; live rollback remains *Unverified*.

To return to source **without changing cursor format**, first migrate the clients back to the recorded primary marketplace using [install's remove-and-add procedure](install.md#select-the-plugin-marketplace), not a release marketplace link pointed at an unversioned source plugin. Restore the viewer with the trusted release tool's `viewer-restore --from "$record"`, using its recorded source plist. Restore the approved clean, detached source and frozen dependencies with its exact Bun as in [the source lane](#deploy-a-new-version), then use the retained upgraded installer:

```sh
AGENT_BUS_REPO="$primary" /bin/sh "$R/app/install-launch-agents.sh" \
  --runtime-only --bun "$previous_bun"
```

Expected: source launcher, server, viewer and source plugins match the recorded previous cohort; state and delivery identity remain intact. Verify those identities and behavior through the source lane: release status's `agree` is release-specific and is not a source-success criterion. An older installer may refuse the release launcher, so do not substitute it. The manual sequence's shared verification mark above applies; this is not live rollback evidence.

If a same-format step fails, inspect `status` per surface and re-run only the failed owned step for the named target, or restore every changed surface in downgrade order. For a cursor-format transition failure, keep the writer held and use [the recovery specific to its cursor phase](recover.md#cursor-format-transition-refused). An unfinished viewer start leaves a marker and the viewer stopped: re-run `viewer` or `viewer-restore`, never remove the marker to claim success. If no coherent state can be restored, disable and boot out only the positively identified owned serve/viewer jobs (`launchctl disable gui/$(id -u)/<label>`, then `launchctl bootout gui/$(id -u)/<label>`). They stay stopped across login; enable and bootstrap only after reviewed repair. A held failure is not successful rollback. *Unverified for live recovery; split-binding recovery and guarded stop were exercised in the disposable rehearsal.*

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

6. **Apply the reviewed service change.** Do not use this restarting lane to cross the cursor format boundary. On the first upgrade from hostname routing, use [the cohort procedure](#switch-to-stable-native-delivery) instead of restarting the machines separately. Otherwise, if only source changed and the existing launcher and service configuration remain correct, restart just `serve` with `launchctl kickstart -k gui/$(id -u)/ai.rawr.agent-bus`. If the runtime binding changes, use the retained, qualified upgraded installer, not the old whole installer:

   ```sh
   AGENT_BUS_REPO="$primary" "$retained_installer" --runtime-only --bun "$approved_bun"
   ```

   Here `primary`, `retained_installer` and `approved_bun` are absolute paths recorded in the decision. This mode updates the launcher and restarts `serve`, not Fluree, the tunnel or credentials. It keeps an existing owned `serve` plist unchanged and waits on that job's own port; it refuses another shape under the label, or an `AGENT_BUS_PORT` or `AGENT_BUS_DIR` that disagrees with the job's. Inspect other installer changes individually: run a full installer only when separately justified and approved, because it reprovisions service configuration and restarts Fluree or the tunnel. *Rehearsed 2026-11-02* on the disposable installation: old symlink adoption, exact managed arguments and unchanged Fluree, configuration and credentials.

7. **Verify the activated pair on each machine.** Confirm exact source commit and tree, installed dependency and Bun identities, launcher contents, LaunchAgent arguments, and the running process entrypoint and start time. Run the restart, query tools and end-to-end checks, then verify a real Claude wake through an owned participant. Do not restart another owner's session to force its hook to rearm. Refresh the plugin only if its source changed. Record every result and its basis; a stand-in hook or a health response alone is insufficient. *Observed live 2026-11-02:* identities, query checks and controlled delivery passed on both; real wakes passed with independent observation on one and a correlated participant receipt on the other.

8. **On failure, restore the complete approved previous state.** This source rollback is same-format only: if the target is legacy and the current format is exact, keep `serve` stopped for forward repair or a separately verified packaged transition. Use only a previous source that refuses or validates queries and preserves public response projection; hold and repair forward if that is not possible. Confirm the primary is clean and detached, switch it explicitly to the recorded previous commit, verify its commit and tree, and use its exact old Bun to install its frozen dependencies. Run the retained upgraded installer with `AGENT_BUS_REPO="$primary" --runtime-only --bun "$previous_bun"`. Repeat the identity, query tools, delivery and real-wake checks. Do not use `git reset --hard`, rely on a mutable `PATH`, or run the old whole installer against the new managed launcher. Refresh a changed plugin as needed. *Rehearsed 2026-11-02*, with the containment check in place of the query tools check: complete source/dependency/runtime rollback under launchd at the same disposable canonical path, with a waiting candidate hook waking against the old server. A live-primary rollback remains *Unverified*.

## Change the cursor format

Use this only when changing between a server that stores URI-encoded cursor filenames and a server that stores exact-address records, with a verified packaged target. It is per installation and current ledger incarnation, not a ledger or plugin migration. The write commands require macOS launchd and the positively identified job's explicit `AGENT_BUS_LABEL` and canonical `AGENT_BUS_PORT`; Linux and other supervision have no supported in-place converter. Use one operator; do not run the converter concurrently or manually run either `serve` outside the owned job. Persistently disable the job throughout conversion and binding, so login or restart cannot bring back the wrong writer. Keep the ledger, token, installation identity, configuration and retained cursor generations unchanged. The full live activation is *Unverified*; stopped conversion and fault cases have disposable test coverage. The ordinary release rehearsal refuses a cross-format pair; exercise this sequence with the exact packages in a disposable installation instead.

Before claiming the shared-ledger sender fence or admission bound for a cohort, hold all obsolete writers and account for already-dispatched writes at the provider. A mixed cohort still permits the older behavior; converting one machine does not settle the others. Preserve the version-matched hosted binding and keep it stopped during the incompatible interval.

1. **Identify the actual installation and inspect without writing.** Confirm the owned job, its plist, state directory and installed launcher. Derive `serve_port` from `EnvironmentVariables.AGENT_BUS_PORT` in that successfully read and validated plist; use the serve default `8096` only if the key is genuinely absent. An unreadable plist or an invalid port is a refusal, not a reason to use the default. Set `state_dir`, `serve_label`, `serve_plist` and `launcher` to the recorded values and `domain="gui/$(id -u)"`. Define the converter from the externally verified *exact-format* release `R`, even when downgrading. Set `verified_target`, `external_sha` and `releases_dir` to the selected package, its independently retained manifest digest and its releases directory. Before converting, confirm the selected target is supported and the current trusted installer supports `--bind-only`.

   ```sh
   cursor_cli() {
     AGENT_BUS_DIR="$state_dir" AGENT_BUS_LABEL="$serve_label" AGENT_BUS_PORT="$serve_port" \
       "$R/runtime/bun" --no-env-file --config="$R/app/bunfig.toml" "$R/app/cli.js" cursors "$@"
   }
   cursor_cli --action check
   ```

   Expected: exit 0 and `state: "legacy"` before conversion or `state: "exact"` after it, with the intended `installation`, `incarnation`, inspected `head` and `count`. Exact-state `check` includes `legacyExport.eligible` and the first reason when ineligible. It describes the inspected cursor files and pinned history, not permission to downgrade later. A validation or read failure is an error, not an eligibility result. A live preflight is preliminary; only the stopped operation decides. This never creates a Fluree ledger, changes cursor files or consumes mail. *Unverified as an installed command.*

2. **Hold the existing writer.**

   ```sh
   launchctl disable "$domain/$serve_label"
   launchctl bootout "$domain/$serve_label"
   launchctl print-disabled "$domain"
   launchctl print "$domain/$serve_label"
   ```

   Expected: the positively identified label is disabled, `print` reports no service, and the recorded old process and listener are gone. The converter checks the exact launchd label and listener on the explicit port. Those checks supplement, not replace, your proof of the previous process's exit and settlement of its outstanding provider writes. Do not treat an unknown domain, a different label or an uninspectable port as an empty installation. Keep the owned job disabled while deciding or recovering, including after a failed command. *Unverified as an installed sequence.*

3. **Convert before launching either binary.** For an upgrade:

   ```sh
   cursor_cli --action migrate
   cursor_cli --action check
   ```

   For a downgrade instead, while the newer writer is still stopped:

   ```sh
   cursor_cli --action export
   ```

   Expected on upgrade: both receipts show `state: "exact"` and the same `installation`, `incarnation` and `generation`. Old files are retained, not reused as a fallback. Expected on downgrade: `state: "exported"` with the matching installation and incarnation. This publishes a fresh old-format directory from the *current* exact positions and retains the exact generation separately. A previous export receipt or pre-upgrade backup is not downgrade authorization. An unrepresentable address, a known case alias (including a historical address without a local cursor) or a cursor without a historical witness refuses export. The alias restriction applies on all volumes, including a case-sensitive volume with both spellings. An exact address stays valid even when it cannot be projected into the older format. On refusal, keep the job held and use [the phase-specific forward recovery](recover.md#cursor-format-transition-refused); do not remove, replay or replace a cursor to make export pass. A successful export cannot prevent a legacy server from aliasing a *future* case variant. *Tested on disposable state; installed transition Unverified.*

4. **Bind the verified package while the job is held.** Use the current verified `trusted_installer`, not an old script from the rollback target. These overrides identify the already validated installation, not a replacement job or state folder.

   ```sh
   AGENT_BUS_LABEL="$serve_label" AGENT_BUS_DIR="$state_dir" \
     AGENT_BUS_PORT="$serve_port" AGENT_BUS_LAUNCHER="$launcher" \
     AGENT_BUS_RELEASES="$releases_dir" /bin/sh "$trusted_installer" \
     --release "$verified_target" --expect "$external_sha" --bind-only
   ```

   Expected: the launcher points to the exact target, the plist is unchanged, and the identified job remains disabled, unloaded and off its port. Check again that the recorded previous process exited. There is no source or `--runtime-only --bind-only` fallback. On refusal, keep the job held and preserve the retained generations. *Unverified as an installed sequence.*

5. **Resume the verified writer.** Verify the selected binary and retained or exported generation, and complete the applicable owned guidance, viewer and hosted binding steps. Then enable and bootstrap just the positively identified job:

   ```sh
   launchctl enable "$domain/$serve_label"
   launchctl bootstrap "$domain" "$serve_plist"
   ```

   Expected: the selected writer runs on the recorded port and state directory and passes the applicable release health and delivery checks above. A pending export blocks exact-format startup and migration. [Recover an interrupted export](recover.md#cursor-format-transition-refused) with the retained exact-format CLI; do not remove its marker or start the old launcher. Files are staged and renamed as complete directories; process-interruption testing does not establish power-loss durability. *Unverified as an installed sequence.*

## Import file positions into the ledger

Use this only for the paired cutover from a file-based release. It is not an activation or rollback procedure. Keep both old writers disabled and unloaded through reconciliation and selection of the paired release. The Fluree server and tunnel stay up. Use the reviewed candidate executable without rebinding either installed launcher; set `AGENT_BUS_DIR`, `AGENT_BUS_LABEL` and `AGENT_BUS_PORT` to the verified local installation, job and listener. The CLI verifies the local hold; the operator establishes the remote hold separately.

1. After verifying both holds, on **each** original installation:

   ```sh
   "$candidate_agent_bus" mailbox-source > "$source_receipt"
   ```

   Expect one JSON receipt with the installation, ledger, cut and cursor inventory digest. The receipts must name distinct expected installations and the same ledger incarnation and commit. Retain them independently from the payload copies. *Unverified on the paired installed hosts; covered on disposable source trees.*

2. Copy only the two `installation-id` files and each installation's exact `fluree-cursors/<encoded ledger>/<first commit id>.v2` directory plus its matching retained directory without the suffix, when present. Keep each source's paths under a separate copied state root. Do not copy credentials. Preserve the captured inventory and bytes without making either copy into a new active state directory.

   Expect two read-only copies with their original installation identities and inventory digests, no adopted launcher or edited cursor. *Unverified on the paired installed hosts.*

3. On the verified local installation, with both old writers still held, apply the paired import once:

   ```sh
   "$candidate_agent_bus" mailbox-import \
     --first-state "$first_copy" --first-receipt "$first_receipt" \
     --second-state "$second_copy" --second-receipt "$second_receipt" \
     --paired-holds-confirmed
   ```

   Expect a per-address report: `IMPORTED` carries the original exact value; `VERIFIED_IMPORT` or `VERIFIED_CLASSIFICATION` confirms this capture's previously stored operation; `UNCHANGED` means another mailbox fact already exists, not that this import applied. A `CLASSIFIED` row has a reason and no guessed position. Keep both holds while reconciling any unexpected result, unresolved position or hosted checkpoint. The existing file export does not project later ledger positions; retained files are not permission to roll back. *Unverified on the paired installed hosts; interruption and exact-result checks run on disposable ledgers.*

   On interruption or an uncertain result, retain the same copies and receipts and repeat this exact command while both holds remain in force. Never recapture to conceal a mismatch or treat an incomplete copy as a missing cursor. See [recover](recover.md#mailbox-import-cannot-be-established).

## When a hosted peer is connected

For an existing approved hosted connection, include the private host in the release and rollback record. Its [separate version binding](../architecture/interfaces.md#release-tools) is not covered by release `status`. A routine rebind inside the existing exposure and identity scope follows that commission; a change to exposure, subject, grant, resource or permissions needs its own decision. The complete sequence remains *Unverified as an operator procedure*; narrower rehearsals are marked below. The binding behavior was checked in [service configuration](../../src/private-web/service.ts) and [per-exchange admission](../../src/private-web/peer.ts), not exercised live by this documentation change.

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

2. **Coordinate the Bus transition and private rebind.** Review host compatibility with both the selected and rollback Bus, including the [peer's read byte-admission check](../../src/private-web/peer.ts). Follow the source or package lane above and verify that the target advertises the exact MCP version in the authorized release record. Then update the selected source's `expectedBusVersion` to that recorded identity, preserving unrelated configuration and all identity material. Use the installation's protected structured-config procedure with atomic same-directory replacement, leaving a regular file owned by the current OS user at mode `0600`; retain its protected previous backup.

   For separately approved first-time [Events enablement](../architecture/interfaces.md#hosted-events), prepare or verify the independent storage directory as service-user-owned at mode `0700`, and preserve the independent Events key. The host requires a pre-created database file; it initializes an empty file's schema but does not create the file. Only when the release record confirms that this database path has never been created and no database, rollback journal, WAL or SHM state exists, set `events_db` to the approved absolute `events.storagePath` and run this exclusive first-create as the service user, before selecting the enabled configuration or restarting:

   ```sh
   bun --no-env-file -e '
   import { closeSync, constants, openSync } from "node:fs";
   const fd = openSync(process.argv[1],
     constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
     0o600);
   closeSync(fd);
   ' "$events_db"
   ```

   Expected: one empty service-user-owned regular file at mode `0600`; an existing path is refused without changing its contents. Existing or uncertain prior state is not first-time initialization: preserve the database, key and journal files and use the recorded recovery procedure. Never truncate, replace, delete sidecars or regenerate a key to make startup succeed. *Rehearsed 2026-11-14 on disposable paths: first-create produced an empty `0600` file, and a repeated attempt refused without changing existing contents.* This narrow rehearsal is not a full recovery or actual-client check.

   Before first enablement of prepared watch authority, separately initialize its watch-map sibling while the attributed private host is stopped. This is required even when its Events database already exists. Set `private_bundle` to the reviewed private bundle's absolute `main.js` path and use that bundle's approved pinned Bun. Only when the watch-state sibling and its journals have never existed, run:

   ```sh
   bun --no-env-file --config=/dev/null -e '
   try {
     const { initializeWatchAuthority } = await import(process.argv[1]);
     initializeWatchAuthority(process.argv[2]);
   } catch {
     console.error("Watch authority initialization refused; preserve existing state.");
     process.exitCode = 1;
   }
   ' "$private_bundle" "$private_config"
   ```

   Expected: the canonical Events database path plus `.watch.sqlite` contains the initialized private watch schema. Creation is exclusive at `0600`; existing state, including a zero-byte or damaged file, is refused rather than reset. Runtime startup never initializes that file. Preserve the Events database, watch map, keys and rollback journals together; uncertain or interrupted provisioning needs attributed recovery, never truncation, deletion or a fresh empty replacement. A successful command creates no ticket, holding or subscription. *Rehearsed 2026-11-14 through the relocated private bundle on disposable paths, including existing-file refusal with unchanged contents; not live recovery evidence.*

   Restart only the attributed private host through its recorded service command. A transition window can refuse hosted exchanges until both identities agree; arrange it with participants rather than claiming uninterrupted service. Keep an existing tunnel unchanged unless the release specifically owns a required change. Expected: the verified Bus target, configuration and restarted private host agree in that order; core release agreement alone does not prove this.

3. **Check the actual hosted consumer and retain complete rollback.** After an approved Events catalogue change, use the existing app's normal refresh/rescan and inspect its Events listing. Expected: `mail.wake` appears with the current argument schema. Discovery alone does not prove subscription eligibility, an accepted lease or idle wake. Preserve the original owner and conversation for any separately authorized monitoring check. If its supported controls cannot establish a subscription, record that limit rather than substituting a timer, another conversation or a generic setup claim. *Observed live 2026-11-14: an earlier catalogue-only attempt did not establish activation; a later prepared watch appeared Active in the actual Scheduled list. The [platform observation](../platforms/mcp-openapi.md#optional-events) distinguishes that evidence from the qualified own-read report and remaining unknowns.*

   For an authorized Events trial, use the original intended conversation's normal `bus_prepare_watch` on an address it already owns. Keep its returned ticket private and use the returned exact arguments in the client's normal monitoring flow. Confirm accepted setup before any probe; only after setup and idle, generate and publish a fresh unpredictable nonce from an owned native participant. Require the rightful conversation's own consuming read and an exact nonce-bearing linked reply without another controller prompt. Record whether own-read evidence is an inspected tool result or a specific participant report of successful own-inbox retrieval; a callback, generic completion claim or shared-history lookup is not own-read evidence. If tool results are unavailable, do not claim independent exclusion of history retrieval. Stop that exact subscription and retire only the authorized temporary holding. *Observed live 2026-11-14: a saved event watch and unprompted exact linked reply were independently observed; the participant specifically reported its own successful inbox read. Raw hosted tool results were unavailable. This is the short-window evidence boundary, not a renewal or continuity qualification.*

   For continued monitoring, refresh before the actual `refreshBefore` with identical arguments and confirm the same subscription identity. A normal host restart and same-holding reprepare must not change the ticket. These are additional checks, not prerequisites to the initial short-window delivery trial; actual-client renewal, token refresh, restart and compaction remain *Unverified*. No ticket substitutes for ordinary tool correlation, and reboot may orphan an old holding rather than recover it.

   Use an owned native participant and the intended hosted conversation for a fresh correlated exchange, checking that the hosted side reads the native participant's reply from its own inbox. Label what was observed separately from health, identity and fixture results; shared-history visibility and interactive participation do not establish automatic wake, token-refresh behavior or large-result handling. Clean up temporary participants. If the transition fails, restore the compatible Bus cohort, prior selected-source configuration and any changed private bundle through the recorded commands, preserving OAuth, watch-map and session state, then repeat the actual-client check. When the previous Bus cannot satisfy the retained host's contract, hold the attributed hosted front stopped before downgrading and report it as unavailable rather than claiming a compatible restoration. Expected: the recorded target or restored coherent state is demonstrated; otherwise report the held state and missing evidence. [Fixture qualification](qualify-private-peer.md) does not substitute for this client proof.

For a separately authorized finite authorization diagnosis, use the same protected startup-config and private-only restart boundary to set `requestDiagnostics` to `true`, preserving all other current fields and state. Check the consumer enabled control and the existing host records, then observe at most one intended subscribe request in the original context. Interpret only the [fixed authorization outcomes](../architecture/interfaces.md#release-tools): continuing workers can interleave, stage exhaustion and failed sinks make absence inconclusive, and a returned consumer scope is not an accepted lease. Do not capture raw requests, metadata, identifiers, callbacks or errors, change grants/holdings, consume mail merely to diagnose setup, or retry an unchanged refusal. No functional probe precedes accepted setup. End any accepted monitoring through its supported stop, or an explicitly approved Events-only sender hold, by the agreed deadline; diagnostic omission is not unsubscribe. Restore diagnostic omission by deleting only that field from the **current** protected configuration, using the recorded private-only restart and health checks; never restore an old whole-config snapshot or reset OAuth/Events storage. *Unverified as a live diagnosis procedure: disposable callback and packaged-entry controls do not establish an actual-client branch or wake outcome.*

For a separately authorized principal-list change, use the same recorded host and rollback boundary. The v2 bundle requires a protected v2 configuration: replace the v1 singleton `ownerSubject` and `grantFile` with a nonempty `principals` array of explicit `{ subject, grantFile }` entries. Preserve the original subject, its grant path, session key, provider, resource, OAuth and all unrelated settings; add only the approved verified provider subjects and their grants, using distinct absolute grant-file path strings. Protect the configuration and each grant as a regular file owned by the service user at mode `0600`. Compare the approved private manifest to the complete resulting list before activation; organization membership or email is not admission. Do not print subjects, grant contents or configuration secrets. Qualify the exact new bundle off-live, retain the old bundle and v1 configuration together, and activate only the attributed host. Verify each authorized account's own OAuth and fresh correlated exchange, then revisit the original account's existing holding without takeover. A synthetic grant-revocation check is not a reason to disrupt live participants. On rollback restore both the old bundle and its matching old configuration; neither version accepts the other's schema. *Unverified as an operator procedure*; [qualification](qualify-private-peer.md) is not actual-account or activation evidence.

### Update the existing hosted plugin's skill

Use this when the approved release changes the bundled skill in an existing workspace plugin. It updates that definition and its existing app, not a separate plugin or connection. The observed UI update retained the app mapping and saved connection; see the [client evidence and limits](../platforms/mcp-openapi.md#direct-host-and-http-admission). The commands below apply to the observed legacy manifest with `apps: "./.app.json"`; stop and review a different layout rather than guessing. Keep the downloaded package, mapping and private paths out of public records. No server restart or credential change is implied.

1. Privately record the existing plugin and app identity, saved connection, and applicable required, workspace availability and audience settings; record any setting you cannot inspect as unknown. From that plugin's detail, choose **More actions > Download plugin ZIP**. Set `BASE_PLUGIN_ZIP` to its absolute path, `BUS_SKILL_ROOT` to the absolute path of `plugin/skills/agent-bus` in the reviewed release, and `PLUGIN_VERSION` to a newer numeric `major.minor.patch` version. This procedure refuses prerelease and build suffixes; review those separately. Snapshot the download in private staging, record its digest, and inspect that snapshot and the skill before extracting either:

   ```sh
   umask 077
   if plugin_stage=$(mktemp -d "${TMPDIR:-/tmp}/agent-bus-plugin.XXXXXX"); then
   (
   set -e
   cp "$BASE_PLUGIN_ZIP" "$plugin_stage/baseline.zip"
   cmp "$BASE_PLUGIN_ZIP" "$plugin_stage/baseline.zip"
   shasum -a 256 "$plugin_stage/baseline.zip" > "$plugin_stage/baseline.sha256"
   unzip -Z1 "$plugin_stage/baseline.zip"
   zipinfo -l "$plugin_stage/baseline.zip"
   unzip -t "$plugin_stage/baseline.zip"
   find "$BUS_SKILL_ROOT" -exec ls -ld {} +
   )
   else
     printf '%s\n' 'Could not create private staging; stop.' >&2
     false
   fi
   ```

   Expected: the current manifest and `.app.json` are present once, CRC checks pass, and all entries and skill files are regular files or directories. Stop on duplicate or case-colliding names, absolute or traversal paths, backslashes, links, unexpected layout or content. Preserve all unrelated members and metadata. *Checked read-only 2026-11-15 for the original export; inspect each new baseline independently.*

2. Recheck the pinned snapshot and use it for the build and rollback. Replace only the skill directory and edit the existing manifest's version and skill path; do not author a new app mapping:

   ```sh
   (
   set -e
   shasum -a 256 -c "$plugin_stage/baseline.sha256"
   mkdir "$plugin_stage/original" "$plugin_stage/package" "$plugin_stage/verify"
   unzip -qq "$plugin_stage/baseline.zip" -d "$plugin_stage/original"
   cp -R "$plugin_stage/original/." "$plugin_stage/package/"
   if [ -e "$plugin_stage/package/skills/agent-bus" ]; then
     mv "$plugin_stage/package/skills/agent-bus" "$plugin_stage/previous-skill"
   fi
   mkdir -p "$plugin_stage/package/skills"
   cp -pR "$BUS_SKILL_ROOT" "$plugin_stage/package/skills/agent-bus"
   python3 - "$plugin_stage/package/.codex-plugin/plugin.json" "$PLUGIN_VERSION" "$plugin_stage/baseline.zip" <<'PY'
   import json, pathlib, re, sys, zipfile
   def unique(pairs):
       result = {}
       for key, value in pairs:
           if key in result:
               raise ValueError("duplicate manifest key")
           result[key] = value
       return result
   def numeric_version(value):
       if not isinstance(value, str) or not re.fullmatch(
           r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value
       ):
           raise SystemExit("Expected a numeric major.minor.patch version; stop.")
       return tuple(int(part) for part in value.split("."))
   def reject_constant(_):
       raise ValueError("invalid JSON constant")
   path, version = pathlib.Path(sys.argv[1]), sys.argv[2]
   manifest = json.loads(path.read_text(), object_pairs_hook=unique, parse_constant=reject_constant)
   if (manifest.get("apps") != "./.app.json" or
       manifest.get("skills", "./skills/") != "./skills/" or
       numeric_version(version) <= numeric_version(manifest.get("version"))):
       raise SystemExit("Unexpected manifest or version; stop.")
   manifest.update(version=version, skills="./skills/")
   path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
   with zipfile.ZipFile(sys.argv[3]) as baseline:
       mode = (baseline.getinfo(".codex-plugin/plugin.json").external_attr >> 16) & 0o777
   if not mode:
       raise SystemExit("Manifest mode unavailable; stop.")
   path.chmod(mode)
   PY
   cp "$plugin_stage/baseline.zip" "$plugin_stage/candidate.zip"
   if unzip -Z1 "$plugin_stage/candidate.zip" | grep -q '^skills/agent-bus/'; then
     zip -qd "$plugin_stage/candidate.zip" 'skills/agent-bus/*'
   fi
   (cd "$plugin_stage/package" &&
     zip -q "$plugin_stage/candidate.zip" .codex-plugin/plugin.json &&
     zip -qrD "$plugin_stage/candidate.zip" skills/agent-bus)
   )
   ```

   Expected: a protected, digest-pinned baseline and one candidate at `"$plugin_stage/candidate.zip"`, with the selected skill and a newer version. Stop on any command failure. *The reviewed live update used a separately built candidate; this procedure has synthetic coverage.*

3. Inspect the candidate's inventory, modes and CRC as in step 1 before extracting it. Then recheck the pinned baseline and compare the mapping, selected skill, manifest and other members without printing their contents:

   ```sh
   unzip -Z1 "$plugin_stage/candidate.zip"
   zipinfo -l "$plugin_stage/candidate.zip"
   unzip -t "$plugin_stage/candidate.zip"
   ```

   Stop before extraction if the inventory or modes are unsafe or unexpected. Otherwise continue:

   ```sh
   (
   set -e
   shasum -a 256 -c "$plugin_stage/baseline.sha256"
   unzip -qq "$plugin_stage/candidate.zip" -d "$plugin_stage/verify"
   cmp "$plugin_stage/original/.app.json" "$plugin_stage/verify/.app.json"
   diff -rq "$BUS_SKILL_ROOT" "$plugin_stage/verify/skills/agent-bus"
   diff -qr "$plugin_stage/original" "$plugin_stage/verify" || [ "$?" -eq 1 ]
   python3 - "$plugin_stage/original/.codex-plugin/plugin.json" \
     "$plugin_stage/verify/.codex-plugin/plugin.json" "$PLUGIN_VERSION" <<'PY'
   import json, pathlib, sys
   original, candidate = (json.loads(pathlib.Path(p).read_text()) for p in sys.argv[1:3])
   original.update(version=sys.argv[3], skills="./skills/")
   if original != candidate:
       raise SystemExit("Unexpected manifest change; stop.")
   print("Manifest fields match the intended update.")
   PY
   shasum -a 256 "$plugin_stage/candidate.zip" > "$plugin_stage/candidate.sha256"
   )
   ```

   Expected: `cmp` and the skill comparison are silent; the directory comparison reports only the intended manifest and skill changes, and the final message confirms the manifest fields. Compare the inventory and modes with step 1, including unchanged members, and stop on any unexpected difference. A digest pins the candidate for upload. *The independently reviewed live candidate preserved the mapping and matched every selected skill file; this procedure has synthetic coverage.*

4. Recheck the candidate digest, then on the **same** plugin detail choose **More actions > Upload new version** and select that candidate:

   ```sh
   shasum -a 256 -c "$plugin_stage/candidate.sha256"
   ```

   Check the same plugin and app identities, saved connection and the previously recorded required, availability and audience settings; keep an uninspectable setting unknown. Check that the new version and skill appear. Refresh tools normally, then use one fresh conversation selecting only that app. Its Sources must show `Skills > agent-bus`, and a bounded guidance-sensitive task can ask for the cursor-ahead remedy and a session-free peer lookup. If the skill is absent from Sources, client activation is not established. Record visible evidence separately from participant-reported tool success, individual reference reads and raw traces; a listed skill alone does not prove use. If the upload or check fails, stop and retain both archives and the observed error; use the retained previous package through the same version-update control only if that rollback is supported, and verify the original app and connection. *Observed live 2026-11-15 for the same-definition update and fresh client check; rollback through this control is unverified.*

5. After a successful check, set `PLUGIN_BACKUP_DIR` to a **new** absolute directory in the owner's protected backup area, outside the staging directory. Retain both archives and their digests, then remove only this procedure's extracted staging:

   ```sh
   (
   set -e
   umask 077
   shasum -a 256 -c "$plugin_stage/baseline.sha256"
   shasum -a 256 -c "$plugin_stage/candidate.sha256"
   mkdir -m 700 "$PLUGIN_BACKUP_DIR"
   cp "$plugin_stage/baseline.zip" "$PLUGIN_BACKUP_DIR/baseline.zip"
   cp "$plugin_stage/candidate.zip" "$PLUGIN_BACKUP_DIR/candidate.zip"
   cmp "$plugin_stage/baseline.zip" "$PLUGIN_BACKUP_DIR/baseline.zip"
   cmp "$plugin_stage/candidate.zip" "$PLUGIN_BACKUP_DIR/candidate.zip"
   shasum -a 256 "$PLUGIN_BACKUP_DIR/baseline.zip" "$PLUGIN_BACKUP_DIR/candidate.zip" > "$PLUGIN_BACKUP_DIR/SHA256SUMS"
   )
   ```

   Expected: the new protected backup directory holds byte-equal archives and their digests. Before cleanup, verify that `plugin_stage` still names this invocation's private temporary directory, that it is not a link, and that the retained archives are outside it. Only then remove its known entries:

   ```sh
   (
   set -e
   rm -r "$plugin_stage/original" "$plugin_stage/package" "$plugin_stage/verify"
   if [ -d "$plugin_stage/previous-skill" ]; then rm -r "$plugin_stage/previous-skill"; fi
   rm "$plugin_stage/baseline.zip" "$plugin_stage/baseline.sha256" \
      "$plugin_stage/candidate.zip" "$plugin_stage/candidate.sha256"
   rmdir "$plugin_stage"
   )
   ```

   Expected: only the owned staging directory is gone; `rmdir` refuses unexpected leftovers. On a failure, keep the remaining files and inspect them before retrying. *The extraction and retention commands have synthetic coverage; cleanup and rollback through the upload control remain unverified.*

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

This procedure describes the earlier file-based release. It does not establish or change a ledger mailbox position; follow the paired cutover when changing position storage.

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

Also refresh the Codex plugin on every machine and Codex home with participants, following [the native installation and discovery check](install.md#install-the-codex-skill-plugin). MCP registration exposes the skill resources but does not install native hooks or establish that Codex loads them. Notify active participants of the changed guidance and its source path; do not equate an installed cache with a refresh of already-loaded threads. *Observed live 2026-11-01:* native refresh repaired a manifest-only installation on one machine and installed the missing plugin on the other. Source equality and fresh prompt discovery were *Checked read-only 2026-11-01* on both.

## Recover a diverged primary checkout

Stop if the primary is dirty, attached, divergent or its deployed identity is uncertain. Preserve unfamiliar work without overwriting it and contact its actual owner when ownership or intent is unclear. A merge-base or reflog can help investigate, but neither proves the reviewed release decision. Do not select current `main` or an arbitrary older commit as a recovery target. Only after identifying the exact reviewed source and runtime and ensuring public-query containment, use the complete rollback in [Deploy a new version](#deploy-a-new-version). *Unverified* for the revised procedure.

## If it fails

| Symptom | Action |
| --- | --- |
| Dirty, attached or divergent primary, or unexpected source identity | Stop and [recover the checkout](#recover-a-diverged-primary-checkout); preserve the work. |
| Foreign or modified launcher refused | Stop before replacing it. Establish ownership and resolve it explicitly; do not bypass the installer check. |
| Release verification fails, `agree` is false/unknown, or a viewer start is pending | Do not advance guidance or delete markers. Follow [release rollback and partial failure](#release-rollback-and-partial-failure); status exit 0 is not agreement. |
| Native release checks pass but a connected hosted peer refuses calls | Read the peer's `[agent-bus] hosted-peer-preflight` stderr lines ([format](../architecture/interfaces.md#release-tools)): `version_mismatch` names the expected and observed Bus versions (`absent` when the Bus reported none); `unavailable` means the call was refused before dispatch for the loopback connection, a missing or incompatible tool, or an incompatible initialization. An `exhausted` record stops only that reason's lines until restart. Check the selected private source's exact version and attributed host binding; follow [the hosted transition](#when-a-hosted-peer-is-connected). Preserve identity material and resolve the affected operation rather than widening access. |
| Hosted plugin upload or fresh-client skill check fails | Stop and preserve the baseline and candidate, saved connection and observed error. Follow [the hosted plugin update](#update-the-existing-hosted-plugins-skill); a listed skill, healthy server or passing fixture alone does not establish client use. |
| Private watch preparation or shutdown is waiting on native observation | Cancellation is cooperative; the single preparation queue and connection remain owned until admitted work actually settles. Do not start a competing writer, abandon the queue or reset state to force progress. Use the attributed private-host recovery boundary and preserve acknowledged watch state. |
| Launcher or plist rename or launchd bootstrap fails | The two file replacements are atomic individually, not together. Inspect both files and the job, then rerun the qualified narrow installer for the intended source and runtime or complete the approved rollback; do not assume either pair is active. *Unverified* on launchd. |
| Health, process identity, query tools or delivery fails | Keep the affected `serve` stopped if query guarding is uncertain; otherwise use the complete approved rollback above. Consult [operate](operate.md) and [recover](recover.md) for diagnosis. |
