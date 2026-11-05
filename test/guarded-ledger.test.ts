import { afterAll, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { Message, Origin } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { type Designation, type DesignationScope, Ledger } from "../src/Ledger.ts";
import { startFileFlureeServer } from "./fluree-file-server.ts";

interface Config {
  readonly url: string;
  readonly ledger: string;
  readonly token: string;
}

let running: ReturnType<typeof startFileFlureeServer> | undefined;
const freshLedger = async (name = "guarded"): Promise<Config> => {
  running ??= startFileFlureeServer();
  const server = await running;
  return server.freshLedger(name);
};
const insertRaw = async (config: Config, node: unknown) => {
  const response = await fetch(
    `${config.url}/v1/fluree/insert?ledger=${encodeURIComponent(config.ledger)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify(node),
    }
  );
  if (!response.ok) throw new Error(`raw fixture insert failed (HTTP ${response.status})`);
};
afterAll(async () => {
  const server = await running?.catch(() => undefined);
  await server?.stop();
});

const bus = "https://rawr.ai/ns/agent-bus#";
const context = { bus, xsd: "http://www.w3.org/2001/XMLSchema#" };
const id = () => Bun.randomUUIDv7().toLowerCase();
const message = (body: string, from = "codex/publisher") =>
  new Message({
    id: id(),
    ts: "2026-11-03T12:00:00.000Z",
    from,
    to: ["codex/reader"],
    kind: "message",
    body,
    origin: new Origin({ host: "fixture", cwd: "/work" }),
  });
const request = (scope: DesignationScope, expected: string | null): Designation => {
  const operation = id();
  return {
    scope,
    expected,
    operation,
    intent: JSON.stringify({ scope, expected, publisher: "codex/publisher" }),
    record: JSON.stringify({ kind: scope.kind, body: "known fixture" }),
    notification: message(`notice for ${operation}`),
  };
};

const open = async (config: Awaited<ReturnType<typeof freshLedger>>, url = config.url) => {
  const runtime = ManagedRuntime.make(
    layerFluree({ ...config, url }).pipe(Layer.provide(FetchHttpClient.layer))
  );
  try {
    await runtime.runPromise(Effect.void);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  const designate = (value: Designation) =>
    runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.designate(value)));
  const witness = (operation: string) =>
    runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.readWitness(operation)));
  const read = (from: number) => runtime.runPromise(Effect.flatMap(Ledger, (l) => l.read(from)));
  return { config, runtime, designate, witness, read };
};
const setup = async () => open(await freshLedger("guarded"));

/** Literal provider queries, independent of the production read/classification helpers. */
const query = async (
  config: Awaited<ReturnType<typeof freshLedger>>,
  body: Record<string, unknown>
): Promise<unknown> => {
  const result = await fetch(`${config.url}/v1/fluree/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ "@context": context, from: config.ledger, ...body }),
  });
  if (!result.ok) throw new Error(`independent query failed: HTTP ${result.status}`);
  return result.json();
};
const at = (config: Awaited<ReturnType<typeof freshLedger>>, t: number) =>
  `${config.ledger}@t:${t}`;
const pointer = (config: Awaited<ReturnType<typeof freshLedger>>, scope: string, t: number) =>
  query(config, {
    from: at(config, t),
    select: "?revision",
    where: { "@id": scope, "bus:currentRevision": "?revision" },
  });
const history = (
  config: Awaited<ReturnType<typeof freshLedger>>,
  messageId: string,
  head: number
) =>
  query(config, {
    from: at(config, 1),
    to: at(config, head),
    select: ["?t"],
    values: [["?m"], [[{ "@type": "@id", "@value": `urn:agent-bus:message:${messageId}` }]]],
    where: [{ "@id": "?m", "bus:json": { "@value": "?json", "@t": "?t", "@op": true } }],
  });

type Fault = "lost" | "status" | "malformed" | "broken-body" | "before-headers" | "mid-body";

