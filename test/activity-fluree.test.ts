// Reachable inactivity on the real store (docs/frames/reachable-inactivity.md): the command
// applicability race through bus_activity and its MCP surface, lost and duplicate writes, the
// fold's guard over the stored representation, legacy readers and rollback, a damaged standing,
// a serve restart, the @t and projection pins, query fields, and directory and concern mutes.
// Seams are the frame's stored representation and an HTTP boundary in front of a disposable
// Fluree server (test/fluree-server.ts), never the adapter's Ledger method names.
import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { orientationAssociations, peers } from "../src/catalogue.ts";
import { Message, MessageJson, Origin, Presence } from "../src/domain.ts";
import { toNode } from "../src/Fluree.ts";
import * as Ledger from "../src/Ledger.ts";
import { messageIri, scopeIri } from "../src/Ledger.ts";
import { updateDirectory } from "../src/Orientation.ts";
import * as Serve from "../src/serve.ts";
import {
  act,
  type Serve as BusServe,
  bodies,
  busOn,
  commandAssertions,
  commandBoundary,
  commandValues,
  context,
  cwd,
  end,
  type FlureeConfig,
  flureeStore,
  freshFluree,
  joinAs,
  literal,
  type MuteScope,
  plain,
  programme,
  rawCommand,
  rung,
  say,
  sentinelFor,
  serveOn,
  sid,
  sortedMutes,
  takeAll,
  tempDir,
  topic,
  uuid,
  withSentinel,
} from "./activity-support.ts";
import { insertRaw } from "./fluree-server.ts";

const x = "claude/x";
const y = "codex/y";
const successor = "session:successor";
const TIMEOUT = 90_000;

/** Disposes everything a test opened, however it ends. */
const scoped = async (
  body: (open: <T>(resource: T, close: () => unknown) => T) => Promise<void>
) => {
  const closers: Array<() => unknown> = [];
  try {
    await body((resource, close) => {
      closers.push(close);
      return resource;
    });
  } finally {
    for (const close of closers.reverse()) await close();
  }
};
const open = async (
  track: <T>(resource: T, close: () => unknown) => T,
  config: FlureeConfig,
  options: { readonly url?: string; readonly dir?: string } = {}
) => {
  const serve = await serveOn(flureeStore(config, options.url), options.dir);
  return track(serve, serve.dispose);
};

const holderOf = (address: string) =>
  Effect.map(
    Effect.flatMap(Bus.Bus, (bus) => bus.peers),
    (all) => all.find((peer) => peer.address === address)
  );

/** The peers query's row for an address, at head. */
const peerRow = (serve: BusServe, address: string) =>
  serve.run(
    Effect.map(peers.run({ includeLeft: false, limit: 500 }, {}, undefined), (page) =>
      (plain(page).rows as Array<Record<string, unknown>>).find((row) => row.address === address)
    )
  );

const takeOver = (serve: BusServe, address: string, session = successor) =>
  serve.run(
    Effect.gen(function* () {
      const holder = yield* holderOf(address);
      const bus = yield* Bus.Bus;
      yield* bus.join({ address, runtime: "claude", session, cwd, takeover: holder?.joinId });
    })
  );

const runOf = (serve: BusServe, address: string) =>
  serve.run(
    Effect.map(holderOf(address), (holder) => holder?.presence.rejoinOf ?? holder?.joinId ?? "")
  );

/** A typed failure becomes its tag; a defect still fails the test. */
const settled = (effect: Effect.Effect<unknown, { readonly _tag: string }, Bus.Bus>) =>
  effect.pipe(
    Effect.map((value) => ({ ok: plain(value) })),
    Effect.catch((error) => Effect.succeed({ error: error._tag }))
  );

describe("bus_activity: the command applicability race", () => {
  /** Serve A writes through the boundary; serve B is another machine's serve on the same ledger. */
  const race = async (track: <T>(resource: T, close: () => unknown) => T, name: string) => {
    const config = await freshFluree(name);
    const relay = commandBoundary(config.url);
    track(relay, relay.stop);
    const a = await open(track, config, { url: relay.url });
    const b = await open(track, config);
    return { config, relay, a, b };
  };

  test(
    "1. a takeover committed between validation and the command's commit: CONFLICT not-holder, nothing changed",
    () =>
      scoped(async (track) => {
        const { relay, a, b } = await race(track, "race-holder");
        await a.run(joinAs(x));
        let fired = false;
        void relay.beforeNextCommand(async () => {
          await takeOver(b, x);
          fired = true;
        });
        const operation = uuid();
        const intent = { activity: "inactive" as const, mutes: [programme], operation };
        const result = plain(await a.run(act(x, intent)));
        expect(fired).toBe(true);
        expect(result).toMatchObject({ status: "CONFLICT", operation, reason: "not-holder" });
        expect(typeof plain(result.cut).head).toBe("number");
        expect(await peerRow(b, x)).toMatchObject({ activity: "active", mutes: [] });
        const holders = plain(await b.run(act(x, { activity: "active", session: successor })));
        expect(holders).toMatchObject({ status: "APPLIED", mutes: [] });
        // The old session's retry reads the recorded operation: the same receipt, no write.
        const head = await a.run(end);
        expect(plain(await a.run(act(x, intent)))).toEqual(result);
        expect(await a.run(end)).toBe(head);
      }),
    TIMEOUT
  );

  test(
    "1. a replay committed between validation and the command's commit: CONFLICT stale-run, anchor and mutes kept",
    () =>
      scoped(async (track) => {
        const { relay, a, b } = await race(track, "race-replay");
        await a.run(joinAs(x));
        expect(plain(await a.run(act(x, { mutes: [programme] })))).toMatchObject({
          status: "APPLIED",
        });
        let fired = false;
        void relay.beforeNextCommand(async () => {
          await b.run(joinAs(x, { replay: true }));
          fired = true;
        });
        const result = plain(await a.run(act(x, { activity: "inactive", mutes: [] })));
        expect(fired).toBe(true);
        expect(result).toMatchObject({ status: "CONFLICT", reason: "stale-run" });
        const row = await peerRow(b, x);
        expect(row).toMatchObject({ activity: "active" });
        expect(sortedMutes(row?.mutes)).toEqual(sortedMutes([programme]));
      }),
    TIMEOUT
  );

  test(
    "1. a leave committed between validation and the command's commit: CONFLICT not-joined",
    () =>
      scoped(async (track) => {
        const { relay, a, b } = await race(track, "race-leave");
        await a.run(joinAs(x));
        let fired = false;
        void relay.beforeNextCommand(async () => {
          await b.run(Effect.flatMap(Bus.Bus, (bus) => bus.leave(x, sid(x))));
          fired = true;
        });
        const result = plain(await a.run(act(x, { activity: "inactive" })));
        expect(fired).toBe(true);
        expect(result).toMatchObject({ status: "CONFLICT", reason: "not-joined" });
        expect(await peerRow(b, x)).toBeUndefined();
      }),
    TIMEOUT
  );

  test(
    "1. over MCP, through the official client: the takeover race returns CONFLICT, never APPLIED",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("race-mcp");
        const relay = commandBoundary(config.url);
        track(relay, relay.stop);
        const b = await open(track, config);
        const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
        const port = Number(probe.url.port);
        probe.stop(true);
        const runtime = ManagedRuntime.make(
          Serve.layerHttp({ port, version: "test" }).pipe(
            Layer.provideMerge(busOn(flureeStore(config, relay.url), tempDir()))
          )
        );
        track(runtime, () => runtime.dispose());
        await runtime.runPromise(Effect.void);
        const client = new Client({ name: "activity-test", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
        );
        track(client, () => client.close());
        await client.listTools();
        const call = async (name: string, args: Record<string, unknown>) => {
          const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
          const [first] = result.content;
          const text = first?.type === "text" ? first.text : "";
          if (result.isError) throw new Error(`${name} refused: ${text}`);
          expect(result.structuredContent).toEqual(JSON.parse(text));
          return result.structuredContent as Record<string, unknown>;
        };
        await call("bus_join", { address: x, runtime: "claude", session: sid(x), cwd });
        let fired = false;
        void relay.beforeNextCommand(async () => {
          await takeOver(b, x);
          fired = true;
        });
        const operation = uuid();
        const result = await call("bus_activity", {
          address: x,
          session: sid(x),
          operation,
          activity: "inactive",
        });
        expect(fired).toBe(true);
        expect(result).toMatchObject({ status: "CONFLICT", operation, reason: "not-holder" });
        expect(await peerRow(b, x)).toMatchObject({ activity: "active", mutes: [] });
      }),
    TIMEOUT
  );
});

