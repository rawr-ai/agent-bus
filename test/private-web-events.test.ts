import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventsValue, InvocationIdentity } from "mcp-openapi";
import {
  type AuthorizationDiagnosticObserver,
  authorizationDiagnostics,
  eventsProgram,
  prepareWatchTool,
} from "../src/private-web/events.ts";
import { clerkPeerIdentity, PEER_PERMISSION } from "../src/private-web/identity.ts";
import { wakePort } from "../src/private-web/peer.ts";
import {
  initializeWatchAuthority,
  WatchAuthority,
  watchAuthorityPath,
} from "../src/private-web/watch-authority.ts";
import type { WakeBinding } from "../src/wake-observation.ts";

const signal = new AbortController().signal;
const issuer = "https://identity.invalid";
const resource = "https://bus.invalid/mcp";
const address = "chatgpt/fixture";
const invocation = (token = "first", chat?: string): InvocationIdentity => ({
  auth: { authType: "oauth", accessToken: token },
  signal,
  client: { version: undefined },
  ...(chat === undefined ? {} : { requestMeta: { "openai/session": chat } }),
});

const fixtures: Array<{ dir: string; authority?: WatchAuthority }> = [];
afterEach(async () => {
  let failed = false;
  for (const { dir, authority } of fixtures.splice(0)) {
    try {
      await authority?.close();
    } catch {
      failed = true;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Could not clean watch fixture.");
});

const fixture = async (diagnostics?: AuthorizationDiagnosticObserver) => {
  const reads: string[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = [];
  const grants = new Map<string, unknown>([
    ["/first", { subject: "first", resource, permissions: [PEER_PERMISSION] }],
    ["/second", { subject: "second", resource, permissions: [PEER_PERMISSION] }],
  ]);
  const identity = clerkPeerIdentity({
    issuer,
    resource,
    key: new Uint8Array(32).fill(42),
    principals: [
      { subject: "first", grantFile: "/first" },
      { subject: "second", grantFile: "/second" },
    ],
    identify: async (token) => (["rotated", "TOKEN_CANARY"].includes(token) ? "first" : token),
    readGrant: async (path) => {
      reads.push(path);
      return grants.get(path);
    },
  });
  const actor = await identity.resolveAuthorized(invocation("first", "chat"));
  if (actor.session === undefined) throw new Error("Missing session.");
  const binding: WakeBinding = {
    address,
    session: actor.session,
    runtime: "other",
    installation: "local-installation",
    incarnation: "ledger-incarnation",
    run: "join-run",
  };
  const coverage = { binding, cursor: 17, rung: ["message-1"] };
  const state: {
    observation: Record<string, unknown>;
    check: Record<string, unknown>;
    fail: boolean;
    isError: boolean;
    thrown: unknown;
    beforeReturn?: () => void;
  } = {
    observation: {
      binding,
      observationCut: { head: 19, incarnation: binding.incarnation },
      ready: true,
      news: true,
      latestEligibleAt: "2026-01-01T00:00:00.000Z",
      nextCoverage: coverage,
    },
    check: { binding, observationCut: { head: 19, incarnation: binding.incarnation } },
    fail: false,
    isError: false,
    thrown: new Error("native failure"),
  };
  const wake = wakePort(async (name, args, callSignal) => {
    calls.push({ name, args, ...(callSignal === undefined ? {} : { signal: callSignal }) });
    if (state.fail) throw state.thrown;
    state.beforeReturn?.();
    if (state.isError)
      return { isError: true, content: [{ type: "text", text: "NATIVE_ERROR_CANARY" }] };
    return {
      content: [],
      structuredContent: name === "bus_observe_wake" ? state.observation : state.check,
    };
  });
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-watch-events-"));
  const owned: { dir: string; authority?: WatchAuthority } = { dir };
  fixtures.push(owned);
  const eventsPath = join(dir, "events.sqlite");
  writeFileSync(eventsPath, "", { mode: 0o600, flag: "wx" });
  initializeWatchAuthority({ eventsPath, resource });
  const authority = new WatchAuthority({ eventsPath, resource });
  owned.authority = authority;
  const prepare = prepareWatchTool({ identity, wake, authority });
  const prepared = await prepare.execute({ address }, { ...invocation("first", "chat"), actor });
  if (prepared.isError || !object(prepared.structuredContent))
    throw new Error("Watch preparation failed.");
  const args = prepared.structuredContent.arguments;
  if (!object(args) || typeof args.ticket !== "string") throw new Error("Missing watch ticket.");
  const ticket = args.ticket;
  calls.length = 0;
  const program = eventsProgram({
    identity,
    wake,
    authority,
    resource,
    diagnostics,
    storage: {
      path: "/private/events.db",
      maxBytes: 1_048_576,
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    },
  });
  const account = await program.resolvePrincipal(invocation("first"));
  const definition = program.definitions[0];
  if (definition === undefined) throw new Error("Missing event.");
  return {
    actor,
    identity,
    wake,
    account,
    definition,
    program,
    binding,
    coverage,
    calls,
    grants,
    reads,
    state,
    authority,
    prepare,
    ticket,
    eventsPath,
  };
};

const diagnosticPrefix = "[agent-bus] authorization-diagnostic ";
const outcomes = {
  account: ["allowed", "refused"],
  subscription: [
    "input_refused",
    "context_refused",
    "account_mismatch",
    "watch_authority_refused",
    "correlation_mismatch",
    "native_observation_failed",
    "scope_returned",
    "cancelled",
  ],
  delivery: ["scope_refused", "grant_refused", "native_binding_failed", "allowed", "cancelled"],
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const diagnosticRecords = (lines: string[]) =>
  lines.map((line) => {
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(256);
    expect(line.startsWith(diagnosticPrefix)).toBe(true);
    const value: unknown = JSON.parse(line.slice(diagnosticPrefix.length));
    if (!object(value)) throw new Error("Non-object diagnostic.");
    expect(value.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    if (value.type === "enabled") {
      expect(Object.keys(value).sort()).toEqual(["maxRecords", "timestamp", "type"]);
      expect(value.maxRecords).toBe(52);
    } else if (value.type === "exhausted") {
      expect(Object.keys(value).sort()).toEqual(["callback", "timestamp", "type"]);
      if (typeof value.callback !== "string") throw new Error("Unknown callback.");
      expect(["account", "subscription", "delivery"]).toContain(value.callback);
    } else {
      expect(value.type).toBe("authorization");
      expect(Object.keys(value).sort()).toEqual(["callback", "outcome", "timestamp", "type"]);
      if (
        value.callback !== "account" &&
        value.callback !== "subscription" &&
        value.callback !== "delivery"
      )
        throw new Error("Unknown callback.");
      if (typeof value.outcome !== "string") throw new Error("Unknown outcome.");
      expect(outcomes[value.callback]).toContain(value.outcome);
    }
    return value;
  });

test("diagnostics reserve independent callback budgets and cap all controls and outcomes at 52", async () => {
  const lines: string[] = [];
  expect(authorizationDiagnostics(undefined, (line) => lines.push(line))).toBeUndefined();
  expect(authorizationDiagnostics(false, (line) => lines.push(line))).toBeUndefined();
  expect(lines).toEqual([]);
  const observe = authorizationDiagnostics(true, (line) => lines.push(line));
  if (observe === undefined) throw new Error("Missing diagnostic observer.");
  for (let i = 0; i < 40; i++) observe("delivery", "allowed");
  observe("subscription", "scope_returned");
  expect(diagnosticRecords(lines).at(-1)).toMatchObject({
    type: "authorization",
    callback: "subscription",
    outcome: "scope_returned",
  });
  for (let i = 0; i < 10; i++) observe("subscription", "context_refused");
  for (let i = 0; i < 10; i++) observe("account", "refused");
  const records = diagnosticRecords(lines);
  expect(records).toHaveLength(52);
  for (const [callback, count] of [
    ["account", 8],
    ["subscription", 8],
    ["delivery", 32],
  ] as const) {
    expect(
      records.filter((record) => record.type === "authorization" && record.callback === callback)
    ).toHaveLength(count);
    expect(
      records.filter((record) => record.type === "exhausted" && record.callback === callback)
    ).toHaveLength(1);
  }
  for (let i = 0; i < 10; i++) {
    observe("account", "allowed");
    observe("subscription", "scope_returned");
    observe("delivery", "allowed");
  }
  expect(lines).toHaveLength(52);
});

test("a throwing diagnostic writer consumes its own budget but never the others", () => {
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error("must not inspect");
      },
    }
  );
  const lines: string[] = [];
  let fail = true;
  let attempts = 0;
  const observe = authorizationDiagnostics(true, (line) => {
    attempts++;
    if (fail) throw hostile;
    lines.push(line);
  });
  if (observe === undefined) throw new Error("Missing diagnostic observer.");
  for (let i = 0; i < 8; i++) observe("account", "allowed");
  fail = false;
  for (let i = 0; i < 10; i++) observe("account", "allowed");
  observe("subscription", "scope_returned");
  expect(attempts).toBe(11);
  expect(diagnosticRecords(lines)).toMatchObject([
    { type: "exhausted", callback: "account" },
    { type: "authorization", callback: "subscription", outcome: "scope_returned" },
  ]);
});

test("delivery worker exhaustion still leaves a fresh subscription's evidence", async () => {
  const lines: string[] = [];
  const f = await fixture(authorizationDiagnostics(true, (line) => lines.push(line)));
  const scope = { principal: f.account.principal, resource, binding: f.binding };
  const context = { event: "mail.wake", arguments: { address, ticket: f.ticket }, signal };
  for (let i = 0; i < 40; i++)
    expect(await f.program.authorizeDelivery(scope, context)).toEqual({ allowed: true });
  expect(diagnosticRecords(lines).at(-1)).toMatchObject({
    type: "exhausted",
    callback: "delivery",
  });
  expect(
    await f.program.authorizeSubscription({
      account: f.account,
      event: "mail.wake",
      arguments: { address, ticket: f.ticket },
      invocation: invocation("first", "chat"),
      signal,
    })
  ).toEqual(scope);
  expect(diagnosticRecords(lines).at(-1)).toMatchObject({
    type: "authorization",
    callback: "subscription",
    outcome: "scope_returned",
  });
});

test("diagnostics are behavior-inert for admission, delivery and hostile synchronous writers", async () => {
  const cases = [
    ["account_allowed", "account", "allowed"],
    ["account_bad_token", "account", "refused"],
    ["active", "subscription", "scope_returned"],
    ["inactive", "subscription", "scope_returned"],
    ["empty", "subscription", "scope_returned"],
    ["no_chat", "subscription", "scope_returned"],
    ["no_chat_key", "subscription", "scope_returned"],
    ["blank_chat", "subscription", "scope_returned"],
    ["empty_chat", "subscription", "scope_returned"],
    ["nul_chat", "subscription", "scope_returned"],
    ["long_chat", "subscription", "scope_returned"],
    ["numeric_chat", "subscription", "scope_returned"],
    ["chat_canary", "subscription", "correlation_mismatch"],
    ["bad_token", "subscription", "context_refused"],
    ["deleted_grant", "subscription", "context_refused"],
    ["bad_grant", "subscription", "context_refused"],
    ["mismatch", "subscription", "account_mismatch"],
    ["wrong_event", "subscription", "input_refused"],
    ["wrong_filter", "subscription", "input_refused"],
    ["native_error", "subscription", "native_observation_failed"],
    ["native_throw", "subscription", "native_observation_failed"],
    ["native_malformed", "subscription", "native_observation_failed"],
    ["cancelled", "subscription", "cancelled"],
    ["cancelled_invocation", "subscription", "cancelled"],
    ["cancelled_native", "subscription", "cancelled"],
    ["delivery_allowed", "delivery", "allowed"],
    ["delivery_wrong_event", "delivery", "scope_refused"],
    ["delivery_wrong_filter", "delivery", "scope_refused"],
    ["delivery_bad_binding", "delivery", "scope_refused"],
    ["delivery_bad_resource", "delivery", "scope_refused"],
    ["delivery_deleted_grant", "delivery", "grant_refused"],
    ["delivery_native_error", "delivery", "native_binding_failed"],
    ["delivery_native_throw", "delivery", "native_binding_failed"],
    ["delivery_native_malformed", "delivery", "native_binding_failed"],
    ["delivery_cancelled", "delivery", "cancelled"],
    ["delivery_cancelled_native", "delivery", "cancelled"],
  ] as const;
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error("must not inspect a thrown value");
      },
      getPrototypeOf: () => {
        throw new Error("must not inspect a thrown value");
      },
    }
  );
  const run = async (
    name: (typeof cases)[number][0],
    callback: (typeof cases)[number][1],
    diagnostics: AuthorizationDiagnosticObserver | undefined
  ) => {
    const f = await fixture(diagnostics);
    f.reads.length = 0;
    f.calls.length = 0;
    const abort = new AbortController();
    let sub: Parameters<typeof f.program.authorizeSubscription>[0] = {
      account: f.account,
      event: "mail.wake",
      arguments: { address, ticket: f.ticket },
      invocation: invocation("TOKEN_CANARY", "chat"),
      signal: abort.signal,
    };
    let scope: Parameters<typeof f.program.authorizeDelivery>[0] = {
      principal: f.account.principal,
      resource,
      binding: f.binding,
    };
    let context: Parameters<typeof f.program.authorizeDelivery>[1] = {
      event: "mail.wake",
      arguments: { address, ticket: f.ticket },
      signal: abort.signal,
    };
    switch (name) {
      case "inactive":
        f.state.observation = { ...f.state.observation, ready: false, news: false };
        delete f.state.observation.latestEligibleAt;
        break;
      case "empty":
        f.state.observation = { ...f.state.observation, news: false };
        break;
      case "no_chat":
        sub = { ...sub, invocation: invocation("first") };
        break;
      case "no_chat_key":
        sub = { ...sub, invocation: { ...invocation("first"), requestMeta: {} } };
        break;
      case "blank_chat":
        sub = { ...sub, invocation: invocation("first", " \t") };
        break;
      case "empty_chat":
        sub = { ...sub, invocation: invocation("first", "") };
        break;
      case "nul_chat":
        sub = { ...sub, invocation: invocation("first", "chat\u0000CANARY") };
        break;
      case "long_chat":
        sub = { ...sub, invocation: invocation("first", "x".repeat(1025)) };
        break;
      case "numeric_chat":
        sub = {
          ...sub,
          invocation: { ...invocation("first"), requestMeta: { "openai/session": 9 } },
        };
        break;
      case "chat_canary":
        sub = { ...sub, invocation: invocation("first", "CHAT_CANARY") };
        break;
      case "bad_token":
        sub = { ...sub, invocation: invocation("UNKNOWN_TOKEN_CANARY", "chat") };
        break;
      case "deleted_grant":
      case "delivery_deleted_grant":
        f.grants.delete("/first");
        break;
      case "bad_grant":
        f.grants.set("/first", {
          subject: "first",
          resource,
          permissions: [PEER_PERMISSION],
          extra: "GRANT_CANARY",
        });
        break;
      case "mismatch":
        sub = { ...sub, invocation: invocation("second", "chat") };
        break;
      case "wrong_event":
        sub = { ...sub, event: "mail.other" };
        break;
      case "wrong_filter":
        sub = { ...sub, arguments: { address: "codex/ADDRESS_CANARY" } };
        break;
      case "delivery_wrong_event":
        context = { ...context, event: "mail.other" };
        break;
      case "delivery_wrong_filter":
        context = { ...context, arguments: { address: "codex/ADDRESS_CANARY" } };
        break;
      case "delivery_bad_binding":
        scope = { ...scope, binding: { ...f.binding, address: "chatgpt/BINDING_CANARY" } };
        break;
      case "delivery_bad_resource":
        scope = { ...scope, resource: "https://private.invalid/mcp" };
        break;
      case "native_error":
      case "delivery_native_error":
        f.state.isError = true;
        break;
      case "native_throw":
      case "delivery_native_throw":
        f.state.fail = true;
        f.state.thrown = hostile;
        break;
      case "native_malformed":
        f.state.observation = { ...f.state.observation, extra: "OBSERVATION_CANARY" };
        break;
      case "delivery_native_malformed":
        f.state.check = { ...f.state.check, extra: "BINDING_CANARY" };
        break;
      case "cancelled":
      case "delivery_cancelled":
        abort.abort();
        break;
      case "cancelled_invocation":
        abort.abort();
        sub = { ...sub, signal, invocation: { ...sub.invocation, signal: abort.signal } };
        break;
      case "cancelled_native":
      case "delivery_cancelled_native":
        f.state.beforeReturn = () => abort.abort();
        break;
    }
    const result =
      callback === "account"
        ? await Promise.resolve(
            f.program.resolvePrincipal(
              invocation(name === "account_bad_token" ? "UNKNOWN_TOKEN_CANARY" : "first")
            )
          ).then(
            (value) => ({ value }),
            () => ({ rejected: true })
          )
        : callback === "subscription"
          ? await f.program.authorizeSubscription(sub)
          : await f.program.authorizeDelivery(scope, context);
    return {
      result,
      reads: f.reads,
      calls: f.calls.map(({ name: call, args }) => ({ name: call, args })),
    };
  };
  for (const [name, callback, expected] of cases) {
    const baseline = await run(name, callback, authorizationDiagnostics(false));
    for (const mode of ["capture", "error", "primitive", "proxy"] as const) {
      const lines: string[] = [];
      let writes = 0;
      const diagnostics = authorizationDiagnostics(true, (line) => {
        writes++;
        lines.push(line);
        if (mode === "error") throw new Error("https://private.invalid/?token=TOKEN_CANARY");
        if (mode === "primitive") throw "THROWN_CANARY";
        if (mode === "proxy") throw hostile;
      });
      expect(await run(name, callback, diagnostics)).toEqual(baseline);
      expect(writes).toBe(3);
      const records = diagnosticRecords(lines);
      expect(records.map(({ type, callback, outcome }) => ({ type, callback, outcome }))).toEqual([
        { type: "enabled", callback: undefined, outcome: undefined },
        { type: "authorization", callback: "account", outcome: "allowed" },
        { type: "authorization", callback, outcome: expected },
      ]);
      for (const canary of [
        "TOKEN_CANARY",
        "CHAT_CANARY",
        "ADDRESS_CANARY",
        "BINDING_CANARY",
        "GRANT_CANARY",
        "OBSERVATION_CANARY",
        "NATIVE_ERROR_CANARY",
        "https://private.invalid",
        "openai/session",
      ])
        expect(lines.join("\n")).not.toContain(canary);
    }
  }
});

