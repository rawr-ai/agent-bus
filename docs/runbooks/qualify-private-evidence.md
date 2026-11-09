# Qualify private evidence locally

Run the private evidence candidate against a disposable ledger and the exact owned direct-tool MCP host. The [tool contract](../architecture/interfaces.md#private-evidence-tools), [trust boundary](../architecture/connections.md#private-evidence-facade) and [host evidence](../platforms/mcp-openapi.md) are separate. This procedure neither starts nor modifies an installed Bus.

## Before you start

Use a development worktree with installed frozen dependencies. Put the repository's pinned Bun and the [qualified Fluree executable](../platforms/README.md#installed-versions) first on `PATH`. Obtain the checksum-pinned tarball privately from its owner; do not substitute the host's checkout or add the tarball to this repository. No OAuth, tunnel, real credentials, ChatGPT connection or live ledger is used.

## Run the disposable checks

1. Confirm runtime selection and run the native shared-permit and unread checks:

   ```sh
   bun --version
   fluree --version
   bun --no-env-file test test/query.test.ts -t 'evidence admission|evidence reads'
   ```

   Expected: a stalled pin and a queued saved query release local permits at their deadlines while the fixture has not answered. A later local query can use the returned permit, and evidence reads leave unread mail and its wake mark unchanged. *Rehearsed 2026-11-09.*

2. Run the owned host and official MCP client against a new fixture:

   ```sh
   bun --no-env-file run qualify:private-web /absolute/path/to/mcp-openapi-cdb182c1695db3bb.tgz
   ```

   Expected: checksum verification before install, exactly four tools, access and schema refusals, pinned evidence and distinct unavailable-evidence signals, continuation and restart checks, body byte measurement, and saturation and recovery after a disconnected read. The qualifier stops its host and disposable Fluree server and removes its temporary install. *Rehearsed 2026-11-09.*

## If it fails

Do not retry with an unverified artifact or a running ledger. Check the runtime selections and [artifact identity](../platforms/mcp-openapi.md) and retain only sanitized phase results. If a process outlived interruption, identify the fixture's supervisor and child before stopping either; never kill by a shared pattern or touch the installed Bus. For installed-service recovery, use [recover](recover.md).

Success is local qualification only. Do not use it to start a web trial or disclose live evidence.

The application boundary is `serveEvidence` in `src/private-web/program.ts`: it opens the loopback reader before binding, gives the direct host exactly four tools and the per-invocation owner resolver, and disposes the reader only after the host settles. The fixture exercises this boundary with the exact host artifact and synthetic provider proof. A separately authorized trial would need a dedicated Bun entry binding the approved host settings and an active provider verifier. There is no live startup command, deployment configuration or real verifier here.
