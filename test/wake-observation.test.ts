import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import { Cursors } from "../src/Cursors.ts";
import { LedgerError, Message, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { HostedNativeTools } from "../src/mcp.ts";
import { peerTools } from "../src/private-web/peer.ts";
import { QueryGateway } from "../src/Query.ts";
import * as Serve from "../src/serve.ts";
import {
  MAX_WAKE_COVERAGE_IDS,
  MAX_WAKE_OBSERVATION_BYTES,
  type ObserveWakeRequest,
  WakeObservation,
} from "../src/wake-observation.ts";
import { freshLedger } from "./fluree-server.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const address = "fixture/observer";
const session = "fixture-owner";
const sender = "fixture/sender";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const open = async (kind = "jsonl", silent = false, ownerRuntime: "claude" | "other" = "other") => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-observe-"));
  const store = ManagedRuntime.make(
    kind === "fluree"
      ? layerFluree(await freshLedger("wake-observation")).pipe(Layer.provide(platform))
      : layerJsonl(join(dir, "ledger.jsonl")).pipe(Layer.provide(platform))
  );
  cleanups.push(async () => {
    await store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = await store.runPromise(Ledger);
  const gateway = await store.runPromise(QueryGateway);
  const positions = new Map<string, number>();
  const state: {
    cursorWrites: number;
    cursorReads: number;
    ledgerWrites: number;
    reads: number;
    beforeRead?: () => Effect.Effect<void>;
    afterRead?: () => Effect.Effect<void>;
    failRead?: boolean;
    replacement?: string;
  } = { cursorWrites: 0, cursorReads: 0, ledgerWrites: 0, reads: 0 };
  const ledger = Ledger.of({
    ...base,
    append: (message) =>
      Effect.suspend(() => {
        state.ledgerWrites++;
        return base.append(message);
      }),
    admit: (message, cut) =>
      Effect.suspend(() => {
        state.ledgerWrites++;
        return base.admit(message, cut);
      }),
    appendCommand: (operation, command) =>
      Effect.suspend(() => {
        state.ledgerWrites++;
        return base.appendCommand(operation, command);
      }),
    read: (from) =>
      Effect.gen(function* () {
        state.reads++;
        const before = state.beforeRead;
        delete state.beforeRead;
        if (before !== undefined) yield* before();
        if (state.failRead)
          return yield* new LedgerError({ message: "Synthetic incomplete read." });
        const slice = yield* base.read(from);
        const after = state.afterRead;
        delete state.afterRead;
        if (after !== undefined) yield* after();
        return slice;
      }),
    presenceAt: (at) =>
      Effect.map(base.presenceAt(at), (read) => ({
        ...read,
        cut: { ...read.cut, incarnation: state.replacement ?? read.cut.incarnation },
      })),
    changes: silent ? Stream.never : base.changes,
  });
  const cursors = Cursors.of({
    get: (name) =>
      Effect.sync(() => {
        state.cursorReads++;
        return Option.fromUndefinedOr(positions.get(name));
      }),
    set: (name, next) =>
      Effect.sync(() => {
        state.cursorWrites++;
        positions.set(name, next);
      }),
    clear: (name) =>
      Effect.sync(() => {
        state.cursorWrites++;
        positions.delete(name);
      }),
  });
  const services = Layer.mergeAll(
    Layer.succeed(Ledger, ledger),
    Layer.succeed(QueryGateway, gateway),
    Layer.succeed(Cursors, cursors)
  );
  const runtime = ManagedRuntime.make(
    Bus.layer("fixture-installation").pipe(Layer.provideMerge(services))
  );
  cleanups.push(() => runtime.dispose());
  const bus = await runtime.runPromise(Bus.Bus);
  const run = <A, E>(effect: Effect.Effect<A, E, Bus.Bus | Ledger | Cursors | QueryGateway>) =>
    runtime.runPromise(effect);
  const joinAs = (
    name = address,
    owner = session,
    runtime: "claude" | "other" = "other",
    extra: Partial<Bus.JoinInput> = {}
  ) =>
    run(
      bus.join({
        address: name,
        session: owner,
        runtime,
        cwd: "/missing-fixture-directory",
        ...extra,
      })
    );
  await joinAs(address, session, ownerRuntime);
  await joinAs(sender, "fixture-sender");
  const observe = (extra: Partial<ObserveWakeRequest> = {}) =>
    run(bus.observeWake({ address, session, ...extra }));
  const say = async (to: ReadonlyArray<string>, body = "mail", pierce?: ReadonlyArray<string>) => {
    const posted = await run(
      bus.publish({
        from: sender,
        session: "fixture-sender",
        to,
        body,
        ...(pierce === undefined ? {} : { pierce }),
      })
    );
    return posted.message;
  };
  const durable = async () => ({
    cursor: positions.get(address),
    cursorWrites: state.cursorWrites,
    ledgerWrites: state.ledgerWrites,
    presence: await store.runPromise(base.presenceAt()),
    head: await store.runPromise(base.end),
  });
  return {
    dir,
    base,
    gateway,
    bus,
    run,
    services,
    state,
    positions,
    joinAs,
    observe,
    say,
    durable,
    store,
  };
};

for (const kind of ["jsonl", "fluree"])
  describe(`pure wake observation (${kind})`, () => {
    test("empty unrelated scans, successful observations and refusals never write, and coverage is caller-retained", async () => {
      const f = await open(kind);
      await f.say(["somebody/else"]);
      const before = await f.durable();
      expect(await f.observe()).toMatchObject({ ready: false, news: false });
      expect(await f.observe()).not.toHaveProperty("nextCoverage");
      expect(await f.durable()).toEqual(before);
      const a = await f.say([address]);
      const b = await f.say([address]);
      const initial = await f.observe();
      expect(initial).toMatchObject({
        ready: true,
        news: true,
        binding: { address, session, runtime: "other", installation: "fixture-installation" },
        nextCoverage: { cursor: before.cursor, rung: [a.id, b.id] },
      });
      const holder = (await f.run(f.bus.peers)).find((peer) => peer.address === address);
      if (holder === undefined) throw new Error("Missing holder.");
      expect(initial.binding.run).toBe(holder.joinId);
      expect(initial.binding.incarnation).toBe(initial.observationCut.incarnation);
      const covered = initial.nextCoverage;
      if (covered === undefined) throw new Error("Missing complete coverage.");
      Object.freeze(covered.rung);
      Object.freeze(covered.binding);
      Object.freeze(covered);
      const stable = await f.durable();
      expect(await f.observe({ previousCoverage: covered })).toMatchObject({
        ready: true,
        news: false,
        nextCoverage: covered,
      });
      expect(await f.observe()).toMatchObject({ ready: true, news: true });
      for (const owner of [undefined, "", "$UNEXPANDED", "intruder"]) {
        expect(
          (
            await f.run(
              Effect.flip(
                f.bus.observeWake({ address, ...(owner === undefined ? {} : { session: owner }) })
              )
            )
          )._tag
        ).toBe("NotOwner");
      }
      f.state.failRead = true;
      expect((await f.run(Effect.flip(f.bus.observeWake({ address, session }))))._tag).toBe(
        "LedgerError"
      );
      delete f.state.failRead;
      expect(await f.durable()).toEqual(stable);
      expect((await f.run(f.bus.take(address, session))).map((message) => message.id)).toEqual([
        a.id,
        b.id,
      ]);
      const consumed = await f.durable();
      expect(await f.observe({ previousCoverage: covered })).toMatchObject({
        ready: false,
        news: false,
        nextCoverage: covered,
      });
      expect(await f.durable()).toEqual(consumed);
    });

    test("same-run renewal preserves binding; replay, leave/rejoin, runtime and takeovers fence it", async () => {
      const f = await open(kind);
      const original = await f.observe();
      await f.joinAs(address, session, "other", { topics: ["reviews"] });
      expect((await f.observe({ expectedBinding: original.binding })).binding).toEqual(
        original.binding
      );
      await f.joinAs(address, session, "other", { replay: true });
      expect(
        (
          await f.run(
            Effect.flip(f.bus.observeWake({ address, session, expectedBinding: original.binding }))
          )
        )._tag
      ).toBe("InvalidQuery");
      const replay = await f.observe();
      await f.run(f.bus.leave(address, session));
      expect(
        (
          await f.run(
            Effect.flip(f.bus.observeWake({ address, session, expectedBinding: replay.binding }))
          )
        )._tag
      ).toBe("NotJoined");
      await f.joinAs();
      expect(
        (
          await f.run(
            Effect.flip(f.bus.observeWake({ address, session, expectedBinding: replay.binding }))
          )
        )._tag
      ).toBe("InvalidQuery");
      const live = await f.observe();
      await f.joinAs(address, session, "claude", {
        takeover: (await f.run(f.bus.peers)).find((peer) => peer.address === address)?.joinId,
      });
      expect(
        (
          await f.run(
            Effect.flip(f.bus.observeWake({ address, session, expectedBinding: live.binding }))
          )
        )._tag
      ).toBe("InvalidQuery");
      let holder = (await f.run(f.bus.peers)).find((peer) => peer.address === address);
      await f.joinAs(address, "successor", "other", { takeover: holder?.joinId });
      expect(
        (
          await f.run(
            Effect.flip(f.bus.observeWake({ address, session, expectedBinding: live.binding }))
          )
        )._tag
      ).toBe("NotOwner");
      holder = (await f.run(f.bus.peers)).find((peer) => peer.address === address);
      await f.joinAs(address, session, "other", { takeover: holder?.joinId });
      expect(
        (
          await f.run(
            Effect.flip(f.bus.observeWake({ address, session, expectedBinding: live.binding }))
          )
        )._tag
      ).toBe("InvalidQuery");
      const renewed = await f.observe();
      for (const field of [
        "address",
        "session",
        "runtime",
        "installation",
        "incarnation",
        "run",
      ] as const) {
        const stale = { ...renewed.binding, [field]: field === "runtime" ? "claude" : "stale" };
        // Decode the adversarial binding through the public schema rather than assert its type.
        const input = Schema.decodeUnknownSync(
          Schema.Struct({ binding: WakeObservation.fields.binding })
        )({ binding: stale });
        expect(
          (
            await f.run(
              Effect.flip(f.bus.observeWake({ address, session, expectedBinding: input.binding }))
            )
          )._tag
        ).toBe("InvalidQuery");
      }
      f.positions.delete(address);
      expect((await f.run(Effect.flip(f.bus.observeWake({ address, session }))))._tag).toBe(
        "NotJoined"
      );
    });

    test("native eligibility and held-back coverage survive suppression, restoration and partial owner reads", async () => {
      const f = await open(kind);
      await f.joinAs(address, session, "other", { topics: ["a", "b"] });
      const activity = (input: Partial<Bus.ActivityInput>) =>
        f.run(f.bus.activity({ address, session, operation: Bun.randomUUIDv7(), ...input }));
      await activity({ mutes: [{ scope: "topic", topic: "b" }, { scope: "programme" }] });
      const a = await f.say(["#a", "*"]);
      const b = await f.say(["#b"]);
      const first = await f.observe();
      if (first.nextCoverage === undefined) throw new Error("Missing coverage.");
      expect(first.nextCoverage?.rung).toEqual([a.id]);
      await activity({ activity: "inactive" });
      expect(await f.observe({ previousCoverage: first.nextCoverage })).toMatchObject({
        ready: false,
        news: false,
        nextCoverage: first.nextCoverage,
      });
      await activity({ activity: "active" });
      expect(await f.observe({ previousCoverage: first.nextCoverage })).toMatchObject({
        ready: true,
        news: false,
      });
      await activity({ mutes: [] });
      const both = await f.observe({ previousCoverage: first.nextCoverage });
      if (both.nextCoverage === undefined) throw new Error("Missing coverage.");
      expect(both).toMatchObject({ ready: true, news: true, nextCoverage: { rung: [a.id, b.id] } });
      await f.run(f.bus.take(address, session, 1));
      expect(await f.observe({ previousCoverage: both.nextCoverage })).toMatchObject({
        ready: true,
        news: true,
        nextCoverage: { rung: [b.id] },
      });
      await activity({
        activity: "inactive",
        mutes: [{ scope: "programme" }, { scope: "topic", topic: "a" }],
      });
      const pierced = await f.say(["#a"], "pierced", [address]);
      expect((await f.observe()).nextCoverage?.rung).toEqual([pierced.id]);
      const direct = await f.say([address], "direct");
      expect((await f.observe()).nextCoverage?.rung).toEqual([b.id, pierced.id, direct.id]);
      await f.run(f.bus.publish({ from: address, session, to: [address, "*"], body: "self" }));
      await f.say(["#unsubscribed"], "not ours");
      expect((await f.observe()).nextCoverage?.rung).toEqual([b.id, pierced.id, direct.id]);
    });

    test("independent writers during and after the slice cannot return mixed-owner or mixed-history evidence", async () => {
      const f = await open(kind);
      const original = await f.observe();
      await f.say([address]);
      const change = () =>
        Effect.promise(async () => {
          const peer = (await f.store.runPromise(f.base.presenceAt())).entries.find(
            (entry) => entry.from === address
          );
          if (!peer?.presence) throw new Error("Missing fixture join.");
          await f.store.runPromise(
            f.base.append(
              new Message({
                ...peer,
                id: Bun.randomUUIDv7(),
                presence: new Presence({ ...peer.presence, session: "successor" }),
              })
            )
          );
        });
      f.state.beforeRead = change;
      const before = await f.durable();
      expect(
        (
          await f.run(
            Effect.flip(f.bus.observeWake({ address, session, expectedBinding: original.binding }))
          )
        )._tag
      ).toBe("NotOwner");
      expect(f.state.cursorWrites).toBe(before.cursorWrites);
      // A same-owner return is still a new run, even when the original session returns.
      await f.joinAs(address, session, "other", {
        takeover: (await f.run(f.bus.peers)).find((peer) => peer.address === address)?.joinId,
      });
      const live = await f.observe();
      f.state.afterRead = change;
      expect(
        (
          await f.run(
            Effect.flip(f.bus.observeWake({ address, session, expectedBinding: live.binding }))
          )
        )._tag
      ).toBe("NotOwner");
      await f.joinAs(address, session, "other", {
        takeover: (await f.run(f.bus.peers)).find((peer) => peer.address === address)?.joinId,
      });
      const current = await f.observe();
      f.state.afterRead = () =>
        Effect.sync(() => {
          f.state.replacement = "new-history-at-same-head";
        });
      expect(
        (
          await f.run(
            Effect.flip(f.bus.observeWake({ address, session, expectedBinding: current.binding }))
          )
        )._tag
      ).toBe("InvalidQuery");
    });
  });

test("observation changes neither holder activity diagnostics nor native hooks, marks or waiters", async () => {
  const f = await open("jsonl", false, "claude");
  const refused = () =>
    f.run(
      Effect.flip(f.bus.join({ address, runtime: "claude", session: "intruder", cwd: "/missing" }))
    );
  const diagnostic = await refused();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await f.observe();
  expect(await refused()).toEqual(diagnostic);
  expect((await f.joinAs(address, session, "claude")).hooked).toBeUndefined();
  await f.say([address]);
  await f.observe();
  expect((await f.run(f.bus.wake(session, 1))).addresses).toEqual([address]);
  await f.observe();
  expect((await f.run(f.bus.wake(session, 0.01))).addresses).toEqual([]);
  await f.run(
    Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(f.bus.wake(session, 3));
        yield* Effect.sleep("20 millis");
        yield* f.bus.observeWake({ address, session });
        yield* f.bus.publish({
          from: sender,
          session: "fixture-sender",
          to: [address],
          body: "second",
        });
        expect(yield* Fiber.join(pending)).toMatchObject({
          addresses: [address],
          superseded: false,
        });
      })
    )
  );
});

