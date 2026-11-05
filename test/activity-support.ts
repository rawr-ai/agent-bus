/**
 * Shared fixtures for the reachable-inactivity suites (docs/frames/reachable-inactivity.md).
 *
 * Expectations come from the frame, not from an implementation. Where a suite needs to
 * observe whether an inactive address was rung, it uses a sentinel: an address owned by the
 * same session that always has fresh direct mail, so a wake that returns the sentinel proves
 * the pass evaluated every address of the session, and an absent target is a real
 * suppression rather than a timeout.
 *
 * Interface assumed (decided by the DRA):
 * - `Bus.activity(input)` serves `bus_activity`: input {address, session, operation, activity?,
 *   mutes?}; result {status: "APPLIED" | "CONFLICT" | "UNKNOWN" | "IDENTITY_MISMATCH", ...}.
 * - `Bus.publish` accepts `pierce?: string[] | "all"` and `confirm?: string`; an unconfirmed
 *   "all" returns {status: "NOT_SENT", bypass, digest}.
 * - Mute scopes: {scope: "programme"} | {scope: "topic", topic} | {scope: "directory",
 *   directory} | {scope: "concern", directory, concern}.
 * Fluree-side seams use the frame's stored representation and the HTTP boundary, never
 * Ledger method names, so they hold whatever the adapter's methods are called.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { CodexError, type Daemon, type Queue, type Queued } from "../src/codex.ts";
import * as Fluree from "../src/Fluree.ts";
import * as Ledger from "../src/Ledger.ts";
import type { QueryGateway } from "../src/Query.ts";
import { BUS } from "../src/sparql.ts";
import { flureeServer, ledgerOn } from "./fluree-server.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

export const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
export const tempDir = () => mkdtempSync(join(tmpdir(), "agent-bus-activity-"));
export const cwd = process.cwd();
/** Each test address's session id. */
export const sid = (address: string) => `session:${address}`;
export const uuid = () => Bun.randomUUIDv7();
export const bodies = (messages: ReadonlyArray<{ readonly body: string }>) =>
  messages.map((message) => message.body);

export type Services = Bus.Bus | Ledger.Ledger | Cursors.Cursors | QueryGateway;
type Store = Layer.Layer<Ledger.Ledger | QueryGateway, unknown, never>;

export interface FlureeConfig {
  readonly url: string;
  readonly ledger: string;
  readonly token: string;
}

/** One serve: a Bus over a store, with its own cursors directory. */
export interface Serve {
  readonly run: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>;
  readonly dispose: () => Promise<void>;
}

export const busOn = (store: Store, cursorsDir: string) =>
  Bus.layer.pipe(
    Layer.provideMerge(store),
    Layer.provideMerge(Cursors.layerFiles(join(cursorsDir, "cursors"))),
    Layer.provide(platform)
  );

export const serveOn = async (store: Store, cursorsDir = tempDir()): Promise<Serve> => {
  const runtime = ManagedRuntime.make(busOn(store, cursorsDir));
  await runtime.runPromise(Effect.void);
  return { run: (effect) => runtime.runPromise(effect), dispose: () => runtime.dispose() };
};

export const jsonlStore = (file: string): Store => layerJsonl(file).pipe(Layer.provide(platform));
export const flureeStore = (config: FlureeConfig, url = config.url): Store =>
  Fluree.layerFluree({ ...config, url }).pipe(Layer.provide(platform));

/** A new empty ledger on the shared throwaway Fluree server (test/fluree-server.ts). */
export const freshFluree = async (name = "activity"): Promise<FlureeConfig> =>
  ledgerOn(await flureeServer(), name);

/** The two delivery backends; JSONL is the delivery double, Fluree the real store. */
export const backends = [
  {
    name: "jsonl",
    open: () => {
      const dir = tempDir();
      return serveOn(jsonlStore(join(dir, "ledger.jsonl")), dir);
    },
  },
  { name: "fluree", open: async () => serveOn(flureeStore(await freshFluree())) },
] as const;

// ---- Calls -------------------------------------------------------------------------------------

export type MuteScope =
  | { readonly scope: "programme" }
  | { readonly scope: "topic"; readonly topic: string }
  | { readonly scope: "directory"; readonly directory: string }
  | { readonly scope: "concern"; readonly directory: string; readonly concern: string };

export const programme: MuteScope = { scope: "programme" };
export const topic = (name: string): MuteScope => ({ scope: "topic", topic: name });

export interface ActivityCall {
  readonly activity?: "active" | "inactive";
  readonly mutes?: ReadonlyArray<MuteScope>;
  readonly operation?: string;
  readonly session?: string;
}