test("unusable metadata cannot override explicit authority or leak through diagnostics", async () => {
  for (const enabled of [false, true]) {
    const lines: string[] = [];
    const f = await fixture(authorizationDiagnostics(enabled, (line) => lines.push(line)));
    let metadataReads = 0;
    let valueReads = 0;
    let presenceChecks = 0;
    const metadata = new Proxy<Record<string, unknown>>(
      {},
      {
        get: () => {
          valueReads++;
          return undefined;
        },
        has: () => {
          presenceChecks++;
          throw new Error("PROXY_CANARY");
        },
      }
    );
    const request = {
      ...invocation("first"),
      get requestMeta() {
        metadataReads++;
        return metadata;
      },
    };
    expect(
      await f.program.authorizeSubscription({
        account: f.account,
        event: "mail.wake",
        arguments: { address, ticket: f.ticket },
        invocation: request,
        signal,
      })
    ).toEqual({ principal: f.account.principal, resource, binding: f.binding });
    expect(f.calls).toHaveLength(1);
    expect(valueReads).toBe(1);
    expect(metadataReads).toBe(1);
    expect(presenceChecks).toBe(0);
    if (enabled)
      expect(
        diagnosticRecords(lines).map(({ type, callback, outcome }) => ({ type, callback, outcome }))
      ).toEqual([
        { type: "enabled", callback: undefined, outcome: undefined },
        { type: "authorization", callback: "account", outcome: "allowed" },
        { type: "authorization", callback: "subscription", outcome: "scope_returned" },
      ]);
    else expect(lines).toEqual([]);
    expect(lines.join("\n")).not.toContain(f.ticket);
    expect(lines.join("\n")).not.toContain(f.binding.session);
  }
});