test("bounded expiry freshly observes cursor-only progress and cancellation releases the address lock", async () => {
  const f = await open("jsonl", true);
  const a = await f.say([address]);
  const b = await f.say([address]);
  const initial = await f.observe();
  if (initial.nextCoverage === undefined) throw new Error("Missing coverage.");
  const previousCoverage = initial.nextCoverage;
  const entered = Deferred.makeUnsafe<void>();
  f.state.afterRead = () => Effect.asVoid(Deferred.succeed(entered, undefined));
  await f.run(
    Effect.scoped(
      Effect.gen(function* () {
        const waiting = yield* Effect.forkChild(
          f.bus.observeWake({
            address,
            session,
            previousCoverage,
            timeoutSeconds: 0.05,
          })
        );
        yield* Deferred.await(entered);
        const taken = yield* f.bus.take(address, session, 1);
        expect(taken.map((message) => message.id)).toEqual([a.id]);
        expect(yield* Fiber.join(waiting)).toMatchObject({
          ready: true,
          news: true,
          nextCoverage: { rung: [b.id] },
        });
        const gate = Deferred.makeUnsafe<void>();
        f.state.beforeRead = () => Effect.andThen(Deferred.succeed(gate, undefined), Effect.never);
        const cancelled = yield* Effect.forkChild(
          f.bus.observeWake({ address, session, timeoutSeconds: 1 })
        );
        yield* Deferred.await(gate);
        yield* Fiber.interrupt(cancelled);
        expect((yield* f.bus.observeWake({ address, session })).ready).toBe(true);
      })
    )
  );
});