describe("bus_activity: unknown outcomes and duplicate writes", () => {
  test(
    "2. a write that commits but loses its response is never an error, and its retry writes no second node",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("lost");
        const relay = commandBoundary(config.url);
        track(relay, relay.stop);
        const a = await open(track, config, { url: relay.url });
        await a.run(joinAs(x));
        void relay.loseNextCommand();
        const operation = uuid();
        const first = await a.run(settled(act(x, { activity: "inactive", operation })));
        expect("ok" in first).toBe(true);
        expect(["UNKNOWN", "APPLIED"]).toContain(String(plain(plain(first).ok ?? {}).status));
        const head = await a.run(end);
        const assertions = await commandAssertions(config, operation, head);
        expect(assertions.length).toBe(1);
        const retry = plain(await a.run(act(x, { activity: "inactive", operation })));
        expect(retry).toMatchObject({ status: "APPLIED", operation, activity: "inactive" });
        expect(plain(retry.cut).head).toBe(assertions[0]?.[0]);
        expect(await a.run(end)).toBe(head);
        expect((await commandAssertions(config, operation, head)).length).toBe(1);
      }),
    TIMEOUT
  );

  test(
    "2. a write that never reached the store is not reported APPLIED; its retry writes exactly once",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("dropped");
        const relay = commandBoundary(config.url);
        track(relay, relay.stop);
        const a = await open(track, config, { url: relay.url });
        await a.run(joinAs(x));
        void relay.dropNextCommand();
        const operation = uuid();
        const first = plain(await a.run(settled(act(x, { activity: "inactive", operation }))));
        expect(plain(first.ok ?? {}).status).not.toBe("APPLIED");
        expect(await commandValues(config, operation)).toEqual([]);
        const retry = plain(await a.run(act(x, { activity: "inactive", operation })));
        expect(retry).toMatchObject({ status: "APPLIED", operation });
        const head = await a.run(end);
        expect((await commandAssertions(config, operation, head)).length).toBe(1);
      }),
    TIMEOUT
  );

  test(
    "2. two concurrent calls with one operation and intent leave one node and agree, or one is UNKNOWN",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("concurrent");
        const a = await open(track, config);
        const b = await open(track, config);
        await a.run(joinAs(x));
        const operation = uuid();
        const intent = { activity: "inactive" as const, mutes: [topic("t")], operation };
        const outcomes = (await Promise.all([a.run(act(x, intent)), b.run(act(x, intent))])).map(
          (value) => plain(value)
        );
        for (const outcome of outcomes)
          expect(["APPLIED", "UNKNOWN"]).toContain(String(outcome.status));
        const appliedHeads = outcomes
          .filter((outcome) => outcome.status === "APPLIED")
          .map((outcome) => plain(outcome.cut).head);
        expect(appliedHeads.length).toBeGreaterThan(0);
        expect(new Set(appliedHeads).size).toBe(1);
        const head = await a.run(end);
        const assertions = await commandAssertions(config, operation, head);
        expect(assertions.length).toBe(1);
        expect(assertions[0]?.[0]).toBe(appliedHeads[0]);
        expect((await commandValues(config, operation)).length).toBe(1);
      }),
    TIMEOUT
  );

  test(
    "2. an operation absent at the cut is refused after a takeover; this call writes nothing",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("absent");
        const a = await open(track, config);
        const b = await open(track, config);
        await a.run(joinAs(x));
        expect(plain(await a.run(act(x, { mutes: [] })))).toMatchObject({ status: "APPLIED" });
        await takeOver(b, x);
        const head = await a.run(end);
        const operation = uuid();
        const refused = plain(await a.run(settled(act(x, { activity: "inactive", operation }))));
        expect(refused).toEqual({ error: "NotOwner" });
        expect(await a.run(end)).toBe(head);
        expect(await commandValues(config, operation)).toEqual([]);
      }),
    TIMEOUT
  );
});

