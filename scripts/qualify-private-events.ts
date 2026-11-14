// Packed-host Events qualification against disposable services and synthetic principals only.
import { strict as assert } from "node:assert";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger, stopFlureeServer } from "../test/fluree-server.ts";
import { spawnSupervised } from "../test/supervised.ts";

const archiveHash = "6c6091e6a97d0e75ecf0ec9e03fa4901cc985b2e0d76c6aab52ed3ca1ac82c25";
const entryHash = "d7fdd22e950dfc1c43a5e756692d4306910711a9f3a6187b56fcbcc2fda7041b";
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const [archive, caseFlag, requestedCase] = process.argv.slice(2);
const selectedCase = caseFlag === undefined ? "all" : requestedCase;
if (
  !archive ||
  !isAbsolute(archive) ||
  !(
    (process.argv.length === 3 && caseFlag === undefined) ||
    (process.argv.length === 5 &&
      caseFlag === "--case" &&
      (requestedCase === "checkpoint" || requestedCase === "native-expiry"))
  ) ||
  digest(archive) !== archiveHash
)
  throw new Error("Supply the absolute host archive and optional --case checkpoint|native-expiry.");

const catalog = Schema.decodeUnknownSync(
  Schema.Struct({ events: Schema.Array(Schema.Struct({ name: Schema.String })) })
);
const subscription = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    refreshBefore: Schema.String,
    cursor: Schema.Null,
    truncated: Schema.Literal(false),
  }),
  { onExcessProperty: "error" }
);
const empty = Schema.decodeUnknownSync(Schema.Struct({}), { onExcessProperty: "error" });
const notice = Schema.decodeUnknownSync(
  Schema.Struct({
    eventId: Schema.String,
    name: Schema.Literal("mail.wake"),
    timestamp: Schema.String,
    data: Schema.Struct({ address: Schema.String }),
    cursor: Schema.Null,
  }),
  { onExcessProperty: "error" }
);
const capability = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({ capabilities: Schema.Record(Schema.String, Schema.Unknown) }),
  })
);
const redirect = "http://127.0.0.1:49171/callback";

