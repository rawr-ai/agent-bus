// Fake upstream bodies are deliberately private-looking; only classified failures
// may cross the real Fluree -> Bus -> HTTP MCP path.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import * as Serve from "../src/serve.ts";

const marker = "synthetic-private-upstream-body";
const dir = mkdtempSync(join(tmpdir(), "agent-bus-public-errors-"));
const storeRequests: Array<string> = [];
let failure: { body: string; status: number } | undefined;
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.endsWith("/events")) storeRequests.push(path);
    if (path.includes("/exists/")) return Response.json({ exists: true });
    if (path.includes("/info/")) return Response.json({ ledger: { t: 2 } });
    if (path.includes("/show/")) return Response.json({ id: "fixture-commit" });
    if (path.endsWith("/events"))
      return new Response("", { headers: { "content-type": "text/event-stream" } });
    if (failure) return new Response(failure.body, { status: failure.status });
    return Response.json([]);
  },
});
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const ledgerLayer = layerFluree({ url: upstream.url.origin, ledger: "fixture:main" }).pipe(
  Layer.provide(platform)
);
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = Number(probe.url.port);
probe.stop(true);
const server = ManagedRuntime.make(
  Serve.layerHttp({ port, version: "test" }).pipe(
    Layer.provideMerge(
      Bus.layer.pipe(
        Layer.provideMerge(ledgerLayer),
        Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(platform)
      )
    )
  )
);
const client = new Client({ name: "public-errors", version: "test" });
beforeAll(async () => {
  await server.runPromise(Effect.void);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  await client.listTools();
});
afterAll(async () => {
  await client.close();
  await server.dispose();
  upstream.stop(true);
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  failure = undefined;
});

const refused = async (name: string, args: Record<string, unknown>, expected: string) => {
  const result = await client.callTool({ name, arguments: args });
  expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expected }] });
  expect(result.structuredContent).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(marker);
};

test.each([400, 401, 403, 409, 500, 503])(
  "HTTP %s exposes only its status class, never its body",
  async (status) => {
    failure = { body: JSON.stringify({ session: marker, nested: { raw: marker } }), status };
    for (const [name, args] of [
      ["bus_history", {}],
      ["bus_peers", {}],
      ["bus_query", { query: "SELECT ?s WHERE { ?s bus:id ?o }" }],
      ["bus_run_query", { name: "history" }],
    ] as const) {
      await refused(name, args, `Fluree request failed (HTTP ${status}).`);
    }
  }
);

test("malformed JSON and schema failures omit source values", async () => {
  failure = { body: marker, status: 200 };
  await refused("bus_history", {}, "Fluree returned an invalid response.");
  failure = { body: JSON.stringify({ nested: { session: marker } }), status: 200 };
  await refused("bus_history", {}, "Fluree returned an invalid response.");
});

test("bus_query refuses forbidden and malformed queries before reading head or querying upstream", async () => {
  failure = { body: marker, status: 500 };
  const before = storeRequests.length;
  for (const query of [
    "",
    "INSERT DATA { <urn:x> <urn:p> 1 }",
    "ASK { ?s ?p ?o }",
    "SELECT * FROM <urn:other> WHERE { ?s ?p ?o }",
    "SELECT * WHERE { SERVICE SILENT <urn:other> { ?s ?p ?o } }",
    "SELECT * WHERE { GRAPH <urn:other> { ?s ?p ?o } }",
    "SELECT * WHERE {",
    "SELECT ?j WHERE { ?m bus:json ?j }",
    "SELECT * WHERE { ?s ?p ?o }",
    marker.repeat(4096),
  ]) {
    const result = await client.callTool({ name: "bus_query", arguments: { query } });
    expect(result).toMatchObject({ isError: true });
  }
  expect(storeRequests.length).toBe(before);
});

test("transport failures do not echo request paths or raw transport errors", async () => {
  // A fixture URL carrying the marker catches accidental HttpClientError.message forwarding.
  const transport = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.includes("/exists/")) return Response.json({ exists: true });
      if (path.includes("/info/")) return Response.json({ ledger: { t: 2 } });
      return Response.json({ id: "fixture-commit" });
    },
  });
  const broken = layerFluree({
    url: `${transport.url.origin}/${marker}`,
    ledger: "fixture:main",
  }).pipe(Layer.provide(platform));
  const runtime = ManagedRuntime.make(broken);
  try {
    await runtime.runPromise(Effect.void);
    transport.stop(true);
    const error = await runtime.runPromise(
      Effect.flatMap(Ledger, (ledger) => Effect.flip(ledger.end))
    );
    expect(error.message).toBe("Fluree could not complete the request.");
    expect(JSON.stringify(error)).not.toContain(marker);
  } finally {
    await runtime.dispose();
    transport.stop(true);
  }
});

test("HTTP classification preserves the concurrent ledger-creation 409 recovery", async () => {
  let creations = 0;
  const raced = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.includes("/exists/")) return Response.json({ exists: false });
      if (path.endsWith("/create")) {
        creations += 1;
        return new Response(marker, { status: 409 });
      }
      if (path.includes("/info/")) return Response.json({ ledger: { t: 2 } });
      return Response.json({ id: "fixture-commit" });
    },
  });
  try {
    expect(
      await Effect.runPromise(
        Effect.flatMap(Ledger, (ledger) => ledger.end).pipe(
          Effect.provide(layerFluree({ url: raced.url.origin, ledger: "fixture:main" })),
          Effect.provide(platform)
        )
      )
    ).toBe(2);
    expect(creations).toBe(1);
  } finally {
    raced.stop(true);
  }
});
