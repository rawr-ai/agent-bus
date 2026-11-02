// The read-only query tools (bus_query, bus_run_query, bus_queries) and the presets built on
// them, driven through the real McpServer on the shared throwaway Fluree server.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Duration, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { CATALOGUE_VERSION, operationNames } from "../src/catalogue.ts";
import { Message, MessageJson, Origin, Presence } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { QueryGateway } from "../src/Query.ts";
import * as Serve from "../src/serve.ts";
import { READABLE_PREDICATES } from "../src/sparql.ts";
import { boundary, chunked, padded, stallBeforeHeaders, stallMidBody } from "./fluree-boundary.ts";
import { flureeFetch, freshLedger, insertRaw } from "./fluree-server.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

type Config = Awaited<ReturnType<typeof freshLedger>>;
type Json = Record<string, any>;

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const dirs: Array<string> = [];
const disposers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  return port;
};

type Store = Layer.Layer<Ledger | QueryGateway, unknown, never>;

/**
 * A bus serving MCP over one store, with an official SDK client. With `testClock`, the whole
 * bus runs on a TestClock that only `adjust` moves, so deadlines pass without waiting.
 */
const startBus = async (store: Store, options: { readonly testClock?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-query-"));
  dirs.push(dir);
  const port = freePort();
  const layer = Serve.layerHttp({ port, version: "test" }).pipe(
    Layer.provideMerge(
      Bus.layer.pipe(
        Layer.provideMerge(store),
        Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(platform)
      )
    )
  );
  const runtime = ManagedRuntime.make(
    options.testClock === true
      ? (layer.pipe(Layer.provideMerge(TestClock.layer())) as unknown as typeof layer)
      : layer
  );
  await runtime.runPromise(Effect.void);
  /** A new MCP connection of its own to the same bus. */
  const connect = async () => {
    const connection = new Client({ name: "query-test", version: "1" });
    await connection.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    );
    return connection;
  };
  const client = await connect();
  const { tools } = await client.listTools();
  const adjust = (duration: Duration.Input) => runtime.runPromise(TestClock.adjust(duration));
  const dispose = async () => {
    await client.close();
    await runtime.dispose();
  };
  disposers.push(dispose);
  const call = async (name: string, args: Json) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (result: CallToolResult) => {
    const [first] = result.content;
    return first?.type === "text" ? first.text : "";
  };
  const ok = async (name: string, args: Json = {}): Promise<Json> => {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name} refused: ${text(result)}`);
    expect(result.structuredContent).toEqual(JSON.parse(text(result)));
    return result.structuredContent as Json;
  };
  const refused = async (name: string, args: Json): Promise<string> => {
    const result = await call(name, args);
    if (!result.isError) throw new Error(`${name} answered: ${text(result)}`);
    return text(result);
  };
  const append = (...messages: ReadonlyArray<Message>) =>
    runtime.runPromise(
      Effect.flatMap(Ledger, (ledger) => Effect.forEach(messages, (m) => ledger.append(m)))
    );
  const run = (name: string, args: Json, extra: Json = {}) =>
    ok("bus_run_query", { name, args, ...extra });
  /** Every page of a traversal at one t. */
  const all = async (name: string, args: Json, extra: Json = {}) => {
    const pages = [await run(name, args, extra)];
    while (pages.at(-1)?.next !== undefined) {
      pages.push(await run(name, args, { cursor: pages.at(-1)?.next }));
    }
    return pages;
  };
  return {
    runtime,
    tools,
    client,
    connect,
    adjust,
    text,
    call,
    ok,
    refused,
    append,
    run,
    all,
    dispose,
  };
};

const flureeStore = (config: Config): Store => layerFluree(config).pipe(Layer.provide(platform));

let clock = Date.parse("2026-11-01T09:00:00.000Z");
const nextTs = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};
let serial = 0;
const id = (label: string) => {
  serial += 1;
  return `${label}-${String(serial).padStart(4, "0")}`;
};
const message = (fields: {
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly body: string;
  readonly id?: string;
  readonly ts?: string;
  readonly subject?: string;
  readonly replyTo?: string;
}) =>
  new Message({
    id: fields.id ?? id("m"),
    ts: fields.ts ?? nextTs(),
    from: fields.from,
    to: [...fields.to],
    kind: "message",
    body: fields.body,
    ...(fields.subject === undefined ? {} : { subject: fields.subject }),
    ...(fields.replyTo === undefined ? {} : { replyTo: fields.replyTo }),
    origin: new Origin({ host: "fixture-host", cwd: "/workspace" }),
  });
const presence = (
  from: string,
  status: "joined" | "left",
  extra: { readonly session?: string; readonly topics?: ReadonlyArray<string> } = {}
) =>
  new Message({
    id: id("p"),
    ts: nextTs(),
    from,
    to: ["*"],
    kind: "presence",
    body: `${from} ${status}`,
    presence: new Presence({
      runtime: "codex",
      status,
      topics: [...(extra.topics ?? [])],
      ...(extra.session === undefined ? {} : { session: extra.session }),
      note: "public note",
    }),
  });
const encodeJson = Schema.encodeSync(MessageJson);
/** A damaged entry: typed and identified like any other, without bus:json or with junk in it. */
const damaged = (config: Config, json?: string) => {
  const m = message({ from: "claude/damaged", to: ["#damaged"], body: "damaged entry" });
  const { "bus:json": _, ...node } = toNode(m, "");
  return insertRaw(config, json === undefined ? node : { ...node, "bus:json": json }).then(
    () => m.id
  );
};
const ids = (rows: ReadonlyArray<Json>) => rows.map((row) => row.id);
const rowsOf = (pages: ReadonlyArray<Json>) => pages.flatMap((page) => page.rows as Array<Json>);

describe("catalogue", () => {
  test("bus_queries, the bus_run_query enum and dispatch name the same operations, and every example runs", async () => {
    const bus = await startBus(flureeStore(await freshLedger("catalogue")));
    const root = message({ from: "claude/a", to: ["codex/b"], body: "root" });
    await bus.append(root);
    const listing = await bus.ok("bus_queries");
    expect(listing.catalogueVersion).toBe(CATALOGUE_VERSION);
    expect(listing.headT).toBeGreaterThan(0);
    expect(listing.operations.map((operation: Json) => operation.name)).toEqual([
      ...operationNames,
    ]);
    const tool = bus.tools.find((candidate) => candidate.name === "bus_run_query");
    expect((tool?.inputSchema.properties?.name as Json | undefined)?.enum).toEqual([
      ...operationNames,
    ]);
    for (const operation of listing.operations as Array<Json>) {
      expect(operation.args.type).toBe("object");
      expect(operation.row.type).toBe("object");
      expect(operation.note.length).toBeGreaterThan(0);
      // Placeholders name a real message where the operation needs one.
      const args = JSON.parse(
        JSON.stringify(operation.example.args).replaceAll("<message id>", root.id)
      );
      const page = await bus.run(operation.example.name, args);
      expect(page.name).toBe(operation.name);
      expect(page.unit).toBe(operation.unit);
      expect(page.note).toBe(operation.note);
    }
    expect(listing.raw.tool).toBe("bus_query");
    expect(await bus.refused("bus_run_query", { name: "nonsense" })).toContain("name");
    expect(
      await bus.refused("bus_run_query", { name: "history", args: { surprise: true } })
    ).toContain("Invalid args for history");
    expect(await bus.refused("bus_run_query", { name: "history", args: { limit: 201 } })).toContain(
      "Invalid args for history"
    );
  });

  test("a JSONL store refuses every query, and its presets, explicitly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bus-query-jsonl-"));
    dirs.push(dir);
    const bus = await startBus(layerJsonl(join(dir, "ledger.jsonl")).pipe(Layer.provide(platform)));
    for (const [name, args] of [
      ["bus_run_query", { name: "history" }],
      ["bus_query", { query: "SELECT ?s WHERE { ?s bus:id ?o }" }],
      ["bus_queries", {}],
      ["bus_history", {}],
      ["bus_peers", {}],
    ] as const) {
      expect(await bus.refused(name, args)).toBe("Queries need the Fluree ledger.");
    }
  });
});

describe("entries", () => {
  test("history orders by commit, one row per entry, and pages forward and backward at one t", async () => {
    const config = await freshLedger("history");
    const bus = await startBus(flureeStore(config));
    const ts = nextTs();
    const first = message({ from: "claude/a", to: ["codex/b", "#review"], body: "one", ts });
    // The same ts: the commit decides the order, and the later write comes later.
    const second = message({ from: "codex/b", to: ["claude/a"], body: "two", ts });
    const third = message({ from: "claude/c", to: ["*"], body: "three" });
    await bus.append(first, presence("claude/a", "joined", { session: "s" }), second, third);

    const forward = await bus.all("history", { limit: 2 });
    expect(forward.map((page) => page.rows.length)).toEqual([2, 1]);
    expect(ids(rowsOf(forward))).toEqual([first.id, second.id, third.id]);
    expect(new Set(forward.map((page) => page.t)).size).toBe(1);
    expect(forward.map((page) => [page.exhausted, page.complete])).toEqual([
      [false, false],
      [true, true],
    ]);
    const [firstRow] = rowsOf(forward);
    expect(firstRow).toEqual({
      t: expect.any(Number),
      id: first.id,
      ts,
      from: "claude/a",
      to: ["codex/b", "#review"],
      kind: "message",
      body: "one",
      origin: { host: "fixture-host", cwd: "/workspace" },
    });

    const backward = await bus.all("history", { direction: "backward", limit: 2 });
    expect(ids(rowsOf(backward))).toEqual([third.id, second.id, first.id]);

    // A multi-recipient entry matched through two participants is still one row.
    const both = await bus.run("history", { participants: ["#review", "codex/b"] });
    expect(ids(both.rows)).toEqual([first.id, second.id]);
    const withPresence = await bus.run("history", { kinds: ["presence", "message"] });
    expect(withPresence.rows.map((row: Json) => row.kind)).toEqual([
      "message",
      "presence",
      "message",
      "message",
    ]);
    // Saved rows carry the public presence fields, never the session claim.
    expect(withPresence.rows[1].presence).toEqual({
      runtime: "codex",
      status: "joined",
      topics: [],
      note: "public note",
    });
    expect(JSON.stringify(withPresence)).not.toContain('"session"');
    const windowed = await bus.run("history", { fromTs: third.ts, toTs: nextTs() });
    expect(ids(windowed.rows)).toEqual([third.id]);
    expect(windowed.args).toEqual({
      fromTs: third.ts,
      toTs: expect.any(String),
      kinds: ["message"],
      direction: "forward",
      limit: 50,
    });
  });

  test("history and counts order window bounds as instants, however many fractional digits they spell", async () => {
    const bus = await startBus(flureeStore(await freshLedger("window-precision")));
    const at = (time: string) => `2026-11-04T${time}Z`;
    const entry = (time: string) =>
      message({ from: "claude/a", to: ["#w"], body: time, ts: at(time) });
    const early = entry("09:00:00.050");
    const middle = entry("09:00:00.120");
    await bus.append(early, middle, entry("09:00:00.200"));
    const answers: ReadonlyArray<readonly [string, string, ReadonlyArray<Message>]> = [
      // A whole second before a fractional one.
      [at("09:00:00"), at("09:00:00.100"), [early]],
      // One and two fractional digits.
      [at("09:00:00.1"), at("09:00:00.15"), [middle]],
      // Nanoseconds against milliseconds.
      [at("09:00:00.120000000"), at("09:00:00.2"), [middle]],
    ];
    for (const [fromTs, toTs, expected] of answers) {
      const history = await bus.run("history", { fromTs, toTs });
      expect(ids(history.rows)).toEqual(expected.map((entry) => entry.id));
      const counts = await bus.run("counts", {
        groupBy: ["sender"],
        unit: "message",
        fromTs,
        toTs,
      });
      expect(counts.total).toBe(expected.length);
    }
    const refusals: ReadonlyArray<readonly [string, string]> = [
      // Equal instants spelled differently: an empty window.
      [at("09:00:00.000"), at("09:00:00")],
      [at("09:00:00.1"), at("09:00:00.100000000")],
      // True inversions, whole and fractional.
      [at("09:00:01"), at("09:00:00")],
      [at("09:00:00.100"), at("09:00:00")],
      [at("09:00:00.15"), at("09:00:00.1")],
    ];
    for (const [fromTs, toTs] of refusals) {
      expect(
        await bus.refused("bus_run_query", { name: "history", args: { fromTs, toTs } })
      ).toContain("fromTs must be before toTs");
      expect(
        await bus.refused("bus_run_query", {
          name: "counts",
          args: { groupBy: ["sender"], unit: "message", fromTs, toTs },
        })
      ).toContain("fromTs must be before toTs");
    }
  });

  test("entries sharing one commit page by (t, id)", async () => {
    const config = await freshLedger("same-commit");
    const bus = await startBus(flureeStore(config));
    const pair = [
      message({ from: "claude/a", to: ["*"], body: "pair b", id: "pair-b" }),
      message({ from: "claude/a", to: ["*"], body: "pair a", id: "pair-a" }),
    ];
    await insertRaw(config, {
      "@context": toNode(pair[0] as Message, "")["@context"],
      "@graph": pair.map((m) => {
        const { "@context": _, ...node } = toNode(m, encodeJson(m));
        return node;
      }),
    });
    await bus.append(message({ from: "claude/a", to: ["*"], body: "after", id: "pair-c" }));
    const forward = await bus.all("history", { limit: 1 });
    expect(ids(rowsOf(forward))).toEqual(["pair-a", "pair-b", "pair-c"]);
    expect(rowsOf(forward)[0]?.t).toBe(rowsOf(forward)[1]?.t);
    const backward = await bus.all("history", { limit: 1, direction: "backward" });
    expect(ids(rowsOf(backward))).toEqual(["pair-c", "pair-b", "pair-a"]);
  });

  test("damaged entries are counted in place; an exhausted traversal that met one is not complete", async () => {
    const config = await freshLedger("damage");
    const bus = await startBus(flureeStore(config));
    const missing = await damaged(config);
    const junk = await damaged(config, "{not json");
    const clean = message({ from: "claude/a", to: ["#damaged"], body: "clean" });
    await bus.append(clean);
    const pages = await bus.all("history", { limit: 2 });
    expect(pages.map((page) => [page.rows.length, page.damaged, page.damagedTotal])).toEqual([
      [0, 2, 2],
      [1, 0, 2],
    ]);
    // A page of only damaged entries still advances.
    expect(pages[0]?.next).toBeDefined();
    expect(pages[0]?.damagedAt).toHaveLength(2);
    expect(pages.at(-1)).toMatchObject({ exhausted: true, complete: false, damage: "checked" });
    const lookup = await bus.run("messages", { ids: [clean.id, missing, junk, "absent-id"] });
    expect(ids(lookup.rows)).toEqual([clean.id]);
    expect(lookup).toMatchObject({ damaged: 2, notFound: ["absent-id"], complete: false });
    const counted = await bus.run("counts", { groupBy: ["sender"], unit: "message" });
    expect(counted).toMatchObject({
      damage: "not-checked",
      exhausted: true,
      complete: false,
      missingJson: 1,
      total: 3,
    });
  });

  test("an entry with two stored encodings is damaged once, and neither copy is chosen", async () => {
    const config = await freshLedger("two-json");
    const bus = await startBus(flureeStore(config));
    /** One node holding two different encodings of the same entry. */
    const doubled = async (first: Message, second: Message) => {
      const node = toNode(first, encodeJson(first));
      await insertRaw(config, { ...node, "bus:json": [encodeJson(first), encodeJson(second)] });
    };
    const twin = message({ from: "claude/a", to: ["#twin"], body: "twin doubled original" });
    const forged = message({ ...twin, to: [...twin.to], body: "twin doubled forgery" });
    await doubled(twin, forged);
    const clean = message({ from: "claude/b", to: ["#twin"], body: "clean", replyTo: twin.id });
    await bus.append(clean);
    const joined = presence("codex/twin", "joined", { session: "s-1" });
    const leaving = presence("codex/twin", "left", { session: "s-1" });
    const left = new Message({ ...leaving, id: joined.id, ts: joined.ts, to: [...leaving.to] });
    await doubled(joined, left);

    const history = await bus.all("history", { participants: ["#twin"], limit: 1 });
    expect(ids(rowsOf(history))).toEqual([clean.id]);
    expect(history.at(-1)).toMatchObject({ damagedTotal: 1, exhausted: true, complete: false });
    const backward = await bus.all("history", { participants: ["#twin"], direction: "backward" });
    expect(ids(rowsOf(backward))).toEqual([clean.id]);
    expect(backward.at(-1)).toMatchObject({ damagedTotal: 1, complete: false });
    const lookup = await bus.run("messages", { ids: [twin.id, clean.id] });
    expect(ids(lookup.rows)).toEqual([clean.id]);
    expect(lookup).toMatchObject({ damaged: 1, complete: false });
    const tree = await bus.run("thread", { id: clean.id });
    expect(ids(tree.rows)).toEqual([clean.id]);
    expect(tree).toMatchObject({ damaged: 1, members: 2, complete: false });
    let found = await bus.run("search", { text: "twin doubled" });
    for (let attempt = 0; attempt < 50 && found.damaged === 0; attempt++) {
      await Bun.sleep(100);
      found = await bus.run("search", { text: "twin doubled" });
    }
    expect(found).toMatchObject({ rows: [], damaged: 1 });
    const peers = await bus.run("peers", { includeLeft: true });
    expect(peers.rows).toEqual([]);
    expect(peers).toMatchObject({ damaged: 1, complete: false });
  });

  for (const copies of [3, 4]) {
    test(`an entry with ${copies} stored encodings is damaged once at limit 1, never split across pages`, async () => {
      const config = await freshLedger(`copies-${copies}`);
      const bus = await startBus(flureeStore(config));
      /** One node holding `copies` decodable encodings of the same entry. */
      const stored = async (variants: ReadonlyArray<Message>) => {
        const [first] = variants as [Message];
        await insertRaw(config, {
          ...toNode(first, encodeJson(first)),
          "bus:json": variants.map((variant) => encodeJson(variant)),
        });
      };
      const range = Array.from({ length: copies }, (_, k) => k);
      const before = message({ from: "claude/a", to: ["#copies"], body: "copied entry before" });
      await bus.append(before);
      const multi = message({ from: "claude/a", to: ["#copies"], body: "copied entry multi" });
      await stored(
        range.map((k) => message({ ...multi, to: [...multi.to], body: `${multi.body} ${k}` }))
      );
      const after = message({
        from: "claude/b",
        to: ["#copies"],
        body: "copied entry after",
        replyTo: multi.id,
      });
      await bus.append(after);
      const joined = presence("codex/copies", "joined", { session: "s-1" });
      await stored(
        range.map(
          (k) =>
            new Message({
              ...joined,
              to: [...joined.to],
              body: `${joined.body} ${k}`,
            })
        )
      );
      const traversal = (pages: ReadonlyArray<Json>) => ({
        ids: ids(rowsOf(pages)),
        damaged: pages.map((page) => page.damaged).reduce((a: number, b: number) => a + b, 0),
        damagedTotal: pages.at(-1)?.damagedTotal,
        exhausted: pages.at(-1)?.exhausted,
      });
      const once = (order: Array<string>) => ({
        ids: order,
        damaged: 1,
        damagedTotal: 1,
        exhausted: true,
      });

      const args = { participants: ["#copies"], limit: 1 };
      expect(traversal(await bus.all("history", args))).toEqual(once([before.id, after.id]));
      expect(traversal(await bus.all("history", { ...args, direction: "backward" }))).toEqual(
        once([after.id, before.id])
      );
      expect(traversal(await bus.all("thread", { id: after.id, limit: 1 }))).toEqual(
        once([after.id])
      );
      expect(traversal([await bus.run("messages", { ids: [multi.id, before.id] })])).toEqual(
        once([before.id])
      );
      const peers = await bus.run("peers", { includeLeft: true, limit: 1 });
      expect(peers).toMatchObject({ rows: [], damaged: 1, exhausted: true });

      // Search pages by offset over stored copies: the entry's copies are consumed together.
      let found = traversal(await bus.all("search", { text: "copied entry", limit: 1 }));
      for (let attempt = 0; attempt < 50 && found.ids.length + found.damaged < 3; attempt++) {
        await Bun.sleep(100);
        found = traversal(await bus.all("search", { text: "copied entry", limit: 1 }));
      }
      expect([...found.ids].sort()).toEqual([before.id, after.id].sort());
      expect(found).toMatchObject({ damaged: 1, damagedTotal: 1, exhausted: true });
    });
  }

  test("messages keeps the asked order and resolves each id at t", async () => {
    const config = await freshLedger("messages");
    const bus = await startBus(flureeStore(config));
    const a = message({ from: "claude/a", to: ["codex/b"], body: "a" });
    const b = message({ from: "codex/b", to: ["claude/a"], body: "b" });
    await bus.append(a, b);
    const pinned = (await bus.run("messages", { ids: [a.id] })).t;
    const later = message({ from: "claude/a", to: ["codex/b"], body: "later" });
    await bus.append(later);
    const page = await bus.run("messages", { ids: [b.id, later.id, a.id] }, { t: pinned });
    expect(ids(page.rows)).toEqual([b.id, a.id]);
    expect(page).toMatchObject({ notFound: [later.id], complete: true, currentHeadT: pinned + 1 });
    expect(
      await bus.refused("bus_run_query", { name: "messages", args: { ids: [a.id, a.id] } })
    ).toBe("ids has duplicates.");
  });

  test("thread is the reply tree from its nearest reachable top; a missing target cuts it", async () => {
    const config = await freshLedger("thread");
    const bus = await startBus(flureeStore(config));
    const root = message({ from: "claude/a", to: ["#t"], body: "root" });
    const reply = message({ from: "codex/b", to: ["claude/a"], body: "reply", replyTo: root.id });
    const nested = message({
      from: "claude/a",
      to: ["codex/b"],
      body: "nested",
      replyTo: reply.id,
    });
    const sibling = message({
      from: "claude/c",
      to: ["claude/a"],
      body: "sibling",
      replyTo: root.id,
    });
    const unrelated = message({ from: "claude/c", to: ["*"], body: "unrelated" });
    const orphan = message({ from: "claude/c", to: ["*"], body: "orphan", replyTo: "never-sent" });
    const orphanReply = message({ from: "claude/a", to: ["*"], body: "o2", replyTo: orphan.id });
    await bus.append(root, reply, unrelated, nested, sibling, orphan, orphanReply);
    const pages = await bus.all("thread", { id: nested.id, limit: 2 });
    expect(ids(rowsOf(pages))).toEqual([root.id, reply.id, nested.id, sibling.id]);
    expect(pages[0]).toMatchObject({ root: root.id, members: 4, missingReplyTargets: [] });
    expect(pages.at(-1)).toMatchObject({ exhausted: true, complete: true });
    const dangling = await bus.run("thread", { id: orphanReply.id });
    expect(ids(dangling.rows)).toEqual([orphan.id, orphanReply.id]);
    expect(dangling).toMatchObject({ members: 2, missingReplyTargets: ["never-sent"] });
    expect(dangling.root).toBeUndefined();
    const before = dangling.t;
    const late = message({ from: "claude/a", to: ["*"], body: "late" });
    await bus.append(late);
    expect(
      await bus.refused("bus_run_query", { name: "thread", args: { id: late.id }, t: before })
    ).toBe(`Message ${late.id} is not in the ledger at t=${before}.`);
  });

  test("search ranks matches at one t and is never complete", async () => {
    const config = await freshLedger("search");
    const bus = await startBus(flureeStore(config));
    await bus.append(
      message({ from: "claude/a", to: ["*"], body: "Deploying the adapters now" }),
      message({ from: "claude/a", to: ["*"], body: "unrelated", subject: "adapter" }),
      message({ from: "codex/b", to: ["*"], body: "lunch" })
    );
    let page = await bus.run("search", { text: "deploy adapter" });
    for (let attempt = 0; attempt < 50 && page.rows.length < 2; attempt++) {
      await Bun.sleep(100);
      page = await bus.run("search", { text: "deploy adapter" });
    }
    expect(page.rows.map((row: Json) => row.body)).toEqual([
      "Deploying the adapters now",
      "unrelated",
    ]);
    expect(page.rows[0].score).toBeGreaterThan(page.rows[1].score);
    expect(page).toMatchObject({ unit: "ranked match", exhausted: true, complete: false });
    const literal = await bus.run("search", { text: '") (bind ?x' });
    expect(literal.rows).toEqual([]);
    const narrowed = await bus.run("search", { text: "deploy adapter", participants: ["codex/b"] });
    expect(narrowed.rows).toEqual([]);
  });
});

describe("aggregates and peers", () => {
  test("counts groups distinct messages or recipient pairs and never claims completeness", async () => {
    const bus = await startBus(flureeStore(await freshLedger("counts")));
    await bus.append(
      message({
        from: "claude/a",
        to: ["codex/b", "#t"],
        body: "1",
        ts: "2026-11-02T23:59:00.000Z",
      }),
      message({ from: "claude/a", to: ["codex/b"], body: "2", ts: "2026-11-03T00:01:00.000Z" }),
      message({ from: "codex/b", to: ["*"], body: "3", ts: "2026-11-03T08:00:00.000Z" })
    );
    const byDay = await bus.run("counts", { groupBy: ["day", "sender"], unit: "message" });
    expect(byDay.rows).toEqual([
      { sender: "claude/a", day: "2026-11-02", count: 1 },
      { sender: "claude/a", day: "2026-11-03", count: 1 },
      { sender: "codex/b", day: "2026-11-03", count: 1 },
    ]);
    expect(byDay).toMatchObject({
      args: { groupBy: ["sender", "day"], unit: "message", limit: 200 },
      total: 3,
      missingJson: 0,
      damage: "not-checked",
      exhausted: true,
      complete: false,
    });
    const pairs = await bus.run("counts", {
      groupBy: ["recipient"],
      unit: "recipient-pair",
      participants: ["codex/b", "#t"],
    });
    // Participants match senders too: codex/b's broadcast is in scope.
    expect(pairs.rows).toEqual([
      { recipient: "#t", count: 1 },
      { recipient: "*", count: 1 },
      { recipient: "codex/b", count: 2 },
    ]);
    expect(pairs.total).toBe(4);
    const paged = await bus.all("counts", {
      groupBy: ["sender", "day"],
      unit: "message",
      limit: 2,
    });
    expect(rowsOf(paged)).toEqual(byDay.rows);
  });

  test("peers folds the presences visible at t, ignoring those without a session", async () => {
    const bus = await startBus(flureeStore(await freshLedger("peers")));
    await bus.append(
      presence("claude/a", "joined", { session: "sa", topics: ["review"] }),
      presence("codex/legacy", "joined"),
      presence("codex/b", "joined", { session: "sb" })
    );
    const before = (await bus.run("peers", {})).t;
    await bus.append(presence("claude/a", "left", { session: "sa" }));
    const now = await bus.run("peers", {});
    expect(now.rows.map((row: Json) => row.address)).toEqual(["codex/b"]);
    const everyone = await bus.run("peers", { includeLeft: true });
    expect(everyone.rows.map((row: Json) => [row.address, row.status])).toEqual([
      ["claude/a", "left"],
      ["codex/b", "joined"],
    ]);
    // A historical cut decodes the presences of that cut, never today's.
    const then = await bus.run("peers", {}, { t: before });
    expect(then.rows).toEqual([
      {
        address: "claude/a",
        runtime: "codex",
        status: "joined",
        topics: ["review"],
        since: expect.any(String),
        t: expect.any(Number),
        note: "public note",
      },
      expect.objectContaining({ address: "codex/b", status: "joined" }),
    ]);
    expect(then).toMatchObject({ complete: true, currentHeadT: before + 1 });
    const preset = await bus.ok("bus_peers");
    expect(preset.peers.map((peer: Json) => peer.address)).toEqual(["codex/b"]);
  });

  test("director-dm-volume counts distinct direct mail per UTC day beside observed traffic", async () => {
    const bus = await startBus(flureeStore(await freshLedger("director")));
    const director = "lead/d";
    const at = (ts: string, from: string, to: ReadonlyArray<string>, body = "m") =>
      message({ from, to, body, ts });
    // Each branch has a day of its own in the window 2026-12-01 to 2026-12-08 (exclusive).
    await bus.append(
      // Before the window, by a millisecond.
      at("2026-11-30T23:59:59.999Z", director, ["codex/x"]),
      // 12-01, at the window's first instant: one direct message.
      at("2026-12-01T00:00:00.000Z", director, ["codex/x"]),
      // 12-02, several in one day: mixed direct and topic recipients count once each, and the
      // director's topic-only message is concern traffic, not direct mail.
      at("2026-12-02T10:00:00.000Z", director, ["codex/w", "codex/x", "#ops"]),
      at("2026-12-02T11:00:00.000Z", director, ["codex/w"]),
      at("2026-12-02T12:00:00.000Z", director, ["codex/x", "#other"]),
      at("2026-12-02T13:00:00.000Z", director, ["codex/w"]),
      at("2026-12-02T14:00:00.000Z", director, ["#ops"]),
      // 12-03: an outside sender to a concern topic is observed traffic alone.
      at("2026-12-03T10:00:00.000Z", "codex/outsider", ["#ops"]),
      // 12-04: only traffic that reaches an excluded topic, so no row.
      at("2026-12-04T10:00:00.000Z", director, ["codex/w", "#noise"]),
      at("2026-12-04T11:00:00.000Z", "codex/x", ["#noise"]),
      at("2026-12-04T12:00:00.000Z", "codex/outsider", ["#ops", "#noise"]),
      // 12-05: only unrelated traffic, so no row.
      at("2026-12-05T10:00:00.000Z", "codex/outsider", ["codex/other"]),
      at("2026-12-05T11:00:00.000Z", director, ["#elsewhere"]),
      at("2026-12-05T12:00:00.000Z", director, ["codex/other"]),
      // 12-06: nothing. 12-07, at its last millisecond: a cohort address to an unrelated topic.
      at("2026-12-07T23:59:59.999Z", "codex/w", ["#random"]),
      // At toDay's midnight, outside the window.
      at("2026-12-08T00:00:00.000Z", director, ["codex/x"])
    );
    const window = {
      director,
      cohort: ["codex/x", "codex/w"],
      concernTopics: ["#ops"],
      excludeTopics: ["#noise"],
    };
    const page = await bus.run("director-dm-volume", {
      ...window,
      fromDay: "2026-12-01",
      toDay: "2026-12-08",
    });
    expect(page.rows).toEqual([
      { day: "2026-12-01", directorToCohort: 1, observedTraffic: true },
      { day: "2026-12-02", directorToCohort: 4, observedTraffic: true },
      { day: "2026-12-03", directorToCohort: 0, observedTraffic: true },
      { day: "2026-12-07", directorToCohort: 0, observedTraffic: true },
    ]);
    expect(page).toMatchObject({
      totals: { directorToCohort: 5, observedTrafficDays: 4, ratio: 1.25 },
      missingJson: 0,
      damage: "not-checked",
      exhausted: true,
      complete: false,
      args: { cohort: ["codex/w", "codex/x"] },
    });
    expect(page.next).toBeUndefined();
    // A window with no traffic at all has no rows and no ratio.
    const empty = await bus.run("director-dm-volume", {
      ...window,
      fromDay: "2026-12-10",
      toDay: "2026-12-12",
    });
    expect(empty.rows).toEqual([]);
    expect(empty).toMatchObject({
      totals: { directorToCohort: 0, observedTrafficDays: 0, ratio: null },
      missingJson: 0,
      exhausted: true,
    });
    expect(
      await bus.refused("bus_run_query", {
        name: "director-dm-volume",
        args: {
          director: "lead/d",
          cohort: ["lead/d"],
          concernTopics: [],
          fromDay: "2026-11-01",
          toDay: "2026-11-02",
        },
      })
    ).toBe("The director cannot be in the cohort.");
  });

  test("director-dm-volume answers whole or refuses: never trimmed rows or a cursor", async () => {
    const config = await freshLedger("director-oversize");
    const bus = await startBus(flureeStore(config));
    // 50 cohort addresses and 50 topics of 450 characters each, and traffic on all 366 days.
    const long = (prefix: string, i: number) =>
      `${prefix}${"q".repeat(450 - prefix.length - 3)}${String(i).padStart(3, "0")}`;
    const cohort = Array.from({ length: 50 }, (_, i) => long("codex/", i));
    const concernTopics = Array.from({ length: 50 }, (_, i) => long("#", i));
    const first = Date.parse("2027-01-01T12:00:00.000Z");
    const daily = Array.from({ length: 366 }, (_, day) =>
      message({
        from: cohort[0] as string,
        to: ["#daily"],
        body: `day ${day}`,
        ts: new Date(first + day * 86_400_000).toISOString(),
      })
    );
    await insertRaw(config, {
      "@context": toNode(daily[0] as Message, "")["@context"],
      "@graph": daily.map((m) => {
        const { "@context": _, ...node } = toNode(m, encodeJson(m));
        return node;
      }),
    });
    const args = { director: "lead/d", cohort, concernTopics, fromDay: "2027-01-01" };
    expect(
      await bus.refused("bus_run_query", {
        name: "director-dm-volume",
        args: { ...args, toDay: "2028-01-02" },
      })
    ).toBe(
      "The director-dm-volume result exceeds the 65536-byte limit and has no pages; narrow the window, cohort or topics."
    );
    // A narrower window answers whole: every day's row, with totals over exactly those rows.
    const month = await bus.run("director-dm-volume", { ...args, toDay: "2027-01-31" });
    expect(month.rows).toHaveLength(30);
    expect(month.rows[29]).toEqual({
      day: "2027-01-30",
      directorToCohort: 0,
      observedTraffic: true,
    });
    expect(month).toMatchObject({
      totals: { directorToCohort: 0, observedTrafficDays: 30, ratio: 0 },
      exhausted: true,
    });
    expect(month.next).toBeUndefined();
  });
});

describe("snapshots and cursors", () => {
  test("appends between pages and during input resolution leave the snapshot unchanged", async () => {
    const config = await freshLedger("snapshot");
    const late = message({ from: "claude/a", to: ["*"], body: "written mid-resolution" });
    // A gateway that, once armed, appends before its next query, as a concurrent writer would.
    let armed = false;
    const store = flureeStore(config);
    const decorated = Layer.effect(
      QueryGateway,
      Effect.gen(function* () {
        const inner = yield* QueryGateway;
        const ledger = yield* Ledger;
        return QueryGateway.of({
          ...inner,
          jsonld: (t, body) =>
            Effect.suspend(() => {
              if (!armed) return inner.jsonld(t, body);
              armed = false;
              return Effect.andThen(Effect.orDie(ledger.append(late)), inner.jsonld(t, body));
            }),
        });
      })
    ).pipe(Layer.provide(store));
    const bus = await startBus(Layer.merge(store, decorated));
    const seed = Array.from({ length: 5 }, (_, i) =>
      message({ from: "claude/a", to: ["*"], body: `s${i}` })
    );
    await bus.append(...seed);
    const first = await bus.run("history", { limit: 2 });
    await bus.append(message({ from: "claude/a", to: ["*"], body: "between pages" }));
    const rest = [first];
    while (rest.at(-1)?.next !== undefined) {
      rest.push(await bus.run("history", { limit: 2 }, { cursor: rest.at(-1)?.next }));
    }
    expect(ids(rowsOf(rest))).toEqual(ids(seed));
    expect(rest.at(-1)).toMatchObject({ t: first.t, currentHeadT: first.t + 1, complete: true });

    // The pin comes before any input is resolved: an id written meanwhile is not found.
    armed = true;
    const resolved = await bus.run("messages", { ids: [seed[0]?.id, late.id] });
    expect(armed).toBe(false);
    expect(ids(resolved.rows)).toEqual([seed[0]?.id]);
    expect(resolved).toMatchObject({ notFound: [late.id], currentHeadT: resolved.t + 1 });
  });

  test("a ledger replaced while a query runs fails the call instead of answering from it", async () => {
    const config = await freshLedger("replaced");
    // Once armed, the gateway drops the ledger and recreates it under the same alias right after
    // its next query returns, as an operator's replacement would, before the closing pin.
    let armed = false;
    const replace = async () => {
      const drop = await flureeFetch("/v1/fluree/drop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ledger: config.ledger.replace(/:main$/, ""), hard: true }),
      });
      const create = await flureeFetch("/v1/fluree/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ledger: config.ledger }),
      });
      if (!drop.ok || !create.ok) throw new Error("replacing the ledger failed");
      await insertRaw(config, {
        "@id": "urn:agent-bus:message:other",
        "https://rawr.ai/ns/agent-bus#id": "other",
      });
    };
    const after = <A, E, R>(query: Effect.Effect<A, E, R>) =>
      Effect.tap(query, () => {
        if (!armed) return Effect.void;
        armed = false;
        return Effect.promise(replace);
      });
    const store = flureeStore(config);
    const decorated = Layer.effect(
      QueryGateway,
      Effect.map(QueryGateway, (inner) =>
        QueryGateway.of({
          ...inner,
          jsonld: (t, body) => after(inner.jsonld(t, body)),
          sparql: (t, text) => after(inner.sparql(t, text)),
        })
      )
    ).pipe(Layer.provide(store));
    const bus = await startBus(Layer.merge(store, decorated));
    await bus.append(message({ from: "claude/a", to: ["*"], body: "before" }));
    const replaced = "The ledger was replaced while the query ran; run it again.";
    armed = true;
    expect(await bus.refused("bus_run_query", { name: "history", args: {} })).toBe(replaced);
    expect(armed).toBe(false);
    armed = true;
    expect(await bus.refused("bus_query", { query: "SELECT ?id WHERE { ?m bus:id ?id }" })).toBe(
      replaced
    );
    expect(armed).toBe(false);
  });

  test("cursors are bound to their operation, args, page size, snapshot and ledger", async () => {
    const config = await freshLedger("cursor");
    const bus = await startBus(flureeStore(config));
    await bus.append(
      ...Array.from({ length: 4 }, (_, i) =>
        message({ from: "claude/a", to: ["*"], body: `c${i}` })
      )
    );
    const first = await bus.run("history", { limit: 2 });
    const cursor = first.next as string;
    const head = first.t;
    const reject = (name: string, args: Json, extra: Json) =>
      bus.refused("bus_run_query", { name, args, ...extra });
    expect(await reject("search", { text: "c", limit: 2 }, { cursor })).toBe(
      "The cursor belongs to history, not search."
    );
    expect(await reject("history", { limit: 2, direction: "backward" }, { cursor })).toBe(
      "The cursor was issued for different args; resend the same args."
    );
    expect(await reject("history", { limit: 3 }, { cursor })).toBe(
      "The cursor was issued for page size 2, not 3."
    );
    expect(await reject("history", { limit: 2 }, { cursor, t: head - 1 })).toBe(
      `t=${head - 1} differs from the cursor's t=${head}.`
    );
    expect(await reject("history", { limit: 2 }, { t: 0 })).toBe(
      `t must be a commit from 1 to ${head}.`
    );
    expect(await reject("history", { limit: 2 }, { t: head + 1 })).toBe(
      `t must be a commit from 1 to ${head}.`
    );
    const decoded = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString());
    const forge = (value: unknown) =>
      `bq1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
    expect(await reject("history", { limit: 2 }, { cursor: forge({ ...decoded, extra: 1 }) })).toBe(
      "The cursor is not one this bus issued."
    );
    expect(await reject("history", { limit: 2 }, { cursor: "bq1.%%%" })).toBe(
      "The cursor is not one this bus issued."
    );
    expect(await reject("history", { limit: 2 }, { cursor: forge({ ...decoded, cv: 0 }) })).toBe(
      `The cursor is from catalogue version 0; this bus runs version ${CATALOGUE_VERSION}. Start again, passing t=${head} to keep the snapshot.`
    );
    expect(
      await reject("history", { limit: 2 }, { cursor: forge({ ...decoded, t: head + 5 }) })
    ).toBe(`The cursor's t=${head + 5} is ahead of the ledger (t=${head}).`);
    expect(await reject("director-dm-volume", {}, { cursor })).toContain("Invalid args");

    // The same alias, replaced: the old cursor names another incarnation.
    await bus.dispose();
    const dropped = await flureeFetch("/v1/fluree/drop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ledger: config.ledger.replace(/:main$/, ""), hard: true }),
    });
    expect(dropped.ok).toBe(true);
    const replaced = await startBus(flureeStore(config));
    await replaced.append(
      ...Array.from({ length: 4 }, (_, i) =>
        message({ from: "claude/a", to: ["*"], body: `r${i}` })
      )
    );
    expect(
      await replaced.refused("bus_run_query", { name: "history", args: { limit: 2 }, cursor })
    ).toBe("The ledger was replaced since this cursor was issued; start the traversal again.");
  });

  test("pages fit the byte limit by whole rows, resume after the last emitted row, and fail on one oversized row", async () => {
    const config = await freshLedger("bytes");
    const bus = await startBus(flureeStore(config));
    // 39,000 UTF-8 bytes in 13,000 characters: two such rows exceed 65,536 bytes, though not
    // 65,536 characters, so a page holds one of them only when the limit counts bytes.
    const big = (tag: string) =>
      message({ from: "claude/a", to: ["*"], body: `${tag}${"€".repeat(13_000)}` });
    // damaged, valid (fits), damaged, valid (too big to share the page), valid
    const before = await damaged(config);
    const fits = big("a");
    await bus.append(fits);
    const between = await damaged(config);
    const crowded = big("b");
    const last = big("c");
    await bus.append(crowded, last);
    const pageIds = (pages: ReadonlyArray<Json>) => pages.map((page) => ids(page.rows));
    const counts = (pages: ReadonlyArray<Json>) =>
      pages.map((page) => [page.damaged, page.damagedTotal, page.exhausted]);
    const fitsTheLimit = (pages: ReadonlyArray<Json>) => {
      for (const page of pages) {
        expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(65_536);
      }
    };

    // Forward: only the damage before the last emitted row is consumed, and each page resumes
    // right after that row, so every entry appears once, in order.
    const forward = await bus.all("history", { limit: 10 });
    expect(pageIds(forward)).toEqual([[fits.id], [crowded.id], [last.id]]);
    expect(counts(forward)).toEqual([
      [1, 1, false],
      [1, 2, false],
      [0, 2, true],
    ]);
    expect(forward.at(-1)).toMatchObject({ complete: false });
    fitsTheLimit(forward);

    // Backward: the entry damaged between crowded and fits lies after the second page's last
    // emitted row, so that page neither counts nor skips it; the third page counts it.
    const backward = await bus.all("history", { limit: 10, direction: "backward" });
    expect(pageIds(backward)).toEqual([[last.id], [crowded.id], [fits.id]]);
    expect(counts(backward)).toEqual([
      [0, 0, false],
      [0, 0, false],
      [2, 2, true],
    ]);
    expect(backward.at(-1)).toMatchObject({ complete: false });
    fitsTheLimit(backward);

    // Offset paging consumes the same prefix: the ids after the last emitted row are asked again.
    const lookup = { ids: [before, fits.id, between, crowded.id] };
    const byId = await bus.run("messages", lookup);
    expect(ids(byId.rows)).toEqual([fits.id]);
    expect(byId).toMatchObject({ damaged: 1, damagedTotal: 1, exhausted: false });
    const rest = await bus.run("messages", lookup, { cursor: byId.next });
    expect(ids(rest.rows)).toEqual([crowded.id]);
    expect(rest).toMatchObject({ damaged: 1, damagedTotal: 2, exhausted: true, complete: false });

    // One row too large alone fails by name, whether it is 70,000 ASCII bytes or 66,000 UTF-8
    // bytes in 22,000 characters.
    const huge = message({ from: "claude/a", to: ["*"], body: "x".repeat(70_000) });
    const wide = message({ from: "claude/a", to: ["*"], body: "€".repeat(22_000) });
    await bus.append(huge, wide);
    for (const entry of [huge, wide]) {
      expect(
        await bus.refused("bus_run_query", { name: "messages", args: { ids: [entry.id] } })
      ).toMatch(
        new RegExp(`^The entry ${entry.id} \\(t=\\d+\\) alone exceeds the 65536-byte result limit`)
      );
    }
    // The presets keep their historical contract: no byte cap.
    const preset = await bus.ok("bus_history", { limit: 2 });
    expect(preset.messages.map((m: Json) => m.id)).toEqual([huge.id, wide.id]);
  });

  test("a byte cut between entries sharing one commit resumes at the next id, in both directions", async () => {
    const config = await freshLedger("bytes-tie");
    const bus = await startBus(flureeStore(config));
    // Two 39,000-byte entries written in one commit, listed out of id order, then a small one.
    const tie = ["tie-b", "tie-a"].map((name) =>
      message({ from: "claude/a", to: ["*"], body: "€".repeat(13_000), id: name })
    );
    await insertRaw(config, {
      "@context": toNode(tie[0] as Message, "")["@context"],
      "@graph": tie.map((m) => {
        const { "@context": _, ...node } = toNode(m, encodeJson(m));
        return node;
      }),
    });
    await bus.append(message({ from: "claude/a", to: ["*"], body: "after", id: "tie-c" }));
    const forward = await bus.all("history", { limit: 10 });
    expect(forward.map((page) => ids(page.rows))).toEqual([["tie-a"], ["tie-b", "tie-c"]]);
    const [first, second] = rowsOf(forward);
    expect(first?.t).toBe(second?.t);
    const backward = await bus.all("history", { limit: 10, direction: "backward" });
    expect(backward.map((page) => ids(page.rows))).toEqual([["tie-c", "tie-b"], ["tie-a"]]);
    for (const page of [...forward, ...backward]) {
      expect(page).toMatchObject({ damaged: 0, damagedTotal: 0 });
    }
    expect(backward.at(-1)).toMatchObject({ exhausted: true, complete: true });
  });
});