test("foreign-installation holdings refuse before accessing their cursor", async () => {
  const f = await open();
  const peer = (await f.store.runPromise(f.base.presenceAt())).entries.find(
    (entry) => entry.from === address
  );
  if (!peer?.presence) throw new Error("Missing join.");
  await f.store.runPromise(
    f.base.append(
      new Message({
        ...peer,
        id: Bun.randomUUIDv7(),
        presence: new Presence({ ...peer.presence, installation: "foreign" }),
      })
    )
  );
  const before = await f.durable();
  const cursorReads = f.state.cursorReads;
  expect((await f.run(Effect.flip(f.bus.observeWake({ address, session }))))._tag).toBe(
    "InvalidQuery"
  );
  expect(f.state.reads).toBe(0);
  expect(f.state.cursorReads).toBe(cursorReads);
  expect(await f.durable()).toEqual(before);
});

test("a wait fences its initial same-session run even if its first message slice times out", async () => {
  const f = await open("jsonl", true);
  const entered = Deferred.makeUnsafe<void>();
  f.state.beforeRead = () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never);
  await f.run(
    Effect.scoped(
      Effect.gen(function* () {
        const waiting = yield* Effect.forkChild(
          Effect.result(f.bus.observeWake({ address, session, timeoutSeconds: 0.05 }))
        );
        yield* Deferred.await(entered);
        const peer = (yield* f.base.presenceAt()).entries.find((entry) => entry.from === address);
        if (!peer?.presence) throw new Error("Missing fixture join.");
        // Independent replay/new run; no change notification reaches the waiting observer.
        yield* f.base.append(new Message({ ...peer, id: Bun.randomUUIDv7() }));
        const result = yield* Fiber.join(waiting);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("InvalidQuery");
      })
    )
  );
});

