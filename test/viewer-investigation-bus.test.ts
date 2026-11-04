// Investigation pages against the bus's own endpoint on a throwaway ledger. The official MCP SDK
// is the independent caller: its echoed envelope is the reference a handoff would carry.
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
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import * as Serve from "../src/serve.ts";
import { createViewer } from "../viewer/server/host.ts";
import { ObservationReader, readerLayer } from "../viewer/server/reader.ts";
import type { ViewerClient } from "../viewer/shared/client-types.ts";
import { checkReference, type InvestigationReference } from "../viewer/shared/public.ts";
import { freshLedger } from "./fluree-server.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-viewer-investigation-"));
const cwd = mkdtempSync(join(tmpdir(), "agent-bus-viewer-investigation-cwd-"));
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const store = layerFluree(await freshLedger("viewer-investigation")).pipe(Layer.provide(platform));
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
const marker = "private-session-never-observed";
const sdk = new Client({ name: "viewer-investigation-test", version: "1" });

type Envelope = {
  readonly name: string;
  readonly catalogueVersion: number;
  readonly ledger: string;
  readonly t: number;
  readonly args: Record<string, unknown>;
  readonly rows: ReadonlyArray<{ readonly t: number; readonly id: string }>;
  readonly next?: string;
};
const run = async (args: Record<string, unknown>) => {
  const result = (await sdk.callTool({ name: "bus_run_query", arguments: args })) as CallToolResult;
  if (result.isError) throw new Error("bus_run_query refused");
  return result.structuredContent as Envelope;
};
/** What a handoff carries: the echoed envelope, its arguments without the page size. */
const referenceOf = (envelope: Envelope): unknown => {
  const { limit: _, ...criteria } = envelope.args;
  return {
    name: envelope.name,
    catalogueVersion: envelope.catalogueVersion,
    ledger: envelope.ledger,
    t: envelope.t,
    criteria,
  };
};
const accepted = (value: unknown) => {
  const checked = checkReference(value);
  if (!("reference" in checked)) throw new Error(`reference refused: ${checked.refused}`);
  return checked.reference;
};
const page = (reference: InvestigationReference, cursor?: string) =>
  reader.runPromise(
    Effect.flatMap(ObservationReader, (r) =>
      r.investigationPage({ reference, ...(cursor === undefined ? {} : { cursor }) })
    )
  );
const failure = (reference: InvestigationReference, cursor?: string) =>
  reader.runPromise(
    Effect.flatMap(ObservationReader, (r) =>
      Effect.flip(r.investigationPage({ reference, ...(cursor === undefined ? {} : { cursor }) }))
    )
  );
const pairs = (rows: ReadonlyArray<{ readonly t: number; readonly id: string }>) =>
  rows.map(({ t, id }) => [t, id]);