describe("presets", () => {
  test("bus_history is the newest window or ranked text, shown newest last", async () => {
    const bus = await startBus(flureeStore(await freshLedger("presets")));
    await bus.append(
      message({ from: "claude/a", to: ["codex/b"], body: "the ledger adapter is ready" }),
      message({ from: "codex/b", to: ["claude/c"], subject: "ledger", body: "noted" }),
      message({ from: "claude/c", to: ["*"], body: "lunch?" })
    );
    const bodies = async (args: Json) =>
      (await bus.ok("bus_history", args)).messages.map((m: Json) => m.body);
    expect(await bodies({ limit: 10 })).toEqual(["the ledger adapter is ready", "noted", "lunch?"]);
    expect(await bodies({ limit: 2 })).toEqual(["noted", "lunch?"]);
    expect(await bodies({ limit: 1 })).toEqual(["lunch?"]);
    expect(await bodies({ participant: "claude/c", limit: 10 })).toEqual(["noted", "lunch?"]);
    let ranked = await bodies({ query: "ledger", limit: 10 });
    for (let attempt = 0; attempt < 50 && ranked.length < 2; attempt++) {
      await Bun.sleep(100);
      ranked = await bodies({ query: "ledger", limit: 10 });
    }
    expect(ranked).toEqual(["the ledger adapter is ready", "noted"]);
    expect(await bodies({ query: "ledger", participant: "claude/a", limit: 10 })).toEqual([
      "the ledger adapter is ready",
    ]);
  });
});

