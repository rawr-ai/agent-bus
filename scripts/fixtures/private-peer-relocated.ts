// This fixture is bundled separately and run from a directory with no node_modules ancestors.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type * as Identity from "../../src/private-web/identity.ts";
import type * as Program from "../../src/private-web/program.ts";
import type * as Service from "../../src/private-web/service.ts";

const [dir, portText] = process.argv.slice(2);
if (!dir || !portText) throw new Error("Missing isolated fixture inputs.");
const bundle: unknown = await import(pathToFileURL(join(dir, "main.js")).href);
const isBundle = (
  value: unknown
): value is {
  clerkPeerResolver: typeof Identity.clerkPeerResolver;
  servePeer: typeof Program.servePeer;
  decodeServiceConfig: typeof Service.decodeServiceConfig;
  hostConfig: typeof Service.hostConfig;
} =>
  typeof value === "object" &&
  value !== null &&
  "clerkPeerResolver" in value &&
  typeof value.clerkPeerResolver === "function" &&
  "servePeer" in value &&
  typeof value.servePeer === "function" &&
  "decodeServiceConfig" in value &&
  typeof value.decodeServiceConfig === "function" &&
  "hostConfig" in value &&
  typeof value.hostConfig === "function";
if (!isBundle(bundle)) throw new Error("Invalid peer bundle.");
const host: unknown = await import(pathToFileURL(join(dir, "mcp-host.mjs")).href);
if (
  typeof host !== "object" ||
  host === null ||
  !("serveTools" in host) ||
  typeof host.serveTools !== "function"
)
  throw new Error("Invalid host bundle.");
const serveTools = host.serveTools;
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const hostPort = Number(probe.url.port);
probe.stop(true);
const busPort = Number(portText);
const key = randomBytes(32).toString("hex");
const issuer = "https://fixture.invalid";
const resource = `${issuer}/mcp`;
const subject = "fixture";
const config = bundle.decodeServiceConfig({
  schema: "agent-bus-private-web-v1",
  baseUrl: issuer,
  resource,
  port: hostPort,
  ownerSubject: subject,
  provider: {
    issuer,
    userInfo: `${issuer}/userinfo`,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
  },
  grantFile: join(dir, "grant"),
  sessionKeyFile: join(dir, "key"),
  binding: "fixture",
  sources: {
    fixture: { port: busPort, expectedBusVersion: "relocated-peer-fixture" },
    live: { port: hostPort, expectedBusVersion: "unused" },
  },
  oauth: {
    clientId: "fixture",
    clientSecret: "fixture",
    jwtSigningKey: "fixture",
    encryptionKey: "fixture",
    tokenStorageDir: dir,
    allowedRedirectUris: [`${issuer}/callback`],
  },
});
const resolve = bundle.clerkPeerResolver({
  issuer,
  subject,
  resource,
  key: new Uint8Array(32).fill(8),
  identify: async () => subject,
  readGrant: async () => ({ subject, resource, permissions: ["agent-bus:peer"] }),
});
const abort = new AbortController();
const running = bundle.servePeer({
  busPort,
  expectedBusVersion: "relocated-peer-fixture",
  cwd: dir,
  resolveContext: resolve,
  signal: abort.signal,
  runHost: (tools, lifecycle) =>
    serveTools({ ...bundle.hostConfig(config), serverAuth: { type: "apiKey", key } }, tools, {
      ...lifecycle,
      resolveContext: (invocation: Identity.PeerInvocation) =>
        lifecycle.resolveContext({
          ...invocation,
          auth:
            invocation.auth?.authType === "apiKey"
              ? { authType: "oauth", accessToken: "synthetic" }
              : undefined,
        }),
    }),
});
void running.catch(() => undefined);
let client: Client | undefined;
try {
  for (let attempt = 0; attempt < 50 && client === undefined; attempt++) {
    const candidate = new Client({ name: "relocated-fixture", version: "1.0.0" });
    try {
      await candidate.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hostPort}/mcp`), {
          requestInit: { headers: { "x-api-key": key } },
        })
      );
      client = candidate;
    } catch {
      await candidate.close();
      await Bun.sleep(100);
    }
  }
  assert(client);
  const connected = client;
  const call = async (name: string, args: Record<string, unknown>, chat: string) => {
    await Bun.sleep(300);
    const result = await connected.callTool({
      name,
      arguments: args,
      _meta: { "openai/session": chat },
    });
    assert.notEqual(result.isError, true);
    return result.structuredContent;
  };
  await call("bus_join", { address: "chatgpt/bundle-a" }, "a");
  await call("bus_join", { address: "chatgpt/bundle-b" }, "b");
  const sent = await call(
    "bus_publish",
    { from: "chatgpt/bundle-b", to: ["chatgpt/bundle-a"], body: "relocated body" },
    "b"
  );
  const received = await call("bus_read", { address: "chatgpt/bundle-a" }, "a");
  assert(typeof sent === "object" && sent !== null && "id" in sent);
  assert(
    typeof received === "object" &&
      received !== null &&
      "messages" in received &&
      Array.isArray(received.messages)
  );
  assert.equal(received.messages[0]?.id, sent.id);
  assert.equal(received.messages[0]?.body, "relocated body");
  console.log("Relocated private peer and exact host fixture passed.");
} finally {
  await client?.close();
  abort.abort();
  await running.catch(() => undefined);
}