class SyntheticOAuthClient implements OAuthClientProvider {
  readonly redirectUrl = redirect;
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: "Events qualification client",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [redirect],
    response_types: ["code"],
    scope: "read",
    token_endpoint_auth_method: "none",
  };
  #information?: OAuthClientInformationMixed;
  #tokens?: OAuthTokens;
  #verifier?: string;
  #url?: URL;
  clientInformation() {
    return this.#information;
  }
  saveClientInformation(value: OAuthClientInformationMixed) {
    this.#information = value;
  }
  tokens() {
    return this.#tokens;
  }
  saveTokens(value: OAuthTokens) {
    this.#tokens = value;
  }
  saveCodeVerifier(value: string) {
    this.#verifier = value;
  }
  codeVerifier() {
    if (this.#verifier === undefined) throw new Error("SDK PKCE verifier missing.");
    return this.#verifier;
  }
  redirectToAuthorization(value: URL) {
    this.#url = value;
  }
  state() {
    return "synthetic-client-state";
  }
  authorizationUrl() {
    if (this.#url === undefined) throw new Error("SDK authorization URL missing.");
    return this.#url;
  }
}

const reservePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("Could not reserve fixture port.");
  return port;
};
const until = async (condition: () => boolean, description: string, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}.`);
    await Bun.sleep(25);
  }
};
const location = (response: Response) => {
  const value = response.headers.get("location");
  if (value === null) throw new Error(`Expected OAuth redirect, received ${response.status}.`);
  return new URL(value, response.url);
};
const refused = async (work: Promise<unknown>, code: number) => {
  try {
    await work;
  } catch (error) {
    assert(error && typeof error === "object" && "code" in error);
    assert.equal(error.code, code);
    return;
  }
  throw new Error("Expected Events refusal.");
};

const dir = mkdtempSync(join(tmpdir(), "agent-bus-events-qualification-"));
let disposeBus: (() => Promise<void>) | undefined;
let host: ReturnType<typeof spawnSupervised> | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
let receiver: ReturnType<typeof Bun.serve> | undefined;
const clients: Client[] = [];
try {
  const extracted = Bun.spawnSync(["tar", "-xzf", archive, "-C", dir, "package/dist/index.js"]);
  if (!extracted.success) throw new Error("Could not extract the packed host.");
  const entry = join(dir, "package/dist/index.js");
  if (digest(entry) !== entryHash) throw new Error("Wrong packed host entry.");
  const busPort = reservePort();
  let hostPort = reservePort();
  while (hostPort === busPort) hostPort = reservePort();
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
  const store = layerFluree(await freshLedger("hosted-events")).pipe(Layer.provide(platform));
  const bus = ManagedRuntime.make(
    Serve.layerHttp({ port: busPort, version: "events-fixture" }).pipe(
      Layer.provideMerge(
        Bus.layer("fixture").pipe(
          Layer.provideMerge(store),
          Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
          Layer.provide(platform)
        )
      )
    )
  );
  disposeBus = () => bus.dispose();
  await bus.runPromise(Effect.void);

  const authorizationCodes = new Map<
    string,
    { challenge: string; redirectUri: string; subject: string; expiresIn: number }
  >();
  let nextSubject = "fixture-first";
  let nextLifetime = 3600;
  let upstreamExchanges = 0;
  let upstreamRefusal = "no token request";
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        const challenge = url.searchParams.get("code_challenge");
        if (
          url.searchParams.get("client_id") !== "fixture-client" ||
          redirectUri !== `http://127.0.0.1:${hostPort}/oauth/callback` ||
          !state ||
          !challenge ||
          url.searchParams.get("code_challenge_method") !== "S256"
        )
          return Response.json({ error: "invalid_request" }, { status: 400 });
        const code = randomBytes(18).toString("hex");
        authorizationCodes.set(code, {
          challenge,
          redirectUri,
          subject: nextSubject,
          expiresIn: nextLifetime,
        });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", state);
        return Response.redirect(callback.href, 302);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const body = new URLSearchParams(await request.text());
        const code = body.get("code") ?? "";
        const grant = authorizationCodes.get(code);
        const challenge = createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          body.get("client_id") !== "fixture-client" ||
          body.get("client_secret") !== "fixture-secret" ||
          body.get("grant_type") !== "authorization_code" ||
          !grant ||
          grant.redirectUri !== body.get("redirect_uri") ||
          grant.challenge !== challenge
        ) {
          upstreamRefusal = JSON.stringify({
            client: body.get("client_id") === "fixture-client",
            secret: body.get("client_secret") === "fixture-secret",
            kind: body.get("grant_type") === "authorization_code",
            code: grant !== undefined,
            redirect: grant?.redirectUri === body.get("redirect_uri"),
            challenge: grant?.challenge === challenge,
          });
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        authorizationCodes.delete(code);
        upstreamExchanges++;
        return Response.json({
          access_token: grant.subject === "fixture-first" ? "synthetic-first" : "synthetic-second",
          expires_in: grant.expiresIn,
          scope: "read",
          token_type: "Bearer",
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const cert = join(dir, "receiver.pem");
  const certKey = join(dir, "receiver-key.pem");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      certKey,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=receiver.example.test",
      "-addext",
      "subjectAltName=DNS:receiver.example.test",
    ],
    { stdout: "ignore", stderr: "ignore" }
  );
  if (!generated.success) throw new Error("Could not create the synthetic receiver certificate.");
  const secretBytes = randomBytes(32);
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const deliveries: Array<{ id: string; body: string }> = [];
  let verifications = 0;
  let acceptDeliveries = false;
  let callbackError: unknown;
  receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(certKey), cert: Bun.file(cert) },
    fetch: async (request) => {
      try {
        const body = await request.text();
        const id = request.headers.get("webhook-id");
        const timestamp = request.headers.get("webhook-timestamp");
        const signatures = request.headers.get("webhook-signature");
        assert(id && timestamp && signatures);
        const signature = `v1,${createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
        assert(signatures.split(" ").includes(signature));
        const value: unknown = JSON.parse(body);
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "verification" &&
          "challenge" in value
        ) {
          verifications++;
          return Response.json({ challenge: value.challenge });
        }
        notice(value);
        deliveries.push({ id, body });
        return new Response(null, { status: acceptDeliveries ? 204 : 503 });
      } catch (error) {
        callbackError = error;
        return new Response(null, { status: 500 });
      }
    },
  });
  const oauthDir = join(dir, "oauth");
  mkdirSync(oauthDir, { mode: 0o700 });
  const eventsPath = join(dir, "events.sqlite");
  writeFileSync(eventsPath, "", { mode: 0o600 });
  const firstGrant = join(dir, "first-grant.json");
  const secondGrant = join(dir, "second-grant.json");
  const resource = `http://127.0.0.1:${hostPort}/mcp`;
  const grant = (file: string, subject: string, permitted: boolean) =>
    writeFileSync(
      file,
      JSON.stringify({ subject, resource, permissions: permitted ? ["agent-bus:peer"] : [] }),
      { mode: 0o600 }
    );
  grant(firstGrant, "fixture-first", true);
  grant(secondGrant, "fixture-second", true);
  const tracePath = join(dir, "dial-trace");
  const coverageTrace = join(dir, "coverage-trace");
  writeFileSync(tracePath, "");
  writeFileSync(coverageTrace, "");
  const fixture = join(dir, "host-fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      entry,
      busPort,
      hostPort,
      providerPort: provider.port,
      oauthDir,
      eventsPath,
      eventsKey: randomBytes(32).toString("base64"),
      firstGrant,
      secondGrant,
      receiverPort: receiver.port,
      caPath: cert,
      tracePath,
      coverageTrace,
    }),
    { mode: 0o600 }
  );
  const endpoint = new URL(resource);
  const start = async () => {
    host = spawnSupervised(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        "./test/fixtures/private-events-preload.ts",
        "./test/fixtures/private-events-host.ts",
        fixture,
      ],
      { cwd: process.cwd(), stdout: "inherit", stderr: "inherit" }
    );
    let ready = false;
    for (let attempt = 0; attempt < 200 && host.exitCode === null; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          signal: AbortSignal.timeout(300),
        });
        ready = response.status === 401;
        await response.body?.cancel();
        if (ready) break;
      } catch {
        /* listener is not ready */
      }
      await Bun.sleep(50);
    }
    if (!ready) throw new Error("Packed Events host did not start.");
  };
  const stop = async () => {
    if (host === undefined) return;
    host.kill();
    await host.exited;
    host = undefined;
  };
  const connect = async (auth: SyntheticOAuthClient) => {
    const client = new Client({ name: "events-qualifier", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: auth }));
    clients.push(client);
    return client;
  };
  const authorize = async (subject: string, expiresIn = 3600) => {
    nextSubject = subject;
    nextLifetime = expiresIn;
    const auth = new SyntheticOAuthClient();
    const pending = new Client({ name: "events-qualifier", version: "1" });
    const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: auth });
    try {
      await pending.connect(transport);
      throw new Error("Unauthenticated client connected.");
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }
    const authUrl = auth.authorizationUrl();
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    const consentPage = await fetch(authUrl, { redirect: "manual" });
    assert.equal(consentPage.status, 200);
    const transaction = /name="transaction_id" value="([^"]+)"/.exec(await consentPage.text())?.[1];
    if (!transaction) throw new Error("Consent transaction missing.");
    const consent = await fetch(new URL("/oauth/consent", authUrl.origin), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "approve", transaction_id: transaction }),
    });
    assert.equal(consent.status, 302);
    const upstreamAuth = await fetch(location(consent), { redirect: "manual" });
    assert.equal(upstreamAuth.status, 302);
    const callback = await fetch(location(upstreamAuth), { redirect: "manual" });
    if (callback.status !== 302)
      throw new Error(
        `OAuth callback refused: HTTP ${callback.status}; upstream ${upstreamRefusal}`
      );
    const returned = location(callback);
    assert.equal(returned.searchParams.get("state"), "synthetic-client-state");
    const code = returned.searchParams.get("code");
    assert(code);
    await transport.finishAuth(code);
    await transport.close();
    return auth;
  };
  await start();
  const firstAuth = await authorize("fixture-first");
  const secondAuth = await authorize("fixture-second");
  assert.equal(upstreamExchanges, 2);
  const token = firstAuth.tokens()?.access_token;
  assert(token);
  const initialized = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw-events-qualifier", version: "1" },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  assert(Object.hasOwn(capability(await initialized.json()).result.capabilities, "events"));
  let first = await connect(firstAuth);
  let second = await connect(secondAuth);
  assert.deepEqual(
    catalog(await first.request({ method: "events/list", params: {} }, ResultSchema)).events.map(
      (event) => event.name
    ),
    ["mail.wake"]
  );
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
    chat: string
  ) => {
    const result = await client.callTool({
      name,
      arguments: args,
      _meta: { "openai/session": chat },
    });
    assert.notEqual(result.isError, true, `Tool ${name} failed.`);
    return result.structuredContent;
  };
  await call(first, "bus_join", { address: "chatgpt/events-first" }, "chat-first");
  await call(second, "bus_join", { address: "chatgpt/events-second" }, "chat-second");
  const request = {
    name: "mail.wake",
    arguments: { address: "chatgpt/events-first" },
    delivery: {
      mode: "webhook",
      url: `https://receiver.example.test:${receiver.port}/callback`,
      secret,
    },
    ttlMs: 60_000,
  };
  const subscribe = async (client: Client, input: typeof request, chat: string) =>
    subscription(
      await client.request(
        { method: "events/subscribe", params: { ...input, _meta: { "openai/session": chat } } },
        ResultSchema
      )
    );
  const unsubscribe = async (client: Client, input: typeof request) =>
    empty(
      await client.request(
        {
          method: "events/unsubscribe",
          params: {
            name: input.name,
            arguments: input.arguments,
            delivery: { mode: input.delivery.mode, url: input.delivery.url },
          },
        },
        ResultSchema
      )
    );
  if (selectedCase === "all") {
    await refused(subscribe(first, request, "foreign-conversation"), -32010);
    await refused(subscribe(second, request, "chat-second"), -32010);
    grant(firstGrant, "fixture-first", false);
    await refused(subscribe(first, request, "chat-first"), -32010);
    assert.equal(verifications, 0);
    grant(firstGrant, "fixture-first", true);
    const admitted = await subscribe(first, request, "chat-first");
    assert(admitted.id.startsWith("sub_"));
    assert(Date.parse(admitted.refreshBefore) > Date.now());
    assert(Date.parse(admitted.refreshBefore) <= Date.now() + request.ttlMs);
    assert.equal(verifications, 1);
    assert.deepEqual(await unsubscribe(second, request), {});
    await call(
      second,
      "bus_publish",
      {
        from: "chatgpt/events-second",
        to: ["chatgpt/events-first"],
        body: "synthetic pending mail",
      },
      "chat-second"
    );
    await until(() => deliveries.length >= 1 || callbackError !== undefined, "first wake");
    if (callbackError !== undefined) throw callbackError;
    assert.deepEqual(notice(JSON.parse(deliveries[0]!.body)).data, {
      address: "chatgpt/events-first",
    });
    const read = await call(first, "bus_read", { address: "chatgpt/events-first" }, "chat-first");
    assert(
      typeof read === "object" &&
        read !== null &&
        "messages" in read &&
        Array.isArray(read.messages) &&
        read.messages.length === 1
    );
    await Promise.all([first.close(), second.close()]);
    await stop();
    acceptDeliveries = true;
    await start();
    first = await connect(firstAuth);
    second = await connect(secondAuth);
    await until(
      () => deliveries.length >= 2 || callbackError !== undefined,
      "pending wake after restart"
    );
    if (callbackError !== undefined) throw callbackError;
    assert.deepEqual(deliveries[1], deliveries[0]);
    const emptyRead = await call(
      first,
      "bus_read",
      { address: "chatgpt/events-first" },
      "chat-first"
    );
    assert(
      typeof emptyRead === "object" &&
        emptyRead !== null &&
        "messages" in emptyRead &&
        Array.isArray(emptyRead.messages) &&
        emptyRead.messages.length === 0
    );
    grant(firstGrant, "fixture-first", false);
    assert.deepEqual(await unsubscribe(first, request), {});
    assert.deepEqual(await unsubscribe(first, request), {});
    grant(firstGrant, "fixture-first", true);
    const short = { ...request, ttlMs: 350 };
    const expires = await subscribe(first, short, "chat-first");
    assert(Date.parse(expires.refreshBefore) <= Date.now() + short.ttlMs);
    await Bun.sleep(800);
    const beforeExpiry = deliveries.length;
    await call(
      second,
      "bus_publish",
      { from: "chatgpt/events-second", to: ["chatgpt/events-first"], body: "after lease" },
      "chat-second"
    );
    await Bun.sleep(1200);
    assert.equal(deliveries.length, beforeExpiry);
    await call(first, "bus_read", { address: "chatgpt/events-first" }, "chat-first");
  }

  if (selectedCase !== "checkpoint") {
    acceptDeliveries = true;
    const issuedFrom = Date.now();
    const shortAuth = await authorize("fixture-first", 8);
    const shortBearer = shortAuth.tokens()?.access_token;
    assert(shortBearer);
    const payload = shortBearer.split(".")[1];
    assert(payload);
    const claims = Schema.decodeUnknownSync(Schema.Struct({ exp: Schema.Int }))(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    );
    const nativeDeadline = claims.exp * 1000;
    assert(nativeDeadline > Date.now() + 1000);
    assert(nativeDeadline <= issuedFrom + 10_000);
    const shortClient = await connect(shortAuth);
    const lease = await subscribe(shortClient, request, "chat-first");
    const refreshBefore = Date.parse(lease.refreshBefore);
    assert(refreshBefore > Date.now());
    assert(refreshBefore <= nativeDeadline);
    assert(refreshBefore >= nativeDeadline - 2000);
    assert(refreshBefore < issuedFrom + request.ttlMs);
    const beforeLive = deliveries.length;
    await call(
      second,
      "bus_publish",
      {
        from: "chatgpt/events-second",
        to: ["chatgpt/events-first"],
        body: "before native expiry",
      },
      "chat-second"
    );
    await until(
      () => deliveries.length > beforeLive || callbackError !== undefined,
      "live native-bound delivery"
    );
    if (callbackError !== undefined) throw callbackError;
    assert(Date.now() < nativeDeadline);
    assert.deepEqual(notice(JSON.parse(deliveries.at(-1)!.body)).data, {
      address: "chatgpt/events-first",
    });
    await call(first, "bus_read", { address: "chatgpt/events-first" }, "chat-first");
    await Bun.sleep(Math.max(0, nativeDeadline - Date.now()) + 1200);
    const expired = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${shortBearer}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "expired-native-fixture", version: "1" },
        },
      }),
    });
    assert.equal(expired.status, 401);
    await expired.body?.cancel();
    const afterExpiry = deliveries.length;
    await call(
      second,
      "bus_publish",
      {
        from: "chatgpt/events-second",
        to: ["chatgpt/events-first"],
        body: "after native expiry",
      },
      "chat-second"
    );
    await Bun.sleep(2500);
    assert.equal(deliveries.length, afterExpiry);
    assert(Date.now() < issuedFrom + request.ttlMs);
    const recovered = await connect(await authorize("fixture-first"));
    await subscribe(recovered, request, "chat-first");
    await until(
      () => deliveries.length > afterExpiry || callbackError !== undefined,
      "fresh native authorization control"
    );
    if (callbackError !== undefined) throw callbackError;
    assert.deepEqual(notice(JSON.parse(deliveries.at(-1)!.body)).data, {
      address: "chatgpt/events-first",
    });
    await call(recovered, "bus_read", { address: "chatgpt/events-first" }, "chat-first");
    await unsubscribe(recovered, request);
    await Promise.all([shortClient.close(), recovered.close()]);
    console.log(
      `Native-bound lease: access deadline ${nativeDeadline}, refreshBefore ${refreshBefore}, requested TTL ${request.ttlMs} ms; raw expired bearer returned 401 and fresh authorization restored delivery.`
    );
  }

  // Create a complete native coverage set larger than the host default checkpoint ceiling.
  if (selectedCase !== "native-expiry") {
    acceptDeliveries = true;
    const ids: string[] = [];
    for (let index = 0; index < 120; index += 4) {
      const batch = await Promise.all(
        Array.from({ length: 4 }, (_, offset) =>
          call(
            second,
            "bus_publish",
            {
              from: "chatgpt/events-second",
              to: ["chatgpt/events-first"],
              body: `bulk ${index + offset}`,
            },
            "chat-second"
          )
        )
      );
      for (const result of batch) {
        assert(
          typeof result === "object" &&
            result !== null &&
            "id" in result &&
            typeof result.id === "string"
        );
        ids.push(result.id);
      }
    }
    assert.equal(ids.length, 120);
    assert.equal(new Set(ids).size, 120);
    const idsDigest = (items: readonly string[]) =>
      createHash("sha256")
        .update(JSON.stringify([...items].sort()))
        .digest("hex");
    const expectedDigest = idsDigest(ids);
    assert.notEqual(idsDigest(ids.slice(1)), expectedDigest);
    assert.notEqual(idsDigest(["substituted-fixture-id", ...ids.slice(1)]), expectedDigest);
    const beforeLarge = deliveries.length;
    await subscribe(first, request, "chat-first");
    await until(
      () => deliveries.length > beforeLarge || callbackError !== undefined,
      "large coverage wake",
      30_000
    );
    if (callbackError !== undefined) throw callbackError;
    const decodeTrace = Schema.decodeUnknownSync(
      Schema.Struct({
        count: Schema.Int,
        idsDigest: Schema.String,
        bytes: Schema.Int,
        canonicalFullCoverageDigest: Schema.String,
      }),
      { onExcessProperty: "error" }
    );
    const observations = () =>
      readFileSync(coverageTrace, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeTrace(JSON.parse(line)));
    await until(
      () =>
        observations().some(
          (record) =>
            record.count === 120 && record.idsDigest === expectedDigest && record.bytes > 4096
        ),
      "full coverage checkpoint round trip",
      30_000
    );
    const checkpoint = observations().find(
      (record) => record.count === 120 && record.idsDigest === expectedDigest && record.bytes > 4096
    );
    assert(checkpoint);
    await Promise.all([first.close(), second.close()]);
    await stop();
    const beforeRestartCount = observations().length;
    await start();
    first = await connect(firstAuth);
    await until(
      () =>
        observations()
          .slice(beforeRestartCount)
          .some(
            (record) =>
              record.count === 120 &&
              record.idsDigest === expectedDigest &&
              record.bytes > 4096 &&
              record.canonicalFullCoverageDigest === checkpoint.canonicalFullCoverageDigest
          ),
      "full checkpoint after restart",
      30_000
    );
    assert.deepEqual(await unsubscribe(first, request), {});
    console.log(
      `Checkpoint: ${checkpoint.count} unique published IDs, ${checkpoint.bytes} bytes, IDs SHA-256 ${expectedDigest}, canonical full coverage SHA-256 ${checkpoint.canonicalFullCoverageDigest}; matched before and after joined host restart.`
    );
  }
  const trace = readFileSync(tracePath, "utf8");
  assert(trace.includes("lookup\n") && trace.includes("admitted-tls-dial\n"));
  console.log(
    `Packed public Events ${selectedCase} case passed with synthetic native OAuth and disposable Bus and Fluree.`
  );
  console.log(
    "Callback admission was tested with a fixture-only DNS/TLS dial redirect, not a public destination."
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  if (host !== undefined) {
    host.kill();
    await host.exited;
  }
  receiver?.stop(true);
  provider?.stop(true);
  await disposeBus?.();
  await stopFlureeServer();
  rmSync(dir, { recursive: true, force: true });
}