describe("the fold over stored command nodes", () => {
  test(
    "E. the guard applies the holder's own run and refuses an earlier run or an old session",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("guard");
        const a = await open(track, config);
        const b = await open(track, config);
        await a.run(joinAs(x));
        const command = (fields: Record<string, unknown>) =>
          insertRaw(
            config,
            rawCommand(uuid(), { address: x, runtime: "claude", session: sid(x), ...fields })
          );
        // Control: the frame's representation, from the holder's current run, is applied.
        const firstRun = await runOf(a, x);
        await command({ run: firstRun, activity: "inactive", mutes: [programme] });
        const applied = await peerRow(a, x);
        expect(applied).toMatchObject({ activity: "inactive" });
        expect(sortedMutes(applied?.mutes)).toEqual(sortedMutes([programme]));

        // A delayed command from the earlier run, after a replay: refused; anchor and mutes kept.
        await a.run(joinAs(x, { replay: true }));
        expect(await runOf(a, x)).not.toBe(firstRun);
        await command({ run: firstRun, activity: "active", mutes: [] });
        const replayed = await peerRow(a, x);
        expect(replayed).toMatchObject({ activity: "inactive" });
        expect(sortedMutes(replayed?.mutes)).toEqual(sortedMutes([programme]));

        // The old session's command after a takeover: refused; the reset stands.
        const oldRun = await runOf(a, x);
        await takeOver(b, x);
        await command({ run: oldRun, activity: "inactive", mutes: [programme] });
        expect(await peerRow(b, x)).toMatchObject({ activity: "active", mutes: [] });
      }),
    TIMEOUT
  );
});

/** The stored message fields an earlier release decodes; unknown keys are stripped. */
const LegacyMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    ts: Schema.String,
    from: Schema.String,
    to: Schema.Array(Schema.String),
    kind: Schema.Literals(["message", "presence"]),
    body: Schema.String,
    presence: Schema.optionalKey(
      Schema.Struct({
        session: Schema.optionalKey(Schema.String),
        status: Schema.String,
      })
    ),
  })
);
const decodeLegacy = (json: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(LegacyMessage)(json));

/** The base release's presence fold: the latest session-bearing presence per sender. */
const legacyHolders = async (config: FlureeConfig) => {
  const rows = await literal(config, {
    select: ["?json", "?t"],
    where: [
      { "@id": "?m", "@type": "bus:Presence", "bus:json": { "@value": "?json", "@t": "?t" } },
    ],
    orderBy: "?t",
  });
  const latest = new Map<string, { joinId: string; since: string; session?: string }>();
  for (const [json] of rows) {
    const message = await decodeLegacy(json);
    if (message.presence?.session === undefined) continue;
    latest.set(message.from, {
      joinId: message.id,
      since: message.ts,
      session: message.presence.session,
    });
  }
  return latest;
};

describe("legacy readers and rollback", () => {
  test(
    "F. legacy reads over commands: same join id and since, every entry decodes, nothing new to deliver",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("legacy");
        const a = await open(track, config);
        await a.run(joinAs(x));
        await a.run(joinAs(y, { runtime: "codex" }));
        const before = await legacyHolders(config);
        const head = await a.run(end);
        expect(
          plain(await a.run(act(x, { activity: "inactive", mutes: [programme, topic("t")] })))
        ).toMatchObject({ status: "APPLIED" });
        const after = await a.run(end);
        expect(after).toBeGreaterThan(head);
        expect(await legacyHolders(config)).toEqual(before);
        // A legacy read covers only bus:json, which commands never carry.
        const stored = await literal(config, {
          select: ["?m", "?json"],
          where: [{ "@id": "?m", "bus:json": "?json" }],
        });
        for (const [subject, json] of stored) {
          expect(String(subject)).not.toStartWith("urn:agent-bus:command:");
          await decodeLegacy(json);
        }
        const delivered = await literal(config, {
          from: `${config.ledger}@t:${head + 1}`,
          to: `${config.ledger}@t:${after}`,
          select: ["?json"],
          where: [{ "@id": "?m", "bus:json": { "@value": "?json", "@t": "?t", "@op": true } }],
        });
        expect(delivered).toEqual([]);
        expect(await peerRow(a, x)).toMatchObject({ activity: "inactive" });
      }),
    TIMEOUT
  );

  test(
    "F. a rolled-back serve's rejoin keeps the restored state; its takeover resets it",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("rollback");
        const a = await open(track, config);
        await a.run(joinAs(x));
        expect(
          plain(await a.run(act(x, { activity: "inactive", mutes: [programme] })))
        ).toMatchObject({ status: "APPLIED" });
        const run = await runOf(a, x);
        const legacyPresence = (presence: Presence) =>
          a.run(
            Effect.flatMap(Ledger.Ledger, (ledger) =>
              ledger.append(
                new Message({
                  id: uuid(),
                  ts: new Date().toISOString(),
                  from: x,
                  to: ["*"],
                  kind: "presence",
                  body: `${x} joined`,
                  origin: new Origin({ host: hostname(), cwd }),
                  presence,
                })
              )
            )
          );
        // The legacy serve rejoins the same run: rolling forward restores activity and mutes.
        await legacyPresence(
          new Presence({
            runtime: "claude",
            status: "joined",
            topics: [],
            session: sid(x),
            rejoinOf: run,
          })
        );
        const forward = await open(track, config);
        const restored = await peerRow(forward, x);
        expect(restored).toMatchObject({ activity: "inactive" });
        expect(sortedMutes(restored?.mutes)).toEqual(sortedMutes([programme]));
        // A takeover written while rolled back resets them, as any takeover does.
        const holder = await forward.run(holderOf(x));
        await legacyPresence(
          new Presence({
            runtime: "claude",
            status: "joined",
            topics: [],
            session: successor,
            takeover: holder?.joinId ?? "",
          })
        );
        expect(await peerRow(forward, x)).toMatchObject({ activity: "active", mutes: [] });
      }),
    TIMEOUT
  );

  test(
    "H. the stored pierce set is an additive field a legacy decoder strips",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("pierce-legacy");
        const a = await open(track, config);
        await a.run(joinAs(x));
        await a.run(joinAs(y, { runtime: "codex" }));
        expect(plain(await a.run(act(x, { activity: "inactive" })))).toMatchObject({
          status: "APPLIED",
        });
        const sent = plain(await a.run(say(y, ["*"], "pierced", { pierce: [x] })));
        const [row] = await literal(config, {
          select: ["?json"],
          where: [{ "@id": messageIri(String(sent.id)), "bus:json": "?json" }],
        });
        expect(JSON.parse(String(row?.[0]))).toMatchObject({ pierce: [x], to: ["*"] });
        const legacy = await decodeLegacy(row?.[0]);
        expect("pierce" in legacy).toBe(false);
        expect(legacy.to).toEqual(["*"]);
      }),
    TIMEOUT
  );
});