test("account exceptions and observer exceptions preserve the exact original decision", async () => {
  const f = await fixture();
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error("must not inspect");
      },
    }
  );
  const storage = { path: "/private/events.db", maxBytes: 1_048_576, encryptionKey: "fixture" };
  const lines: string[] = [];
  for (const diagnostics of [
    undefined,
    authorizationDiagnostics(true, (line) => lines.push(line)),
    () => {
      throw hostile;
    },
  ]) {
    const program = eventsProgram({
      identity: {
        ...f.identity,
        resolveAccount: async () => {
          throw hostile;
        },
      },
      wake: f.wake,
      authority: f.authority,
      resource,
      storage,
      diagnostics,
    });
    expect(
      await Promise.resolve(program.resolvePrincipal(invocation())).then(
        () => false,
        (error: unknown) => error === hostile
      )
    ).toBe(true);
    expect(
      await program.authorizeSubscription({
        account: f.account,
        event: "mail.wake",
        arguments: { address, ticket: f.ticket },
        invocation: invocation("first", "chat"),
        signal,
      })
    ).toEqual({ principal: f.account.principal, resource, binding: f.binding });
  }
  expect(
    diagnosticRecords(lines).map(({ type, callback, outcome }) => ({ type, callback, outcome }))
  ).toEqual([
    { type: "enabled", callback: undefined, outcome: undefined },
    { type: "authorization", callback: "account", outcome: "refused" },
    { type: "authorization", callback: "subscription", outcome: "scope_returned" },
  ]);
});

