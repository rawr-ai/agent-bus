// The viewer's MCP reader against the bus's own endpoint (src/serve.ts serving src/mcp.ts), on a
// throwaway ledger and an OS-assigned port: never the machine's running bus.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Message, MessageJson } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { PROCESS_POLICY } from "../src/RankedSelections.ts";
import * as Serve from "../src/serve.ts";
import { createViewer } from "../viewer/server/host.ts";
import { ObservationReader, ObservationUnavailable, readerLayer } from "../viewer/server/reader.ts";
import type { ViewerClient } from "../viewer/shared/client-types.ts";
import { MAX_PAGES, MAX_THREAD_MESSAGES } from "../viewer/shared/public.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-viewer-reader-"));
const cwd = mkdtempSync(join(tmpdir(), "agent-bus-viewer-cwd-"));
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
// The real store: the reader's history and peers run through the bus's query engine.
const config = await freshLedger("viewer-reader");
const store = layerFluree(config).pipe(Layer.provide(platform));
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const busPort = Number(probe.url.port);
probe.stop(true);
const bus = ManagedRuntime.make(
  Serve.layerHttp({ port: busPort, version: "test" }).pipe(
    Layer.provideMerge(
      Bus.layer.pipe(
        Layer.provideMerge(store),
        Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(platform)
      )
    )
  )
);
const reader = ManagedRuntime.make(readerLayer({ busPort }));
// A direct MCP client, for calls the viewer does not make.
const direct = new Client({ name: "viewer-reader-bus-test", version: "1" });
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
  await direct.close();
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
  // Every entry at one commit: the window says so because the bus exhausted it.
  expect(observation.window).toBe("all");
  expect(observation.complete).toBe(true);
  expect(observation.damaged).toBe(0);
  expect(observation.snapshot.t).toBeGreaterThan(0);
  expect(observation.snapshot.ledger.length).toBeGreaterThan(0);
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
  // A new ledger's full-text index can briefly find nothing, so the text search is retried.
  let byText = await read((r) => r.history({ limit: 200, query: "broadcast" }));
  for (let attempt = 0; attempt < 50 && byText.messages.length === 0; attempt++) {
    await Bun.sleep(100);
    byText = await read((r) => r.history({ limit: 200, query: "broadcast" }));
  }
  expect(byText.messages.map((message) => message.id)).toEqual([sent.other]);
  expect(byText.window).toBe("ranked");
  expect(byText.complete).toBe(false);
  const latest = await read((r) => r.history({ limit: 1 }));
  expect(latest.messages.map((message) => message.id)).toEqual([sent.other]);
  expect(latest.window).toBe("latest");
  expect(latest.complete).toBe(false);
});

test("current peers from the real bus keep public fields only", async () => {
  const observation = await read((r) => r.peers());
  expect(observation.omitted).toBe(0);
  expect(observation.complete).toBe(true);
  expect(observation.peers).toEqual([
    {
      address: "claude/lead",
      runtime: "claude",
      topics: ["review"],
      host: hostname(),
      note: "leading the review",
      // The serve's own activity fold reaches the viewer as given.
      activity: "active",
      activeSince: expect.any(String),
      mutes: [],
    },
    {
      address: "codex/reviewer",
      runtime: "codex",
      topics: [],
      host: hostname(),
      activity: "active",
      activeSince: expect.any(String),
      mutes: [],
    },
  ]);
  expect(JSON.stringify(observation)).not.toContain(marker);
});

test("a conversation is the reply tree read at the explicit commit it was opened at", async () => {
  const window = await read((r) => r.history({ limit: 200 }));
  const at = { ledger: window.snapshot.ledger, t: window.snapshot.t };
  const before = await read((r) => r.thread({ id: sent.reply, ...at }));
  expect(before.messages.map((message) => message.id)).toEqual([sent.root, sent.reply]);
  expect(before.snapshot).toEqual(at);
  expect(before.missingReplyTargets).toEqual([]);
  expect(before.exhausted).toBe(true);
  expect(before.complete).toBe(true);
  expect(JSON.stringify(before)).not.toContain(marker);
  const late = await bus.runPromise(
    Effect.flatMap(Bus.Bus, (b) =>
      b.publish({
        from: "claude/lead",
        session: marker,
        to: ["codex/reviewer"],
        body: "Thanks, merged.",
        replyTo: sent.reply,
      })
    )
  );
  // Reread at the same commit: frozen, the later reply is not mixed in.
  const frozen = await read((r) => r.thread({ id: sent.root, ...at }));
  expect(frozen.messages.map((message) => message.id)).toEqual([sent.root, sent.reply]);
  // Accepting the current reading moves to the current commit.
  const current = await read((r) => r.history({ limit: 200 }));
  expect(current.snapshot.t).toBeGreaterThan(at.t);
  const moved = await read((r) =>
    r.thread({ id: sent.root, ledger: current.snapshot.ledger, t: current.snapshot.t })
  );
  expect(moved.messages.map((message) => message.id)).toEqual([sent.root, sent.reply, late.id]);
  // A tree requested for another ledger incarnation is refused, never answered from this one.
  const elsewhere = await reader.runPromiseExit(
    Effect.flatMap(ObservationReader, (r) =>
      r.thread({ id: sent.root, ledger: "replaced", t: at.t })
    )
  );
  expect(elsewhere._tag).toBe("Failure");
});

