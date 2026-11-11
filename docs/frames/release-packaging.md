# Frame: release packaging

This frame designs the source-independent release cohort accepted in [product continuation](product-continuation.md#release-independence-the-smallest-complete-story), before implementation and qualification. Current behaviour stays with the [deploy](../runbooks/deploy.md) and [install](../runbooks/install.md) runbooks; nothing here is shipped or activated.

Status: **design reviewed, implementation in qualification**, 2026-11-07. Codex's director, runtime and simplicity reviews are integrated in decisions 2, 11, 12, 14 and 16 and in decisions 19 to 21. Production activation stays behind the existing deployment gate.

The checks here serve provenance and recovery: a release is the reviewed one, and a bad or partial one is refused before anything moves. They are not hardening against someone who can already write the user's files; signatures, extended attributes and adversarial filesystems are outside them.

## The binding today

One managed launcher, `~/.local/bin/agent-bus`, runs `<bun> --no-env-file <primary>/src/bin.ts`. The `serve` LaunchAgent runs that launcher, and both plugins' hooks run it by absolute path. A development checkout is therefore live source for `serve`, the CLI and every hook. Its dependencies are a 259 MB `node_modules` frozen in place. The plugins are read from that checkout as their marketplace and carry no version, so Claude labels a copy by git commit and Codex labels it `local`. The viewer runs separately from a built `dist/viewer` inside a worktree.

## Decisions

1. **A release is an immutable directory, named by its identity.** `<data>/releases/<id>/` sits under the existing data home (`~/.local/share/agent-bus`, which already holds the pinned runtimes). `<id>` is `<version>-<commit12>`, and the manifest records the full source commit and tree. A release is never edited after verification. It is removed only by explicit retirement, never while a launcher, rollback record or running process names it.

2. **Bundle the code; copy the runtime.** The CLI is one `bun build --target bun` bundle of `src/bin.ts`. A feasibility check produced 1.3 MB, and relocated with `env -i` and an unrelated working directory it answered `--help` and `--version`. That bundle replaces the 259 MB dependency tree. Three facts make bundling sound:
   - the server reads no source-relative files;
   - it spawns only `git` and `codex`, never itself;
   - the viewer is already shipped as a bundle.

   The release carries its own copy of the pinned Bun. Its bytes are anchored by the manifest's recorded digest (decision 11), so a destination needs neither the builder's Bun nor a checkout. A single compiled executable stays optional, as the accepted frame says.

3. **Layout.**

   ```
   releases/<id>/
     manifest.json        identity, source commit and tree, lock hash, Bun version and hash, every file's sha256 and mode
     runtime/bun          the pinned Bun, copied
     app/cli.js           the bundled CLI, `serve` and hooks
     app/release.js       the bundled release tool: verify, viewer, plugin and status
     app/install-launch-agents.sh   the installer, whose --release mode needs no checkout
     app/dist/viewer/     viewer main.js, public/ and its manifest, the same relative layout the built viewer resolves
     plugin/              the plugin tree, with this release's version in both client manifests
   ```

   Store, configuration and credentials (`~/.agent-bus`) are never in a release and never touched by activation.

4. **The launcher names an exact release, not a moving pointer.** Launcher v2 is `exec '<release>/runtime/bun' --no-env-file --config='<release>/app/bunfig.toml' '<release>/app/cli.js' "$@"` (decision 22 gives the reason for `--config`). Activation then changes exactly one file, the launcher, by atomic rename. The `serve` LaunchAgent's arguments stay the same, so the plist is not rewritten: in release and `--runtime-only` modes the installer keeps an existing serve plist byte for byte and waits on that job's own port and state directory. It keeps only the owned job, labelled as configured and running exactly `[<launcher>, "serve"]` with no `Program` key. Any other job under the label is refused unchanged, and so is an `AGENT_BUS_PORT` or `AGENT_BUS_DIR` that disagrees with the job's; a job with no port of its own has `serve`'s default. Only a full install, or a missing plist, writes one. A hook already waiting keeps the old release's files, which remain in place, and the next hook runs the new one. A `current` symlink would add a second binding with its own race and no benefit.

5. **Plugins come from one stable marketplace.** `<data>/marketplace/` is a real directory holding a fixed `.claude-plugin/marketplace.json`, plus a `plugin` symlink to `../releases/<id>/plugin`. It has to be a real directory because Codex resolves the marketplace root's real path when it is added. A symlink at the top level is therefore invisible to it, which was checked in isolated client homes.

   Refreshing the clients works like this:
   - Claude: flip the link, then `claude plugin marketplace update` and `claude plugin update`.
   - Codex: flip the link, then `codex plugin add`.

   Both upgrade and downgrade were checked in isolated client homes. Each client's marketplace switches from the primary checkout to this directory once, as part of the first activation.

6. **Order activation so guidance never runs ahead of the server.**
   1. Verify the candidate release completely.
   2. Write launcher v2, staged and checked with `--help` under `env -i`, and restart `serve`.
   3. Run the health, query-tools and end-to-end checks.
   4. Move an installed viewer onto the release (decision 19).
   5. Flip the marketplace link and refresh both clients' plugins.
   6. Run a real Claude wake check.

   Claude reports the marketplace path as the installed plugin's source. *Inferred, not yet qualified:* a newly started session may then load the skill text from that path rather than from its versioned cache, so guidance could change at the flip, while hooks change only after the plugin update and a session restart. The flip comes last either way, after the server that the new guidance describes is running. The real-client rehearsal settles which text a new session loads.

7. **Rollback runs the same sequence for the previous release.** The first rollback boundary is the deployed-shape source binding, launcher v1 with the recorded primary and Bun. The installer keeps accepting v1 launchers, so source → release A → release B → A → source is one rehearsable path. Rollback is limited to commits that keep queries refused or validated ([query tools](../runbooks/deploy.md#query-tools)).

8. **Reject a bad cohort before anything moves.** Verification recomputes every hash, requires the exact file set (nothing missing, nothing extra), and checks modes. It confirms that the copied Bun reports the pinned version and that the bundle reports the manifest's version under `env -i`. A tampered, incomplete or unverifiable release is refused with the launcher, LaunchAgent, viewer job and marketplace link unchanged. The surfaces can still diverge if a step fails between them; decision 20 gives the recovery, and the qualification injects that split.

9. **Keep the mechanism small and in the repository.**
   - `scripts/release.ts build` produces a release from one commit, using a frozen install and the exact pinned Bun.
   - The release carries the same tool, bundled as `app/release.js`, for `verify`, `viewer`, `viewer-restore`, `plugin` and `status`, and the installer as `app/install-launch-agents.sh`. Activation therefore runs entirely from the release, with no checkout.
   - The installer's `--release <dir> --expect <sha256>` mode branches before any source check. Before running anything the release holds, it checks with system tools that `manifest.json`, `app/` and `runtime/` are not links, that the manifest has the anchored digest, and that each file it runs (`runtime/bun`, `app/release.js` and `app/bunfig.toml`) is a regular file with the bytes the manifest lists. It then runs the release's verifier, writes launcher v2 and recognises v1 and v2 launchers as owned.
   - The installer is itself code, so it must be known code: the reviewed checkout's, or a release's copy checked first with system tools, as the rehearsal does before every run:

     ```sh
     shasum -a 256 "$R/manifest.json"                               # the recorded digest
     grep -A1 '"path": "app/install-launch-agents.sh"' "$R/manifest.json"  # its listed sha256
     shasum -a 256 "$R/app/install-launch-agents.sh"                # the same sha256
     ```

   Every command prints identities and boolean comparisons only, never file contents.

10. **Retain all legacy material until the first release has been activated and its rollback qualified.** This covers the earlier rollback cohorts, retained installers and runtimes in the data home. After that, superseded cohorts older than the rollback floor can be retired once their hashes are recorded. No cleanup is part of this work.

## Adjustments after the testing-design review

The repository's testing-design steward reviewed this design before any code was written. These changes are adopted:

11. **Anchor verification outside the release.** A manifest only vouches for itself: a consistent edit of a file and its hash would pass. The build prints the manifest's sha256. The activation decision records it, and `verify --expect <sha256>` (and the installer's `--release <dir> --expect <sha256>`) refuses any release whose manifest has a different digest. The manifest records the copied Bun's hash, so the anchor covers its bytes too; the builder may also compare it with its approved executable (`--bun`), but no destination needs that executable. The build refuses a `--bun` that is not the runtime itself, such as a shim that runs another Bun, since copying it would ship the shim. Verification names one canonical root: a trailing separator is removed and the parent's real path taken, so a link standing in the release's place is refused rather than followed, and the viewer and plugin steps bind the root that was verified.

12. **Build from the commit, not the worktree.** `git status` cannot see a locally patched `node_modules`. The build therefore exports the commit with `git archive` into a fresh directory, runs a frozen install there with `--ignore-scripts` and the pinned Bun, and bundles from that directory. Two builds of one commit producing identical hashes qualifies the toolchain and mechanism; it is rechecked when they or the inputs change, not for every release.

13. **Embed the release identity.** `VERSION` is a constant, so two releases cannot be told apart. The bundle gets the release id and commit through `define`, and reports them in `--version` and in the MCP server information. A source run reports itself as source.

14. **A read-only `release status`, per surface.** It prints identities and agreement booleans only: the release the launcher names, the marketplace link target, the release in the running `serve`'s arguments, the viewer job's binding and its running process, an unfinished viewer start, and the plugin versions Claude and Codex have installed. This is the oracle for split bindings and for coherent restoration. It agrees only on exact bindings of the launcher's release R, compared by path rather than by name:
    - the marketplace link is exactly `R/plugin`;
    - `serve` is running exactly R's command: its Bun, `--no-env-file`, its `--config` and its `cli.js serve`;
    - the viewer is either absent with nothing loaded under its label, or bound to R and running exactly R's viewer command;
    - no viewer start is pending, in the bindings directory of the launcher's release, of the viewer's release, or the one named;
    - each client either is excluded on purpose (`--claude none`, `--codex none`), or holds the plugin only at R's id and enabled.

    A client whose executable is neither named nor found on `PATH` cannot be asked, so it is `unknown`, never taken to be absent.

    A state launchd or a client cannot report is `unknown`, never absent or empty, and does not agree. Configured agreement does not show what an already running session loaded.

15. **Releases are read-only on disk.** Files are 0444, or 0555 for executables, and directories 0555. Verify checks these modes and refuses anything that is not a regular file or directory, using `lstat`: symlinks, hard links with a link count above 1, FIFOs and a release directory that is itself a link. A build writes `releases/.tmp-<id>`, renames it into place, and never overwrites an existing id. Extended attributes are outside the hashes; that is a recorded limit.

16. **Moving to an older release flips the guidance first, within the existing compatibility rules.** Decision 6 sets the order for moving to a newer release. When moving to an older one, flip the marketplace and refresh first, then swap the launcher, so no guidance gets ahead of the server it describes. Verification refuses a release unless every hook subcommand in its plugin exists in its CLI. That check cannot see three things, so a move from B to an older A also needs the reviewed release decision to show:
    - **Waiting hooks:** a hook already waiting keeps running B's files, which stay in place, against A's server; the deployed overlap rule applies as for any rollback ([deploy](../runbooks/deploy.md#deploy-a-new-version)).
    - **Cached guidance:** a session that loaded B's skill or tool list keeps it until it restarts, and its calls reach A. They must still be accepted or refused as A refuses unknown input; no session is restarted for this, and another owner's session never is.
    - **Stored entries:** A must decode everything B can write. B's delta may not add a stored entry kind, field or mute scope that A cannot decode ([interfaces](../architecture/interfaces.md)), and A must keep queries refused or validated ([query tools](../runbooks/deploy.md#query-tools)).

17. **Rolling back to source is a separate path.** It uses the new installer's `--runtime-only` mode, because older installers refuse a v2 launcher as foreign. The marketplace returns to the primary checkout through the existing native remove-and-add procedure, not by repointing the link at the checkout: that checkout's plugin has no version, so the Claude cache could not tell the two apart. An installed viewer returns with `viewer-restore` from the plist recorded at the first activation. The rehearsal qualifies this path separately. It is the one migration step in either direction between the source binding and the first release.

18. **The rehearsal cannot reach live services.** Every rehearsal step starts with a preflight that refuses default ports, labels, launcher paths and data directories. A disposable launchd job is given its isolated `HOME` explicitly, so Codex delivery cannot find the real control socket. Checks call the disposable launcher by explicit path, never through `PATH`.

19. **The viewer moves with the release, where it is installed.** The viewer job keeps its label, environment (ports), logs and settings. Its runtime becomes the release's Bun and its entry the release's `app/dist/viewer/main.js`, run in `app/`. `release.js viewer` recognises the job only in the shape the [viewer runbook](../runbooks/viewer.md#run-as-a-user-launchagent) writes. It records the previous plist before writing, each record created exclusively, and restarts the job only if it was loaded. Records and markers have one home: the `bindings/` directory beside the release's `releases/` directory (the data home's, for the default root), derived from the release itself. For `viewer-restore`, that home is the directory holding the record, which must be the installed release's own while the job runs a release. A `--bindings` naming any other directory is refused, never silently ignored. It acts only on the owned job: the job launchd has loaded must come from that plist, run its program without a `Program` override, in the runbook shape and with the plist's environment, and a job loaded without its plist is refused. A restart writes `<label>.start-pending` in that directory before it stops the job and removes it only once the job runs again. A failed start therefore leaves the job stopped and the marker, which `release status` reports, and re-running the step or `viewer-restore` starts it. An absent viewer stays absent. `viewer-restore --from <record>` puts back a recorded binding, the source one included, so source rollback restores the viewer too. The installer likewise records the launcher it replaces.

20. **A split binding has a small, executed recovery.** `release status` names the surface that disagrees. Recovery uses only the steps above, for one named release:
    - **Launcher swapped, checks failed:** run `--release` for the previous release, or the source rollback (decision 17). The plugin and viewer have not moved.
    - **Viewer or plugin refresh failed partway:** re-run that step for the target release. If it still fails, return every surface that moved to the previous release in downgrade order (decision 16): plugin link and refresh first, then the viewer, then the launcher.
    - **One client refreshed and the other did not:** the link already names the target, so re-run the failed client's refresh. A client cache that will not refresh is recorded and named in the decision; it does not block restoring the others.
    - **No coherent state can be restored:** stop the owned jobs so launchd cannot restart them, and keep them stopped across login: `launchctl disable gui/$(id -u)/<label>`, then `launchctl bootout gui/$(id -u)/<label>`, for `serve` and an installed viewer. A disabled job does not load at the next login. `launchctl enable` then `launchctl bootstrap` undo it once a reviewed binding is restored. A guarded stop is a held failure, never a success.

21. **Activation and rollback never restart another owner's session.** Running sessions adopt new hooks and guidance when they next start. Configured equality and refreshed caches do not prove that any running session adopted them.

22. **No caller's Bun settings reach release code.** Hooks run in the session's project directory. Bun reads `bunfig.toml` from the working directory even under `--no-env-file`, for a file or for stdin, and its `preload` runs that directory's code in the process. The decoy measurement confirmed this for a bare release run; a `bunfig.toml` in the home directory was not loaded. The launcher keeps the caller's working directory, which commands such as `join` rely on. Instead, every release carries a sealed, empty `app/bunfig.toml`, and the launcher and the verifier name it with `--config`, which replaces the working-directory lookup. The installer's inline validation names `/dev/null` for the same reason. The viewer job runs in `app/`, so its lookup finds the sealed file. The source launcher (v1) keeps this exposure; it is the development binding and is not changed here.

23. **A release needs this installation's delivery identity and never creates one.** Since [stable native delivery](stable-native-delivery.md), `serve` routes wakes by `installation-id` in its state directory and refuses to start without it. Release activation follows the same rule as a rerun of the full installer: before anything changes, it requires a valid identity in the state directory of the `serve` job it binds, and it refuses otherwise. Valid means what `serve`'s loader accepts: a regular file, not a link, holding one lowercase UUIDv4, with only ASCII whitespace around it, such as a CRLF ending. The check stays a subset of `serve`'s rule. Any other byte, such as a byte-order mark, is refused even where `serve` would trim it, so a restored file goes back exactly as it was written. A first upgrade initializes the identity deliberately ([deploy](../runbooks/deploy.md#switch-to-stable-native-delivery)). An established one that is missing is restored, never replaced. A release can do that initialization itself, with no checkout: `AGENT_BUS_DIR=<state> <release>/runtime/bun --no-env-file --config=<release>/app/bunfig.toml <release>/app/cli.js initialize-installation`, which is also the release launcher's `initialize-installation`. Upgrades and rollbacks keep the identity as they keep the configuration and token.

One smaller finding is recorded rather than designed here:
- **Concurrent activation.** Two operators activating at once is out of scope for the first release; activation is single-operator.

## Qualification

Qualification follows the accepted frame's complete story. The repository's testing-design steward shapes the method before any test is written.

The release must run from a relocated, unpacked copy, with:
- the staging path absent;
- an unrelated working directory, holding a `.env` and a `bunfig.toml` whose preload a bare run would load;
- a clean `HOME` and `PATH`;
- no install, build or download step.

`bun run qualify:release` checks this for the current commit and is never cached. It builds the commit twice and requires one manifest digest. A marker patched into the installed dependency of a disposable clone, with its own frozen install, must reach a bundle of that clone but not the release built from it; this checkout's installed dependency and status must be unchanged afterwards. The release's Bun must be the builder's executable byte for byte, and a relocated copy must report its own path as its executable. It scans every bundle for external imports and every file for the build, checkout and home paths. Then it relocates a copy, verifies it against the original digest, runs the generated launcher from the decoy directory, initializes a fresh state directory's identity with it (created once, private, never printed, kept by a rerun), and requires the relocated viewer, run under a supervisor, to serve every asset byte for byte and to be gone once stopped. The bundle tests run a bundled `serve` beside a source `serve` on one throwaway ledger, and require the same MCP surface and refusals, with the bundled CLI and hooks used end to end.

One disposable rehearsal must cover the sequence source → A → B → A → source. It runs against an authenticated, throwaway Fluree and a native `serve` under disposable labels, ports and data directory. It records store, configuration and credential sameness as booleans only. It must also show:
- an independent MCP client answering a pinned query and refusing `SERVICE`;
- a shipped CLI join and publish;
- a real installed Claude hook waking an owned idle session that reads correlated mail;
- the production viewer rendering a known pinned row;
- Codex native discovery of the release's plugin;
- read/unread sentinels surviving rollback;
- tamper, incomplete-cohort and split-binding rejection;
- a disposable viewer job moved source → A → B → A → source, keeping its port and environment;
- a split binding recovered by decision 20, and a guarded stop that launchd will not restart and that refuses a bootstrap until enabled.

`bun run rehearse:release` runs this rehearsal under real launchd for two commits (default `HEAD~1` and `HEAD`). It uses the fixed disposable labels `test.agent-bus-rehearsal` and `.viewer`, so launchd's per-label override record never accumulates, and free ports. One temporary home holds the launcher, data home, plists and marketplace, and a preflight refuses default or production labels, ports and paths before every step. Its checks:
- the source binding, from an exported checkout with a frozen install, its own installer and a viewer job in the runbook's shape;
- an unanchored and a content-tampered release refused with every surface and the running jobs unchanged;
- each split binding injected and recovered by decision 20;
- the downgrade order on B → A;
- the source rollback with `viewer-restore` and the release's installer;
- a guarded stop whose bootstrap launchd refuses until enabled;
- when both clients are installed, their real plugin commands in client directories under that home: the first activation adds the marketplace, every flip refreshes both clients, `release status` reports both client versions in the split binding, and the source rollback removes and re-adds the checkout's marketplace. The Stop hook text that Claude installed, run with the rehearsal bus's port and directory as a session's environment would give it, wakes an address with mail under B and again after the rollback. None of this needs a signed-in client; the rehearsal reports when a client is missing.

In each bound state it checks health, the launcher's `--version`, the running `serve` and viewer arguments, an unchanged store binding (configuration, token and the delivery identity initialized once at setup, each compared by contents, inode, modification time and mode, so a rewrite with the same bytes also fails), a pinned query, the `SERVICE` refusal and `release status`, and the mail sentinels as exact sets. It then removes the jobs and the home, and confirms that the live launcher and LaunchAgents are unchanged. What still needs a signed-in session belongs to the real-client rehearsal: a live session woken by its hook, which skill text a new session loads after the flip (decision 5), and Codex thread discovery.

Real clients run in an isolated `HOME`. The plugins' unchanged hook text then resolves `$HOME/.local/bin/agent-bus` to the disposable launcher. Rewriting the hook path instead would test a stand-in plugin, not the shipped one. The Claude session is started with the disposable bus port and directory. No credential is copied and no separate login is built: the signed-in observations come from existing native sessions, in the separately approved activation check. A real Codex delivery is exercised only with the isolated `HOME` from decision 18; otherwise it stays covered by the existing in-process tests and the bundle's import check.

## Not decided here

This frame does not decide activation of any release on either machine, a viewer installer (the viewer job is still created by its runbook), remote access, or retirement of legacy material.