/** A one-shot fault at the update boundary; all reads still use the real server. */
const updateBoundary = (upstream: string) => {
  let pending:
    | {
        readonly fault: Fault;
        readonly arrived: () => void;
        readonly finalised: () => void;
      }
    | undefined;
  let updates = 0;
  let witnesses = 0;
  let forwardedStatus: number | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.delete("host");
      const body = request.method === "GET" ? undefined : await request.arrayBuffer();
      if (url.pathname.startsWith("/v1/fluree/query/") && body !== undefined) {
        const text = new TextDecoder().decode(body);
        if (text.includes("urn:agent-bus:witness:") && text.includes("?predicate")) witnesses++;
      }
      const forward = () =>
        fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        });
      if (url.pathname !== "/v1/fluree/update") return forward();
      updates++;
      const fault = pending;
      pending = undefined;
      if (fault === undefined) return forward();
      fault.arrived();
      request.signal.addEventListener("abort", fault.finalised, { once: true });
      switch (fault.fault) {
        case "lost": {
          const result = await forward();
          forwardedStatus = result.status;
          await result.arrayBuffer();
          return new Response(null, { status: 504 });
        }
        case "status":
          return new Response(null, { status: 503 });
        case "malformed":
          return new Response("not json", { headers: { "content-type": "application/json" } });
        case "broken-body":
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("fixture disconnected"));
              },
            }),
            { headers: { "content-type": "application/json" } }
          );
        case "before-headers":
          return new Promise<Response>(() => {});
        case "mid-body":
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"t":'));
              },
              pull: () => new Promise<void>(() => {}),
              cancel: fault.finalised,
            }),
            { headers: { "content-type": "application/json" } }
          );
      }
    },
  });
  return {
    url: server.url.origin,
    arm: (fault: Fault) => {
      let arrived = () => {};
      let finalised = () => {};
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const released = new Promise<void>((resolve) => {
        finalised = resolve;
      });
      pending = { fault, arrived, finalised };
      return { reached, released };
    },
    counts: () => ({ updates, witnesses, forwardedStatus }),
    stop: () => server.stop(true),
  };
};

const withBoundary = async <A>(
  config: Config,
  relay: ReturnType<typeof updateBoundary>,
  run: (store: Awaited<ReturnType<typeof open>>) => Promise<A>
): Promise<A> => {
  let store: Awaited<ReturnType<typeof open>> | undefined;
  try {
    store = await open(config, relay.url);
    return await run(store);
  } finally {
    try {
      await store?.runtime.dispose();
    } finally {
      relay.stop();
    }
  }
};

const within = async <A>(promise: Promise<A>, milliseconds = 5_000): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture timed out")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test("production guarded writes retain one immutable witness and notification across replacement and replay", async () => {
  const store = await setup();
  try {
    const scope = { kind: "directory", directory: "project" } as const;
    const initial = request(scope, null);
    const first = await store.designate(initial);
    expect(first.status).toBe("APPLIED");
    if (first.status !== "APPLIED") throw new Error(`initial outcome: ${first.status}`);
    expect(first.revision).toBe(initial.operation);
    expect(first.notification).toEqual(initial.notification);
    const next = request(scope, initial.operation);
    const second = await store.designate(next);
    expect(second.status).toBe("APPLIED");
    if (second.status !== "APPLIED") throw new Error(`replacement outcome: ${second.status}`);
    const literalScope = "urn:agent-bus:orientation:directory:project";
    expect(await pointer(store.config, literalScope, first.cut.head)).toEqual([initial.operation]);
    expect(await pointer(store.config, literalScope, second.cut.head)).toEqual([next.operation]);
    expect(
      await query(store.config, {
        from: at(store.config, first.cut.head),
        select: ["?intent", "?revision", "?notification"],
        where: {
          "@id": `urn:agent-bus:witness:${initial.operation}`,
          "bus:intent": "?intent",
          "bus:revision": "?revision",
          "bus:notification": "?notification",
        },
      })
    ).toEqual([
      [initial.intent, initial.operation, `urn:agent-bus:message:${initial.notification.id}`],
    ]);
    expect(
      await query(store.config, {
        from: at(store.config, first.cut.head),
        select: ["?record", "?scope"],
        where: {
          "@id": `urn:agent-bus:revision:${initial.operation}`,
          "bus:record": "?record",
          "bus:scope": "?scope",
        },
      })
    ).toEqual([[initial.record, literalScope]]);
    const equivalent = { ...initial, notification: message("new transient notification") };
    const replay = await store.designate(equivalent);
    expect(replay.status).toBe("APPLIED");
    if (replay.status !== "APPLIED") throw new Error(`replay outcome: ${replay.status}`);
    expect(replay.notification).toEqual(initial.notification);
    expect(replay.revision).toBe(initial.operation);
    expect(await history(store.config, initial.notification.id, replay.cut.head)).toHaveLength(1);
    expect(await history(store.config, equivalent.notification.id, replay.cut.head)).toHaveLength(
      0
    );
    expect(await history(store.config, id(), replay.cut.head)).toHaveLength(0);
    const ordinary = message("independent history calibration");
    await store.runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.append(ordinary)));
    const head = await store.runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.end));
    expect(await history(store.config, ordinary.id, head)).toHaveLength(1);
    for (const subject of [
      `urn:agent-bus:revision:${initial.operation}`,
      `urn:agent-bus:witness:${initial.operation}`,
    ]) {
      expect(
        await query(store.config, {
          from: at(store.config, head),
          select: "?json",
          where: { "@id": subject, "bus:json": "?json" },
        })
      ).toEqual([]);
    }
    const delivered = await store.read(0);
    expect(delivered.entries.map(({ message: entry }) => entry.id)).toEqual([
      initial.notification.id,
      next.notification.id,
      ordinary.id,
    ]);
    expect(await pointer(store.config, literalScope, replay.cut.head)).toEqual([next.operation]);
  } finally {
    await store.runtime.dispose();
  }
});