describe("raw SPARQL", () => {
  test("every predicate toNode writes is readable by raw SPARQL or explicitly excluded", () => {
    // Every optional field set, so each conditional predicate is written.
    const origin = new Origin({ host: "h", cwd: "/c", repo: "/r", branch: "b" });
    const written = [
      new Message({
        id: "m",
        ts: "2026-11-01T00:00:00.000Z",
        from: "claude/a",
        to: ["#t"],
        kind: "message",
        subject: "s",
        body: "b",
        replyTo: "r",
        origin,
      }),
      new Message({
        id: "p",
        ts: "2026-11-01T00:00:00.000Z",
        from: "claude/a",
        to: ["*"],
        kind: "presence",
        body: "joined",
        origin,
        presence: new Presence({
          runtime: "codex",
          status: "joined",
          topics: ["#t"],
          session: "s",
          takeover: "x",
          rejoinOf: "y",
          codexThreadId: "s",
          note: "n",
        }),
      }),
    ].flatMap((entry) =>
      Object.keys(toNode(entry, "{}")).flatMap((key) =>
        key === "@type" ? ["rdf:type"] : key.startsWith("bus:") ? [key] : []
      )
    );
    const excluded = ["bus:json"];
    const unlisted = [...new Set(written)].filter(
      (predicate) => !READABLE_PREDICATES.includes(predicate) && !excluded.includes(predicate)
    );
    expect(unlisted).toEqual([]);
    // And the list names nothing the bus does not write, except f:t, a commit read through RDF-star.
    const stale = READABLE_PREDICATES.filter(
      (predicate) => predicate !== "f:t" && !written.includes(predicate)
    );
    expect(stale).toEqual([]);
    expect(excluded.filter((predicate) => READABLE_PREDICATES.includes(predicate))).toEqual([]);
  });

  const forbidden = [
    ["INSERT DATA { <urn:x> <urn:p> 1 }", "Only SELECT queries are allowed."],
    ["DELETE WHERE { ?s ?p ?o }", "Only SELECT queries are allowed."],
    ["SELECT * WHERE {", "Not valid SPARQL"],
    ["ASK { ?s ?p ?o }", "Only SELECT queries are allowed."],
    ["CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }", "Only SELECT queries are allowed."],
    ["SELECT * FROM <urn:other> WHERE { ?s ?p ?o }", "FROM and FROM NAMED is not allowed"],
    ["SELECT * FROM NAMED <urn:other> WHERE { ?s ?p ?o }", "FROM and FROM NAMED is not allowed"],
    ["SELECT * WHERE { GRAPH <urn:other> { ?s ?p ?o } }", "GRAPH is not allowed"],
    ["SELECT * WHERE { SERVICE <urn:other> { ?s ?p ?o } }", "SERVICE is not allowed"],
    ["SELECT * WHERE { SERVICE SILENT <urn:other> { ?s ?p ?o } }", "SERVICE is not allowed"],
    ["SELECT * WHERE { { SELECT * WHERE { GRAPH ?g { ?s ?p ?o } } } }", "GRAPH is not allowed"],
  ] as const;

  test("reads bindings at one t, with a row sentinel, caller limits, byte cuts and no Fluree text", async () => {
    const config = await freshLedger("raw");
    const bus = await startBus(flureeStore(config));
    const seed = Array.from({ length: 80 }, (_, i) =>
      message({ from: "claude/a", to: ["codex/b", "#raw"], body: `entry ${i} ${"y".repeat(800)}` })
    );
    await bus.append(...seed);
    const counted = await bus.ok("bus_query", {
      query: "SELECT (COUNT(?m) AS ?n) WHERE { ?m a bus:Message } # PRAGMA ignored",
    });
    expect(counted).toMatchObject({
      name: "sparql",
      unit: "binding",
      rows: [{ "?n": 80 }],
      complete: true,
    });
    const commits = await bus.ok("bus_query", {
      query: "SELECT ?id ?t WHERE { << ?m bus:id ?id >> f:t ?t } ORDER BY ?t LIMIT 2",
    });
    expect(commits.rows.map((row: Json) => row["?id"])).toEqual(seed.slice(0, 2).map((m) => m.id));
    expect(commits).toMatchObject({ complete: true, limitReached: true });
    const wide = await bus.ok("bus_query", {
      query: "SELECT ?m WHERE { ?m a bus:Message ; bus:to ?to . ?n a bus:Message }",
    });
    expect(wide).toMatchObject({ complete: false, cut: "rows" });
    expect(wide.rows.length).toBe(500);
    const bulky = await bus.ok("bus_query", {
      query: "SELECT ?body WHERE { ?m bus:body ?body } LIMIT 200",
    });
    expect(bulky).toMatchObject({ complete: false, cut: "bytes" });
    expect(bulky.rows.length).toBeGreaterThan(0);
    const pinned = await bus.ok("bus_query", {
      query: "SELECT (COUNT(?m) AS ?n) WHERE { ?m a bus:Message }",
      t: counted.t - 10,
    });
    expect(pinned).toMatchObject({ t: counted.t - 10, rows: [{ "?n": 70 }] });

    for (const [query, reason] of forbidden) {
      expect(await bus.refused("bus_query", { query })).toContain(reason);
    }
    expect(
      await bus.refused("bus_query", {
        query: "SELECT ?x WHERE { BIND(<urn:no-such-fn>(1) AS ?x) }",
      })
    ).toMatch(/^Fluree request failed \(HTTP \d+\)\.$/);
    expect(
      await bus.refused("bus_query", { query: "SELECT ?s WHERE { ?s bus:id ?o }", t: 0 })
    ).toBe(`t must be a commit from 1 to ${counted.t}.`);

    const oversized = message({ from: "claude/a", to: ["*"], body: "z".repeat(70_000) });
    await bus.append(oversized);
    const at = counted.t + 1;
    expect(
      await bus.refused("bus_query", {
        query: `SELECT ?body WHERE { ?m bus:id "${oversized.id}" ; bus:body ?body }`,
      })
    ).toBe(
      `The first binding (row 1) at t=${at} alone exceeds the result byte limit; select fewer or shorter values.`
    );
  });

  test("raw queries read only the projected predicates, so session claims stay off every query surface", async () => {
    const config = await freshLedger("raw-allowlist");
    const bus = await startBus(flureeStore(config));
    const claim = "session-claim-0f3c";
    await bus.append(
      presence("claude/a", "joined", { session: claim }),
      message({ from: "claude/a", to: ["codex/b"], body: "hello" })
    );
    const json =
      "bus:json is not readable through bus_query; use bus_run_query for decoded entries and damage counts.";
    const variable =
      "A variable predicate is not allowed: name each predicate (bus_queries lists them).";
    const negated =
      "Negated property sets are not allowed: name each predicate (bus_queries lists them).";
    const shapes = [
      ["SELECT * WHERE { ?s ?p ?o }", variable],
      ["SELECT ?j WHERE { ?m bus:json ?j }", json],
      ["SELECT ?j WHERE { ?m <https://rawr.ai/ns/agent-bus#json> ?j }", json],
      ["PREFIX x: <https://rawr.ai/ns/agent-bus#> SELECT ?j WHERE { ?m x:json ?j }", json],
      ["BASE <https://rawr.ai/ns/agent-bus> SELECT ?j WHERE { ?m <#json> ?j }", json],
      ["BASE <https://rawr.ai/ns/> SELECT ?j WHERE { ?m <agent-bus#json> ?j }", json],
      ["SELECT ?j WHERE { ?m bus:replyTo*/bus:json ?j }", json],
      ["SELECT ?j WHERE { ?j ^bus:json ?m }", json],
      ["SELECT ?j WHERE { ?m bus:id|bus:json ?j }", json],
      ["SELECT ?j WHERE { ?m !bus:id ?j }", negated],
      ["SELECT ?j WHERE { ?m !(bus:id|^bus:ts) ?j }", negated],
      ["SELECT ?j WHERE { { SELECT ?j WHERE { ?m bus:json ?j } } }", json],
      ["SELECT ?m WHERE { ?m bus:id ?id OPTIONAL { ?m bus:json ?j } }", json],
      ["SELECT ?m WHERE { ?m bus:id ?id MINUS { ?m bus:json ?j } }", json],
      ["SELECT ?m WHERE { ?m bus:id ?id FILTER EXISTS { ?m ?p ?j } }", variable],
      ["SELECT ?m WHERE { ?m bus:id ?id FILTER NOT EXISTS { ?m bus:json ?j } }", json],
      ["SELECT ?t WHERE { << ?m bus:json ?j >> f:t ?t }", json],
      ["SELECT ?t WHERE { << ?m ?p ?j >> f:t ?t }", variable],
      ["SELECT ?m WHERE { VALUES ?p { bus:json } ?m ?p ?j }", json],
      ["SELECT ?q WHERE { ?m a bus:Message . BIND(TRIPLE(?m, bus:json, ?j) AS ?q) }", json],
      ["SELECT ?m WHERE { ?m bus:id ?id FILTER(isIRI(bus:json)) }", json],
      ["SELECT ?o WHERE { VALUES ?o { <https://rawr.ai/ns/agent-bus#json> } }", json],
      [
        "SELECT ?m WHERE { ?m bus:id ?id FILTER(?id != bus:session) }",
        "<https://rawr.ai/ns/agent-bus#session> is not readable through bus_query",
      ],
      [
        "SELECT ?m WHERE { ?m bus:id ?id ; <urn:example:session> ?s }",
        "<urn:example:session> is not readable through bus_query",
      ],
    ] as const;
    for (const [query, reason] of shapes) {
      expect([query, await bus.refused("bus_query", { query })]).toEqual([
        query,
        expect.stringContaining(reason),
      ]);
    }
    // The entry classes are bus: terms a query may name.
    const typed = await bus.ok("bus_query", {
      query: "SELECT ?m WHERE { VALUES ?c { bus:Message bus:Presence } ?m a ?c }",
    });
    expect(typed.rows.length).toBeGreaterThan(0);
    // Every readable predicate, read whole: the claim is in bus:json alone, so it never appears.
    const listing = await bus.ok("bus_queries");
    const named = (listing.raw.predicates as Array<string>).filter((name) => name !== "f:t");
    const everything = await bus.ok("bus_query", {
      query: `SELECT ?s ?o WHERE { ?s ${named.join("|")} ?o }`,
    });
    expect(everything.complete).toBe(true);
    expect(everything.rows.length).toBeGreaterThan(10);
    expect(JSON.stringify(everything)).not.toContain(claim);
    // The saved operations project too (rule 13).
    for (const [name, args] of [
      ["history", { kinds: ["message", "presence"] }],
      ["peers", { includeLeft: true }],
      ["search", { text: "hello" }],
    ] as const) {
      expect(JSON.stringify(await bus.run(name, args))).not.toContain(claim);
    }
  });

  test("the server's own route refuses or empties what the parser refuses, without moving head", async () => {
    const config = await freshLedger("raw-bypass");
    const bus = await startBus(flureeStore(config));
    await bus.append(message({ from: "claude/a", to: ["*"], body: "seed" }));
    const head = (await bus.ok("bus_query", { query: "SELECT ?s WHERE { ?s bus:id ?id }" })).t;
    const send = (query: string, type = "application/sparql-query") =>
      flureeFetch(`/v1/fluree/query/${encodeURIComponent(`${config.ledger}@t:${head}`)}`, {
        method: "POST",
        headers: { "content-type": type, accept: "application/vnd.fluree.agent+json" },
        body: query,
      });
    const bypass = [
      'PREFIX bus: <https://rawr.ai/ns/agent-bus#> INSERT DATA { <urn:x> bus:body "x" }',
      "SELECT * FROM <other:main> WHERE { ?s ?p ?o }",
      "SELECT * FROM NAMED <other:main> WHERE { ?s ?p ?o }",
      "SELECT * WHERE { SERVICE <fluree:ledger:other:main> { ?s ?p ?o } }",
    ];
    for (const query of bypass) expect((await send(query)).status).toBe(400);
    expect((await send(bypass[0] as string, "application/sparql-update")).status).toBe(400);
    for (const query of [
      "SELECT * WHERE { SERVICE SILENT <fluree:ledger:other:main> { ?s ?p ?o } }",
      "SELECT * WHERE { GRAPH <other:main> { ?s ?p ?o } }",
    ]) {
      const response = await send(query);
      expect(response.status).toBe(200);
      expect(((await response.json()) as Json).rows).toEqual([]);
    }
    const after = await bus.ok("bus_queries");
    expect(after.headT).toBe(head);
  });
});

