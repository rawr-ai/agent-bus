// A pinned investigation read to its end through the viewer, against the agent path: the
// official MCP SDK following bus_run_query at the reference's own page size and at 7. Both
// share the bus's provider, so agreement is equivalence, not correctness.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { Message, MessageJson, Origin } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import * as Serve from "../src/serve.ts";
import { createViewer } from "../viewer/server/host.ts";
import type { ViewerClient } from "../viewer/shared/client-types.ts";
import { checkReference, type InvestigationReference } from "../viewer/shared/public.ts";
import {
  createPinnedTraversal,
  type TraversalSnapshot,
} from "../viewer/src/features/pinned/traversal.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";

type Row = Record<string, unknown> & { readonly t: number; readonly id: string };
type Envelope = {
  readonly name: string;
  readonly catalogueVersion: number;
  readonly ledger: string;
  readonly t: number;
  readonly args: Record<string, unknown>;
  readonly rows: ReadonlyArray<Row>;
  readonly exhausted: boolean;
  readonly complete: boolean;
  readonly damagedTotal: number;
  readonly next?: string;
};

const dir = mkdtempSync(join(tmpdir(), "agent-bus-viewer-equivalence-"));
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const config = await freshLedger("viewer-equivalence");
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const busPort = Number(probe.url.port);
probe.stop(true);
const bus = ManagedRuntime.make(
  Serve.layerHttp({ port: busPort, version: "test" }).pipe(
    Layer.provideMerge(
      Bus.layer("test-installation").pipe(
        Layer.provideMerge(layerFluree(config).pipe(Layer.provide(platform))),
        Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(platform)
      )
    )
  )
);
const sdk = new Client({ name: "viewer-equivalence-test", version: "1" });
const viewer = createViewer({ port: 0, busPort, assets: new Map() });
const client: ViewerClient = createORPCClient(new RPCLink({ url: new URL("/rpc", viewer.url) }));

const FROM = "2026-11-01T10:00:00.000Z";
const TO = "2026-11-01T11:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(FROM) + minutes * 60_000).toISOString();
const message = (id: string, ts: string, body = id, to = ["#window"]) =>
  new Message({
    id,
    ts,
    from: "claude/a",
    to,
    kind: "message",
    body,
    origin: new Origin({ host: "fixture-host", cwd: "/workspace" }),
  });
// 39,000 UTF-8 bytes: no two share a 65,536-byte page, so the bus cuts pages by bytes.
const bulky = (id: string, ts: string) => message(id, ts, `${id}${"€".repeat(13_000)}`);
const append = (...messages: ReadonlyArray<Message>) =>
  bus.runPromise(Effect.flatMap(Ledger, (ledger) => Effect.forEach(messages, ledger.append)));
/** Entries written in one commit, listed out of id order. */
const oneCommit = (...messages: ReadonlyArray<Message>) =>
  insertRaw(config, {
    "@context": toNode(messages[0] as Message, "")["@context"],
    "@graph": messages.map((m) => {
      const { "@context": _, ...node } = toNode(m, Schema.encodeSync(MessageJson)(m));
      return node;
    }),
  });

/** The seeded expectation: ids inside [FROM, TO), in commit order then id within a commit. */
const expected = [
  "at-from",
  "small-1",
  "bulky-1",
  "bulky-2",
  "tie-a",
  "tie-b",
  "small-2",
  "bulky-3",
  "small-3",
];