test("scopes are isolated; stale targets conflict, while a missed directory fence stays unknown", async () => {
  const store = await setup();
  try {
    const directory = request({ kind: "directory", directory: "same" }, null);
    const programme = request({ kind: "programme" }, null);
    const concern = request({ kind: "concern", directory: "same", concern: "same" }, null);
    const directoryResult = await store.designate(directory);
    const programmeResult = await store.designate(programme);
    const concernResult = await store.designate({
      ...concern,
      directoryRevision: directory.operation,
    });
    expect([directoryResult.status, programmeResult.status, concernResult.status]).toEqual([
      "APPLIED",
      "APPLIED",
      "APPLIED",
    ]);
    if (concernResult.status !== "APPLIED") throw new Error("concern was not applied");
    for (const [subject, expected] of [
      ["urn:agent-bus:orientation:directory:same", directory.operation],
      ["urn:agent-bus:orientation:programme", programme.operation],
      ["urn:agent-bus:orientation:concern:same:same", concern.operation],
    ]) {
      if (subject === undefined || expected === undefined) throw new Error("bad test case");
      expect(await pointer(store.config, subject, concernResult.cut.head)).toEqual([expected]);
    }
    const stale = request({ kind: "directory", directory: "same" }, null);
    const staleResult = await store.designate(stale);
    expect(staleResult).toMatchObject({ status: "CONFLICT", current: directory.operation });
    const replacement = request({ kind: "directory", directory: "same" }, directory.operation);
    expect((await store.designate(replacement)).status).toBe("APPLIED");
    const fenceMiss = request({ kind: "concern", directory: "same", concern: "other" }, null);
    const missed = await store.designate({ ...fenceMiss, directoryRevision: directory.operation });
    expect(missed.status).toBe("UNKNOWN");
    expect((await store.witness(fenceMiss.operation)).status).toBe("ABSENT");
    const read = await store.read(0);
    expect(read.entries.map(({ message: entry }) => entry.id)).toEqual([
      directory.notification.id,
      programme.notification.id,
      concern.notification.id,
      replacement.notification.id,
    ]);
    expect(
      await pointer(store.config, "urn:agent-bus:orientation:concern:same:other", read.next)
    ).toEqual([]);
    expect(await history(store.config, stale.notification.id, read.next)).toHaveLength(0);
    expect(await history(store.config, fenceMiss.notification.id, read.next)).toHaveLength(0);
  } finally {
    await store.runtime.dispose();
  }
});

test("global operation reuse with changed intent is a mismatch and does not move either scope", async () => {
  const store = await setup();
  try {
    const original = request({ kind: "directory", directory: "one" }, null);
    expect((await store.designate(original)).status).toBe("APPLIED");
    const changed = {
      ...request({ kind: "directory", directory: "two" }, null),
      operation: original.operation,
      intent: JSON.stringify({ publisher: "codex/another", scope: "two" }),
      notification: message("changed", "codex/another"),
    };
    expect((await store.designate(changed)).status).toBe("IDENTITY_MISMATCH");
    const entries = await store.read(0);
    expect(entries.entries.map(({ message: entry }) => entry.id)).toEqual([
      original.notification.id,
    ]);
    expect(
      await pointer(store.config, "urn:agent-bus:orientation:directory:one", entries.next)
    ).toEqual([original.operation]);
    expect(
      await pointer(store.config, "urn:agent-bus:orientation:directory:two", entries.next)
    ).toEqual([]);
    expect(await history(store.config, changed.notification.id, entries.next)).toHaveLength(0);
    // The killed classifier is simply witness presence: it would say applied even though
    // the stored intent demonstrably belongs to a different publisher and scope.
    expect(
      await query(store.config, {
        from: at(store.config, entries.next),
        select: "?intent",
        where: { "@id": `urn:agent-bus:witness:${changed.operation}`, "bus:intent": "?intent" },
      })
    ).toEqual([original.intent]);
    expect(original.intent).not.toBe(changed.intent);
  } finally {
    await store.runtime.dispose();
  }
});