// Each unknown names why (activityReason): damage in its own log, or an unreadable direct
// candidate after its inactive anchor. A capped scan is pinned at activityAt (activity.test.ts).
describe("a damaged standing fails the read", () => {
  type Track = <T>(resource: T, close: () => unknown) => T;
  const DAMAGE = "could not be decoded";

  /** The message of a call that must fail, failing the test if it succeeds. */
  const failure = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("the call succeeded; it should have failed the read");
  };

  /**
   * Nothing reads a standing past the damage: the peers query fails, and bus_activity, as the
   * session given, fails without writing a node for its operation or moving the head.
   */
  const unreadable = async (config: FlureeConfig, serve: BusServe, session?: string) => {
    expect(await failure(peerRow(serve, x))).toContain(DAMAGE);
    const operation = uuid();
    const head = await serve.run(end);
    const call = act(x, { activity: "inactive", operation, ...(session ? { session } : {}) });
    expect(await failure(serve.run(call))).toContain(DAMAGE);
    expect(await commandValues(config, operation)).toEqual([]);
    expect(await serve.run(end)).toBe(head);
  };

  /** One update at a new commit: `remove` retracted from a node, `add` asserted on it. */
  const update = async (
    config: FlureeConfig,
    change: { readonly remove: Record<string, unknown>; readonly add?: Record<string, unknown> }
  ) => {
    const response = await fetch(
      `${config.url}/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          "@context": context,
          delete: change.remove,
          ...(change.add === undefined ? {} : { insert: change.add }),
        }),
      }
    );
    if (!response.ok) throw new Error(`update failed: HTTP ${response.status}`);
  };

  /**
   * A joined presence for x naming the successor session, stored as a join stores it, with its
   * node or its recorded sender optionally replaced. The guarded presence read refuses an entry
   * whose node isn't the one its id names or whose sender isn't its own.
   */
  const successorRecord = (identity: { readonly node?: string; readonly from?: string } = {}) => {
    const message = new Message({
      id: uuid(),
      ts: new Date().toISOString(),
      from: x,
      to: ["*"],
      kind: "presence",
      body: `${x} joined`,
      origin: new Origin({ host: hostname(), cwd }),
      presence: new Presence({
        runtime: "claude",
        status: "joined",
        topics: [],
        session: successor,
      }),
    });
    return {
      ...toNode(message, Schema.encodeSync(MessageJson)(message)),
      ...(identity.node === undefined ? {} : { "@id": identity.node }),
      ...(identity.from === undefined ? {} : { "bus:from": identity.from }),
    };
  };

  // Each way the history before a carried-over mute can be corrupted after the fact. Dated at
  // the reset join's commit, any of them could make the later rejoin read as a reset that clears
  // the mute; now no standing is read at all.
  for (const [corruption, corrupt] of [
    [
      "an alteration of the reset join's bus:from",
      (config: FlureeConfig, node: string) =>
        update(config, {
          remove: { "@id": node, "bus:from": x },
          add: { "@id": node, "bus:from": "claude/elsewhere" },
        }),
    ],
    [
      "an alteration of the reset join's bus:id",
      (config: FlureeConfig, node: string, id: string) =>
        update(config, {
          remove: { "@id": node, "bus:id": id },
          add: { "@id": node, "bus:id": uuid() },
        }),
    ],
    [
      "a pure retraction of the reset join's bus:from",
      (config: FlureeConfig, node: string) =>
        update(config, { remove: { "@id": node, "bus:from": x } }),
    ],
  ] as const) {
    test(
      `${corruption} fails peers, bus_activity and pierce all, and keeps a receipt pinned before it`,
      () =>
        scoped(async (track) => {
          const config = await freshFluree("damage-history");
          const a = await open(track, config);
          await a.run(joinAs(x));
          await a.run(joinAs(y, { runtime: "codex" }));
          const reset = (await a.run(holderOf(x)))?.joinId ?? "";
          const intent = { activity: "inactive" as const, mutes: [programme], operation: uuid() };
          const receipt = plain(await a.run(act(x, intent)));
          expect(receipt).toMatchObject({ status: "APPLIED", activity: "inactive" });
          // The same session rejoining continues the run: activity and mutes carry over.
          await a.run(joinAs(x));
          expect(await runOf(a, x)).toBe(reset);
          const before = await peerRow(a, x);
          expect(before).toMatchObject({ activity: "inactive" });
          expect(sortedMutes(before?.mutes)).toEqual(sortedMutes([programme]));

          await corrupt(config, messageIri(reset), reset);
          // Not active with mutes []: no standing past the damage is shown or acted on.
          await unreadable(config, a);
          const head = await a.run(end);
          expect(await failure(a.run(say(y, ["*"], "everyone", { pierce: "all" })))).toContain(
            DAMAGE
          );
          expect(await a.run(end)).toBe(head);
          // The receipt was earned at its own commit, before the damage: a retry still reads it.
          expect(plain(await a.run(act(x, intent)))).toEqual(receipt);
          expect(await a.run(end)).toBe(head);
        }),
      TIMEOUT
    );
  }

  /** x held by its own session, then `record` inserted raw after the join. */
  const heldThen = async (track: Track, name: string, record: Record<string, unknown>) => {
    const config = await freshFluree(name);
    const a = await open(track, config);
    await a.run(joinAs(x));
    await insertRaw(config, record);
    return { config, a };
  };

  const undecodablePresence = () => {
    const id = uuid();
    return {
      "@context": context,
      "@id": messageIri(id),
      "@type": "bus:Presence",
      "bus:id": id,
      "bus:from": x,
      "bus:to": ["*"],
      "bus:json": "{damaged",
    };
  };

  for (const [record, make] of [
    [
      "whose recorded sender is another address",
      () => successorRecord({ from: "claude/elsewhere" }),
    ],
    ["whose node is not the one its id names", () => successorRecord({ node: messageIri(uuid()) })],
    [
      "with an entry but no bus:id",
      () => {
        const { "bus:id": _, ...rest } = successorRecord();
        return rest;
      },
    ],
    ["whose entry can't be decoded", undecodablePresence],
  ] as const) {
    test(
      `a later presence ${record} gives no session authority and fails the read`,
      () =>
        scoped(async (track) => {
          const { config, a } = await heldThen(track, "damage-identity", make());
          // The session a never-valid record names gains nothing from it.
          await unreadable(config, a, successor);
          // The prior holder can't act past damage that may be its own address's either.
          await unreadable(config, a);
        }),
      TIMEOUT
    );
  }

  // A typed presence node holding neither an entry nor an id has nothing to date it by: the read
  // fails at its own commit.
  for (const [shape, extra] of [
    ["only a sender", { "bus:from": x }],
    ["only its type", {}],
  ] as const) {
    test(
      `a presence node with ${shape} fails the read at the read's own commit and writes nothing`,
      () =>
        scoped(async (track) => {
          const { config, a } = await heldThen(track, "damage-empty-presence", {
            "@context": context,
            "@id": messageIri(uuid()),
            "@type": "bus:Presence",
            ...extra,
          });
          const head = await a.run(end);
          expect(await failure(peerRow(a, x))).toBe(
            `A ledger entry at t=${head} could not be decoded.`
          );
          await unreadable(config, a);
        }),
      TIMEOUT
    );
  }

  // Control: the same record with consistent identity is an ordinary takeover by the successor.
  test(
    "control: the consistent record makes the successor the holder; the prior session is refused",
    () =>
      scoped(async (track) => {
        const { config, a } = await heldThen(track, "damage-identity-control", successorRecord());
        const operation = uuid();
        expect(
          plain(await a.run(act(x, { activity: "inactive", operation, session: successor })))
        ).toMatchObject({ status: "APPLIED", operation, activity: "inactive" });
        expect(await commandValues(config, operation)).toHaveLength(1);
        const head = await a.run(end);
        const refused = await a.run(Effect.flip(act(x, { activity: "active" })));
        expect(refused._tag).toBe("NotOwner");
        expect(refused.message).toContain("belongs to another session; this call wrote nothing");
        expect(await a.run(end)).toBe(head);
      }),
    TIMEOUT
  );

  // A damaged command fails the read until it is repaired: no reset ends it.
  for (const [kind, command] of [
    ["an undecodable command", () => "{not json"],
    [
      "x's own command, with an activity no reader knows,",
      (run: string) => ({
        address: x,
        runtime: "claude",
        session: sid(x),
        run,
        activity: "asleep",
      }),
    ],
  ] as const) {
    test(
      `${kind} fails the read through a takeover, until it is repaired`,
      () =>
        scoped(async (track) => {
          const config = await freshFluree("damage-command");
          const a = await open(track, config);
          await a.run(joinAs(x));
          const damaged = rawCommand(uuid(), command(await runOf(a, x)));
          await insertRaw(config, damaged);
          await unreadable(config, a);
          await takeOver(a, x);
          await unreadable(config, a, successor);

          // Repair: the damaged value retracted, the ledger reads again, the takeover's reset intact.
          await update(config, {
            remove: { "@id": damaged["@id"], "bus:command": damaged["bus:command"] },
          });
          expect(await peerRow(a, x)).toMatchObject({ activity: "active", mutes: [] });
          expect(
            plain(await a.run(act(x, { activity: "inactive", session: successor })))
          ).toMatchObject({ status: "APPLIED", activity: "inactive" });
        }),
      TIMEOUT
    );
  }

  test(
    "bus_peers over MCP, through the official client, is an error naming the damage",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("damage-mcp-peers");
        const a = await open(track, config);
        await a.run(joinAs(x));
        await insertRaw(config, rawCommand(uuid(), "{not json"));
        const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
        const port = Number(probe.url.port);
        probe.stop(true);
        const runtime = ManagedRuntime.make(
          Serve.layerHttp({ port, version: "test" }).pipe(
            Layer.provideMerge(busOn(flureeStore(config, config.url), tempDir()))
          )
        );
        track(runtime, () => runtime.dispose());
        await runtime.runPromise(Effect.void);
        const client = new Client({ name: "activity-peers-test", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
        );
        track(client, () => client.close());
        const result = (await client.callTool({
          name: "bus_peers",
          arguments: {},
        })) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(DAMAGE);
      }),
    TIMEOUT
  );

  // Control: damaged mail is not damaged standing. The anchor and mutes read; only whether a
  // direct message came after the anchor is unknown.
  test(
    "control: a damaged direct candidate after the anchor reads as unknown, damaged-mail",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("damage-candidate");
        const a = await open(track, config);
        await a.run(joinAs(x));
        await a.run(joinAs(y, { runtime: "codex" }));
        expect(
          plain(await a.run(act(x, { activity: "inactive", mutes: [programme] })))
        ).toMatchObject({ status: "APPLIED" });
        const candidate = uuid();
        await insertRaw(config, {
          "@context": context,
          "@id": messageIri(candidate),
          "@type": "bus:Message",
          "bus:id": candidate,
          "bus:from": y,
          "bus:to": [x],
          "bus:json": "{damaged",
        });
        const row = await peerRow(a, x);
        expect(row).toMatchObject({ activity: "unknown", activityReason: "damaged-mail" });
        expect(sortedMutes(row?.mutes)).toEqual(sortedMutes([programme]));
      }),
    TIMEOUT
  );

  /**
   * x and its sentinel held by one session, y sending, x's standing set by `call`; then helpers
   * to damage and repair the ledger and to watch x's cursor and pending mail.
   */
  const wakeFixture = async (track: Track, call: Parameters<typeof act>[1]) => {
    const config = await freshFluree("damage-wake");
    const a = await open(track, config);
    const sentinel = sentinelFor(x);
    await a.run(
      Effect.gen(function* () {
        yield* joinAs(x);
        yield* withSentinel(x, y);
        expect(plain(yield* act(x, call))).toMatchObject({ status: "APPLIED" });
      })
    );
    const damaged = rawCommand(uuid(), "{not json");
    return {
      a,
      damage: () => insertRaw(config, damaged),
      repair: () =>
        update(config, {
          remove: { "@id": damaged["@id"], "bus:command": damaged["bus:command"] },
        }),
      /** Mail from y, its id. */
      send: async (
        to: ReadonlyArray<string>,
        body: string,
        extra: Parameters<typeof say>[3] = {}
      ) => String(plain(await a.run(say(y, to, body, extra))).id),
      /**
       * Ambient mail from y, its id. It reaches the sentinel too and is read there at once, so
       * the sentinel's own slice stays direct and its pass proves the wake evaluated x.
       */
      ambient: async (body: string, extra: Parameters<typeof say>[3] = {}) => {
        const id = String(plain(await a.run(say(y, ["*"], body, extra))).id);
        await a.run(takeAll(sentinel, sid(x)));
        return id;
      },
      cursor: () => a.run(Effect.flatMap(Cursors.Cursors, (cursors) => cursors.get(x))),
      /** What a delivery pass would hand x's nudge now, without acknowledging anything. */
      pending: () =>
        a.run(
          Effect.flatMap(Bus.Bus, (bus) =>
            bus.deliver(x, (found) =>
              Effect.succeed({
                messages: found.messages.map((message) => message.id),
                unread: [...found.unread],
                cursor: found.cursor,
              })
            )
          )
        ),
    };
  };

  test(
    "wake: inactive, with ambient mail held back, then damage and a direct message: x wakes on the direct message alone, once",
    () =>
      scoped(async (track) => {
        const w = await wakeFixture(track, { activity: "inactive" });
        const held = await w.ambient("everyone");
        expect(await w.a.run(rung(x, y))).not.toContain(x);
        await w.damage();
        // Ambient mail alone needs the standing: nothing wakes, nothing is acknowledged.
        const before = await w.cursor();
        expect(await w.a.run(rung(x, y))).not.toContain(x);
        const direct = await w.send([x], "direct");

        // The standing can't be read, so only the direct message is eligible; both stay unread.
        const pending = await w.pending();
        expect(pending).toEqual({
          messages: [direct],
          unread: [held, direct],
          cursor: Option.getOrThrow(before),
        });
        expect(await w.a.run(rung(x, y))).toContain(x);
        expect(await w.cursor()).toEqual(before);
        // The same damage and no new mail: nothing rings again.
        expect(await w.a.run(rung(x, y))).not.toContain(x);

        // Repaired: the direct message after the anchor reactivated x, so the held-back ambient
        // message is now eligible and rings once; the direct one rings no more.
        await w.repair();
        expect(await w.pending()).toMatchObject({ messages: [held, direct] });
        expect(await w.a.run(rung(x, y))).toContain(x);
        expect(await w.a.run(rung(x, y))).not.toContain(x);
        expect(bodies(await w.a.run(takeAll(x)))).toEqual(["everyone", "direct"]);
      }),
    TIMEOUT
  );

  test(
    "wake: muted ambient mail alone wakes nothing; with direct or pierced mail, only that wakes; repaired, the mute holds and nothing rings again",
    () =>
      scoped(async (track) => {
        const w = await wakeFixture(track, { mutes: [programme] });
        await w.damage();

        // Direct mail alone reads no standing, so it wakes.
        await w.send([x], "direct");
        expect(await w.a.run(rung(x, y))).toContain(x);
        await w.a.run(takeAll(x));
        // A named pierce alone wakes too.
        await w.ambient("pierced", { pierce: [x] });
        expect(await w.a.run(rung(x, y))).toContain(x);
        await w.a.run(takeAll(x));

        // Muted ambient mail needs the standing: nothing wakes, and nothing is acknowledged.
        const before = await w.cursor();
        const muted = await w.ambient("ambient");
        expect(await w.a.run(rung(x, y))).not.toContain(x);
        expect(await w.cursor()).toEqual(before);
        expect(await failure(peerRow(w.a, x))).toContain(DAMAGE);
        // With direct mail beside it, the direct mail alone wakes.
        const mixed = await w.send([x], "mixed");
        expect(await w.pending()).toMatchObject({ messages: [mixed], unread: [muted, mixed] });
        expect(await w.a.run(rung(x, y))).toContain(x);
        expect(await w.a.run(rung(x, y))).not.toContain(x);
        expect(await w.cursor()).toEqual(before);

        // Repaired, the mute still holds: nothing new is eligible, so nothing rings.
        await w.repair();
        expect(sortedMutes((await peerRow(w.a, x))?.mutes)).toEqual(sortedMutes([programme]));
        expect(await w.pending()).toMatchObject({ messages: [mixed] });
        expect(await w.a.run(rung(x, y))).not.toContain(x);
        expect(bodies(await w.a.run(takeAll(x)))).toEqual(["ambient", "mixed"]);
      }),
    TIMEOUT
  );

  /**
   * x held on a clean ledger, then bus_activity whose command write first lets `between` commit:
   * after the call's ownership read and before its own command's commit.
   */
  const interleaved = async (
    track: Track,
    name: string,
    between: (config: FlureeConfig, other: BusServe) => Promise<void>
  ) => {
    const config = await freshFluree(name);
    const relay = commandBoundary(config.url);
    track(relay, relay.stop);
    const a = await open(track, config, { url: relay.url });
    const other = await open(track, config);
    await a.run(joinAs(x));
    let fired = false;
    void relay.beforeNextCommand(async () => {
      await between(config, other);
      fired = true;
    });
    const intent = { activity: "inactive" as const, mutes: [programme], operation: uuid() };
    const result = plain(await a.run(act(x, intent)));
    expect(fired).toBe(true);
    return { config, a, intent, result };
  };

  for (const [mismatch, identity] of [
    ["recorded sender is another address", { from: "claude/elsewhere" }],
    ["node is not the one its id names", { node: messageIri(uuid()) }],
  ] as const) {
    test(
      `a command that commits after a refused record whose ${mismatch} is UNKNOWN; the read then fails`,
      () =>
        scoped(async (track) => {
          const { config, a, intent, result } = await interleaved(
            track,
            "damage-interleaved",
            (store) => insertRaw(store, successorRecord(identity))
          );
          // Its receipt can't be read at its own commit: the call's failure is UNKNOWN.
          expect(result).toEqual({ status: "UNKNOWN", operation: intent.operation });
          // It did commit: one value on its node.
          expect(await commandValues(config, intent.operation)).toHaveLength(1);
          // A retry reads the recorded operation: still UNKNOWN, and nothing is written.
          const head = await a.run(end);
          expect(plain(await a.run(act(x, intent)))).toEqual(result);
          expect(await a.run(end)).toBe(head);
          await unreadable(config, a);
        }),
      TIMEOUT
    );
  }

  test(
    "control: the holder's own continuing rejoin in the same place leaves the command APPLIED",
    () =>
      scoped(async (track) => {
        const { a, intent, result } = await interleaved(
          track,
          "damage-interleaved-control",
          async (_, other) => {
            await other.run(joinAs(x));
          }
        );
        expect(result).toMatchObject({
          status: "APPLIED",
          operation: intent.operation,
          activity: "inactive",
        });
        const row = await peerRow(a, x);
        expect(row).toMatchObject({ activity: "inactive" });
        expect(sortedMutes(row?.mutes)).toEqual(sortedMutes([programme]));
      }),
    TIMEOUT
  );
});

