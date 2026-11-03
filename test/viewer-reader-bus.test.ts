// The viewer's MCP reader against the bus's own endpoint (src/serve.ts serving src/mcp.ts), on a
// throwaway ledger and an OS-assigned port: never the machine's running bus.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import * as Serve from "../src/serve.ts";
import { createViewer } from "../viewer/server/host.ts";
import { ObservationReader, readerLayer } from "../viewer/server/reader.ts";
import type { ViewerClient } from "../viewer/shared/client-types.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-viewer-reader-"));
const cwd = mkdtempSync(join(tmpdir(), "agent-bus-viewer-cwd-"));
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const busPort = Number(probe.url.port);
probe.stop(true);
const bus = ManagedRuntime.make(
  Serve.layerHttp({ port: busPort, version: "test" }).pipe(
    Layer.provideMerge(
      Bus.layer.pipe(
        Layer.provideMerge(layerJsonl(join(dir, "ledger.jsonl"))),
        Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(platform)
      )
    )
  )
);
const reader = ManagedRuntime.make(readerLayer({ busPort }));
const marker = "private-session-never-observed";

let sent: { root: string; reply: string; other: string };
beforeAll(async () => {
  sent = await bus.runPromise(
    Effect.gen(function* () {
      const b = yield* Bus.Bus;
      yield* b.join({
        address: "claude/lead",
        runtime: "claude",
        session: marker,
        cwd,
        topics: ["review"],
        note: "leading the review",
      });
      yield* b.join({ address: "codex/reviewer", runtime: "codex", session: `${marker}-2`, cwd });
      const root = yield* b.publish({
        from: "claude/lead",
        session: marker,
        to: ["#review"],
        subject: "Review request",
        body: "Please review **the proposal**.",
      });
      const reply = yield* b.publish({
        from: "codex/reviewer",
        session: `${marker}-2`,
        to: ["claude/lead"],
        body: "Confirmed with one note.",
        replyTo: root.id,
      });
      const other = yield* b.publish({
        from: "claude/lead",
        session: marker,
        to: ["*"],
        body: "Unrelated broadcast",
      });
      return { root: root.id, reply: reply.id, other: other.id };
    })
  );
});
afterAll(async () => {
  await reader.dispose();
  await bus.dispose();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const read = <A>(f: (reader: ObservationReader["Service"]) => Effect.Effect<A, unknown>) =>
  reader.runPromise(Effect.flatMap(ObservationReader, f));

test("history from the real bus is projected in order with its public fields only", async () => {
  const observation = await read((r) => r.history({ limit: 200 }));
  expect(observation.criteria).toEqual({ limit: 200 });
  expect(observation.omitted).toBe(0);
  expect(Number.isFinite(Date.parse(observation.observedAt))).toBe(true);
  const origin = { host: hostname(), cwd };
  expect(observation.messages.map(({ ts: _, ...message }) => message)).toEqual([
    {
      id: sent.root,
      from: "claude/lead",
      to: ["#review"],
      kind: "message",
      subject: "Review request",
      body: "Please review **the proposal**.",
      origin,
    },
    {
      id: sent.reply,
      from: "codex/reviewer",
      to: ["claude/lead"],
      kind: "message",
      body: "Confirmed with one note.",
      replyTo: sent.root,
      origin,
    },
    {
      id: sent.other,
      from: "claude/lead",
      to: ["*"],
      kind: "message",
      body: "Unrelated broadcast",
      origin,
    },
  ]);
  expect(JSON.stringify(observation)).not.toContain(marker);
});

test("search and exact participant criteria reach the real bus unchanged", async () => {
  const byParticipant = await read((r) => r.history({ limit: 200, participant: "codex/reviewer" }));
  expect(byParticipant.criteria).toEqual({ limit: 200, participant: "codex/reviewer" });
  expect(byParticipant.messages.map((message) => message.id)).toEqual([sent.reply]);
  const byText = await read((r) => r.history({ limit: 200, query: "broadcast" }));
  expect(byText.messages.map((message) => message.id)).toEqual([sent.other]);
  const latest = await read((r) => r.history({ limit: 1 }));
  expect(latest.messages.map((message) => message.id)).toEqual([sent.other]);
});

test("current peers from the real bus keep public fields only", async () => {
  const observation = await read((r) => r.peers());
  expect(observation.omitted).toBe(0);
  expect(observation.peers).toEqual([
    {
      address: "claude/lead",
      runtime: "claude",
      topics: ["review"],
      host: hostname(),
      note: "leading the review",
    },
    { address: "codex/reviewer", runtime: "codex", topics: [], host: hostname() },
  ]);
  expect(JSON.stringify(observation)).not.toContain(marker);
});

test("the whole viewer serves the real bus's observations to a browser client", async () => {
  const viewer = createViewer({ port: 0, busPort, assets: new Map() });
  try {
    const client: ViewerClient = createORPCClient(
      new RPCLink({ url: new URL("/rpc", viewer.url) })
    );
    const [history, peers] = await Promise.all([client.history({ limit: 200 }), client.peers({})]);
    expect(history.messages.map((message) => message.id)).toEqual([
      sent.root,
      sent.reply,
      sent.other,
    ]);
    expect(peers.peers.map((peer) => peer.address)).toEqual(["claude/lead", "codex/reviewer"]);
  } finally {
    await viewer.close();
  }
});