describe("transport bounds", () => {
  const DEADLINE = "The query did not finish within 10 seconds; narrow it.";
  const RAW = "SELECT ?id WHERE { ?m bus:id ?id }";
  const RAW_BODY = "SELECT ?body WHERE { ?m bus:body ?body }";

  /** A bus whose Fluree requests cross a controlled boundary, with one entry written. */
  const throughBoundary = async (name: string, options: { readonly testClock?: boolean } = {}) => {
    const config = await freshLedger(name);
    const edge = boundary(config.url);
    disposers.push(async () => edge.stop());
    const bus = await startBus(flureeStore({ ...config, url: edge.url }), options);
    await bus.append(message({ from: "claude/a", to: ["*"], body: "seed" }));
    const history = () => bus.call("bus_run_query", { name: "history", args: { limit: 5 } });
    const raw = () => bus.call("bus_query", { query: RAW });
    /** The error text of a call that must fail. */
    const failure = async (pending: Promise<CallToolResult>) => {
      const result = await pending;
      expect(result.isError).toBe(true);
      return bus.text(result);
    };
    /** Holds `n` queries at once, which only a pool with `n` free permits allows, then lets the deadline end them. */
    const poolHolds = async (n: number) => {
      const held = Array.from({ length: n }, () => edge.next(stallBeforeHeaders));
      const calls = Array.from({ length: n }, history);
      await Promise.all(held);
      await bus.adjust("10 seconds");
      for (const call of calls) expect(await failure(call)).toBe(DEADLINE);
    };
    return { bus, edge, history, raw, failure, poolHolds };
  };

  test("a query stalled before headers or mid-body fails at the 10 s deadline, ends its request and returns its permit", async () => {
    const { bus, edge, history, raw, failure, poolHolds } = await throughBoundary("deadline", {
      testClock: true,
    });
    // Four permits, four held requests: two never send headers, two stop mid-body.
    const held = [
      edge.next(stallBeforeHeaders),
      edge.next(stallBeforeHeaders),
      edge.next(stallMidBody),
      edge.next(stallMidBody),
    ];
    const calls = [history(), raw(), history(), raw()];
    let settled = 0;
    for (const call of calls) call.then(() => (settled += 1));
    const requests = await Promise.all(held);
    await bus.adjust("9999 millis");
    await Bun.sleep(50);
    expect(settled).toBe(0);
    expect(requests.map((request) => request.isFinalised())).toEqual([false, false, false, false]);
    await bus.adjust("1 millis");
    for (const call of calls) expect(await failure(call)).toBe(DEADLINE);
    await Promise.all(requests.map((request) => request.finalised));
    // Every permit came back: four new queries are held at once.
    await poolHolds(4);
  });

  test("an MCP cancel ends its query and frees its permit at once; a lost connection's query ends by the deadline", async () => {
    const { bus, edge, history, raw, failure, poolHolds } = await throughBoundary("cancel", {
      testClock: true,
    });
    const abort = new AbortController();
    const heldCancelled = edge.next(stallBeforeHeaders);
    const cancelled = bus.client.callTool(
      { name: "bus_run_query", arguments: { name: "history", args: { limit: 5 } } },
      undefined,
      { signal: abort.signal }
    );
    const cancelledRequest = await heldCancelled;
    const lost = await bus.connect();
    const heldLost = edge.next(stallBeforeHeaders);
    const lostCall = lost.callTool({ name: "bus_query", arguments: { query: RAW } });
    const lostRequest = await heldLost;
    const heldOthers = [edge.next(stallMidBody), edge.next(stallMidBody)];
    const others = [history(), raw()];
    await Promise.all(heldOthers);

    // The pool is full. A cancel sent over MCP ends the request without the clock moving...
    abort.abort();
    await expect(cancelled).rejects.toThrow();
    await cancelledRequest.finalised;
    // ...and frees its permit: one more query is held while the other three still hold theirs.
    const heldNext = edge.next(stallBeforeHeaders);
    const nextCall = history();
    await heldNext;

    // A dropped connection sends no cancel; for it, only the deadline is promised.
    await lost.close();
    await expect(lostCall).rejects.toThrow();
    await bus.adjust("10 seconds");
    await lostRequest.finalised;
    for (const call of [...others, nextCall]) expect(await failure(call)).toBe(DEADLINE);
    await poolHolds(4);
  });

  test("responses are read up to their cap in chunks; one byte more is refused at once and its body cancelled", async () => {
    const { bus, edge, history, raw, failure } = await throughBoundary("response-caps");
    const agentJson = (t: number) => ({
      schema: { "?id": "xsd:string" },
      rows: [{ "?id": "x" }],
      t,
    });
    for (const [cap, call, body] of [
      [262_144, raw, agentJson],
      [33_554_432, history, () => []],
    ] as const) {
      const exact = edge.next((t, ended) => chunked(padded(body(t), cap))(t, ended));
      const answered = await call();
      expect(answered.isError).toBeFalsy();
      await exact;
      // Over by one byte, with the stream left open: only the bus's own count can end it.
      const over = edge.next((t, ended) =>
        chunked(padded(body(t), cap + 1), { open: true })(t, ended)
      );
      expect(await failure(call())).toBe(
        `Fluree's response exceeded ${cap} bytes; narrow the query.`
      );
      await (await over).finalised;
    }
    expect((await bus.ok("bus_query", { query: RAW })).rows).toHaveLength(1);
  });

  test("a raw first row too large for the envelope is refused even when Fluree reports no cut, counting UTF-8 bytes", async () => {
    const { bus, edge, failure } = await throughBoundary("raw-first-row");
    const bindings = (t: number, values: ReadonlyArray<string>) =>
      JSON.stringify({
        schema: { "?body": "xsd:string" },
        rows: values.map((value) => ({ "?body": value })),
        t,
      });
    // 70,000 ASCII bytes, and 66,000 UTF-8 bytes in 22,000 characters: neither fits 65,536.
    for (const value of ["z".repeat(70_000), "€".repeat(22_000)]) {
      const held = edge.next((t, ended) => chunked(bindings(t, [value]))(t, ended));
      const refusal = await failure(bus.call("bus_query", { query: RAW_BODY }));
      expect(refusal).toBe(
        `The first binding (row 1) at t=${(await held).t} alone exceeds the result byte limit; select fewer or shorter values.`
      );
    }
    // Two rows of 36,001 bytes in 12,001 characters each: one is kept, cut by bytes.
    const values = ["€".repeat(12_000) + "1", "€".repeat(12_000) + "2"];
    const held = edge.next((t, ended) => chunked(bindings(t, values))(t, ended));
    const result = await bus.ok("bus_query", { query: RAW_BODY });
    await held;
    expect(result.rows).toEqual([{ "?body": values[0] }]);
    expect(result).toMatchObject({ complete: false, cut: "bytes" });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65_536);
  });
});
