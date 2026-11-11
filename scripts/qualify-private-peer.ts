// Exact-artifact HTTP qualification against disposable services and synthetic identities only.
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import {
  clerkPeerResolver,
  PEER_PERMISSION,
  type PeerInvocation,
} from "../src/private-web/identity.ts";
import { servePeer } from "../src/private-web/program.ts";
import { decodeServiceConfig, hostConfig } from "../src/private-web/service.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger, stopFlureeServer } from "../test/fluree-server.ts";

const archiveHash = "4c95d202370fa3af4515a5993a659d733682c22f7f95e8bfc4ad834518ca3f4a";
const entryHash = "78ac81acc5bb47bd001efd00d504d2adc42857263d21d32ffc3ddfc57b166642";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Every property path an output schema names, `[]` for array items, through local references. */
const propertyPaths = (schema: unknown): ReadonlyArray<string> => {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const root = record(schema);
  const definitions = { ...record(root.definitions), ...record(root.$defs) };
  const paths = new Set<string>();
  const walk = (node: unknown, path: string, seen: ReadonlySet<string>): void => {
    const shape = record(node);
    if (typeof shape.$ref === "string") {
      const name = shape.$ref.replace(/^#\/(\$defs|definitions)\//, "");
      if (!seen.has(name)) walk(definitions[name], path, new Set([...seen, name]));
    }
    for (const [key, value] of Object.entries(record(shape.properties))) {
      const next = path === "" ? key : `${path}.${key}`;
      paths.add(next);
      walk(value, next, seen);
    }
    if (shape.items !== undefined) walk(shape.items, `${path}[]`, seen);
    for (const branch of [shape.anyOf, shape.oneOf, shape.allOf])
      if (Array.isArray(branch)) for (const member of branch) walk(member, path, seen);
  };
  walk(schema, "", new Set());
  return [...paths].sort();
};
const artifact = process.argv[2];
if (!artifact || hash(readFileSync(artifact)) !== archiveHash)
  throw new Error("Wrong host artifact.");
const dir = mkdtempSync(join(tmpdir(), "agent-bus-peer-qualification-"));
const shutdown = new AbortController();
let disposeBus: (() => Promise<void>) | undefined;
let host: Promise<void> | undefined;
const clients: Client[] = [];
try {
  const extract = Bun.spawnSync(["tar", "-xzf", artifact, "-C", dir, "package/dist/index.js"]);
  if (!extract.success) throw new Error("Could not extract the host entry.");
  const entry = join(dir, "package/dist/index.js");
  if (hash(readFileSync(entry)) !== entryHash) throw new Error("Wrong host entry.");
  const module: unknown = await import(entry);
  if (
    typeof module !== "object" ||
    module === null ||
    !("serveTools" in module) ||
    typeof module.serveTools !== "function"
  )
    throw new Error("Host direct-tool entry unavailable.");
  const serveTools = module.serveTools;
  const port = () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const value = Number(probe.url.port);
    probe.stop(true);
    return value;
  };
  const busPort = port();
  let hostPort = port();
  while (hostPort === busPort) hostPort = port();
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
  const store = layerFluree(await freshLedger("hosted-peer-http")).pipe(Layer.provide(platform));
  const bus = ManagedRuntime.make(
    Serve.layerHttp({ port: busPort, version: "peer-http-fixture" }).pipe(
      Layer.provideMerge(
        Bus.layer("fixture").pipe(
          Layer.provideMerge(store),
          Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
          Layer.provide(platform)
        )
      )
    )
  );
  // Dispose through a closure because the runtime's service type is implementation-specific.
  disposeBus = () => bus.dispose();
  await bus.runPromise(Effect.void);
  const apiKey = randomBytes(32).toString("hex");
  const issuer = "https://fixture-issuer.invalid";
  const subject = "fixture-subject";
  const resource = "https://fixture-resource.invalid/mcp";
  let identified = subject;
  let permitted = true;
  let identityChecks = 0;
  let grantChecks = 0;
  let losePublishResult = false;
  let publishExecutions = 0;
  let waitEntered = false;
  const resolve = clerkPeerResolver({
    issuer,
    subject,
    resource,
    key: new Uint8Array(32).fill(7),
    identify: async () => {
      identityChecks++;
      return identified;
    },
    readGrant: async () => {
      grantChecks++;
      return { subject, resource, permissions: permitted ? [PEER_PERMISSION] : [] };
    },
  });
  const fixtureConfig = decodeServiceConfig({
    schema: "agent-bus-private-web-v1",
    baseUrl: "https://fixture.invalid",
    resource: "https://fixture.invalid/mcp",
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
      fixture: { port: busPort, expectedBusVersion: "peer-http-fixture" },
      live: { port: hostPort, expectedBusVersion: "unused" },
    },
    oauth: {
      clientId: "fixture",
      clientSecret: "fixture",
      jwtSigningKey: "fixture",
      encryptionKey: "fixture",
      tokenStorageDir: dir,
      allowedRedirectUris: ["https://fixture.invalid/callback"],
    },
  });
  try {
    host = servePeer({
      busPort,
      expectedBusVersion: "peer-http-fixture",
      cwd: process.cwd(),
      resolveContext: resolve,
      signal: shutdown.signal,
      runHost: (tools, lifecycle) =>
        serveTools(
          { ...hostConfig(fixtureConfig), serverAuth: { type: "apiKey", key: apiKey } },
          tools.map((tool) => ({
            ...tool,
            execute: async (
              input: Parameters<typeof tool.execute>[0],
              context: Parameters<typeof tool.execute>[1]
            ) => {
              if (tool.name === "bus_wait") waitEntered = true;
              const result = await tool.execute(input, context);
              if (tool.name === "bus_publish" && losePublishResult) {
                publishExecutions++;
                throw new Error("Synthetic loss after committed publish.");
              }
              return result;
            },
          })),
          {
            ...lifecycle,
            resolveContext: (invocation: PeerInvocation) =>
              lifecycle.resolveContext({
                ...invocation,
                auth:
                  invocation.auth?.authType === "apiKey"
                    ? { authType: "oauth", accessToken: "synthetic" }
                    : undefined,
              }),
          }
        ),
    });
    void host.catch(() => undefined);
    const connect = async () => {
      let last: unknown;
      for (let attempt = 0; attempt < 50; attempt++) {
        const client = new Client({ name: "peer-http-qualifier", version: "1" });
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hostPort}/mcp`), {
              requestInit: { headers: { "x-api-key": apiKey } },
            })
          );
          clients.push(client);
          return client;
        } catch (error) {
          last = error;
          await client.close();
          await Bun.sleep(100);
        }
      }
      throw last;
    };
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.length, 16);
    assert(!names.includes("bus_wake"));
    // The host's closed outputs name every field the serve's do, nested ones included. Inputs
    // differ by design (the host supplies session and runtime), so only outputs are compared.
    const native = new Client({ name: "peer-http-qualifier-native", version: "1" });
    await native.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${busPort}/mcp`))
    );
    clients.push(native);
    const outputs = async (from: Client) =>
      new Map(
        (await from.listTools()).tools.map((tool) => [tool.name, propertyPaths(tool.outputSchema)])
      );
    const [hostedOutputs, nativeOutputs] = [await outputs(client), await outputs(native)];
    for (const name of ["bus_publish", "bus_peers"])
      assert.deepEqual(hostedOutputs.get(name), nativeOutputs.get(name), name);
    for (const path of [
      "wake.ledger",
      "wake.t",
      "wake.lacking[].address",
      "wake.lacking[].standing",
      "wake.unlisted",
    ])
      assert(hostedOutputs.get("bus_publish")?.includes(path), path);
    assert(hostedOutputs.get("bus_peers")?.includes("peers[].wake"));
    const call = async (name: string, args: Record<string, unknown>, chat?: string) => {
      await Bun.sleep(300);
      return client.callTool({
        name,
        arguments: args,
        ...(chat === undefined ? {} : { _meta: { "openai/session": chat } }),
      });
    };
    const success = async (name: string, args: Record<string, unknown>, chat?: string) => {
      const result = await call(name, args, chat);
      assert.notEqual(result.isError, true);
      assert(Array.isArray(result.content));
      const text = result.content[0];
      assert(
        typeof text === "object" &&
          text !== null &&
          text.type === "text" &&
          typeof text.text === "string"
      );
      assert.deepEqual(JSON.parse(text.text), result.structuredContent);
      return result.structuredContent;
    };
    const deniedCall = async (name: string, args: Record<string, unknown>, chat: string) => {
      assert.equal((await call(name, args, chat)).isError, true);
    };
    assert.equal((await call("bus_join", { address: "chatgpt/missing" })).isError, true);
    await success("bus_peers", {});
    await success("bus_join", { address: "chatgpt/http-a", topics: ["http-fixture"] }, "chat-a");
    await success("bus_join", { address: "chatgpt/http-b" }, "chat-b");
    assert.equal((await call("bus_read", { address: "chatgpt/http-a" }, "chat-b")).isError, true);
    let waitSettled = false;
    const waiting = success(
      "bus_wait",
      { address: "chatgpt/http-a", timeoutSeconds: 5 },
      "chat-a"
    ).finally(() => {
      waitSettled = true;
    });
    for (let attempt = 0; attempt < 30 && !waitEntered; attempt++) await Bun.sleep(50);
    assert(waitEntered);
    assert.equal(waitSettled, false);
    const sent = await success(
      "bus_publish",
      {
        from: "chatgpt/http-b",
        to: ["#http-fixture"],
        body: "complete fixture body",
        subject: "fixture subject",
      },
      "chat-b"
    );
    const received = await waiting;
    assert(
      typeof sent === "object" && sent !== null && "id" in sent && typeof sent.id === "string"
    );
    assert(
      typeof received === "object" &&
        received !== null &&
        "messages" in received &&
        Array.isArray(received.messages)
    );
    assert.equal(received.messages.length, 1);
    assert.deepEqual(
      {
        id: received.messages[0].id,
        body: received.messages[0].body,
        subject: received.messages[0].subject,
      },
      { id: sent.id, body: "complete fixture body", subject: "fixture subject" }
    );
    const largeBody = 'quoted " backslash \\ euro €\n'.repeat(3_000);
    assert(Buffer.byteLength(JSON.stringify(largeBody), "utf8") > 16_384);
    const large = await success(
      "bus_publish",
      { from: "chatgpt/http-b", to: ["chatgpt/http-a"], body: largeBody },
      "chat-b"
    );
    const largeRead = await success("bus_read", { address: "chatgpt/http-a" }, "chat-a");
    assert(typeof large === "object" && large !== null && "id" in large);
    assert(
      typeof largeRead === "object" &&
        largeRead !== null &&
        "messages" in largeRead &&
        Array.isArray(largeRead.messages)
    );
    assert.equal(largeRead.messages.length, 1);
    assert.equal(largeRead.messages[0].id, large.id);
    assert.equal(largeRead.messages[0].body, largeBody);
    // A direct recipient that never joined is reported through the host's closed output schema.
    const unwoken = await success(
      "bus_publish",
      { from: "chatgpt/http-b", to: ["chatgpt/never-joined"], body: "wake fixture" },
      "chat-b"
    );
    assert(
      typeof unwoken === "object" &&
        unwoken !== null &&
        "wake" in unwoken &&
        typeof unwoken.wake === "object" &&
        unwoken.wake !== null
    );
    const { ledger, t, ...observed } = unwoken.wake as Record<string, unknown>;
    assert.equal(typeof ledger, "string");
    assert(Number.isInteger(t));
    assert.deepEqual(observed, {
      lacking: [{ address: "chatgpt/never-joined", standing: "not-joined" }],
    });
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 999,
      method: "tools/call",
      params: {
        name: "bus_publish",
        arguments: {
          from: "chatgpt/http-b",
          to: ["chatgpt/http-a"],
          body: `oversize-canary${"x".repeat(1_048_576)}`,
        },
        _meta: { "openai/session": "chat-b" },
      },
    });
    assert(
      Buffer.byteLength(oversized, "utf8") > hostConfig(fixtureConfig).httpLimits.maxBodyBytes
    );
    const beforeOversized = identityChecks;
    const rejected = await fetch(`http://127.0.0.1:${hostPort}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": apiKey,
      },
      body: oversized,
    });
    assert.equal(rejected.status, 413);
    assert.equal(identityChecks, beforeOversized);
    identified = "wrong-subject";
    const beforeWrongSubject = { identityChecks, grantChecks };
    await deniedCall("bus_join", { address: "chatgpt/forged" }, "chat-c");
    assert.equal(identityChecks, beforeWrongSubject.identityChecks + 1);
    assert.equal(grantChecks, beforeWrongSubject.grantChecks);
    identified = subject;
    permitted = false;
    const beforeRevocation = { identityChecks, grantChecks };
    await deniedCall("bus_join", { address: "chatgpt/ungranted" }, "chat-c");
    assert.equal(identityChecks, beforeRevocation.identityChecks + 1);
    assert.equal(grantChecks, beforeRevocation.grantChecks + 1);
    permitted = true;
    const holdings = await success("bus_owned_addresses", {}, "chat-a");
    assert.deepEqual(holdings, { addresses: ["chatgpt/http-a"] });
    const peers = await success("bus_peers", {});
    assert(
      typeof peers === "object" && peers !== null && "peers" in peers && Array.isArray(peers.peers)
    );
    assert(
      !peers.peers.some((peer) => ["chatgpt/forged", "chatgpt/ungranted"].includes(peer.address))
    );
    losePublishResult = true;
    await deniedCall(
      "bus_publish",
      { from: "chatgpt/http-b", to: ["chatgpt/http-a"], body: "one-after-loss" },
      "chat-b"
    );
    losePublishResult = false;
    assert.equal(publishExecutions, 1);
    const history = await success("bus_history", { participant: "chatgpt/http-b" }, "chat-b");
    assert(
      typeof history === "object" &&
        history !== null &&
        "messages" in history &&
        Array.isArray(history.messages)
    );
    assert.equal(history.messages.filter((message) => message.body === "one-after-loss").length, 1);
    assert(
      !history.messages.some(
        (message) => typeof message.body === "string" && message.body.startsWith("oversize-canary")
      )
    );
    console.log("Exact host HTTP metadata and interactive peer fixture passed.");
  } finally {
    for (const client of clients) await client.close();
    shutdown.abort();
    await host?.catch(() => undefined);
  }
} finally {
  shutdown.abort();
  await host?.catch(() => undefined);
  await disposeBus?.();
  await stopFlureeServer();
  rmSync(dir, { recursive: true, force: true });
}
