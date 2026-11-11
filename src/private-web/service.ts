import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { clerkPeerResolver, discoverProvider, identifyOwner, Provider } from "./identity.ts";
import { servePeer } from "./program.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const Source = Schema.Struct({ port: Port, expectedBusVersion: Text });
export const ServiceConfig = Schema.Struct({
  schema: Schema.Literal("agent-bus-private-web-v1"),
  baseUrl: Text,
  resource: Text,
  port: Port,
  ownerSubject: Text,
  provider: Provider,
  grantFile: Text,
  sessionKeyFile: Text,
  binding: Schema.Literals(["fixture", "live"]),
  sources: Schema.Struct({ fixture: Source, live: Source }),
  oauth: Schema.Struct({
    clientId: Text,
    clientSecret: Text,
    jwtSigningKey: Text,
    encryptionKey: Text,
    tokenStorageDir: Text,
    allowedRedirectUris: Schema.Array(Text).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
      Schema.isUnique()
    ),
  }),
});

const invalid = () => new Error("Invalid private peer configuration.");

/** Private runtime files are explicit, bounded regular files of this OS user, never dotenv. */
export const readPrivateJson = (path: string, maximum = 32_768): unknown => {
  if (!isAbsolute(path)) throw invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > maximum
    )
      throw invalid();
    const bytes = readFileSync(fd);
    if (bytes.byteLength > maximum) throw invalid();
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
};

export const decodeServiceConfig = (input: unknown) => {
  const config = Schema.decodeUnknownSync(ServiceConfig, { onExcessProperty: "error" })(input);
  const base = new URL(config.baseUrl);
  const resource = new URL(config.resource);
  if (
    base.protocol !== "https:" ||
    base.origin !== config.baseUrl ||
    resource.href !== config.resource ||
    resource.origin !== base.origin ||
    resource.pathname !== "/mcp" ||
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash ||
    !isAbsolute(config.grantFile) ||
    !isAbsolute(config.sessionKeyFile) ||
    !isAbsolute(config.oauth.tokenStorageDir) ||
    config.sources.fixture.port === config.sources.live.port
  )
    throw invalid();
  for (const value of config.oauth.allowedRedirectUris) {
    const callback = new URL(value);
    if (
      callback.protocol !== "https:" ||
      callback.hostname.includes("*") ||
      callback.username ||
      callback.password ||
      callback.hash ||
      callback.href !== value
    )
      throw invalid();
  }
  return config;
};

export const hostConfig = (config: typeof ServiceConfig.Type) => ({
  name: "Agent Bus",
  version: "1.0.0",
  transport: "httpStream" as const,
  host: "127.0.0.1",
  port: config.port,
  endpoint: "/mcp",
  serverAuth: {
    type: "oauth" as const,
    baseUrl: config.baseUrl,
    resource: config.resource,
    authorizationEndpoint: config.provider.authorizationEndpoint,
    tokenEndpoint: config.provider.tokenEndpoint,
    scopes: ["openid", "profile", "email", "offline_access"],
    ...config.oauth,
  },
  httpLimits: {
    maxHeaderSize: 16_384,
    headersTimeout: 5_000,
    requestTimeout: 10_000,
    connectionsCheckingInterval: 1_000,
    keepAliveTimeout: 5_000,
    maxConnections: 16,
    // Covers the maximum escaped native SPARQL input and bounded directory updates;
    // ordinary messages have no native size limit, so this remains a hosted limit.
    maxBodyBytes: 1_048_576,
    maxInflightRequests: 16,
    maxConcurrentWork: 8,
    rate: { requestsPerSecond: 4, burst: 8 },
    oauth: {
      maxConcurrentWork: 2,
      maxTransactions: 32,
      maxAuthorizationCodes: 32,
      upstreamTimeoutMs: 5_000,
    },
  },
});
type RunHost = (
  config: ReturnType<typeof hostConfig>,
  ...program: Parameters<Parameters<typeof servePeer>[0]["runHost"]>
) => Promise<void>;

export const decodeSessionKey = (value: unknown) => {
  const { key } = Schema.decodeUnknownSync(Schema.Struct({ key: Text }), {
    onExcessProperty: "error",
  })(value);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw invalid();
  const bytes = Buffer.from(key, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== key) throw invalid();
  return bytes;
};

/** Entry of the private consumer bundle. Its adapter imports only the checksum-pinned direct host. */
export const runPrivatePeer = async (options: {
  readonly configFile: string;
  readonly runHost: RunHost;
  readonly signal?: AbortSignal;
}) => {
  const runtime = ManagedRuntime.make(FetchHttpClient.layer);
  try {
    const config = decodeServiceConfig(readPrivateJson(options.configFile));
    const provider = await runtime.runPromise(discoverProvider(config.provider), {
      signal: options.signal,
    });
    const selected = config.sources[config.binding];
    await servePeer({
      busPort: selected.port,
      expectedBusVersion: selected.expectedBusVersion,
      cwd: process.cwd(),
      resolveContext: clerkPeerResolver({
        issuer: provider.issuer,
        subject: config.ownerSubject,
        resource: config.resource,
        key: decodeSessionKey(readPrivateJson(config.sessionKeyFile, 4096)),
        identify: (token, signal) => runtime.runPromise(identifyOwner(provider, token), { signal }),
        readGrant: async () => readPrivateJson(config.grantFile, 4096),
      }),
      runHost: (tools, lifecycle) => options.runHost(hostConfig(config), tools, lifecycle),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new Error("Private peer service could not start or complete.");
  } finally {
    await runtime.dispose();
  }
};