beforeAll(async () => {
  await bus.runPromise(
    Effect.gen(function* () {
      const b = yield* Bus.Bus;
      yield* b.join({ address: "claude/lead", runtime: "claude", session: marker, cwd });
      yield* b.join({ address: "codex/reviewer", runtime: "codex", session: `${marker}-2`, cwd });
      for (const [index, body] of ["First", "Second", "Third"].entries()) {
        yield* b.publish({
          from: index % 2 === 0 ? "claude/lead" : "codex/reviewer",
          session: index % 2 === 0 ? marker : `${marker}-2`,
          to: ["#review"],
          body,
        });
      }
      yield* b.publish({ from: "claude/lead", session: marker, to: ["*"], body: "Unrelated" });
      // 39,000 UTF-8 bytes each: no two share a 65,536-byte page, so the bus cuts by bytes.
      for (const tag of ["a", "b", "c"]) {
        yield* b.publish({
          from: "codex/reviewer",
          session: `${marker}-2`,
          to: ["#bulk"],
          body: `${tag}${"€".repeat(13_000)}`,
        });
      }
    })
  );
  await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${busPort}/mcp`)));
});
afterAll(async () => {
  await sdk.close();
  await reader.dispose();
  await bus.dispose();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("the SDK's echoed envelope is a reference, and its page reads the same rows at the same commit", async () => {
  // Unsorted and without defaults: the echo, not the call, is what the reference carries.
  const echoed = await run({
    name: "history",
    args: { participants: ["#review", "#ops"], limit: 50 },
  });
  expect(echoed.args).toEqual({
    participants: ["#ops", "#review"],
    kinds: ["message"],
    direction: "forward",
    limit: 50,
  });
  const reference = accepted(referenceOf(echoed));
  const investigation = await page(reference);
  expect(investigation.entries.map(({ t, message }) => [t, message.id])).toEqual(
    pairs(echoed.rows)
  );
  expect(investigation.entries.map((entry) => entry.message.body)).toEqual([
    "First",
    "Second",
    "Third",
  ]);
  expect([investigation.exhausted, investigation.complete, investigation.omitted]).toEqual([
    true,
    true,
    0,
  ]);
  expect(JSON.stringify(investigation)).not.toContain(marker);

  // The same page through the viewer's own host and RPC client.
  const viewer = createViewer({ port: 0, busPort, assets: new Map() });
  try {
    const client: ViewerClient = createORPCClient(
      new RPCLink({ url: new URL("/rpc", viewer.url) })
    );
    expect(await client.investigationPage({ reference })).toEqual(investigation);
  } finally {
    await viewer.close();
  }
});

test("a continuation the bus cut by bytes is accepted on the next page, and the ids continue", async () => {
  const first = await run({ name: "history", args: { participants: ["#bulk"], limit: 50 } });
  expect(first.rows).toHaveLength(1);
  expect(first.next).toBeString();
  const second = await run({
    name: "history",
    args: { participants: ["#bulk"], limit: 50 },
    t: first.t,
    cursor: first.next,
  });
  const reference = accepted(referenceOf(first));
  const one = await page(reference);
  expect(one.entries.map(({ t, message }) => [t, message.id])).toEqual(pairs(first.rows));
  expect(one.exhausted).toBe(false);
  expect(one.next).toBeString();
  const two = await page(reference, one.next);
  // The investigation reads 200 per page and the SDK 50, but both are cut by bytes to one row.
  expect(two.entries.map(({ t, message }) => [t, message.id])).toEqual(pairs(second.rows));
});

test("a reference the bus cannot read at its commit, ledger or cursor is never joined", async () => {
  const echoed = await run({ name: "history", args: { participants: ["#bulk"], limit: 50 } });
  const reference = accepted(referenceOf(echoed));
  const head = reference.t;

  // Past the bus's head: the bus refuses, and the refusal is a failed page, not evidence.
  expect((await failure({ ...reference, t: head + 1_000 }))._tag).toBe("BusError");

  // Another incarnation's ledger: the bus answers for its own, which the identity check refuses.
  const foreign = await failure({ ...reference, ledger: "other-incarnation" });
  expect(foreign).toMatchObject({ _tag: "IdentityMismatch", field: "ledger" });

  // A continuation is bound to the criteria it was issued for, and to its own bytes. The
  // viewer's own page-size-200 continuation first succeeds unchanged, so each refusal below
  // comes from the one thing varied, not from a page-size mismatch.
  const next = (await page(reference)).next;
  if (next === undefined) throw new Error("the bulk reference has a second page");
  expect((await page(reference, next)).entries).toHaveLength(1);
  const changed = { ...reference, criteria: { ...reference.criteria, participants: ["#review"] } };
  expect(checkReference(changed)).toEqual({ reference: changed });
  expect((await failure(changed, next))._tag).toBe("BusError");
  const middle = Math.floor(next.length / 2);
  const tampered = `${next.slice(0, middle)}${next[middle] === "A" ? "B" : "A"}${next.slice(middle + 1)}`;
  expect(tampered).not.toBe(next);
  expect((await failure(reference, tampered))._tag).toBe("BusError");
});
