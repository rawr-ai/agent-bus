# Frame: release packaging

This frame designs the source-independent release cohort accepted in [product continuation](product-continuation.md#release-independence-the-smallest-complete-story), before implementation and qualification. Current behaviour stays with the [deploy](../runbooks/deploy.md) and [install](../runbooks/install.md) runbooks; nothing here is shipped or activated.

Status: **design proposed**, 2026-11-07, by the Claude bus co-lead for Codex director review. Production activation stays behind the existing deployment gate.

## The binding today

One managed launcher, `~/.local/bin/agent-bus`, runs `<bun> --no-env-file <primary>/src/bin.ts`. The `serve` LaunchAgent runs that launcher, and both plugins' hooks run it by absolute path. A development checkout is therefore live source for `serve`, the CLI and every hook. Its dependencies are a 259 MB `node_modules` frozen in place. The plugins are read from that checkout as their marketplace and carry no version, so Claude labels a copy by git commit and Codex labels it `local`. The viewer runs separately from a built `dist/viewer` inside a worktree.

## Decisions

1. **A release is an immutable directory, named by its identity.** `<data>/releases/<id>/` sits under the existing data home (`~/.local/share/agent-bus`, which already holds the pinned runtimes). `<id>` is `<version>-<commit12>`, and the manifest records the full source commit and tree. A release is never edited after verification. It is removed only by explicit retirement, never while a launcher, rollback record or running process names it.

2. **Bundle the code; copy the runtime.** The CLI is one `bun build --target bun` bundle of `src/bin.ts`. A feasibility check produced 1.3 MB, and relocated with `env -i` and an unrelated working directory it answered `--help` and `--version`. That bundle replaces the 259 MB dependency tree. Three facts make bundling sound:
   - the server reads no source-relative files;
   - it spawns only `git` and `codex`, never itself;
   - the viewer is already shipped as a bundle.

   The release carries its own copy of the pinned Bun, hash-checked against the approved executable. A single compiled executable stays optional, as the accepted frame says.

3. **Layout.**

   ```
   releases/<id>/
     manifest.json        identity, source commit and tree, lock hash, Bun version and hash, every file's sha256 and mode
     runtime/bun          the pinned Bun, copied
     app/cli.js           the bundled CLI, `serve` and hooks
     app/dist/viewer/     viewer main.js, public/ and its manifest, the same relative layout the built viewer resolves
     plugin/              the plugin tree, with this release's version in both client manifests
   ```

   Store, configuration and credentials (`~/.agent-bus`) are never in a release and never touched by activation.

4. **The launcher names an exact release, not a moving pointer.** Launcher v2 is `exec '<release>/runtime/bun' --no-env-file '<release>/app/cli.js' "$@"`. Activation then changes exactly one file, the launcher, by atomic rename. The `serve` LaunchAgent's arguments stay the same, so the plist is not rewritten. A hook already waiting keeps the old release's files, which remain in place, and the next hook runs the new one. A `current` symlink would add a second binding with its own race and no benefit.

5. **Plugins come from one stable marketplace.** `<data>/marketplace/` is a real directory holding a fixed `.claude-plugin/marketplace.json`, plus a `plugin` symlink to `../releases/<id>/plugin`. It has to be a real directory because Codex resolves the marketplace root's real path when it is added. A symlink at the top level is therefore invisible to it, which was checked in isolated client homes.

   Refreshing the clients works like this:
   - Claude: flip the link, then `claude plugin marketplace update` and `claude plugin update`.
   - Codex: flip the link, then `codex plugin add`.

   Both upgrade and downgrade were checked in isolated client homes. Each client's marketplace switches from the primary checkout to this directory once, as part of the first activation.

6. **Order activation so guidance never runs ahead of the server.**
   1. Verify the candidate release completely.
   2. Write launcher v2, staged and checked with `--help` under `env -i`.
   3. Restart `serve` with `kickstart`.
   4. Run the health, query-tools and end-to-end checks.
   5. Flip the marketplace link and refresh both clients' plugins.
   6. Run a real Claude wake check.

   Claude reads the installed skill straight from the marketplace path. Its skill text therefore changes at the flip, while hooks change only after the plugin update and a session restart. So the flip comes last, after the server that the new guidance describes is running.

7. **Rollback runs the same sequence for the previous release.** The first rollback boundary is the deployed-shape source binding, launcher v1 with the recorded primary and Bun. The installer keeps accepting v1 launchers, so source → release A → release B → A → source is one rehearsable path. Rollback is limited to commits that keep queries refused or validated ([query tools](../runbooks/deploy.md#query-tools)).

8. **Reject a bad cohort before anything moves.** Verification recomputes every hash, requires the exact file set (nothing missing, nothing extra), and checks modes. It confirms that the copied Bun reports the pinned version and that the bundle reports the manifest's version under `env -i`. A tampered, incomplete or unverifiable release is refused with the launcher, LaunchAgent and marketplace link unchanged. The launcher swap and the marketplace flip can still diverge if a step fails between them. Recovery is to re-run the verified activation for one named release, or keep `serve` stopped behind its guard. The qualification injects that split.

9. **Keep the mechanism small and in the repository.**
   - A build script produces a release only from a clean, committed tree, using a frozen install and the exact pinned Bun.
   - A verify command checks any release directory.
   - The existing installer gains a `--release <dir>` mode. It verifies first, writes launcher v2, and recognises v1 and v2 as owned.
   - A small activate step performs the marketplace flip.

   Build, verify and activate print identities and boolean comparisons only, never file contents.

10. **Retain all legacy material until the first release has been activated and its rollback qualified.** This covers the earlier rollback cohorts, retained installers and runtimes in the data home. After that, superseded cohorts older than the rollback floor can be retired once their hashes are recorded. No cleanup is part of this work.

## Qualification

Qualification follows the accepted frame's complete story. The repository's testing-design steward shapes the method before any test is written.

The release must run from a relocated, unpacked copy, with:
- the staging path absent;
- an unrelated working directory;
- a clean `HOME` and `PATH`;
- no install, build or download step.

One disposable rehearsal must cover the sequence source → A → B → A → source. It runs against an authenticated, throwaway Fluree and a native `serve` under disposable labels, ports and data directory. It records store, configuration and credential sameness as booleans only. It must also show:
- an independent MCP client answering a pinned query and refusing `SERVICE`;
- a shipped CLI join and publish;
- a real installed Claude hook waking an owned idle session that reads correlated mail;
- the production viewer rendering a known pinned row;
- Codex native discovery of the release's plugin;
- read/unread sentinels surviving rollback;
- tamper, incomplete-cohort and split-binding rejection.

One open problem is how the plugins' hooks resolve the launcher. They run `$HOME/.local/bin/agent-bus` by absolute path, so a real-hook trial needs either an isolated `HOME` with an authenticated client, or a hook path the disposable install controls. The steward review settles which, without touching the live launcher.

## Not decided here

This frame does not decide activation of any release on either machine, the viewer LaunchAgent's binding (it can point at a release's viewer later under its own procedure), remote access, or retirement of legacy material.