test("overlapping authorizations report completion order without attribution", async () => {
  const f = await fixture();
  const first = Promise.withResolvers<typeof f.actor>();
  const second = Promise.withResolvers<typeof f.actor>();
  const lines: string[] = [];
  const program = eventsProgram({
    identity: {
      ...f.identity,
      resolveAuthorized: (request) =>
        request.auth?.accessToken === "first" ? first.promise : second.promise,
    },
    wake: f.wake,
    authority: f.authority,
    resource,
    diagnostics: authorizationDiagnostics(true, (line) => lines.push(line)),
    storage: { path: "/private/events.db", maxBytes: 1_048_576, encryptionKey: "fixture" },
  });
  const authorize = (token: string) =>
    program.authorizeSubscription({
      account: f.account,
      event: "mail.wake",
      arguments: { address, ticket: f.ticket },
      invocation: invocation(token, "chat"),
      signal,
    });
  const a = authorize("first");
  const b = authorize("second");
  second.resolve(f.actor);
  expect(await b).toBeDefined();
  first.reject(new Error("PRIVATE_FAILURE_CANARY"));
  expect(await a).toBeUndefined();
  expect(
    diagnosticRecords(lines).map(({ type, callback, outcome }) => ({ type, callback, outcome }))
  ).toEqual([
    { type: "enabled", callback: undefined, outcome: undefined },
    { type: "authorization", callback: "subscription", outcome: "scope_returned" },
    { type: "authorization", callback: "subscription", outcome: "context_refused" },
  ]);
  expect(lines.join("\n")).not.toContain("PRIVATE_FAILURE_CANARY");
});

