import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import {
  clerkPeerResolver,
  discoverProvider,
  identifyOwner,
  PEER_PERMISSION,
} from "../src/private-web/identity.ts";
import {
  decodeServiceConfig,
  decodeSessionKey,
  readPrivateJson,
} from "../src/private-web/service.ts";

const provider = {
  issuer: "https://identity.invalid",
  userInfo: "https://identity.invalid/oauth/userinfo",
  authorizationEndpoint: "https://identity.invalid/oauth/authorize",
  tokenEndpoint: "https://identity.invalid/oauth/token",
};
const discovery = {
  issuer: provider.issuer,
  userinfo_endpoint: provider.userInfo,
  authorization_endpoint: provider.authorizationEndpoint,
  token_endpoint: provider.tokenEndpoint,
};
const http = (handle: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const fake: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      Promise.resolve(handle(String(input), init ?? {})),
    { preconnect: fetch.preconnect }
  );
  return FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fake)));
};

test("provider discovery pins exact HTTPS issuer and endpoints without following redirects", async () => {
  for (const [response, expected] of [
    [Response.json(discovery), "Success"],
    [Response.json({ ...discovery, issuer: "https://other.invalid" }), "Failure"],
    [
      Response.json({ ...discovery, userinfo_endpoint: "https://other.invalid/userinfo" }),
      "Failure",
    ],
    [
      new Response(null, { status: 302, headers: { location: "https://other.invalid" } }),
      "Failure",
    ],
    [new Response("{bad"), "Failure"],
    [new Response(null, { status: 503 }), "Failure"],
  ] as const) {
    let requests = 0;
    const result = await Effect.runPromise(
      discoverProvider(provider).pipe(
        Effect.provide(
          http((url, init) => {
            requests++;
            expect(url).toBe(`${provider.issuer}/.well-known/openid-configuration`);
            expect(init.redirect).toBe("manual");
            return response;
          })
        ),
        Effect.result
      )
    );
    expect(result._tag).toBe(expected);
    expect(requests).toBe(1);
    if (result._tag === "Failure") expect(result.failure.message).toBe("Peer access denied.");
  }
  await expect(
    Effect.runPromise(
      discoverProvider({ ...provider, issuer: "http://identity.invalid" }).pipe(
        Effect.provide(
          http(() => {
            throw new Error("Should not request.");
          })
        )
      )
    )
  ).rejects.toThrow("Peer access denied.");
});

test("UserInfo is bounded and uncached, uses only the mapped provider bearer, and recovers", async () => {
  let response = Response.json({
    sub: "owner",
    aud: "untrusted-resource",
    scope: "not-an-app-grant",
  });
  const runtime = ManagedRuntime.make(
    http((url, init) => {
      expect(url).toBe(provider.userInfo);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer PROVIDER_TOKEN_CANARY");
      expect(init.redirect).toBe("manual");
      return response;
    })
  );
  const read = () => runtime.runPromise(identifyOwner(provider, "PROVIDER_TOKEN_CANARY"));
  try {
    expect(await read()).toBe("owner");
    for (const bad of [
      new Response(null, { status: 401 }),
      Response.json({ sub: "" }),
      Response.json({ email: "owner@example.invalid" }),
      new Response("{bad"),
      Response.json({ sub: "x".repeat(20_000) }),
    ]) {
      response = bad;
      await expect(read()).rejects.toThrow("Peer access denied.");
    }
    response = Response.json({ sub: "owner" });
    expect(await read()).toBe("owner");
  } finally {
    await runtime.dispose();
  }
});

test("stalled UserInfo is interrupted by deadline and caller cancellation", async () => {
  let entered: (() => void) | undefined;
  let transportSignal: AbortSignal | null | undefined;
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      TestClock.layer(),
      http((_url, init) => {
        transportSignal = init.signal;
        entered?.();
        return new Response(new ReadableStream<Uint8Array>());
      })
    )
  );
  try {
    for (const cancel of [false, true]) {
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const abort = new AbortController();
      const result = runtime
        .runPromise(identifyOwner(provider, "token"), { signal: abort.signal })
        .then(
          () => false,
          () => true
        );
      await started;
      if (cancel) abort.abort();
      else await runtime.runPromise(TestClock.adjust("5 seconds"));
      expect(await result).toBe(true);
      expect(transportSignal?.aborted).toBe(true);
    }
  } finally {
    await runtime.dispose();
  }
});