/** bus_activity as the address's own session, with a fresh operation id unless one is given. */
export const act = (address: string, call: ActivityCall) =>
  Effect.flatMap(Bus.Bus, (bus) =>
    bus.activity({
      address,
      session: call.session ?? sid(address),
      operation: call.operation ?? uuid(),
      ...(call.activity === undefined ? {} : { activity: call.activity }),
      ...(call.mutes === undefined ? {} : { mutes: call.mutes }),
    })
  );

/** A JSON-comparable result, so assertions don't depend on the result's static type. */
export const plain = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));

/** Mute sets compare as sets. */
export const sortedMutes = (mutes: unknown) =>
  (Array.isArray(mutes) ? mutes : [])
    .map((mute) => JSON.stringify(mute, Object.keys(mute as object).sort()))
    .sort();

/**
 * The activity the fold reports for an address, through a command that restates its current
 * mutes: an APPLIED result carries the activity at its commit and changes no mutes.
 */
export const activityOf = (address: string, mutes: ReadonlyArray<MuteScope>, session?: string) =>
  Effect.map(act(address, { mutes, ...(session === undefined ? {} : { session }) }), (result) => {
    const outcome = plain(result);
    if (outcome.status !== "APPLIED") throw new Error(`probe was ${String(outcome.status)}`);
    return outcome.activity;
  });

export const joinAs = (
  address: string,
  options: Partial<Bus.JoinInput> & { readonly runtime?: Bus.JoinInput["runtime"] } = {}
) =>
  Effect.flatMap(Bus.Bus, (bus) =>
    bus.join({ address, runtime: "claude", session: sid(address), cwd, ...options })
  );

export const say = (
  from: string,
  to: ReadonlyArray<string>,
  body: string,
  extra: { readonly pierce?: ReadonlyArray<string> | "all"; readonly confirm?: string } = {}
) =>
  Effect.flatMap(Bus.Bus, (bus) => bus.publish({ from, session: sid(from), to, body, ...extra }));

export const takeAll = (address: string, session = sid(address)) =>
  Effect.flatMap(Bus.Bus, (bus) => bus.take(address, session));

/**
 * A session owning `target` and its sentinel, with `sender` to send from. Join `target`
 * yourself first if it needs topics; the sentinel and the sender are joined here.
 */
export const sentinelFor = (target: string) => `${target}-sentinel`;
export const withSentinel = (target: string, sender: string) =>
  Effect.gen(function* () {
    yield* joinAs(sentinelFor(target), { session: sid(target) });
    yield* joinAs(sender, { runtime: "codex" });
  });

/**
 * One Claude wake pass for `target`'s session, proven to have evaluated every address by the
 * sentinel's fresh direct mail. Returns the session's other addresses that rang.
 */
export const rung = (target: string, sender: string, fresh = false) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Bus;
    const sentinel = sentinelFor(target);
    yield* say(sender, [sentinel], "probe");
    const found = yield* bus.wake(sid(target), 30, fresh);
    if (!found.addresses.includes(sentinel)) {
      throw new Error("the wake pass did not reach the sentinel; the probe proves nothing");
    }
    yield* bus.take(sentinel, sid(target));
    return found.addresses.filter((address) => address !== sentinel);
  });

/** The ledger's head position: commit t on Fluree, bytes on JSONL. Unchanged means nothing was written. */
export const end = Effect.flatMap(Ledger.Ledger, (ledger) => ledger.end);

// ---- Codex doubles -----------------------------------------------------------------------------

/** One Codex thread queue and daemon. `mode` fails every request, or refuses adds as a subagent. */
export const fakeCodex = () => {
  const state = { mode: "accept" as "accept" | "fail" | "subagent", opened: 0 };
  const items = new Map<string, Array<Queued>>();
  let added = 0;
  const fail = (method: string, message = "no answer within 2 seconds") =>
    Effect.fail(new CodexError({ method, message }));
  const queue: Queue = {
    list: (thread) =>
      state.mode === "fail" ? fail("thread/queue/list") : Effect.succeed(items.get(thread) ?? []),
    add: (thread, text) => {
      if (state.mode === "fail") return fail("thread/queue/add");
      if (state.mode === "subagent") {
        return fail(
          "thread/queue/add",
          "direct app-server input is not allowed for unloaded spawned sub-agents"
        );
      }
      added += 1;
      const item = { id: `q${added}`, clientUserMessageId: `c${added}`, text };
      items.set(thread, [...(items.get(thread) ?? []), item]);
      return Effect.succeed(item);
    },
    remove: (thread, id) => {
      const before = items.get(thread) ?? [];
      items.set(
        thread,
        before.filter((item) => item.id !== id)
      );
      return Effect.succeed(before.some((item) => item.id === id));
    },
    // No rollout: the thread can't be borrowed, so only the queued nudge wakes it.
    rollout: () => Effect.succeed({ path: undefined, historyMode: "legacy" }),
  };
  const openQueue = Effect.sync(() => {
    state.opened += 1;
    return queue;
  });
  const daemon: Daemon = { borrow: () => Effect.succeed("loaded" as const) };
  return {
    state,
    openQueue,
    daemon,
    waiting: (thread: string) => (items.get(thread) ?? []).map(({ text }) => text),
  };
};