test("the Events public program and schemas stay fixed and samples never emit diagnostics", async () => {
  const lines: string[] = [];
  const off = await fixture();
  const disabled = await fixture(authorizationDiagnostics(false));
  const on = await fixture(authorizationDiagnostics(true, (line) => lines.push(line)));
  expect(off.program.resolvePrincipal).toBe(off.identity.resolveAccount);
  expect(disabled.program.resolvePrincipal).toBe(disabled.identity.resolveAccount);
  expect(on.program.resolvePrincipal).not.toBe(on.identity.resolveAccount);
  expect(Object.keys(on.program).sort()).toEqual(Object.keys(off.program).sort());
  expect(on.program.definitions.map(({ name }) => name)).toEqual(
    off.program.definitions.map(({ name }) => name)
  );
  expect(
    on.definition.inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" })
  ).toEqual(off.definition.inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }));
  expect(
    on.definition.payloadSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" })
  ).toEqual(
    off.definition.payloadSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" })
  );
  expect(await on.definition.payloadSchema["~standard"].validate({ address })).toHaveProperty(
    "value"
  );
  expect(
    await on.definition.payloadSchema["~standard"].validate({ address, ticket: on.ticket })
  ).toHaveProperty("issues");
  const before = lines.length;
  await on.definition.source.sample({
    principal: { principal: on.account.principal, resource, binding: on.binding },
    filter: { address, ticket: on.ticket },
    checkpoint: undefined,
    reason: "activation",
    revision: 1,
    generation: 1,
    waitMs: 0,
    signal,
  });
  expect(lines).toHaveLength(before);
  expect(
    diagnosticRecords(lines).map(({ type, callback, outcome }) => ({ type, callback, outcome }))
  ).toEqual([
    { type: "enabled", callback: undefined, outcome: undefined },
    { type: "authorization", callback: "account", outcome: "allowed" },
  ]);
});