describe("activity in queries", () => {
  test(
    "peers and members carry activity and mutes; members stay all-or-nothing under damage",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("fields");
        const a = await open(track, config);
        await a.run(joinAs(x, { associations: [{ directory: "project", concerns: [] }] }));
        await a.run(joinAs(y, { runtime: "codex" }));
        expect(
          plain(await a.run(act(x, { activity: "inactive", mutes: [topic("t")] })))
        ).toMatchObject({ status: "APPLIED" });
        const row = await peerRow(a, x);
        expect(row).toMatchObject({ address: x, activity: "inactive", status: "joined" });
        expect(sortedMutes(row?.mutes)).toEqual(sortedMutes([topic("t")]));
        expect(await peerRow(a, y)).toMatchObject({ activity: "active", mutes: [] });
        expect(row?.activeSince === undefined || typeof row.activeSince === "string").toBe(true);

        const members = await a.run(
          orientationAssociations.run({ directory: "project" }, {}, 65_536)
        );
        expect(plain(members).rows).toMatchObject([{ address: x, activity: "inactive" }]);

        const id = uuid();
        await insertRaw(config, {
          "@context": context,
          "@id": messageIri(id),
          "@type": "bus:Presence",
          "bus:id": id,
          "bus:from": x,
          "bus:to": ["*"],
          "bus:json": "{damaged",
        });
        const damaged = await a.run(
          orientationAssociations.run({ directory: "project" }, {}, 65_536)
        );
        expect(plain(damaged).rows).toEqual([]);
      }),
    TIMEOUT
  );
});