// ---- Fluree literal access ---------------------------------------------------------------------

export const context = { bus: BUS, xsd: "http://www.w3.org/2001/XMLSchema#" };
export const commandIri = (operation: string) => `urn:agent-bus:command:${operation}`;

/** A literal provider query, independent of the production read helpers. */
export const literal = async (
  config: FlureeConfig,
  body: Record<string, unknown>
): Promise<Array<Array<unknown>>> => {
  const response = await fetch(`${config.url}/v1/fluree/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ "@context": context, from: config.ledger, ...body }),
  });
  if (!response.ok) throw new Error(`literal query failed: HTTP ${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("literal query did not return rows");
  return rows.map((row) => (Array.isArray(row) ? row : [row]));
};

/** Every assertion of `bus:command` on one operation's node, across the whole history. */
export const commandAssertions = async (config: FlureeConfig, operation: string, head: number) =>
  literal(config, {
    from: `${config.ledger}@t:1`,
    to: `${config.ledger}@t:${head}`,
    select: ["?t"],
    values: [["?c"], [[{ "@type": "@id", "@value": commandIri(operation) }]]],
    where: [{ "@id": "?c", "bus:command": { "@value": "?json", "@t": "?t", "@op": true } }],
  });

/** The `bus:command` values on one operation's node now. */
export const commandValues = (config: FlureeConfig, operation: string) =>
  literal(config, {
    select: ["?json"],
    where: [{ "@id": commandIri(operation), "bus:command": "?json" }],
  });

/** A raw command node exactly as the frame stores one. */
export const rawCommand = (operation: string, command: unknown) => ({
  "@context": context,
  "@id": commandIri(operation),
  "@type": "bus:AddressCommand",
  "bus:command": typeof command === "string" ? command : JSON.stringify(command),
});

// ---- HTTP boundary ------------------------------------------------------------------------------

type Fault =
  | { readonly kind: "before"; readonly action: () => Promise<void>; readonly done: () => void }
  | { readonly kind: "lost"; readonly done: () => void }
  | { readonly kind: "dropped"; readonly done: () => void };

/**
 * A relay in front of the throwaway Fluree server. Everything passes through, except:
 * - the next write that carries a command node (any non-query POST naming
 *   `urn:agent-bus:command:`) can run an action first, have its acknowledgement lost after it
 *   commits, or be dropped before it reaches Fluree;
 * - while `failing` is set, pinned or plain queries whose body contains it get a 503.
 */
export const commandBoundary = (upstream: string) => {
  const faults: Array<Fault> = [];
  let failing: string | undefined;
  let commandWrites = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.delete("host");
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const text = body === undefined ? "" : new TextDecoder().decode(body);
      const forward = (signal: AbortSignal) =>
        fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
          signal,
        });
      const query = url.pathname.startsWith("/v1/fluree/query");
      if (query && failing !== undefined && text.includes(failing)) {
        return new Response("unavailable", { status: 503 });
      }
      const write = body !== undefined && !query && text.includes("urn:agent-bus:command:");
      if (!write) return forward(request.signal);
      commandWrites += 1;
      const fault = faults.shift();
      if (fault === undefined) return forward(request.signal);
      if (fault.kind === "dropped") {
        fault.done();
        return new Response(null, { status: 504 });
      }
      if (fault.kind === "before") {
        await fault.action();
        fault.done();
        return forward(request.signal);
      }
      const response = await forward(AbortSignal.timeout(30_000));
      await response.arrayBuffer();
      fault.done();
      return new Response(null, { status: 504 });
    },
  });
  const arm = (make: (done: () => void) => Fault) =>
    new Promise<void>((done) => {
      faults.push(make(done));
    });
  return {
    url: server.url.origin,
    /** Runs `action` (another serve's commit) just before the next command write reaches Fluree. */
    beforeNextCommand: (action: () => Promise<void>) =>
      arm((done) => ({ kind: "before", action, done })),
    /** The next command write commits, but its caller gets a 504. */
    loseNextCommand: () => arm((done) => ({ kind: "lost", done })),
    /** The next command write never reaches Fluree; its caller gets a 504. */
    dropNextCommand: () => arm((done) => ({ kind: "dropped", done })),
    failQueriesContaining: (marker: string | undefined) => {
      failing = marker;
    },
    commandWrites: () => commandWrites,
    stop: () => server.stop(true),
  };
};