test("multi-valued pointers and pre-existing immutable subjects never admit a guarded write", async () => {
  const store = await setup();
  try {
    const scope = { kind: "directory", directory: "damaged" } as const;
    const initial = request(scope, null);
    expect((await store.designate(initial)).status).toBe("APPLIED");
    const other = id();
    await insertRaw(store.config, {
      "@context": context,
      "@id": "urn:agent-bus:orientation:directory:damaged",
      "bus:currentRevision": other,
    });
    const next = request(scope, initial.operation);
    expect((await store.designate(next)).status).toBe("UNKNOWN");
    const entries = await store.read(0);
    const pointers = await pointer(
      store.config,
      "urn:agent-bus:orientation:directory:damaged",
      entries.next
    );
    expect(pointers).toEqual(expect.arrayContaining([initial.operation, other]));
    expect(pointers).toHaveLength(2);
    expect(await history(store.config, next.notification.id, entries.next)).toHaveLength(0);
    const parentFence = request({ kind: "concern", directory: "damaged", concern: "one" }, null);
    expect(
      (await store.designate({ ...parentFence, directoryRevision: initial.operation })).status
    ).toBe("UNKNOWN");
    const invalidPointer = request({ kind: "directory", directory: "bad-type" }, null);
    expect((await store.designate(invalidPointer)).status).toBe("APPLIED");
    await insertRaw(store.config, {
      "@context": context,
      "@id": "urn:agent-bus:orientation:directory:bad-type",
      "bus:currentRevision": { "@id": "urn:fixture:invalid-pointer" },
    });
    const afterDamage = request(invalidPointer.scope, invalidPointer.operation);
    expect((await store.designate(afterDamage)).status).toBe("UNKNOWN");
    const reusedRevision = request({ kind: "programme" }, null);
    await insertRaw(store.config, {
      "@context": context,
      "@id": `urn:agent-bus:revision:${reusedRevision.operation}`,
      "bus:unexpected": "partial",
    });
    expect((await store.designate(reusedRevision)).status).toBe("UNKNOWN");
    const reusedMessage = request({ kind: "programme" }, null);
    await insertRaw(store.config, {
      "@context": context,
      "@id": `urn:agent-bus:message:${reusedMessage.notification.id}`,
      "bus:unexpected": "partial",
    });
    expect((await store.designate(reusedMessage)).status).toBe("UNKNOWN");
    const after = await store.read(0);
    expect(await pointer(store.config, "urn:agent-bus:orientation:programme", after.next)).toEqual(
      []
    );
    expect(await history(store.config, reusedRevision.notification.id, after.next)).toHaveLength(0);
    expect(await history(store.config, reusedMessage.notification.id, after.next)).toHaveLength(0);
    expect(await history(store.config, afterDamage.notification.id, after.next)).toHaveLength(0);
  } finally {
    await store.runtime.dispose();
  }
});