test("complete input and coverage capacity refusals never truncate or store evidence", async () => {
  const f = await open();
  const initial = await f.observe();
  const previousCoverage = {
    binding: initial.binding,
    cursor: f.positions.get(address) ?? 0,
    rung: ["duplicate", "duplicate"],
  };
  const before = await f.durable();
  for (const coverage of [
    previousCoverage,
    {
      ...previousCoverage,
      rung: Array.from({ length: MAX_WAKE_COVERAGE_IDS + 1 }, (_, index) => `id-${index}`),
    },
    { ...previousCoverage, rung: ["x".repeat(MAX_WAKE_OBSERVATION_BYTES)] },
  ]) {
    expect(
      (
        await f.run(
          Effect.flip(f.bus.observeWake({ address, session, previousCoverage: coverage }))
        )
      )._tag
    ).toBe("InvalidQuery");
  }
  await f.store.runPromise(
    f.base.append(
      new Message({
        id: 'escaped-"-\\-\u20ac'.repeat(5000),
        from: sender,
        to: [address],
        body: "small",
        kind: "message",
        ts: "2026-01-01T00:00:00Z",
      })
    )
  );
  const saved = await f.durable();
  expect((await f.run(Effect.flip(f.bus.observeWake({ address, session }))))._tag).toBe(
    "InvalidQuery"
  );
  expect(await f.durable()).toEqual(saved);
  expect(saved.cursorWrites).toBe(before.cursorWrites);
});

