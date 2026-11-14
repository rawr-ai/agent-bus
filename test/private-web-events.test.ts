import { expect, test } from "bun:test";
import type { EventsValue, InvocationIdentity } from "mcp-openapi";
import { eventsProgram } from "../src/private-web/events.ts";
import { clerkPeerIdentity, PEER_PERMISSION } from "../src/private-web/identity.ts";
import { wakePort } from "../src/private-web/peer.ts";
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

const fixture = async () => {
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
    identify: async (token) => (token === "rotated" ? "first" : token),
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
  };
  const wake = wakePort(async (name, args, callSignal) => {
    calls.push({ name, args, ...(callSignal === undefined ? {} : { signal: callSignal }) });
    if (state.fail) throw new Error("native failure");
    return {
      content: [],
      structuredContent: name === "bus_observe_wake" ? state.observation : state.check,
    };
  });
  const program = eventsProgram({
    identity,
    wake,
    resource,
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
    account,
    definition,
    program,
    binding,
    coverage,
    calls,
    grants,
    reads,
    state,
  };
};

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
      arguments: { address },
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
    { arguments: { address: "codex/foreign" } },
    { arguments: { address, extra: true } },
    { invocation: invocation("first") },
    { invocation: invocation("second", "chat") },
  ])
    expect(await authorize(overrides)).toBeUndefined();
  expect(f.calls).toHaveLength(before);
  expect(await f.definition.inputSchema["~standard"].validate({ address })).toHaveProperty("value");
  expect(
    await f.definition.inputSchema["~standard"].validate({ address, secret: "x" })
  ).toHaveProperty("issues");
  f.grants.delete("/first");
  expect(await f.program.resolvePrincipal(invocation("first"))).toEqual(f.account);
  expect(await authorize()).toBeUndefined();
  expect(await f.program.canDiscover(f.account, "mail.wake", signal)).toBe(false);
  expect(f.reads.at(-1)).toBe("/first");
  expect(await f.program.resolvePrincipal(invocation("second"))).not.toEqual(f.account);
  await expect(f.program.resolvePrincipal(invocation("unknown"))).rejects.toThrow();
});

test("delivery checks only the original binding and current principal grant", async () => {
  const f = await fixture();
  const scope = { principal: f.account.principal, resource, binding: f.binding };
  const context = { event: "mail.wake", arguments: { address }, signal };
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

test("rung ordering does not change occurrence identity and checkpoints retain native order", async () => {
  const f = await fixture();
  const principal = { principal: f.account.principal, resource, binding: f.binding };
  const sample = () =>
    f.definition.source.sample({
      principal,
      filter: { address },
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
      filter: { address },
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
      occurrence: { timestamp: "2026-01-01T00:00:00.000Z", data: { address } },
      nextCheckpoint: f.coverage,
      expectedRevision: 7,
      expectedGeneration: 11,
    });
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
      filter: { address },
      checkpoint: undefined,
      reason: "activation",
      revision: 7,
      generation: 11,
      waitMs: 0,
      signal: abort.signal,
    })
  ).rejects.toThrow();
});