test("control: dropping the global witness guard permits cross-scope operation reuse", async () => {
  const store = await setup();
  try {
    const initial = request({ kind: "directory", directory: "control-one" }, null);
    expect((await store.designate(initial)).status).toBe("APPLIED");
    const forbiddenNotice = message("pointer-only control");
    const scope = "urn:agent-bus:orientation:directory:control-two";
    const response = await fetch(
      `${store.config.url}/v1/fluree/update?ledger=${encodeURIComponent(store.config.ledger)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${store.config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          "@context": context,
          where: [
            ["optional", { "@id": scope, "bus:currentRevision": "?current" }],
            ["filter", "(not (bound ?current))"],
          ],
          insert: [
            { "@id": scope, "bus:currentRevision": initial.operation },
            {
              "@id": `urn:agent-bus:message:${forbiddenNotice.id}`,
              "@type": "bus:Message",
              "bus:json": JSON.stringify(forbiddenNotice),
            },
          ],
        }),
      }
    );
    expect(response.ok).toBe(true);
    await response.arrayBuffer();
    const entries = await store.read(0);
    expect(await pointer(store.config, scope, entries.next)).toEqual([initial.operation]);
    expect(await history(store.config, forbiddenNotice.id, entries.next)).toHaveLength(1);
  } finally {
    await store.runtime.dispose();
  }
});

test("noncanonical IDs and invalid scopes fail before a write", async () => {
  const store = await setup();
  try {
    const valid = request({ kind: "directory", directory: "okay" }, null);
    for (const input of [
      { ...valid, operation: valid.operation.toUpperCase() },
      { ...valid, operation: "not-a-uuid" },
      { ...valid, expected: valid.operation.toUpperCase() },
      { ...valid, notification: new Message({ ...valid.notification, id: valid.operation }) },
      { ...valid, scope: { kind: "directory", directory: "../arbitrary" } as const },
      { ...valid, directoryRevision: id() },
    ]) {
      await expect(store.designate(input)).rejects.toThrow();
    }
    await expect(store.witness(valid.operation.toUpperCase())).rejects.toThrow();
    expect((await store.read(0)).entries).toEqual([]);
  } finally {
    await store.runtime.dispose();
  }
});

test("an existing partial witness blocks a write and is malformed, not absent", async () => {
  const store = await setup();
  try {
    const input = request({ kind: "programme" }, null);
    await insertRaw(store.config, {
      "@context": context,
      "@id": `urn:agent-bus:witness:${input.operation}`,
      "bus:unexpected": "damaged",
    });
    expect((await store.witness(input.operation)).status).toBe("MALFORMED");
    const result = await store.designate(input);
    expect(result.status).toBe("UNKNOWN");
    expect((await store.witness(input.operation)).status).toBe("MALFORMED");
    const entries = await store.read(0);
    expect(entries.entries).toHaveLength(0);
    expect(
      await pointer(store.config, "urn:agent-bus:orientation:programme", entries.next)
    ).toEqual([]);
  } finally {
    await store.runtime.dispose();
  }
});

test("lost acknowledgement reconciles once to the original receipt; failures with no witness stay unknown", async () => {
  const config = await freshLedger("guarded-boundary");
  const relay = updateBoundary(config.url);
  await withBoundary(config, relay, async (store) => {
    const initial = request({ kind: "programme" }, null);
    const baseline = relay.counts();
    relay.arm("lost");
    const result = await within(store.designate(initial));
    expect(result.status).toBe("APPLIED");
    if (result.status !== "APPLIED") throw new Error(`lost response outcome: ${result.status}`);
    expect(result.notification).toEqual(initial.notification);
    expect(relay.counts().updates - baseline.updates).toBe(1);
    expect(relay.counts().witnesses - baseline.witnesses).toBe(1);
    expect(relay.counts().forwardedStatus).toBe(200);
    expect(await history(config, initial.notification.id, result.cut.head)).toHaveLength(1);
    const replay = await store.designate({ ...initial, notification: message("regenerated") });
    expect(replay).toMatchObject({ status: "APPLIED", notification: initial.notification });
    const before = relay.counts();
    for (const fault of ["status", "malformed", "broken-body"] as const) {
      const input = request({ kind: "directory", directory: `failure-${fault}` }, null);
      const counts = relay.counts();
      relay.arm(fault);
      expect((await within(store.designate(input))).status).toBe("UNKNOWN");
      expect(relay.counts().updates - counts.updates).toBe(1);
      expect(relay.counts().witnesses - counts.witnesses).toBe(1);
      expect((await store.witness(input.operation)).status).toBe("ABSENT");
    }
    expect(relay.counts().updates - before.updates).toBe(3);
  });
});

test("interrupting an update before headers or mid-body releases the request and remains interrupted", async () => {
  const config = await freshLedger("guarded-interrupt");
  const relay = updateBoundary(config.url);
  await withBoundary(config, relay, async (store) => {
    for (const fault of ["before-headers", "mid-body"] as const) {
      const input = request({ kind: "directory", directory: `held-${fault}` }, null);
      const counts = relay.counts();
      const hold = relay.arm(fault);
      const fiber = store.runtime.runFork(
        Effect.flatMap(Ledger, (ledger) => ledger.designate(input))
      );
      await within(hold.reached);
      await within(Effect.runPromise(Fiber.interrupt(fiber)));
      const exit = await within(Effect.runPromise(Fiber.await(fiber)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      await within(hold.released);
      expect(relay.counts().updates - counts.updates).toBe(1);
      expect(relay.counts().witnesses - counts.witnesses).toBe(0);
    }
  });
});

test("a failed store startup releases its relay", async () => {
  const config = await freshLedger("guarded-startup-failure");
  const relay = updateBoundary(config.url);
  let entered = false;
  try {
    await expect(
      withBoundary({ ...config, token: "invalid-fixture-token" }, relay, async () => {
        entered = true;
      })
    ).rejects.toThrow();
    expect(entered).toBe(false);
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port: Number(new URL(relay.url).port),
      socket: { data() {} },
    });
    probe.stop(true);
  } finally {
    relay.stop();
  }
});