test("exact complete carrier budget admits multibyte escaped evidence and one byte less refuses", async () => {
  const f = await open();
  await f.store.runPromise(
    f.base.append(
      new Message({
        id: 'id-"-\\-\u20ac',
        from: sender,
        to: [address],
        body: "not returned",
        kind: "message",
        ts: "2026-01-01T00:00:00Z",
      })
    )
  );
  const payload = await f.observe();
  const maximum = Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    }),
    "utf8"
  );
  const before = await f.durable();
  expect(await f.observe({ maxResultBytes: maximum })).toEqual(payload);
  expect(
    (await f.run(Effect.flip(f.bus.observeWake({ address, session, maxResultBytes: maximum - 1 }))))
      ._tag
  ).toBe("InvalidQuery");
  expect(await f.durable()).toEqual(before);
});

test("output coverage admits every id at the cardinality bound and refuses one more without truncation", async () => {
  const f = await open();
  for (let index = 0; index < MAX_WAKE_COVERAGE_IDS; index++) {
    await f.store.runPromise(
      f.base.append(
        new Message({
          id: `short-${index}`,
          from: sender,
          to: [address],
          body: "mail",
          kind: "message",
          ts: "2026-01-01T00:00:00Z",
        })
      )
    );
  }
  const full = await f.observe();
  expect(full.nextCoverage?.rung).toEqual(
    Array.from({ length: MAX_WAKE_COVERAGE_IDS }, (_, index) => `short-${index}`)
  );
  await f.store.runPromise(
    f.base.append(
      new Message({
        id: "one-more",
        from: sender,
        to: [address],
        body: "mail",
        kind: "message",
        ts: "2026-01-01T00:00:00Z",
      })
    )
  );
  const before = await f.durable();
  expect((await f.run(Effect.flip(f.bus.observeWake({ address, session }))))._tag).toBe(
    "InvalidQuery"
  );
  expect(await f.durable()).toEqual(before);
});

