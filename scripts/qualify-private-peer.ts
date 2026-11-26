// Exact-artifact HTTP qualification against disposable services and synthetic identities only.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import { layerFluree } from "../src/Fluree.ts";
import {
  clerkPeerResolver,
  PEER_PERMISSION,
  type PeerInvocation,
  peerSession,
} from "../src/private-web/identity.ts";
import { servePeer } from "../src/private-web/program.ts";
import { decodeServiceConfig, hostConfig } from "../src/private-web/service.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger, stopFlureeServer } from "../test/fluree-server.ts";
import {
  archiveHash,
  digest,
  hostForQualification,
  modernHttp,
  modernRequest,
  protocolVersion,
} from "./private-modern-http.ts";

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
const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    bundle: { type: "string" },
    expect: { type: "string" },
    commit: { type: "string" },
    tree: { type: "string" },
  },
});
const [artifact] = positionals;
if (
  positionals.length !== 1 ||
  !artifact ||
  !isAbsolute(artifact) ||
  (values.bundle === undefined && values.expect !== undefined) ||
  (values.commit === undefined) !== (values.tree === undefined) ||
  (values.commit !== undefined && values.expect === undefined) ||
  digest(artifact) !== archiveHash
)
  throw new Error(
    "Supply the absolute host archive and optional --bundle directory --expect digest [--commit id --tree id]."
  );
