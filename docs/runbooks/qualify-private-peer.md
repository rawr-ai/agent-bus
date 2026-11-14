# Qualify the hosted peer fixture

Exercise the hosted peer projection and its pinned direct host against a disposable Bus and synthetic identity. This does not qualify ChatGPT, a real upstream identity provider, the permanent connection or a live Bus. The [connections reference](../architecture/connections.md) describes the trust boundary.

## Before you start

Use a development worktree, the pinned Bun and Fluree on `PATH`, `gh` with access to the private host repository, and `openssl` for a disposable local certificate. The tests start a supervised disposable Fluree instance and never load live provider credentials or a live ledger.

The Events consumer uses the genuine host package's exported types, not copied interfaces. The full developer installation has an explicit private-artifact prerequisite. Authenticate the GitHub CLI through the normal external credential mechanism, download the released archive into its ignored relative location, and verify the externally anchored SHA-256 before the normal frozen Bun install. From the checkout root:

```sh
mkdir -p dist/private-artifacts
gh release download v1.2.0-events.2 --repo rawr-ai/mcp-openapi \
  --pattern mcp-openapi-1.2.0-events.2.tgz --dir dist/private-artifacts
HOST_ARCHIVE="$PWD/dist/private-artifacts/mcp-openapi-1.2.0-events.2.tgz"
printf '%s  %s\n' 6c6091e6a97d0e75ecf0ec9e03fa4901cc985b2e0d76c6aab52ed3ca1ac82c25 "$HOST_ARCHIVE" | shasum -a 256 -c -
bun install --frozen-lockfile
```

Bun owns package installation and declarations through the relative `file:` dev dependency; no script extracts into `node_modules`. Keep the archive ignored and out of Git. A cold `bun install` cannot acquire the private release by itself, and an anonymous public checkout cannot complete this full developer install without authorized artifact access. CI needs separately authorized private-repository access; the public repository's ordinary token does not imply it. Never put credentials, transient signed URLs or absolute local paths into the manifest or lockfile. The separate runtime bundle still checks both archive and bundled-entry identities before import. These steps do not select a live bundle or change service configuration. *Rehearsed 2026-11-14: clean frozen install with an isolated cache preserved the manifest/lock and installed the released module/declaration bytes; a separate empty-cache install without the archive refused with the manifest/lock unchanged.*

## Run the fixture

1. Run the local identity, Events callback and real-Bus peer tests:

   ```sh
   bun --no-env-file test test/private-web-identity.test.ts test/private-web-events.test.ts test/private-web-peer.test.ts test/wake-observation.test.ts
   ```

   Expected: provider and independent per-principal grant checks pass; distinct synthetic principals with the same conversation correlation and one principal with distinct correlations join and exchange mail. Reciprocal foreign inbox refusals preserve each pending message for its rightful reader, and reconnect recovers the same holding. The cross-principal takeover is an intentionally authorized transfer, not an isolation proof; takeover and ambiguous-result checks pass. Events capture follows current eligibility without consuming mail; continuing authority survives a later read, mute or inactivity but refuses a stale holding or revoked grant. Complete checkpoints, deterministic timestamps and occurrence identity are checked independently of callback delivery. *Rehearsed 2026-11-14 with the released dependency, disposable services and synthetic principals.*

2. Supply the exact privately obtained host artifact to the HTTP fixture:

   ```sh
   bun --no-env-file scripts/qualify-private-peer.ts "$HOST_ARCHIVE"
   ```

   Expected: the script verifies the archive and bundled entry checksums before loading them, then uses synthetic API-key and provider proof with the actual direct host and official HTTP client. The host's `bus_publish` and `bus_peers` output schemas name the same properties as the serve's, including `wake`. Separate conversation metadata reaches the peer, a waiting conversation receives another's publication, a publication to a never-joined address returns its `wake` notice through the host, wrong subject and grant are refused, and an injected post-publication response loss produces one stored message. The synthetic failure is not a dropped-transport test. Fixture services stop and temporary files are removed. *Rehearsed 2026-11-14.*

3. Build and qualify a private review bundle in an existing private directory:

   ```sh
   bun --no-env-file scripts/build-private-peer.ts "$HOST_ARCHIVE" /absolute/path/to/private-output
   bun --no-env-file scripts/qualify-private-bundle.ts /absolute/path/to/private-output/private-peer-PRINTED-SUFFIX
   ```

   Expected: the builder verifies the exact host and prints a new review directory with its checksum manifest. The qualifier copies it away from the checkout, checks there are no `node_modules` ancestors, starts its entry with a synthetic private config and local HTTPS provider, and checks the unauthenticated OAuth challenge. A separate fixture then invokes the relocated bundle's real `runPrivatePeer` with two provider subjects and protected grants, exercising independent grant failure and recovery, shared-correlation ownership refusal and preserved unread mail through the exact host and a disposable Bus. Its API-key-to-synthetic-token adapter is not actual OAuth evidence. Supervised children and temporary files are removed. The working-tree source is not attested by this review manifest. *Rehearsed 2026-11-14.*

4. Exercise the optional Events program through the same exact host archive:

   ```sh
   bun --no-env-file scripts/qualify-private-events.ts "$HOST_ARCHIVE"
   ```

   Expected: the fixture verifies archive and bundled-entry checksums, then uses public native OAuth registration, consent and PKCE against a synthetic upstream provider. Actual production callbacks and a disposable Bus/Fluree exercise address-only signed notices, foreign conversation/account/grant refusals, captured-notice retry after an owner read and host restart, account-only unsubscribe after grant loss, requested lease expiry and independent native-access expiry. A 120-ID checkpoint exceeds 4 KiB and restores the exact published ID set and canonical binding/cursor/ID-set digest after the old host has fully exited. `--case checkpoint` and `--case native-expiry` select only those discriminators; neither replaces the full fixture. The native-expiry case requests a longer lease, checks its required native-expiry clamp, an expired-bearer 401 and a fresh-authorization delivery control; it does not isolate native rechecking from that required persisted lease expiry. Callback admission uses an isolated test-only DNS/TLS dial redirect, not an actual public callback destination. Supervised children and temporary files are removed. *Rehearsed 2026-11-14 against the released artifact.*

5. Keep fixture, source adoption and client outcomes separate. Building or qualifying a review bundle does not select it for an installed service. Follow [deploy](deploy.md#when-a-hosted-peer-is-connected) only under a separately authorized deployment. The existing [actual-client check](../platforms/mcp-openapi.md#direct-host-and-http-admission) exercised fresh OAuth and two conversations against a disposable ledger; it did not exercise Events. Before claiming automatic hosted wake, the intended client must actually discover and subscribe to `mail.wake`, accept its verified callback, and cause the rightful conversation to read its own mail. A callback receipt, an unrelated model turn or shared-history lookup is not that chain. A late notice may correctly lead to an empty read, and retries may repeat the same notice; they do not permit another conversation's inbox or bypass ordinary tool authorization. *Unverified: actual-client Events and live Bus activation have not been rehearsed by this procedure.*

## If it fails

Check the pinned runtime and fixture output. A checksum mismatch refuses before host import; obtain the intended artifact rather than relaxing the check. Enabled Events with incompatible storage/key or unsupported native authorization must refuse rather than silently fall back to tools-only operation; omission of Events is the intentional disabled mode. Identify any fixture process by its own supervisor before stopping it; never kill by a shared pattern or touch the installed Bus. For installed-service recovery, see [recover](recover.md).