describe("restart and store pins", () => {
  test(
    "J. a restarted serve rebuilds activity from the ledger alone; live and pinned agree before and after",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("restart");
        const dir = tempDir();
        const first = await serveOn(flureeStore(config), dir);
        try {
          await first.run(
            Effect.gen(function* () {
              yield* joinAs(x);
              yield* withSentinel(x, y);
              expect(
                plain(yield* act(x, { activity: "inactive", mutes: [topic("t")] }))
              ).toMatchObject({ status: "APPLIED" });
              yield* say(y, ["*"], "before restart");
              expect(yield* rung(x, y)).not.toContain(x);
            })
          );
          expect(await peerRow(first, x)).toMatchObject({ activity: "inactive" });
        } finally {
          await first.dispose();
        }
        const second = await open(track, config, { dir });
        const rebuilt = await peerRow(second, x);
        expect(rebuilt).toMatchObject({ activity: "inactive" });
        expect(sortedMutes(rebuilt?.mutes)).toEqual(sortedMutes([topic("t")]));
        await second.run(
          Effect.gen(function* () {
            yield* say(y, ["*"], "after restart");
            expect(yield* rung(x, y)).not.toContain(x);
            // Direct mail reactivates even once it has been read: activity is not a cursor.
            yield* say(y, [x], "direct");
            yield* takeAll(x);
          })
        );
        expect(await peerRow(second, x)).toMatchObject({ activity: "active" });
        await second.run(
          Effect.gen(function* () {
            yield* say(y, ["*"], "ambient once active");
            expect(yield* rung(x, y)).toContain(x);
            yield* takeAll(x);
          })
        );
        await second.dispose();
        const third = await open(track, config, { dir });
        expect(await peerRow(third, x)).toMatchObject({ activity: "active" });
        await third.run(
          Effect.gen(function* () {
            yield* say(y, ["*"], "after the second restart");
            expect(yield* rung(x, y)).toContain(x);
          })
        );
      }),
    TIMEOUT
  );

  test(
    "J. a ledger of legacy data alone reads every joined address as active and unmuted",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("legacy-only");
        const a = await open(track, config);
        await a.run(joinAs(x));
        await a.run(joinAs(y, { runtime: "codex", topics: ["t"] }));
        expect(await peerRow(a, x)).toMatchObject({ activity: "active", mutes: [] });
        expect(await peerRow(a, y)).toMatchObject({ activity: "active", mutes: [] });
      }),
    TIMEOUT
  );

  test(
    "J. pins: a current-state @t is the entry's single commit, and every recipient is projected",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("pins");
        const a = await open(track, config);
        const message = new Message({
          id: uuid(),
          ts: new Date().toISOString(),
          from: y,
          to: [x, "#t", "*", "claude/other"],
          kind: "message",
          body: "projected",
        });
        expect(toNode(message, "{}")["bus:to"]).toEqual([...message.to]);
        const head = await a.run(end);
        const written = await a.run(
          Effect.gen(function* () {
            const ledger = yield* Ledger.Ledger;
            yield* ledger.append(message);
            return (yield* ledger.read(head)).entries.find(
              (entry) => entry.message.id === message.id
            );
          })
        );
        const rows = await literal(config, {
          select: ["?to", "?t"],
          where: [{ "@id": messageIri(message.id), "bus:to": { "@value": "?to", "@t": "?t" } }],
        });
        expect(rows.map(([to]) => String(to)).sort()).toEqual([...message.to].sort());
        for (const [, t] of rows) expect(t).toBe(written?.end);
      }),
    TIMEOUT
  );
});

