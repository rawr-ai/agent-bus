// Tracked defect, separate from reachable inactivity: a join or leave validated on one serve
// commits after another serve's takeover, and so re-installs or removes the old session as
// the address's holder. The ownership check reads the ledger, then writes; nothing makes the
// write conditional on the holder it checked. These are `test.failing` reproductions: each
// fails today for that race, so the suite stays green until the defect is fixed, at which
// point Bun reports them as unexpectedly passing and they become ordinary tests.
//
// Owner: claude/agent-bus (the Claude lead). Recorded as a limit in docs/architecture/messaging.md.
// Next action: make a presence write conditional on the holder its ownership check read, as
// bus_activity's commands are decided at their own commit, then drop `test.failing` here.
//
// The seam is deterministic: serve A writes through a relay that holds A's next presence
// insert until serve B, on the same ledger, has committed the takeover.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import { freshLedger } from "./fluree-server.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const address = "claude/held";
const holder = "session:holder";
const successor = "session:successor";
const cwd = process.cwd();

type Config = Awaited<ReturnType<typeof freshLedger>>;

const serveOn = async (config: Config, url: string) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-lifecycle-"));
  const runtime = ManagedRuntime.make(
    Bus.layer.pipe(
      Layer.provideMerge(layerFluree({ ...config, url }).pipe(Layer.provide(platform))),
      Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
      Layer.provide(platform)
    )
  );
  await runtime.runPromise(Effect.void);
  return runtime;
};

/** A relay that can run an action before forwarding the next presence insert. */
const presenceRelay = (upstream: string) => {
  let before: (() => Promise<void>) | undefined;
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
      const query = url.pathname.startsWith("/v1/fluree/query");
      if (!query && before !== undefined && text.includes('"bus:Presence"')) {
        const action = before;
        before = undefined;
        await action();
      }
      return fetch(`${upstream}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
      });
    },
  });
  return {
    url: server.url.origin,
    beforeNextPresence: (action: () => Promise<void>) => {
      before = action;
    },
    stop: () => server.stop(true),
  };
};

const latestOf = Effect.map(
  Effect.flatMap(Bus.Bus, (bus) => bus.peers),
  (peers) => peers.find((peer) => peer.address === address)
);

/**
 * Serve A holds the address for `holder`; A's next presence write (from `lifecycle`) is held
 * until serve B has taken the address over for `successor`. Returns the holder afterwards, or
 * undefined when the race was not staged (so the `test.failing` reports instead of passing).
 */
const race = async (
  name: string,
  lifecycle: Effect.Effect<unknown, unknown, Bus.Bus>
): Promise<{ readonly session: string | undefined; readonly status: string } | undefined> => {
  const config = await freshLedger(name);
  const relay = presenceRelay(config.url);
  const a = await serveOn(config, relay.url);
  const b = await serveOn(config, config.url);
  try {
    await a.runPromise(
      Effect.flatMap(Bus.Bus, (bus) =>
        bus.join({ address, runtime: "claude", session: holder, cwd })
      )
    );
    let tookOver = false;
    relay.beforeNextPresence(async () => {
      await b.runPromise(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const current = yield* latestOf;
          yield* bus.join({
            address,
            runtime: "claude",
            session: successor,
            cwd,
            takeover: current?.joinId,
          });
          const after = yield* latestOf;
          tookOver = after?.presence.session === successor && after.presence.status === "joined";
        })
      );
    });
    // Whatever A's call returns, its write was validated before the takeover existed.
    await a.runPromise(Effect.exit(lifecycle));
    if (!tookOver) return undefined;
    const final = await b.runPromise(latestOf);
    return { session: final?.presence.session, status: final?.presence.status ?? "absent" };
  } finally {
    await a.dispose();
    await b.dispose();
    relay.stop();
  }
};

describe("lifecycle takeover race (tracked defect, not reachable inactivity)", () => {
  test.failing("lifecycle takeover race: the old holder's rejoin committed after a takeover must not re-install it", async () => {
    const after = await race(
      "lifecycle-rejoin",
      Effect.flatMap(Bus.Bus, (bus) =>
        bus.join({ address, runtime: "claude", session: holder, cwd })
      )
    );
    // Not staged: return without throwing, so `test.failing` reports it rather than passing.
    if (after === undefined) return;
    expect(after).toEqual({ session: successor, status: "joined" });
  }, 60_000);

  test.failing("lifecycle takeover race: the old holder's leave committed after a takeover must not remove the successor", async () => {
    const after = await race(
      "lifecycle-leave",
      Effect.flatMap(Bus.Bus, (bus) => bus.leave(address, holder))
    );
    if (after === undefined) return;
    expect(after).toEqual({ session: successor, status: "joined" });
  }, 60_000);
});
