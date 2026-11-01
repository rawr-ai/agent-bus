// Exercise the HTTP handler with a store that would expose a sentinel if touched.
// A second guard in each Ledger implementation is tested separately.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isInitializeRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { LedgerError } from "../src/domain.ts";
import { Ledger } from "../src/Ledger.ts";
import * as Serve from "../src/serve.ts";

// Independent literal oracle: a changed refusal cannot silently update the expectation.
const refusal =
  "Public SPARQL queries are disabled while the public-data boundary is being qualified. Use bus_history or bus_peers.";
const marker = "synthetic-private-query-sentinel";
const accesses: Array<string> = [];
const unexpected = (operation: string) =>
  Effect.suspend(() => {
    accesses.push(operation);
    return Effect.fail(new LedgerError({ message: marker }));
  });
const poisoned = Layer.succeed(
  Ledger,
  Ledger.of({
    instance: "query-refusal-fixture",
    append: () => unexpected("append"),
    read: () => unexpected("read"),
    end: unexpected("end"),
    presence: unexpected("presence"),
    search: () => unexpected("search"),
    select: () => unexpected("select"),
    changes: Stream.fromEffect(unexpected("changes").pipe(Effect.orDie)),
  })
);
const dir = mkdtempSync(join(tmpdir(), "agent-bus-public-query-"));
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = Number(probe.url.port);
probe.stop(true);
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const server = ManagedRuntime.make(
  Serve.layerHttp({ port, version: "test" }).pipe(
    Layer.provide(
      Bus.layer.pipe(
        Layer.provide(poisoned),
        Layer.provide(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
      )
    )
  )
);
beforeAll(() => server.runPromise(Effect.void));
afterAll(async () => {
  await server.dispose();
  rmSync(dir, { recursive: true, force: true });
});

class Offering extends StreamableHTTPClientTransport {
  constructor(private readonly offered: string) {
    super(url);
  }
  override send(
    message: JSONRPCMessage,
    options?: Parameters<StreamableHTTPClientTransport["send"]>[1]
  ) {
    return super.send(
      isInitializeRequest(message)
        ? { ...message, params: { ...message.params, protocolVersion: this.offered } }
        : message,
      options
    );
  }
}

test.each([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
])("public queries over %s refuse every schema-valid input before any store operation", async (version) => {
  const client = new Client({ name: "query-refusal", version: "test" });
  try {
    const transport = new Offering(version);
    await client.connect(transport);
    expect(transport.protocolVersion).toBe(version);
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === "bus_query");
    expect(tool?.description).toContain(refusal);
    expect(tool?.inputSchema.required).toEqual(["query"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["query", "t"]);
    expect(tool?.inputSchema.properties).toMatchObject({
      query: { type: "string" },
      t: { type: "integer" },
    });
    // Includes public and internal predicates, aggregates, federation, mutation,
    // parser errors and strings beyond the retired parser's length/byte budget.
    const queries = [
      "SELECT ?body WHERE { ?m a bus:Message ; bus:body ?body }",
      `SELECT ?json WHERE { ?m bus:json ?json } # ${marker}`,
      "SELECT (?value AS ?body) WHERE { ?m bus:json ?value }",
      "SELECT (COUNT(?m) AS ?n) WHERE { ?m a bus:Message FILTER EXISTS { ?p bus:json ?private FILTER EXISTS { ?p bus:body ?body } } }",
      "# PRAGMA reasoning:none\nSELECT (COUNT(?body) AS ?n) WHERE { ?m a bus:Presence ; bus:body ?body }",
      "SELECT * FROM <other:main> WHERE { SERVICE <https://example.invalid> { ?s ?p ?o } }",
      "DELETE WHERE { ?s ?p ?o }",
      "",
      `not SPARQL: ${marker}\u0000`,
      marker.repeat(4096),
      "\u00e9".repeat(65_536),
    ];
    for (const query of queries) {
      for (const t of [undefined, 1, 2, 0, -1, Number.MAX_SAFE_INTEGER]) {
        const result = await client.callTool({
          name: "bus_query",
          arguments: { query, ...(t === undefined ? {} : { t }) },
        });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: refusal }]);
        expect(result.structuredContent).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain(marker);
        expect(accesses).toEqual([]);
      }
    }
  } finally {
    await client.close();
  }
});