describe("directory and concern mutes", () => {
  const publisher = "claude/publisher";
  const directory = (concerns: ReadonlyArray<{ readonly id: string; readonly topic: string }>) => ({
    id: "project",
    name: "Project",
    aliases: [],
    concerns: concerns.map(({ id, topic }) => ({ id, name: id, topic })),
  });
  /** Registers or replaces the project directory; returns its new revision. */
  const register = (
    serve: BusServe,
    expected: string | null,
    concerns: ReadonlyArray<{ readonly id: string; readonly topic: string }>
  ) =>
    serve.run(
      Effect.gen(function* () {
        const result = yield* updateDirectory({
          from: publisher,
          session: sid(publisher),
          operation: uuid(),
          expected,
          directory: directory(concerns),
          audience: [y],
        });
        if (result.status !== "APPLIED" || result.revision === undefined) {
          throw new Error(`directory update was ${result.status}`);
        }
        return result.revision;
      })
    );
  const muted = async (
    track: <T>(resource: T, close: () => unknown) => T,
    ledger: string | FlureeConfig,
    topics: ReadonlyArray<string>,
    mutes: ReadonlyArray<MuteScope>,
    concerns: ReadonlyArray<{ readonly id: string; readonly topic: string }>,
    url?: string
  ) => {
    const config = typeof ledger === "string" ? await freshFluree(ledger) : ledger;
    const a = await open(track, config, url === undefined ? {} : { url });
    await a.run(
      Effect.gen(function* () {
        yield* joinAs(publisher);
        yield* joinAs(x, { topics });
        yield* withSentinel(x, y);
      })
    );
    const revision = await register(a, null, concerns);
    expect(plain(await a.run(act(x, { mutes })))).toMatchObject({ status: "APPLIED" });
    return { config, a, revision };
  };
  const project: MuteScope = { scope: "directory", directory: "project" };
  const delivery: MuteScope = { scope: "concern", directory: "project", concern: "delivery" };

  test(
    "a directory mute covers a concern added after it, resolved at each message's commit",
    () =>
      scoped(async (track) => {
        const { a, revision } = await muted(
          track,
          "mute-new-concern",
          ["deliv", "later"],
          [project],
          [{ id: "delivery", topic: "deliv" }]
        );
        await a.run(say(y, ["#later"], "before the concern exists"));
        expect(await a.run(rung(x, y))).toContain(x);
        await a.run(takeAll(x));
        await register(a, revision, [
          { id: "delivery", topic: "deliv" },
          { id: "later-concern", topic: "later" },
        ]);
        await a.run(say(y, ["#later"], "after the concern exists"));
        await a.run(say(y, ["#deliv"], "existing concern"));
        expect(await a.run(rung(x, y))).not.toContain(x);
      }),
    TIMEOUT
  );

  test(
    "a concern mute follows its concern's remapped topic",
    () =>
      scoped(async (track) => {
        const { a, revision } = await muted(
          track,
          "mute-remap",
          ["old", "new"],
          [delivery],
          [{ id: "delivery", topic: "old" }]
        );
        await a.run(say(y, ["#old"], "old topic, mapped"));
        expect(await a.run(rung(x, y))).not.toContain(x);
        await register(a, revision, [{ id: "delivery", topic: "new" }]);
        await a.run(say(y, ["#new"], "new topic, mapped"));
        expect(await a.run(rung(x, y))).not.toContain(x);
        await a.run(say(y, ["#old"], "old topic, no longer mapped"));
        expect(await a.run(rung(x, y))).toContain(x);
      }),
    TIMEOUT
  );

  test(
    "a directory mute with an unrelated unmuted topic on the same message still wakes",
    () =>
      scoped(async (track) => {
        const { a } = await muted(
          track,
          "mute-unrelated",
          ["deliv", "unrelated"],
          [project],
          [{ id: "delivery", topic: "deliv" }]
        );
        await a.run(say(y, ["#deliv"], "covered"));
        expect(await a.run(rung(x, y))).not.toContain(x);
        await a.run(say(y, ["#deliv", "#unrelated"], "one uncovered route"));
        expect(await a.run(rung(x, y))).toContain(x);
      }),
    TIMEOUT
  );

  test(
    "a damaged directory leaves its routes uncovered and wakes, and never clears the mutes",
    () =>
      scoped(async (track) => {
        const { config, a } = await muted(
          track,
          "mute-damaged",
          ["deliv"],
          [project, delivery],
          [{ id: "delivery", topic: "deliv" }]
        );
        await a.run(say(y, ["#deliv"], "covered"));
        expect(await a.run(rung(x, y))).not.toContain(x);
        // A second current revision makes the designation damaged.
        await insertRaw(config, {
          "@context": context,
          "@id": scopeIri({ kind: "directory", directory: "project" }),
          "bus:currentRevision": uuid(),
        });
        await a.run(say(y, ["#deliv"], "while damaged"));
        expect(await a.run(rung(x, y))).toContain(x);
        const row = await peerRow(a, x);
        expect(sortedMutes(row?.mutes)).toEqual(sortedMutes([project, delivery]));
      }),
    TIMEOUT
  );

  test(
    "an unavailable designation errs toward contact and never clears the mutes",
    () =>
      scoped(async (track) => {
        const config = await freshFluree("mute-unavailable");
        const relay = commandBoundary(config.url);
        track(relay, relay.stop);
        // Every read goes through the relay, so designation reads can be made to fail.
        const { a } = await muted(
          track,
          config,
          ["deliv"],
          [project],
          [{ id: "delivery", topic: "deliv" }],
          relay.url
        );
        await a.run(say(y, ["#deliv"], "covered"));
        expect(await a.run(rung(x, y))).not.toContain(x);
        relay.failQueriesContaining("currentRevision");
        await a.run(say(y, ["#deliv"], "while unavailable"));
        const woke = await a.run(rung(x, y));
        relay.failQueriesContaining(undefined);
        expect(woke).toContain(x);
        const row = await peerRow(a, x);
        expect(sortedMutes(row?.mutes)).toEqual(sortedMutes([project]));
      }),
    TIMEOUT
  );
});
