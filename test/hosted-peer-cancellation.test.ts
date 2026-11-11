import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { Messages } from "../src/mcp.ts";
import { busPeer, peerTools } from "../src/private-web/peer.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger } from "./fluree-server.ts";

const gate = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const bounded = async (promise: Promise<unknown>, milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture deadline expired.")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

test("wait applies byte admission on arrival and hosted cancellation reaches the native wait finalizer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-wait-cancellation-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
  const store = layerFluree(await freshLedger("wait-admission")).pipe(Layer.provide(platform));
  let arrivalBranch = gate();
  let nativeSettled = gate();
  const observedLedger = Layer.effect(
    Ledger,
    Effect.map(Ledger, (ledger) =>
      Ledger.of({
        ...ledger,
        changes: ledger.changes.pipe(Stream.onStart(Effect.sync(() => arrivalBranch.release()))),
      })
    )
  ).pipe(Layer.provideMerge(store));
  const baseBus = Bus.layer("fixture").pipe(
    Layer.provideMerge(observedLedger),
    Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
    Layer.provide(platform)
  );
  const observedBus = Layer.effect(
    Bus.Bus,
    Effect.map(Bus.Bus, (bus) =>
      Bus.Bus.of({
        ...bus,
        wait: (...args) =>
          bus.wait(...args).pipe(Effect.ensuring(Effect.sync(() => nativeSettled.release()))),
      })
    )
  ).pipe(Layer.provideMerge(baseBus));
  const server = ManagedRuntime.make(
    Serve.layerHttp({ port, version: "wait-fixture" }).pipe(Layer.provideMerge(observedBus))
  );
  await server.runPromise(Effect.void);
  const peer = await busPeer({ busPort: port, expectedBusVersion: "wait-fixture" });
  try {
    const a = { session: "wait-session-a" };
    const b = { session: "wait-session-b" };
    const tools = peerTools(peer.exchange, process.cwd());
    const invoke = async (
      name: string,
      args: Record<string, unknown>,
      actor: typeof a,
      signal = new AbortController().signal
    ) => {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error("Missing fixture tool.");
      return tool.execute(args, { actor, signal });
    };
    expect((await invoke("bus_join", { address: "chatgpt/wait-a" }, a)).isError).not.toBe(true);
    expect((await invoke("bus_join", { address: "chatgpt/wait-b" }, b)).isError).not.toBe(true);
    const getCursor = async () => {
      const cursor = await server.runPromise(
        Effect.flatMap(Cursors.Cursors, (cursors) => cursors.get("chatgpt/wait-a"))
      );
      if (cursor._tag !== "Some") throw new Error("Missing cursor.");
      return cursor.value;
    };
    const smallWait = peer.exchange("bus_wait", {
      address: "chatgpt/wait-a",
      session: a.session,
      timeoutSeconds: 30,
      maxResultBytes: 128,
    });
    await bounded(arrivalBranch.promise, 5_000);
    const beforeArrival = await getCursor();
    const largeBody = "too large".repeat(100);
    const sentLarge = await invoke(
      "bus_publish",
      { from: "chatgpt/wait-b", to: ["chatgpt/wait-a"], body: largeBody },
      b
    );
    expect(sentLarge.isError).not.toBe(true);
    const sentLargeId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      "structuredContent" in sentLarge ? sentLarge.structuredContent : undefined
    ).id;
    const refusal = await smallWait;
    expect(refusal.isError).toBe(true);
    expect(await getCursor()).toBe(beforeArrival);
    await bounded(nativeSettled.promise, 5_000);
    const original = await peer.exchange("bus_read", {
      address: "chatgpt/wait-a",
      session: a.session,
    });
    expect(
      Schema.decodeUnknownSync(Messages)(original.structuredContent).messages.map(
        ({ id, body }) => ({ id, body })
      )
    ).toEqual([{ id: sentLargeId, body: largeBody }]);

    arrivalBranch = gate();
    nativeSettled = gate();
    const abort = new AbortController();
    const waiting = invoke(
      "bus_wait",
      { address: "chatgpt/wait-a", timeoutSeconds: 30 },
      a,
      abort.signal
    );
    await bounded(arrivalBranch.promise, 5_000);
    abort.abort();
    await bounded(nativeSettled.promise, 5_000);
    expect((await waiting).isError).toBe(true);
    const sentAfter = await invoke(
      "bus_publish",
      { from: "chatgpt/wait-b", to: ["chatgpt/wait-a"], body: "after native finalizer" },
      b
    );
    expect(sentAfter.isError).not.toBe(true);
    const sentAfterId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      "structuredContent" in sentAfter ? sentAfter.structuredContent : undefined
    ).id;
    const read = await invoke("bus_read", { address: "chatgpt/wait-a" }, a);
    expect(
      Schema.decodeUnknownSync(Messages)(
        "structuredContent" in read ? read.structuredContent : undefined
      ).messages.map(({ id, body }) => ({ id, body }))
    ).toEqual([{ id: sentAfterId, body: "after native finalizer" }]);
  } finally {
    await peer.dispose();
    await server.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