const dir = mkdtempSync(join(tmpdir(), "agent-bus-peer-qualification-"));
const shutdown = new AbortController();
let disposeBus: (() => Promise<void>) | undefined;
let host: Promise<void> | undefined;
const clients: Client[] = [];
try {
  const expected =
    values.expect === undefined
      ? undefined
      : {
          manifestSha256: values.expect,
          source:
            values.commit === undefined ? undefined : { commit: values.commit, tree: values.tree! },
        };
  const entry = hostForQualification(artifact, dir, values.bundle, expected);
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
        Bus.layer("fixture").pipe(Layer.provideMerge(store), Layer.provide(platform))
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
  const identityKey = new Uint8Array(32).fill(7);
  const resolved: Array<{ correlation: unknown; session: string | undefined; marker: unknown }> =
    [];
  const executed: Array<{ correlation: unknown; session: string | undefined; marker: unknown }> =
    [];
  let releaseSlow = () => {};
  let reportSlow = () => {};
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const slowEntered = new Promise<void>((resolve) => {
    reportSlow = resolve;
  });
  const resolve = clerkPeerResolver({
    issuer,
    principals: [{ subject, grantFile: join(dir, "grant") }],
    resource,
    key: identityKey,
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
    schema: "agent-bus-private-web-v2",
    baseUrl: "https://fixture.invalid",
    resource: "https://fixture.invalid/mcp",
    port: hostPort,
    principals: [{ subject, grantFile: join(dir, "grant") }],
    provider: {
      issuer,
      userInfo: `${issuer}/userinfo`,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
    },
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
              executed.push({
                correlation: context.requestMeta?.["openai/session"],
                session: context.actor.session,
                marker: context.requestMeta?.["fixture/resolver"],
              });
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
            resolveContext: async (invocation: PeerInvocation) => {
              if (invocation.requestMeta?.["fixture/resolver"] === "slow") {
                reportSlow();
                await slowGate;
              }
              const actor = await lifecycle.resolveContext({
                ...invocation,
                auth:
                  invocation.auth?.authType === "apiKey"
                    ? { authType: "oauth", accessToken: "synthetic" }
                    : undefined,
              });
              resolved.push({
                correlation: invocation.requestMeta?.["openai/session"],
                session: actor.session,
                marker: invocation.requestMeta?.["fixture/resolver"],
              });
              return actor;
            },
          }
        ),
    });
    void host.catch(() => undefined);
    const connect = async () => {
      let last: unknown;
      for (let attempt = 0; attempt < 50; attempt++) {
        const client = modernHttp(
          `http://127.0.0.1:${hostPort}/mcp`,
          "peer-http-qualifier",
          { "x-api-key": apiKey },
          { name: "Agent Bus", version: "1.0.0" }
        );
        try {
          await client.discover();
          return client;
        } catch (error) {
          last = error;
          await Bun.sleep(100);
        }
      }
      throw last;
    };
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.length, 17);
    assert(names.includes("bus_ack"));
    assert(!names.includes("bus_wake"));
    // The host's closed outputs name every field the serve's do, nested ones included. Inputs
    // differ by design (the host supplies session and runtime), so only outputs are compared.
    const native = new Client({ name: "peer-http-qualifier-native", version: "1" });
    await native.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${busPort}/mcp`))
    );
    clients.push(native);
    const outputs = async (from: Pick<Client, "listTools">) =>
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
    const missingCorrelation = await call("bus_join", { address: "chatgpt/missing" });
    assert.equal(missingCorrelation.isError, true);
    assert.deepEqual(missingCorrelation.content, [
      {
        type: "text",
        text: "This call requires supported conversation correlation metadata. No Bus call was sent.",
      },
    ]);
    assert.equal(missingCorrelation.structuredContent, undefined);
    await success("bus_peers", {});
    await success("bus_join", { address: "chatgpt/http-a", topics: ["http-fixture"] }, "chat-a");
    await success("bus_join", { address: "chatgpt/http-b" }, "chat-b");
    const sessionA = peerSession(identityKey, issuer, subject, "chat-a");
    const sessionB = peerSession(identityKey, issuer, subject, "chat-b");
    assert.notEqual(sessionA, sessionB);
    for (const observations of [resolved, executed]) {
      assert(
        observations.some((value) => value.correlation === "chat-a" && value.session === sessionA)
      );
      assert(
        observations.some((value) => value.correlation === "chat-b" && value.session === sessionB)
      );
    }
    // Neither omission nor an authored empty correlation may inherit the preceding actor.
    const beforeMissing = executed.length;
    for (const meta of [{}, { "openai/session": "" }]) {
      const denied = await client.callTool({
        name: "bus_read",
        arguments: { address: "chatgpt/http-a" },
        _meta: meta,
      });
      assert.equal(denied.isError, true);
    }
    assert.equal(executed.length, beforeMissing + 2);
    assert(executed.slice(beforeMissing).every((value) => value.session === undefined));
    // Force the first resolver to finish last, then prove each request kept its own actor.
    const slow = client.callTool({
      name: "bus_owned_addresses",
      arguments: {},
      _meta: { "openai/session": "chat-a", "fixture/resolver": "slow" },
    });
    try {
      await Promise.race([
        slowEntered,
        Bun.sleep(5_000).then(() => {
          throw new Error("Slow resolver did not start.");
        }),
      ]);
      const fast = await client.callTool({
        name: "bus_owned_addresses",
        arguments: {},
        _meta: { "openai/session": "chat-b", "fixture/resolver": "fast" },
      });
      assert.deepEqual(fast.structuredContent, { addresses: ["chatgpt/http-b"] });
    } finally {
      releaseSlow();
    }
    assert.deepEqual((await slow).structuredContent, { addresses: ["chatgpt/http-a"] });
    for (const observations of [resolved, executed])
      assert.deepEqual(
        observations
          .filter((value) => value.marker !== undefined)
          .map(({ marker, session, correlation }) => ({ marker, session, correlation })),
        [
          { marker: "fast", session: sessionB, correlation: "chat-b" },
          { marker: "slow", session: sessionA, correlation: "chat-a" },
        ]
      );
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
    // Escape-heavy, and within the 32,768-byte limit for searchable text (30,000 bytes).
    const largeBody = 'quoted " backslash \\ euro €\n'.repeat(1_000);
    assert(Buffer.byteLength(JSON.stringify(largeBody), "utf8") > 16_384);
    const large = await success(
      "bus_publish",
      { from: "chatgpt/http-b", to: ["chatgpt/http-a"], body: largeBody },
      "chat-b"
    );
    assert.equal((await call("bus_read", { address: "chatgpt/http-a" }, "chat-b")).isError, true);
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
    // Keyed reads, peek and bus_ack through the host's own transport. A peek leaves the mail
    // unread, bus_ack marks exactly that batch, a repeat of either writes nothing, and a read
    // repeated with its readId returns the same batch as a replay.
    const object = (value: unknown): Record<string, unknown> => {
      assert(typeof value === "object" && value !== null && !Array.isArray(value));
      return Object.fromEntries(Object.entries(value));
    };
    const bodies = (value: unknown) => {
      const messages = object(value).messages;
      assert(Array.isArray(messages));
      return messages.map((message) => object(message).body);
    };
    await success(
      "bus_publish",
      { from: "chatgpt/http-b", to: ["chatgpt/http-a"], body: "peeked fixture body" },
      "chat-b"
    );
    const peeked = await success("bus_read", { address: "chatgpt/http-a", peek: true }, "chat-a");
    assert.deepEqual(bodies(peeked), ["peeked fixture body"]);
    const peekReceipt = object(object(peeked).receipt);
    assert.equal(peekReceipt.replayed, false);
    assert(typeof object(peekReceipt.basis).t === "number");
    assert.equal(object(peekReceipt.served).count, 1);
    assert.equal(typeof object(peeked).nextReadId, "string");
    const peekedAgain = await success(
      "bus_read",
      { address: "chatgpt/http-a", peek: true },
      "chat-a"
    );
    assert.deepEqual(bodies(peekedAgain), ["peeked fixture body"], "A peek consumed the mail.");
    assert.equal(
      (await call("bus_ack", { address: "chatgpt/http-a", receipt: peekReceipt }, "chat-b"))
        .isError,
      true
    );
    const acked = object(
      await success("bus_ack", { address: "chatgpt/http-a", receipt: peekReceipt }, "chat-a")
    );
    assert.equal(object(acked.receipt).replayed, false);
    assert.equal(object(acked.receipt).through, peekReceipt.through);
    const ackedAgain = object(
      await success("bus_ack", { address: "chatgpt/http-a", receipt: peekReceipt }, "chat-a")
    );
    assert.equal(object(ackedAgain.receipt).replayed, true);
    const drained = object(await success("bus_read", { address: "chatgpt/http-a" }, "chat-a"));
    assert.deepEqual(bodies(drained), [], "bus_ack did not mark the peeked batch read.");
    assert.equal(drained.receipt, undefined);
    const readId = drained.nextReadId;
    assert.equal(typeof readId, "string");
    await success(
      "bus_publish",
      { from: "chatgpt/http-b", to: ["chatgpt/http-a"], body: "keyed fixture body" },
      "chat-b"
    );
    const keyed = object(
      await success("bus_read", { address: "chatgpt/http-a", readId }, "chat-a")
    );
    assert.deepEqual(bodies(keyed), ["keyed fixture body"]);
    assert.deepEqual(
      { readId: object(keyed.receipt).readId, replayed: object(keyed.receipt).replayed },
      { readId, replayed: false }
    );
    const replayed = object(
      await success("bus_read", { address: "chatgpt/http-a", readId }, "chat-a")
    );
    assert.deepEqual(bodies(replayed), ["keyed fixture body"]);
    assert.equal(object(replayed.receipt).replayed, true);
    assert.notEqual(replayed.nextReadId, keyed.nextReadId);
    assert.deepEqual(
      bodies(await success("bus_read", { address: "chatgpt/http-a" }, "chat-a")),
      [],
      "A replay changed the read position."
    );
    const beforePrivateArguments = executed.length;
    const privateArguments = await client.callTool({
      name: "bus_read",
      arguments: { address: "chatgpt/http-a", session: sessionA },
      _meta: { "openai/session": "chat-a" },
    });
    assert.equal(
      privateArguments.isError,
      true,
      "Hidden native arguments must fail host validation."
    );
    assert.deepEqual(privateArguments.content, [{ type: "text", text: "Invalid tool input" }]);
    assert.equal(
      executed.length,
      beforePrivateArguments,
      "Forbidden arguments reached tool execution."
    );
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
    assert.equal(hostConfig(fixtureConfig).httpLimits.maxBodyBytes, 1_048_576);
    const beforeDeclared = { identityChecks, grantChecks, handlers: executed.length };
    let withheldResponse: IncomingMessage | undefined;
    const withheld = httpRequest(`http://127.0.0.1:${hostPort}/mcp`, {
      method: "POST",
      agent: false,
      signal: AbortSignal.timeout(5_000),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocolVersion,
        "mcp-method": "tools/call",
        "mcp-name": "bus_publish",
        "x-api-key": apiKey,
        "content-length": hostConfig(fixtureConfig).httpLimits.maxBodyBytes + 1,
      },
    });
    try {
      const early = await new Promise<{
        status: number | undefined;
        bytes: number;
        complete: boolean;
      }>((resolve, reject) => {
        withheld.once("error", reject);
        withheld.once("response", (response) => {
          withheldResponse = response;
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 0) {
              reject(new Error("Early body refusal was not empty."));
              response.destroy();
            }
          });
          response.once("error", reject);
          response.once("aborted", () => reject(new Error("Incomplete early body refusal.")));
          response.once("close", () => {
            if (!response.complete) reject(new Error("Early body refusal closed prematurely."));
          });
          response.once("end", () =>
            resolve({ status: response.statusCode, bytes, complete: response.complete })
          );
        });
        // Flush only headers: declared overflow must refuse before any body bytes arrive.
        withheld.flushHeaders();
      });
      assert.deepEqual(early, { status: 413, bytes: 0, complete: true });
      assert.deepEqual({ identityChecks, grantChecks, handlers: executed.length }, beforeDeclared);
    } finally {
      withheldResponse?.destroy();
      withheld.destroy();
    }
    await success("bus_peers", {}, "chat-a");
    const oversized = {
      name: "bus_publish",
      arguments: {
        from: "chatgpt/http-b",
        to: ["chatgpt/http-a"],
        body: `oversize-canary${"x".repeat(1_048_576)}`,
      },
      _meta: { "openai/session": "chat-b" },
    };
    assert(
      Buffer.byteLength(JSON.stringify(oversized), "utf8") >
        hostConfig(fixtureConfig).httpLimits.maxBodyBytes
    );
    const beforeOversized = identityChecks;
    const rejected = await modernRequest(
      `http://127.0.0.1:${hostPort}/mcp`,
      "oversize-fixture",
      999,
      "tools/call",
      oversized,
      { "x-api-key": apiKey }
    );
    assert.equal(rejected.status, 413);
    await rejected.body?.cancel();
    assert.equal(identityChecks, beforeOversized);
    identified = "wrong-subject";
    const beforeWrongSubject = { identityChecks, grantChecks };
    await deniedCall("bus_join", { address: "chatgpt/forged" }, "chat-c");
    assert.equal(identityChecks, beforeWrongSubject.identityChecks + 1);
    assert.equal(grantChecks, beforeWrongSubject.grantChecks);
    identified = subject;
    permitted = false;
    const beforeRevocation = { identityChecks, grantChecks };
    // A previously authorized correlation must not reuse cached grant authority.
    await deniedCall("bus_join", { address: "chatgpt/ungranted" }, "chat-a");
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