test("unreadable entries are counted apart from projection omissions, across pages at one t", async () => {
  // Newest entry, damaged: typed and identified, without the stored entry.
  const damaged = new Message({
    id: "damaged-viewer-entry",
    ts: new Date().toISOString(),
    from: "claude/damaged",
    to: ["#review"],
    kind: "message",
    body: "unreadable",
  });
  const { "bus:json": _, ...node } = toNode(damaged, "");
  await insertRaw(config, node);
  // limit 1: the first page meets only the damaged entry, so the reader follows next at the
  // same commit to the newest readable message.
  const latest = await read((r) => r.history({ limit: 1 }));
  expect(latest.messages).toHaveLength(1);
  expect(latest.messages[0]?.from).toBe("claude/lead");
  expect(latest.damaged).toBe(1);
  expect(latest.omitted).toBe(0);
  expect(latest.window).toBe("latest");
  // Every entry was reached, but one could not be read: all readable entries, never all.
  const all = await read((r) => r.history({ limit: 200 }));
  expect(all.window).toBe("readable");
  expect(all.damaged).toBe(1);
  expect(all.complete).toBe(false);
  expect(all.messages.map((message) => message.id)).not.toContain(damaged.id);
});

test("the whole viewer serves the real bus's observations to a browser client", async () => {
  const viewer = createViewer({ port: 0, busPort, assets: new Map() });
  try {
    const client: ViewerClient = createORPCClient(
      new RPCLink({ url: new URL("/rpc", viewer.url) })
    );
    const [history, peers] = await Promise.all([client.history({ limit: 200 }), client.peers({})]);
    expect(history.messages.map((message) => message.id).slice(0, 3)).toEqual([
      sent.root,
      sent.reply,
      sent.other,
    ]);
    expect(peers.peers.map((peer) => peer.address)).toEqual(["claude/lead", "codex/reviewer"]);
    const tree = await client.thread({
      id: sent.root,
      ledger: history.snapshot.ledger,
      t: history.snapshot.t,
    });
    expect(tree.messages[0]?.id).toBe(sent.root);
    expect(tree.snapshot.t).toBe(history.snapshot.t);
  } finally {
    await viewer.close();
  }
});

const encodeJson = Schema.encodeSync(MessageJson);
/**
 * One reply tree written in a single commit, so its entries page by id: `count` replies to a
 * root, each with a body of `bodyBytes`. Returns the ids in the bus's page order.
 */
const writeTree = async (prefix: string, count: number, bodyBytes: number) => {
  const ts = new Date().toISOString();
  const id = (index: number) => `${prefix}-${String(index).padStart(3, "0")}`;
  const messages = Array.from(
    { length: count + 1 },
    (_, index) =>
      new Message({
        id: id(index),
        ts,
        from: "claude/lead",
        to: ["#tree"],
        kind: "message",
        body: `${id(index)} ${"x".repeat(bodyBytes)}`,
        ...(index === 0 ? { subject: "Large tree" } : { replyTo: id(0) }),
      })
  );
  await insertRaw(config, {
    "@context": toNode(messages[0] as Message, "")["@context"],
    "@graph": messages.map((m) => {
      const { "@context": _, ...node } = toNode(m, encodeJson(m));
      return node;
    }),
  });
  return messages.map((m) => m.id);
};

/** The thread for `id`, read at the current history observation's commit. */
const treeAtHead = async (id: string) => {
  const window = await read((r) => r.history({ limit: 1 }));
  return read((r) => r.thread({ id, ledger: window.snapshot.ledger, t: window.snapshot.t }));
};

test("a tree larger than the read keeps its first entries, and a late selected entry is beyond it", async () => {
  // A root and 200 replies: 201 entries, one more than a conversation reads.
  const ids = await writeTree("wide", MAX_THREAD_MESSAGES, 0);
  const selected = ids.at(-1) ?? "";
  const tree = await treeAtHead(selected);
  expect(tree.messages.map((message) => message.id)).toEqual(ids.slice(0, MAX_THREAD_MESSAGES));
  expect(tree.exhausted).toBe(false);
  expect(tree.complete).toBe(false);
  // The selected entry is in the tree at t, but beyond what was read.
  expect(tree.messages.some((message) => message.id === selected)).toBe(false);
});