test("provider identity, exact host resource and application grant remain independent", async () => {
  const resource = "https://bus.invalid/mcp";
  let subject = "owner";
  let grant: unknown = { subject, resource, permissions: [PEER_PERMISSION] };
  let accepted = 0;
  const resolve = clerkPeerResolver({
    issuer: provider.issuer,
    key: new Uint8Array(32).fill(1),
    subject: "owner",
    resource,
    identify: async () => {
      accepted++;
      return subject;
    },
    readGrant: async () => grant,
  });
  const invocation = {
    auth: { authType: "oauth", accessToken: "token" },
    signal: new AbortController().signal,
  };
  expect(await resolve(invocation)).toEqual({});
  for (const denied of [
    { subject, resource, permissions: [] },
    { subject, resource: "https://other.invalid/mcp", permissions: [PEER_PERMISSION] },
    { subject: "other", resource, permissions: [PEER_PERMISSION] },
    undefined,
  ]) {
    grant = denied;
    await expect(resolve(invocation)).rejects.toThrow("Peer access denied.");
  }
  grant = { subject: "owner", resource, permissions: [PEER_PERMISSION] };
  subject = "other";
  await expect(resolve(invocation)).rejects.toThrow("Peer access denied.");
  subject = "owner";
  expect(await resolve(invocation)).toEqual({});
  const count = accepted;
  await expect(
    resolve({ ...invocation, auth: { authType: "apiKey", accessToken: "token" } })
  ).rejects.toThrow("Peer access denied.");
  expect(accepted).toBe(count);
});

const config = {
  schema: "agent-bus-private-web-v1",
  baseUrl: "https://bus.invalid",
  resource: "https://bus.invalid/mcp",
  port: 6027,
  ownerSubject: "owner",
  provider,
  grantFile: "/private/read-grant.json",
  sessionKeyFile: "/private/session-key.json",
  binding: "fixture",
  sources: {
    fixture: { port: 6030, expectedBusVersion: "fixture-release" },
    live: { port: 6025, expectedBusVersion: "live-release" },
  },
  oauth: {
    clientId: "client",
    clientSecret: "secret",
    jwtSigningKey: "signing",
    encryptionKey: "encryption",
    tokenStorageDir: "/private/tokens",
    allowedRedirectUris: ["https://chat.invalid/oauth/callback"],
  },
};

test("service binding chooses exactly one explicit source and keeps its permanent host resource", () => {
  const fixture = decodeServiceConfig(config);
  const live = decodeServiceConfig({ ...config, binding: "live" });
  expect(fixture.sources[fixture.binding]).toEqual(config.sources.fixture);
  expect(live.sources[live.binding]).toEqual(config.sources.live);
  expect(live.resource).toBe(fixture.resource);
  for (const bad of [
    { ...config, fallback: config.sources.live },
    { ...config, binding: "automatic" },
    { ...config, resource: "https://other.invalid/mcp" },
    { ...config, sources: { fixture: config.sources.live, live: config.sources.live } },
    { ...config, oauth: { ...config.oauth, allowedRedirectUris: ["https://*.invalid/callback"] } },
  ])
    expect(() => decodeServiceConfig(bad)).toThrow();
});

test("private config and app-grant files refuse symlinks and permissive access", () => {
  const dir = mkdtempSync(join(tmpdir(), "bus-private-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    expect(decodeServiceConfig(readPrivateJson(path)).binding).toBe("fixture");
    const link = join(dir, "link.json");
    symlinkSync(path, link);
    expect(() => readPrivateJson(link)).toThrow();
    chmodSync(path, 0o644);
    expect(() => readPrivateJson(path)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private session key has a single canonical 256-bit encoding", () => {
  const key = Buffer.alloc(32, 7);
  expect(decodeSessionKey({ key: key.toString("base64url") })).toEqual(key);
  for (const bad of [
    "",
    "AA",
    `${key.toString("base64url")}=`,
    Buffer.alloc(33).toString("base64url"),
  ]) {
    expect(() => decodeSessionKey({ key: bad })).toThrow();
  }
  expect(() => decodeSessionKey({ key: key.toString("base64url"), extra: true })).toThrow();
});
