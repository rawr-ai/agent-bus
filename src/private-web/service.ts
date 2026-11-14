import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { eventsProgram } from "./events.ts";
import { clerkPeerIdentity, discoverProvider, identifyOwner, Provider } from "./identity.ts";
import { servePeer } from "./program.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const Source = Schema.Struct({ port: Port, expectedBusVersion: Text });
export const ServiceConfig = Schema.Struct({
  schema: Schema.Literal("agent-bus-private-web-v2"),
  baseUrl: Text,
  resource: Text,
  port: Port,
  principals: Schema.Array(Schema.Struct({ subject: Text, grantFile: Text })).check(
    Schema.isMinLength(1)
  ),
  provider: Provider,
  sessionKeyFile: Text,
  events: Schema.optionalKey(
    Schema.Struct({
      storagePath: Text,
      maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1_048_576, maximum: 67_108_864 })),
      encryptionKeyFile: Text,
    })
  ),
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
const within = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

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
    new Set(config.principals.map(({ subject }) => subject)).size !== config.principals.length ||
    new Set(config.principals.map(({ grantFile }) => grantFile)).size !==
      config.principals.length ||
    config.principals.some(({ grantFile }) => !isAbsolute(grantFile)) ||
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
  if (config.events !== undefined) {
    const { storagePath, encryptionKeyFile } = config.events;
    if (
      !isAbsolute(storagePath) ||
      !isAbsolute(encryptionKeyFile) ||
      resolve(storagePath) !== storagePath ||
      resolve(encryptionKeyFile) !== encryptionKeyFile ||
      storagePath === encryptionKeyFile ||
      [storagePath, encryptionKeyFile].some(
        (path) =>
          path === resolve(config.sessionKeyFile) ||
          config.principals.some(({ grantFile }) => path === resolve(grantFile)) ||
          within(resolve(config.oauth.tokenStorageDir), path)
      )
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

export const decodeEventsKey = (
  value: unknown,
  sessionKey: Uint8Array,
  oauthSecrets: ReadonlyArray<string>
) => {
  const { key } = Schema.decodeUnknownSync(Schema.Struct({ key: Text }), {
    onExcessProperty: "error",
  })(value);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw invalid();
  const bytes = Buffer.from(key, "base64");
  if (
    bytes.length !== 32 ||
    bytes.toString("base64") !== key ||
    bytes.equals(sessionKey) ||
    oauthSecrets.some((secret) => secret === key || secret === bytes.toString("base64url"))
  )
    throw invalid();
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
    const sessionKey = decodeSessionKey(readPrivateJson(config.sessionKeyFile, 4096));
    const eventsKey =
      config.events === undefined
        ? undefined
        : decodeEventsKey(readPrivateJson(config.events.encryptionKeyFile, 4096), sessionKey, [
            config.oauth.encryptionKey,
            config.oauth.jwtSigningKey,
            config.oauth.clientSecret,
          ]);
    if (
      config.events !== undefined &&
      (config.events.storagePath === resolve(options.configFile) ||
        config.events.encryptionKeyFile === resolve(options.configFile) ||
        eventsKey === undefined)
    )
      throw invalid();
    const provider = await runtime.runPromise(discoverProvider(config.provider), {
      signal: options.signal,
    });
    const selected = config.sources[config.binding];
    const identity = clerkPeerIdentity({
      issuer: provider.issuer,
      principals: config.principals,
      resource: config.resource,
      key: sessionKey,
      identify: (token, signal) => runtime.runPromise(identifyOwner(provider, token), { signal }),
      readGrant: async (grantFile) => readPrivateJson(grantFile, 4096),
    });
    const events = config.events;
    await servePeer({
      busPort: selected.port,
      expectedBusVersion: selected.expectedBusVersion,
      cwd: process.cwd(),
      resolveContext: identity.resolvePeer,
      ...(events === undefined || eventsKey === undefined
        ? {}
        : {
            events: (wake: Parameters<typeof eventsProgram>[0]["wake"]) =>
              eventsProgram({
                identity,
                wake,
                resource: config.resource,
                storage: {
                  path: events.storagePath,
                  maxBytes: events.maxBytes,
                  encryptionKey: eventsKey.toString("base64"),
                },
              }),
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