test("account control is independent of correlation and grant while subscription is freshly authorized", async () => {
  const f = await fixture();
  expect(await f.program.resolvePrincipal(invocation("rotated", "other"))).toEqual(f.account);
  expect(await f.program.resolvePrincipal(invocation("second", "chat"))).not.toEqual(f.account);
  expect(JSON.stringify(f.account)).not.toContain("first");
  const authorize = (
    overrides: Partial<Parameters<typeof f.program.authorizeSubscription>[0]> = {}
  ) =>
    f.program.authorizeSubscription({
      account: f.account,
      event: "mail.wake",
      arguments: { address, ticket: f.ticket },
      invocation: invocation("first", "chat"),
      signal,
      ...overrides,
    });
  const scope = await authorize();
  expect(scope).toEqual({ principal: f.account.principal, resource, binding: f.binding });
  expect(f.calls.at(-1)?.args).not.toHaveProperty("previousCoverage");
  const before = f.calls.length;
  for (const overrides of [
    { event: "mail.other" },
    { arguments: { address: "codex/foreign", ticket: f.ticket } },
    { arguments: { address, ticket: f.ticket, extra: true } },
    { invocation: invocation("second", "chat") },
  ])
    expect(await authorize(overrides)).toBeUndefined();
  expect(f.calls).toHaveLength(before);
  expect(await authorize({ invocation: invocation("first") })).toEqual(scope);
  expect(
    await f.definition.inputSchema["~standard"].validate({ address, ticket: f.ticket })
  ).toHaveProperty("value");
  expect(await f.definition.inputSchema["~standard"].validate({ address })).toHaveProperty(
    "issues"
  );
  expect(
    await f.definition.inputSchema["~standard"].validate({ address, ticket: f.ticket, secret: "x" })
  ).toHaveProperty("issues");
  f.grants.delete("/first");
  expect(await f.program.resolvePrincipal(invocation("first"))).toEqual(f.account);
  expect(await authorize()).toBeUndefined();
  expect(await f.program.canDiscover(f.account, "mail.wake", signal)).toBe(false);
  expect(f.reads.at(-1)).toBe("/first");
  expect(await f.program.resolvePrincipal(invocation("second"))).not.toEqual(f.account);
  await expect(f.program.resolvePrincipal(invocation("unknown"))).rejects.toThrow();
});

