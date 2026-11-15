// This child runs the real Events adapter and packed public host against the disposable Bus.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { authorizationDiagnostics } from "../../src/private-web/events.ts";
import type * as PeerBundle from "../../src/private-web/main.ts";
import type { wakePort } from "../../src/private-web/peer.ts";
import { readPrivateJson } from "../../src/private-web/service.ts";
import { WatchAuthority } from "../../src/private-web/watch-authority.ts";

const config = JSON.parse(readFileSync(process.argv.at(-1) ?? "", "utf8")) as {
  readonly entry: string;
  readonly peerEntry: string;
  readonly busPort: number;
  readonly hostPort: number;
  readonly providerPort: number;
  readonly oauthDir: string;
  readonly eventsPath: string;
  readonly eventsKey: string;
  readonly firstGrant: string;
  readonly secondGrant: string;
  readonly coverageTrace: string;
  readonly authorizationTrace: string;
  readonly bindingTrace: string;
};
const host: typeof import("mcp-openapi") = await import(config.entry);
const candidate: unknown = await import(pathToFileURL(config.peerEntry).href);
const isPeerBundle = (
  value: unknown
): value is Pick<
  typeof PeerBundle,
  "clerkPeerIdentity" | "servePeer" | "prepareWatchTool" | "eventsProgram"
> =>
  typeof value === "object" &&
  value !== null &&
  "clerkPeerIdentity" in value &&
  typeof value.clerkPeerIdentity === "function" &&
  "servePeer" in value &&
  typeof value.servePeer === "function" &&
  "prepareWatchTool" in value &&
  typeof value.prepareWatchTool === "function" &&
  "eventsProgram" in value &&
  typeof value.eventsProgram === "function";
if (!isPeerBundle(candidate)) throw new Error("Invalid relocated peer bundle.");
const base = `http://127.0.0.1:${config.hostPort}`;
const upstream = `http://127.0.0.1:${config.providerPort}`;
const resource = `${base}/mcp`;
const identity = candidate.clerkPeerIdentity({
  issuer: "https://synthetic-issuer.invalid",
  principals: [
    { subject: "fixture-first", grantFile: config.firstGrant },
    { subject: "fixture-second", grantFile: config.secondGrant },
  ],
  resource,
  key: new Uint8Array(32).fill(7),
  identify: async (token) => {
    if (token === "synthetic-first") return "fixture-first";
    if (token === "synthetic-second") return "fixture-second";
    if (token === "synthetic-unmapped") return "fixture-unmapped";
    throw new Error("Unknown synthetic identity.");
  },
  readGrant: async (file) => readPrivateJson(file, 4096),
});
let capturedBinding = false;
const traceWake = (wake: ReturnType<typeof wakePort>) => ({
  ...wake,
  observe: async (...args: Parameters<typeof wake.observe>) => {
    const coverage = args[0].previousCoverage;
    if (coverage !== undefined) {
      const digest = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const ids = [...coverage.rung].sort();
      const { binding, cursor } = coverage;
      appendFileSync(
        config.coverageTrace,
        `${JSON.stringify({
          count: ids.length,
          idsDigest: digest(ids),
          bytes: Buffer.byteLength(JSON.stringify(coverage)),
          canonicalFullCoverageDigest: digest([
            binding.address,
            binding.session,
            binding.runtime,
            binding.installation,
            binding.incarnation,
            binding.run,
            cursor,
            ids,
          ]),
        })}\n`
      );
    }
    const observed = await wake.observe(...args);
    if (!capturedBinding) {
      appendFileSync(config.bindingTrace, `${JSON.stringify(observed.binding)}\n`, { mode: 0o600 });
      capturedBinding = true;
    }
    return observed;
  },
});
const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());
let authority: WatchAuthority | undefined;
try {
  authority = new WatchAuthority({ eventsPath: config.eventsPath, resource });
  const activeAuthority = authority;
  await candidate.servePeer({
    busPort: config.busPort,
    expectedBusVersion: "events-fixture",
    cwd: process.cwd(),
    resolveContext: identity.resolvePeer,
    signal: shutdown.signal,
    prepareWatch: (wake) =>
      candidate.prepareWatchTool({ identity, wake: traceWake(wake), authority: activeAuthority }),
    events: (wake) =>
      candidate.eventsProgram({
        identity,
        wake: traceWake(wake),
        authority: activeAuthority,
        resource,
        diagnostics: authorizationDiagnostics(true, (line) =>
          appendFileSync(config.authorizationTrace, `${line}\n`)
        ),
        storage: {
          path: config.eventsPath,
          maxBytes: 16 * 1024 * 1024,
          encryptionKey: config.eventsKey,
        },
      }),
    runHost: (tools, lifecycle) =>
      host.serveTools(
        {
          name: "Agent Bus Events qualification",
          version: "1.0.0",
          transport: "httpStream",
          host: "127.0.0.1",
          port: config.hostPort,
          endpoint: "/mcp",
          serverAuth: {
            type: "oauth",
            baseUrl: base,
            resource,
            authorizationEndpoint: `${upstream}/authorize`,
            tokenEndpoint: `${upstream}/token`,
            clientId: "fixture-client",
            clientSecret: "fixture-secret",
            tokenEndpointAuthMethod: "client_secret_post",
            allowedRedirectUris: ["http://127.0.0.1:49171/callback"],
            scopes: ["read"],
            jwtSigningKey: "fixture-signing-key-only",
            encryptionKey: "fixture-oauth-key-only",
            tokenStorageDir: config.oauthDir,
          },
          httpLimits: {
            maxHeaderSize: 16_384,
            headersTimeout: 5_000,
            requestTimeout: 10_000,
            connectionsCheckingInterval: 1_000,
            keepAliveTimeout: 5_000,
            maxConnections: 16,
            maxBodyBytes: 1_048_576,
            maxInflightRequests: 16,
            maxConcurrentWork: 8,
            rate: { requestsPerSecond: 100, burst: 100 },
            oauth: {
              maxConcurrentWork: 2,
              maxTransactions: 32,
              maxAuthorizationCodes: 32,
              upstreamTimeoutMs: 5_000,
            },
          },
        },
        tools,
        lifecycle
      ),
  });
} finally {
  await authority?.close();
}