test("a tree the byte budget trims is followed page by page, within the page bound", async () => {
  // About 20 KB each, so a 64 KiB page holds three entries.
  const small = await writeTree("trim", 11, 20_000);
  const whole = await treeAtHead(small.at(-1) ?? "");
  // Twelve entries over four pages, all read: the whole tree, the selected entry included.
  expect(whole.messages.map((message) => message.id)).toEqual(small);
  expect(whole.exhausted).toBe(true);
  expect(whole.complete).toBe(true);

  const large = await writeTree("bulk", 29, 20_000);
  const selected = large.at(-1) ?? "";
  const cut = await treeAtHead(selected);
  // MAX_PAGES pages of three: the first entries in order, the selected one excluded.
  expect(cut.messages.map((message) => message.id)).toEqual(large.slice(0, MAX_PAGES * 3));
  expect(cut.exhausted).toBe(false);
  expect(cut.messages.some((message) => message.id === selected)).toBe(false);
});

/** `count` messages matching `word`, each about 20 KB, so a 64 KiB page holds three. */
const writeMatches = async (word: string, count: number) => {
  const ts = new Date().toISOString();
  const messages = Array.from(
    { length: count },
    (_, index) =>
      new Message({
        id: `${word}-${String(index).padStart(3, "0")}`,
        ts,
        from: "claude/lead",
        to: ["#search"],
        kind: "message",
        body: `${word} ${"x".repeat(20_000)}`,
      })
  );
  await insertRaw(config, {
    "@context": toNode(messages[0] as Message, "")["@context"],
    "@graph": messages.map((m) => {
      const { "@context": _, ...node } = toNode(m, encodeJson(m));
      return node;
    }),
  });
  return messages.map((m) => m.id);
};

const call = async (name: string, args: Record<string, unknown>) => {
  if (direct.transport === undefined) {
    await direct.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${busPort}/mcp`))
    );
  }
  const result = (await direct.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) throw new Error(`${name} refused`);
  return result.structuredContent as Record<string, unknown>;
};

/**
 * Waits until a new commit's full-text index finds every match, through bus_history, whose
 * ranking is its own call's and never held by the bus, so waiting leaves no ranking behind.
 */
const indexed = async (query: string, expected: number) => {
  const found = () =>
    call("bus_history", { query, limit: expected }).then(
      (result) => (result.messages as ReadonlyArray<unknown>).length
    );
  for (let attempt = 0; attempt < 50 && (await found()) < expected; attempt++) {
    await Bun.sleep(100);
  }
  expect(await found()).toBe(expected);
};

/** Rankings this file's reads have left held by the bus, for the capacity test's exact count. */
let held = 0;

test("a search over several calls returns every match once, as one ranked window", async () => {
  // Seven matches of about 20 KB need three calls, each continuing the ranking the bus holds. The
  // viewer shows matches in commit order, so their ranked order is checked against the stub in
  // test/search-selection.test.ts; here, that every match arrives once.
  const ids = await writeMatches("zebra", 7);
  await indexed("zebra", ids.length);
  const found = await read((r) => r.history({ limit: 200, query: "zebra" }));
  held += 1;
  expect(found.messages.map((message) => message.id).sort()).toEqual(ids);
  expect(found.window).toBe("ranked");
  expect(found.complete).toBe(false);
});

// Last in this file: it fills the bus's store of rankings for the rest of its lifetime.
test("when the bus holds all the rankings it can, a search needing another call is unavailable, and one call still serves", async () => {
  await writeMatches("yak", 7);
  await indexed("yak", 7);
  // A traversal held before the store fills keeps its ranking after it fills.
  const first = await call("bus_run_query", { name: "search", args: { text: "yak", limit: 2 } });
  held += 1;
  // Each two-row read of seven matches leaves a ranking held, until the store holds all it can.
  let served = 0;
  let refusal: unknown;
  while (refusal === undefined && served <= PROCESS_POLICY.records) {
    refusal = await read((r) => r.history({ limit: 2, query: "yak" })).then(
      () => {
        served += 1;
        return undefined;
      },
      (error: unknown) => error
    );
  }
  expect(refusal).toBeInstanceOf(ObservationUnavailable);
  expect(served).toBe(PROCESS_POLICY.records - held);
  const second = await call("bus_run_query", {
    name: "search",
    args: { text: "yak", limit: 2 },
    t: first.t,
    cursor: first.next,
  });
  expect(second.rows).toHaveLength(2);
  const single = await read((r) => r.history({ limit: 200, query: "broadcast" }));
  expect(single.messages.map((message) => message.id)).toEqual([sent.other]);
});