test("watch preparation requires the owning tool context and admission needs its exact ticket", async () => {
  const lines: string[] = [];
  const f = await fixture(authorizationDiagnostics(true, (line) => lines.push(line)));
  const callPrepare = (request: InvocationIdentity, input: unknown = { address }) =>
    f.prepare.execute(input, { ...request, actor: f.actor });
  const prepare = await callPrepare(invocation("rotated", "chat"));
  expect(prepare.isError).not.toBe(true);
  expect(
    JSON.stringify(prepare.structuredContent) ===
      JSON.stringify({
        event: "mail.wake",
        arguments: { address, ticket: f.ticket },
      })
  ).toBe(true);
  const text = prepare.content[0]?.text;
  expect(typeof text).toBe("string");
  if (typeof text !== "string") throw new Error("Missing preparation text carrier.");
  expect(JSON.stringify(JSON.parse(text)) === JSON.stringify(prepare.structuredContent)).toBe(true);
  const observe = f.calls.at(-1);
  expect(observe?.name).toBe("bus_observe_wake");
  expect(observe?.args).not.toHaveProperty("previousCoverage");
  expect(observe?.args).not.toHaveProperty("expectedBinding");
  const foreignRequest = invocation("first", "other-chat");
  const foreignActor = await f.identity.resolvePeer(foreignRequest);
  expect(typeof foreignActor.session).toBe("string");
  expect(foreignActor.session !== f.actor.session).toBe(true);
  const foreignPrepare = await f.prepare.execute(
    { address },
    { ...foreignRequest, actor: foreignActor }
  );
  expect(foreignPrepare.isError).toBe(true);
  expect(f.calls.at(-1)?.args.session === foreignActor.session).toBe(true);
  const originalPrepare = await callPrepare(invocation("first", "chat"));
  const originalArgs = originalPrepare.structuredContent?.arguments;
  expect(
    originalPrepare.isError !== true && object(originalArgs) && originalArgs.ticket === f.ticket
  ).toBe(true);
  expect((await callPrepare(invocation("first"))).isError).toBe(true);
  expect(
    (await callPrepare(invocation("first", "chat"), { address, ticket: f.ticket })).isError
  ).toBe(true);
  f.grants.delete("/first");
  expect((await callPrepare(invocation("first", "chat"))).isError).toBe(true);
  f.grants.set("/first", { subject: "first", resource, permissions: [PEER_PERMISSION] });

  const authorize = (input: unknown, request: InvocationIdentity, account = f.account) =>
    f.program.authorizeSubscription({
      account,
      event: "mail.wake",
      arguments: input,
      invocation: request,
      signal,
    });
  const altered = `${f.ticket[0] === "A" ? "B" : "A"}${f.ticket.slice(1)}`;
  const foreign = await f.program.resolvePrincipal(invocation("second"));
  const before = f.calls.length;
  for (const [input, request, account] of [
    [{ address }, invocation("first"), f.account],
    [{ address, ticket: altered }, invocation("first"), f.account],
    [{ address: "chatgpt/foreign", ticket: f.ticket }, invocation("first"), f.account],
    [{ address, ticket: f.ticket }, invocation("second"), foreign],
    [{ address, ticket: f.ticket }, invocation("first", "other-chat"), f.account],
  ] as const)
    expect(await authorize(input, request, account)).toBeUndefined();
  expect(f.calls).toHaveLength(before);
  expect(await authorize({ address, ticket: f.ticket }, invocation("first"))).toEqual({
    principal: f.account.principal,
    resource,
    binding: f.binding,
  });
  const trace = lines.join("\n");
  for (const secret of [f.ticket, ...Object.values(f.binding)])
    expect(trace.includes(secret)).toBe(false);
});

test("delivery checks only the original binding and current principal grant", async () => {
  const f = await fixture();
  const scope = { principal: f.account.principal, resource, binding: f.binding };
  const context = { event: "mail.wake", arguments: { address, ticket: f.ticket }, signal };
  expect(await f.program.authorizeDelivery(scope, context)).toEqual({ allowed: true });
  expect(f.calls.map(({ name }) => name)).toEqual(["bus_check_wake_binding"]);
  for (const bad of [
    { ...scope, resource: "https://other.invalid/mcp" },
    { ...scope, principal: "unknown" },
    { ...scope, binding: { ...f.binding, run: "different" } },
    { ...scope, binding: { ...f.binding, address: "chatgpt/other" } },
  ])
    expect(await f.program.authorizeDelivery(bad, context)).toEqual({ allowed: false });
  f.grants.set("/first", { subject: "second", resource, permissions: [PEER_PERMISSION] });
  const calls = f.calls.length;
  expect(await f.program.authorizeDelivery(scope, context)).toEqual({ allowed: false });
  expect(f.calls).toHaveLength(calls);
  f.grants.set("/first", { subject: "first", resource, permissions: [PEER_PERMISSION] });
  f.state.fail = true;
  expect(await f.program.authorizeDelivery(scope, context)).toEqual({ allowed: false });
});

test("an accepted scope continues through map removal until its next refresh", async () => {
  const f = await fixture();
  const input = { address, ticket: f.ticket };
  const subscribe = () =>
    f.program.authorizeSubscription({
      account: f.account,
      event: "mail.wake",
      arguments: input,
      invocation: invocation("first"),
      signal,
    });
  const scope = await subscribe();
  if (scope === undefined) throw new Error("Subscription was refused.");
  const path = watchAuthorityPath(f.eventsPath);
  await f.authority.close();
  rmSync(path);
  expect(
    await f.program.authorizeDelivery(scope, { event: "mail.wake", arguments: input, signal })
  ).toEqual({
    allowed: true,
  });
  const observed = await f.definition.source.sample({
    principal: scope,
    filter: input,
    checkpoint: undefined,
    reason: "activation",
    revision: 1,
    generation: 1,
    waitMs: 0,
    signal,
  });
  expect(observed).toMatchObject({ kind: "occurrence" });
  if (observed.kind !== "occurrence") throw new Error("Missing occurrence.");
  expect(observed.occurrence.data).toEqual({ address });
  expect(await subscribe()).toBeUndefined();
});

