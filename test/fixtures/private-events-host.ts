// This child runs the real Events adapter and packed public host against the disposable Bus.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { eventsProgram } from "../../src/private-web/events.ts";
import { clerkPeerIdentity } from "../../src/private-web/identity.ts";
import { busPeer, peerTools } from "../../src/private-web/peer.ts";
import { readPrivateJson } from "../../src/private-web/service.ts";

const config = JSON.parse(readFileSync(process.argv.at(-1) ?? "", "utf8")) as {
  readonly entry: string;
  readonly busPort: number;
  readonly hostPort: number;
  readonly providerPort: number;
  readonly oauthDir: string;
  readonly eventsPath: string;
  readonly eventsKey: string;
  readonly firstGrant: string;
  readonly secondGrant: string;
  readonly coverageTrace: string;
};
const host: typeof import("mcp-openapi") = await import(config.entry);
const base = `http://127.0.0.1:${config.hostPort}`;
const upstream = `http://127.0.0.1:${config.providerPort}`;
const resource = `${base}/mcp`;
const identity = clerkPeerIdentity({
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
    throw new Error("Unknown synthetic identity.");
  },
  readGrant: async (file) => readPrivateJson(file, 4096),
});
const peer = await busPeer({ busPort: config.busPort, expectedBusVersion: "events-fixture" });
const wake = {
  ...peer.wake,
  observe: async (...args: Parameters<typeof peer.wake.observe>) => {
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
    return peer.wake.observe(...args);
  },
};
const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());
try {
  await host.serveTools(
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
    peerTools(peer.exchange, process.cwd()),
    {
      resolveContext: identity.resolvePeer,
      signal: shutdown.signal,
      events: eventsProgram({
        identity,
        wake,
        resource,
        storage: {
          path: config.eventsPath,
          maxBytes: 16 * 1024 * 1024,
          encryptionKey: config.eventsKey,
        },
      }),
    }
  );
} finally {
  await peer.dispose();
}
