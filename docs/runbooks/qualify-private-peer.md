# Qualify the hosted peer fixture

Exercise the hosted peer projection and its pinned direct host against a disposable Bus and synthetic identity. This does not qualify ChatGPT, real OAuth, the permanent connection or a live Bus. The [connections reference](../architecture/connections.md) describes the trust boundary.

## Before you start

Use a development worktree with frozen dependencies, the pinned Bun and Fluree on `PATH`, and `openssl` available for a disposable local certificate. The tests start a supervised disposable Fluree instance and never load live credentials or a live ledger.

## Run the fixture

1. Run the local identity and real-Bus peer tests:

   ```sh
   bun --no-env-file test test/private-web-identity.test.ts test/private-web-peer.test.ts
   ```

   Expected: provider and grant checks pass; separate synthetic conversations join and exchange mail, ownership refusals preserve unread mail, reconnect recovers the same holding, and takeover and ambiguous-result checks pass. *Rehearsed 2026-11-11.*

2. Supply the exact privately obtained host artifact to the HTTP fixture:

   ```sh
   bun --no-env-file scripts/qualify-private-peer.ts /absolute/path/to/mcp-openapi-1.0.0.tgz
   ```

   Expected: the script verifies the archive and bundled entry checksums before loading them, then uses synthetic API-key and provider proof with the actual direct host and official HTTP client. Separate conversation metadata reaches the peer, a waiting conversation receives another's publication, wrong subject and grant are refused, and an injected post-publication response loss produces one stored message. The synthetic failure is not a dropped-transport test. Fixture services stop and temporary files are removed. *Rehearsed 2026-11-11.*

3. Build and qualify a private review bundle in an existing private directory:

   ```sh
   bun --no-env-file scripts/build-private-peer.ts /absolute/path/to/mcp-openapi-1.0.0.tgz /absolute/path/to/private-output
   bun --no-env-file scripts/qualify-private-bundle.ts /absolute/path/to/private-output/private-peer-PRINTED-SUFFIX
   ```

   Expected: the builder verifies the exact host and prints a new review directory with its checksum manifest. The qualifier copies it away from the checkout, checks there are no `node_modules` ancestors, starts its entry with a synthetic private config and local HTTPS discovery provider, checks the unauthenticated OAuth challenge, then exercises joined peer messaging through the relocated bundle. Supervised children and temporary files are removed. The working-tree source is not attested by this review manifest. *Rehearsed 2026-11-11.*

4. Do not bind a live Bus on this fixture evidence alone. A separate [actual-client check](../platforms/mcp-openapi.md#direct-host-and-http-admission) exercised fresh OAuth and two conversations against a disposable ledger; live activation and the remaining untested behaviors still need their own review and qualification. *Unverified: live Bus activation has not been rehearsed by this procedure.*

## If it fails

Check the pinned runtime and fixture output. Identify any fixture process by its own supervisor before stopping it; never kill by a shared pattern or touch the installed Bus. For installed-service recovery, see [recover](recover.md).