test("rung ordering does not change occurrence identity and checkpoints retain native order", async () => {
  const f = await fixture();
  const principal = { principal: f.account.principal, resource, binding: f.binding };
  const sample = () =>
    f.definition.source.sample({
      principal,
      filter: { address, ticket: f.ticket },
      checkpoint: undefined,
      reason: "activation",
      revision: 7,
      generation: 11,
      waitMs: 0,
      signal,
    });
  const firstCoverage = { ...f.coverage, rung: ["b", "a"] };
  const secondCoverage = { ...f.coverage, rung: ["a", "b"] };
  f.state.observation = { ...f.state.observation, nextCoverage: firstCoverage };
  const first = await sample();
  f.state.observation = { ...f.state.observation, nextCoverage: secondCoverage };
  const second = await sample();
  if (first.kind !== "occurrence" || second.kind !== "occurrence")
    throw new Error("Missing occurrence.");
  expect(first.occurrence).toEqual(second.occurrence);
  expect(first.nextCheckpoint).toEqual(firstCoverage);
  expect(second.nextCheckpoint).toEqual(secondCoverage);
});

test("samples preserve complete coverage and pass fresh observation revision, generation, wait and signal", async () => {
  const f = await fixture();
  expect(f.program.limits?.maxCheckpointBytes).toBe(65_536);
  const principal = { principal: f.account.principal, resource, binding: f.binding };
  const sample = (
    reason: "activation" | "restart" | "resolved" | "wait-expired",
    checkpoint: EventsValue | undefined = undefined
  ) =>
    f.definition.source.sample({
      principal,
      filter: { address, ticket: f.ticket },
      checkpoint,
      reason,
      revision: 7,
      generation: 11,
      waitMs: 51_000,
      signal,
    });
  for (const reason of ["activation", "restart", "resolved", "wait-expired"] as const) {
    const observed = await sample(reason);
    expect(observed).toMatchObject({
      kind: "occurrence",
      occurrence: { timestamp: "2026-01-01T00:00:00.000Z" },
      nextCheckpoint: f.coverage,
      expectedRevision: 7,
      expectedGeneration: 11,
    });
    if (observed.kind !== "occurrence") throw new Error("Missing occurrence.");
    expect(observed.occurrence.data).toEqual({ address });
    expect(JSON.stringify(observed)).not.toContain("private");
    expect(f.calls.at(-1)?.args).toMatchObject({
      timeoutSeconds: 50,
      maxResultBytes: 65_536,
      expectedBinding: f.binding,
    });
    expect(f.calls.at(-1)?.signal).toBe(signal);
  }
  const first = await sample("activation");
  f.state.observation = {
    ...f.state.observation,
    observationCut: { head: 100, incarnation: f.binding.incarnation },
  };
  const repeated = await sample("restart");
  expect(repeated).toEqual(first);
  f.state.observation = { ...f.state.observation, latestEligibleAt: "2026-02-01T00:00:00.000Z" };
  const changed = await sample("restart");
  if (first.kind !== "occurrence" || changed.kind !== "occurrence")
    throw new Error("Missing occurrence.");
  expect(changed.occurrence.id).not.toBe(first.occurrence.id);

  const large = {
    ...f.coverage,
    rung: Array.from({ length: 200 }, (_, i) => `message-${i}-${"x".repeat(40)}`),
  };
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(4096);
  f.state.observation = { ...f.state.observation, nextCoverage: large };
  const largeObservation = await sample("resolved", large);
  expect(largeObservation.kind).toBe("occurrence");
  if (largeObservation.kind !== "occurrence") throw new Error("Missing occurrence.");
  expect(largeObservation.nextCheckpoint).toEqual(large);
  expect(largeObservation.nextCheckpoint).toHaveProperty("rung", large.rung);
  expect(f.calls.at(-1)?.args.previousCoverage).toEqual(large);
  f.state.observation = { ...f.state.observation, ready: true, news: false };
  expect(await sample("resolved", large)).toEqual({ kind: "idle" });
  f.state.observation = {
    ...f.state.observation,
    ready: false,
    news: false,
    latestEligibleAt: undefined,
  };
  delete f.state.observation.latestEligibleAt;
  expect(await sample("wait-expired", large)).toEqual({ kind: "idle" });
  f.state.observation = { ...f.state.observation, news: true };
  await expect(sample("activation", large)).rejects.toThrow();
  f.state.observation = {
    ...f.state.observation,
    ready: true,
    latestEligibleAt: "2026-02-01T00:00:00.000Z",
    nextCoverage: { ...large, rung: Array.from({ length: 1025 }, (_, i) => `id-${i}`) },
  };
  await expect(sample("activation", large)).rejects.toThrow();
  f.state.observation = { ...f.state.observation, nextCoverage: undefined };
  await expect(sample("activation", large)).rejects.toThrow();
  f.state.observation = { ...f.state.observation, nextCoverage: f.coverage, extra: true };
  await expect(sample("activation")).rejects.toThrow();
  delete f.state.observation.extra;
  f.state.observation = { ...f.state.observation, binding: { ...f.binding, run: "stale" } };
  await expect(sample("activation")).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.definition.source.sample({
      principal,
      filter: { address, ticket: f.ticket },
      checkpoint: undefined,
      reason: "activation",
      revision: 7,
      generation: 11,
      waitMs: 0,
      signal: abort.signal,
    })
  ).rejects.toThrow();
});