test("official SDK sees a pure native-only tool, complete duplicated content and typed refusals", async () => {
  const f = await open();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  const environment = Layer.mergeAll(f.services, Layer.succeed(Bus.Bus, f.bus));
  const server = ManagedRuntime.make(
    Serve.layerHttp({ port, version: "test" }).pipe(Layer.provide(environment))
  );
  cleanups.push(() => server.dispose());
  await server.runPromise(Effect.void);
  const client = new Client({ name: "wake-observation-fixture", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const { tools } = await client.listTools();
  const tool = tools.find((entry) => entry.name === "bus_observe_wake");
  expect(tool?.annotations).toMatchObject({
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  });
  expect(tool?.inputSchema.properties).toHaveProperty("expectedBinding");
  expect(tool?.outputSchema?.required).toContain("observationCut");
  expect(HostedNativeTools).not.toHaveProperty("ObserveWake");
  expect(
    peerTools(async () => {
      throw new Error("Must not forward.");
    }, "/fixture").map((entry) => entry.name)
  ).not.toContain("bus_observe_wake");
  await f.say([address], 'body-not-returned-"-\\-\u20ac');
  const response = await client.callTool({
    name: "bus_observe_wake",
    arguments: { address, session },
  });
  expect(response.isError).toBe(false);
  const decoded = Schema.decodeUnknownSync(WakeObservation)(response.structuredContent);
  expect(response.content).toEqual([{ type: "text", text: JSON.stringify(decoded) }]);
  expect(JSON.stringify(response)).not.toContain("body-not-returned");
  expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
    MAX_WAKE_OBSERVATION_BYTES
  );
  for (const args of [
    { address, session: "intruder" },
    { address, session, timeoutSeconds: 51 },
    { address, session, unknown: true },
  ]) {
    const refused = await client.callTool({ name: "bus_observe_wake", arguments: args });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
  }
});
