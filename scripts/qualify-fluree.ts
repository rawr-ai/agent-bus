#!/usr/bin/env bun
/**
 * Qualifies the installed Fluree CLI as the bus store, on a durable
 * (file-backed) server in a temporary directory. Rerun after upgrading Fluree.
 *
 * 1. Restart and catch-up: a cursor taken before a server restart reads every
 *    message committed after it, and a waiting reader is woken through the
 *    reconnected event stream.
 * 2. Search across the index boundary: with background indexing held back,
 *    full-text search finds both indexed messages and a fresh unindexed canary,
 *    and finds the same messages once the index catches up.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import * as Fluree from "../src/Fluree.ts";

const fluree = Bun.which("fluree");
if (fluree === null) throw new Error("fluree is not on PATH");

const dir = mkdtempSync(join(tmpdir(), "agent-bus-qualify-"));
const port = 18_900 + Math.floor(Math.random() * 90);
const config = { url: `http://127.0.0.1:${port}`, ledger: "agent-bus-qualify:main" };
const api = `${config.url}/v1/fluree`;
// Novelty this large is never indexed during the run, holding the index back.
const HOLD_INDEX = ["--", "--reindex-min-bytes", "1000000000", "--reindex-max-bytes", "2000000000"];

Bun.spawnSync([fluree, "init"], { cwd: dir, stdout: "ignore" });

let server: ReturnType<typeof Bun.spawn> | undefined;

const start = async (extra: ReadonlyArray<string> = []) => {
  server = Bun.spawn(
    [
      fluree,
      "server",
      "run",
      "--config",
      join(dir, ".fluree", "config.toml"),
      "--storage-path",
      join(dir, "storage"),
      "--listen-addr",
      `127.0.0.1:${port}`,
      ...extra,
    ],
    { cwd: dir, stdout: "ignore", stderr: "ignore" }
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await fetch(`${config.url}/health`).then(
        (r) => r.ok,
        () => false
      )
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error("fluree server did not start");
};

const stop = async () => {
  server?.kill();
  await server?.exited;
};

const indexLag = async () => {
  const info = (await fetch(`${api}/info/${encodeURIComponent(config.ledger)}`).then((r) =>
    r.json()
  )) as { ledger: { "commit-t": number; "index-t": number } };
  return info.ledger["commit-t"] - info.ledger["index-t"];
};

const waitForIndex = async () => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await indexLag()) === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("background index did not catch up");
};

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const busLayer = () =>
  Bus.layer.pipe(
    Layer.provideMerge(Fluree.layerFluree(config)),
    Layer.provide(Cursors.layerFiles(join(dir, "cursors"))),
    Layer.provide(platform)
  );
const withBus = <A, E>(effect: Effect.Effect<A, E, Bus.Bus>) =>
  Effect.runPromise(Effect.provide(effect, busLayer()));

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const search = (query: string) =>
  withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      return yield* bus.history({ query, limit: 10 });
    })
  );

/** The qualification's two sessions. */
const READER = "qualify-reader";
const SENDER = "qualify-sender";

const bodies = (messages: ReadonlyArray<{ readonly body: string }>) =>
  messages.map((message) => message.body).sort();

try {
  await start();
  const corpus = Array.from({ length: 50 }, (_, i) => `routine status update ${i}`);
  await withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      yield* bus.join({
        address: "codex/reader",
        runtime: "codex",
        session: READER,
        cwd: process.cwd(),
      });
      yield* bus.join({
        address: "claude/a",
        runtime: "claude",
        session: SENDER,
        cwd: process.cwd(),
      });
      yield* bus.publish({
        from: "claude/a",
        session: SENDER,
        to: ["*"],
        body: "indexed: deploying the adapters",
      });
      for (const body of corpus)
        yield* bus.publish({ from: "claude/a", session: SENDER, to: ["*"], body });
    })
  );
  await waitForIndex();
  check("corpus indexed", (await indexLag()) === 0);

  // Restart with indexing held back; the reader's cursor predates the restart.
  await stop();
  await start(HOLD_INDEX);
  await withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      yield* bus.publish({
        from: "claude/a",
        session: SENDER,
        to: ["*"],
        body: "canary: redeployed adapter",
      });
    })
  );
  const lag = await indexLag();
  check("canary is unindexed novelty", lag > 0, `commit-t minus index-t = ${lag}`);

  const searchHeld = await search("deploy adapters");
  const expected = ["canary: redeployed adapter", "indexed: deploying the adapters"];
  check(
    "search spans indexed and novelty",
    JSON.stringify(bodies(searchHeld)) === JSON.stringify(expected),
    bodies(searchHeld).join(" | ")
  );

  const caughtUp = await withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      return yield* bus.take("codex/reader", READER);
    })
  );
  check(
    "cursor catches up across restart",
    caughtUp.length === corpus.length + 2,
    `${caughtUp.length} messages`
  );

  // A waiting reader survives the server restarting underneath its event stream.
  const woken = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const waiting = yield* Effect.forkChild(bus.wait("codex/reader", READER, 60));
        yield* Effect.sleep("500 millis");
        yield* Effect.promise(stop);
        yield* Effect.promise(() => start());
        const sent = Date.now();
        yield* bus.publish({
          from: "claude/a",
          session: SENDER,
          to: ["codex/reader"],
          body: "after restart",
        });
        const messages = yield* Fiber.join(waiting);
        return { messages, ms: Date.now() - sent };
      }),
      busLayer()
    )
  );
  check(
    "waiting reader woken after restart",
    bodies(woken.messages).join() === "after restart",
    `${woken.ms} ms`
  );

  await waitForIndex();
  const searchIndexed = await search("deploy adapters");
  check(
    "same matches once indexed",
    JSON.stringify(bodies(searchIndexed)) === JSON.stringify(expected),
    bodies(searchIndexed).join(" | ")
  );
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