beforeAll(async () => {
  await bus.runPromise(Effect.void);
  await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${busPort}/mcp`)));
  await append(
    message("before-from", "2026-11-01T09:59:59.999Z"),
    message("at-from", FROM),
    message("small-1", at(1)),
    message("elsewhere", at(2), "elsewhere", ["#other"]),
    bulky("bulky-1", at(3)),
    bulky("bulky-2", at(4))
  );
  await oneCommit(message("tie-b", at(5)), message("tie-a", at(5)));
  await append(
    message("small-2", at(6)),
    bulky("bulky-3", at(7)),
    message("small-3", "2026-11-01T10:59:59.999Z"),
    message("at-to", TO)
  );
});
afterAll(async () => {
  await viewer.close();
  await sdk.close();
  await bus.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const run = async (args: Record<string, unknown>) => {
  const result = (await sdk.callTool({ name: "bus_run_query", arguments: args })) as CallToolResult;
  if (result.isError) throw new Error("bus_run_query refused");
  return result.structuredContent as Envelope;
};
/** The agent path: every page of the reference's criteria at its commit, at one page size. */
const agent = async (reference: InvestigationReference, limit: number) => {
  const args = { ...reference.criteria, limit };
  const pages = [await run({ name: "history", args, t: reference.t })];
  while (pages.at(-1)?.next !== undefined) {
    pages.push(await run({ name: "history", args, t: reference.t, cursor: pages.at(-1)?.next }));
  }
  return pages;
};
/** The viewer path: one traversal through the viewer's host, read to its end. */
const traverse = (reference: InvestigationReference) =>
  new Promise<TraversalSnapshot>((resolve) => {
    const traversal = createPinnedTraversal({
      reference,
      readPage: (input, signal) => client.investigationPage(input, { signal }),
    });
    traversal.subscribe(() => {
      const snapshot = traversal.getSnapshot();
      if (snapshot.phase.kind === "ended" || snapshot.phase.kind === "too-large") {
        traversal.dispose();
        resolve(snapshot);
      }
    });
    traversal.start();
  });
const PUBLIC = ["id", "ts", "from", "to", "kind", "body", "subject", "replyTo", "origin"];
const material = (row: Row) => ({
  t: row.t,
  message: Object.fromEntries(PUBLIC.filter((key) => key in row).map((key) => [key, row[key]])),
});

/** The agent's own call and the reference its echo makes, as a handoff would carry it. */
const referenceFor = async (args: Record<string, unknown>) => {
  const echoed = await run({ name: "history", args });
  const { limit: _, ...criteria } = echoed.args;
  const checked = checkReference({
    name: echoed.name,
    catalogueVersion: echoed.catalogueVersion,
    ledger: echoed.ledger,
    t: echoed.t,
    criteria,
  });
  if (!("reference" in checked)) throw new Error("reference refused");
  return { echoed, reference: checked.reference };
};

test("a reference made at the default page size reads the same ordered evidence at 200, 50 and 7", async () => {
  // No page size in the agent's call, so its echo carries the default 50.
  const { echoed, reference } = await referenceFor({
    participants: ["#window"],
    fromTs: FROM,
    toTs: TO,
  });
  expect(echoed.args.limit).toBe(50);

  const viewed = await traverse(reference);
  expect(viewed.phase).toEqual({ kind: "ended", end: { kind: "complete" } });
  // Byte cuts made it a multi-page reading even at page size 200.
  expect(viewed.calls).toBeGreaterThanOrEqual(3);
  const entries = viewed.progress.entries;
  expect(entries.map((entry) => entry.message.id)).toEqual(expected);
  const [tieA, tieB] = entries.filter((entry) => entry.message.id.startsWith("tie-"));
  expect(tieA?.t).toBe(tieB?.t);

  for (const limit of [50, 7]) {
    const pages = await agent(reference, limit);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect<unknown>(entries).toEqual(pages.flatMap((page) => page.rows.map(material)));
    const final = pages.at(-1);
    expect([final?.exhausted, final?.complete, final?.damagedTotal]).toEqual([true, true, 0]);
  }
});

test("200 matching entries read to completion, and 201 stop at the bound without the cut page's claims", async () => {
  const filler = (topic: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      message(`${topic.slice(1)}-${String(index).padStart(3, "0")}`, at(30), "filler", [topic])
    );
  await oneCommit(...filler("#two-hundred", 200));
  await oneCommit(...filler("#two-hundred-one", 201));
  const exact = await traverse((await referenceFor({ participants: ["#two-hundred"] })).reference);
  // One call: the bus reads one past the page size to know 200 is the whole window.
  expect([exact.phase, exact.progress.entries.length, exact.calls]).toEqual([
    { kind: "ended", end: { kind: "complete" } },
    200,
    1,
  ]);
  const over = await referenceFor({ participants: ["#two-hundred-one"] });
  const bounded = await traverse(over.reference);
  expect([bounded.phase, bounded.progress.entries.length]).toEqual([
    { kind: "ended", end: { kind: "bound" } },
    200,
  ]);
  // The bound keeps the bus's first 200, in its order.
  const agentRows = (await agent(over.reference, 200)).flatMap((page) => page.rows);
  expect(agentRows).toHaveLength(201);
  expect(bounded.progress.entries.map((entry) => entry.message.id)).toEqual(
    agentRows.slice(0, 200).map((row) => row.id)
  );
});

test("bus damage stops the reading as damaged, apart from the viewer's own omissions", async () => {
  const broken = message("damaged-entry", at(40), "damaged", ["#damaged"]);
  const { "bus:json": _, ...node } = toNode(broken, "");
  await append(message("damaged-before", at(39), "before", ["#damaged"]));
  await insertRaw(config, node);
  await append(message("damaged-after", at(41), "after", ["#damaged"]));
  const { reference } = await referenceFor({ participants: ["#damaged"] });
  const viewed = await traverse(reference);
  expect(viewed.phase).toEqual({ kind: "ended", end: { kind: "damaged" } });
  expect([viewed.progress.damaged, viewed.progress.omitted]).toEqual([1, 0]);
  const [final] = await agent(reference, 200);
  expect([final?.complete, final?.damagedTotal]).toEqual([false, 1]);
  expect<unknown>(viewed.progress.entries).toEqual(final?.rows.map(material));
});
