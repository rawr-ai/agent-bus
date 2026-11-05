// The bus's MCP endpoint as clients outside Effect see it: driven by the official
// TypeScript SDK, so a spec deviation shared by Effect's client and server still fails.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CallToolResult,
  ErrorCode,
  isInitializeRequest,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Message, Origin, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { Messages } from "../src/mcp.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger } from "./fluree-server.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-official-"));
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
// The real store: bus_history, bus_peers and the query tools need its query engine.
const store = layerFluree(await freshLedger("official")).pipe(Layer.provide(platform));
// A port the OS just handed out, so a concurrent run can't hold it.
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = Number(probe.url.port);
probe.stop(true);
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const server = ManagedRuntime.make(
  Serve.layerHttp({ port, version: "test" }).pipe(
    Layer.provideMerge(
      Bus.layer.pipe(
        Layer.provideMerge(store),
        Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(platform)
      )
    )
  )
);
beforeAll(() => server.runPromise(Effect.void));
afterAll(async () => {
  await server.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** The SDK always offers its latest protocol; offering another stands in for an older client. */
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

const sid = (address: string) => `session:${address}`;
const joining = (address: string) => ({
  address,
  runtime: "claude",
  session: sid(address),
  cwd: process.cwd(),
});
const text = (result: CallToolResult) => {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
};

// An exact allowlist is the oracle, not another projection derived from the schema.
const publicMessage = {
  id: "projection-message",
  ts: "2026-01-01T00:00:00.000Z",
  from: "other/sender",
  to: ["other/reader"],
  kind: "message" as const,
  body: "ordinary public body",
  subject: "public subject",
  replyTo: "earlier-message",
  origin: { host: "fixture-host", cwd: "/workspace", repo: "/workspace", branch: "fixture" },
};
const privateMarker = "synthetic-private-claim";
const privatePresence = new Presence({
  runtime: "codex",
  status: "joined",
  topics: [],
  session: privateMarker,
  codexThreadId: privateMarker,
  rejoinOf: "synthetic-private-run",
});

test("the public message schema excludes presence and unknown objects at every level", () => {
  const message = new Message({
    ...publicMessage,
    origin: Object.assign(new Origin(publicMessage.origin), { internal: { privateMarker } }),
    presence: privatePresence,
  });
  Object.assign(message, { internal: { privateMarker } });
  expect(Schema.encodeSync(Messages)({ messages: [message] })).toEqual({
    messages: [publicMessage],
  });
});

// The stateful versions serve advertises. The SDK can't speak the stateless 2026-07-28,
// which bus.test.ts covers with Effect's own client.
describe.each(["2025-11-25", "2025-06-18", "2025-03-26"])("official client over %s", (version) => {
  // Output schemas and structured content arrived in 2025-06-18.
  const structured = version !== "2025-03-26";
  const clients: Array<Client> = [];
  afterEach(() => Promise.all(clients.splice(0).map((client) => client.close())));

  const connect = async () => {
    const client = new Client({ name: "official-sdk-test", version: "1" });
    clients.push(client);
    const transport = new Offering(version);
    await client.connect(transport);
    expect(transport.protocolVersion).toBe(version);
    // callTool checks structured content only against the output schemas listTools cached.
    const { tools } = await client.listTools();
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult;
    const succeed = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} refused: ${text(result)}`);
      // Clients that ignore structured content read the same object from the text block.
      const json = JSON.parse(text(result));
      expect(result.structuredContent).toEqual(structured ? json : undefined);
      return json;
    };
    const refused = async (name: string, args: Record<string, unknown>, reason: RegExp) => {
      const result = await call(name, args);
      expect([name, result.isError, result.structuredContent]).toEqual([name, true, undefined]);
      expect(text(result)).toMatch(reason);
    };
    return { tools, call, succeed, refused };
  };

  // Codex asks approval for a tool that is destructive, or not read-only and possibly
  // open-world (requires_mcp_tool_approval in codex-rs/core/src/mcp_tool_call.rs), and
  // refuses the call outright under approval policy never outside full access.
  test("annotates the tools as closed-world, lookups as read-only and only bus_takeover as destructive", async () => {
    const { tools } = await connect();
    const changes = { destructiveHint: false, openWorldHint: false, readOnlyHint: false };
    const lookup = { ...changes, readOnlyHint: true };
    expect(
      Object.fromEntries(
        tools.map(({ name, annotations }) => [
          name,
          {
            destructiveHint: annotations?.destructiveHint,
            openWorldHint: annotations?.openWorldHint,
            readOnlyHint: annotations?.readOnlyHint,
          },
        ])
      )
    ).toEqual({
      bus_join: changes,
      bus_takeover: { ...changes, destructiveHint: true },
      bus_publish: changes,
      bus_activity: changes,
      bus_directory: changes,
      bus_bulletin: changes,
      bus_orient: lookup,
      bus_read: changes,
      bus_wait: changes,
      bus_wake: changes,
      bus_owned_addresses: lookup,
      bus_peers: lookup,
      bus_history: lookup,
      bus_query: lookup,
      bus_run_query: lookup,
      bus_queries: lookup,
      bus_leave: changes,
    });
  });

  test("describes every tool parameter", async () => {
    const { tools } = await connect();
    const undescribed = tools.flatMap(({ name, inputSchema }) =>
      Object.entries(inputSchema.properties ?? {})
        .filter(
          ([, property]) =>
            String((property as { description?: unknown }).description ?? "").trim() === ""
        )
        .map(([parameter]) => `${name}.${parameter}`)
    );
    expect(undescribed).toEqual([]);
  });

  test("describes every nested orientation input and result field", async () => {
    const { tools } = await connect();
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const missing = (schema: unknown, path: string): Array<string> => {
      if (!object(schema)) return [];
      const properties = object(schema.properties) ? Object.entries(schema.properties) : [];
      return [
        ...properties.flatMap(([name, field]) => [
          ...(!object(field) ||
          typeof field.description !== "string" ||
          field.description.trim() === ""
            ? [`${path}.${name}`]
            : []),
          ...missing(field, `${path}.${name}`),
        ]),
        ...(schema.items === undefined ? [] : missing(schema.items, `${path}[]`)),
        ...(Array.isArray(schema.anyOf)
          ? schema.anyOf.flatMap((item, index) => missing(item, `${path}|${index}`))
          : []),
      ];
    };
    const orientationTools = tools.filter(({ name }) =>
      ["bus_directory", "bus_bulletin", "bus_orient"].includes(name)
    );
    expect(orientationTools).toHaveLength(3);
    expect(
      orientationTools.flatMap((tool) => [
        ...missing(tool.inputSchema, `${tool.name}.input`),
        ...(tool.outputSchema === undefined
          ? []
          : missing(tool.outputSchema, `${tool.name}.output`)),
      ])
    ).toEqual([]);
  });

  test("lists the bus tools, with output schemas from 2025-06-18", async () => {
    const { tools } = await connect();
    const required = {
      bus_join: ["address", "associations", "cursor"],
      bus_takeover: ["address", "associations", "cursor"],
      // A NOT_SENT answer has no id or ts, so nothing is required.
      bus_publish: undefined,
      bus_activity: ["status", "operation"],
      bus_directory: ["status", "operation", "expected"],
      bus_bulletin: ["status", "operation", "expected"],
      bus_orient: ["status"],
      bus_read: ["messages"],
      bus_wait: ["messages"],
      bus_wake: ["addresses", "owns", "superseded"],
      bus_owned_addresses: ["addresses"],
      bus_peers: ["peers"],
      bus_history: ["messages"],
      bus_query: ["name", "ledger", "t", "unit", "columns", "rows", "complete", "note"],
      bus_run_query: [
        "name",
        "catalogueVersion",
        "ledger",
        "t",
        "unit",
        "args",
        "rows",
        "damage",
        "damaged",
        "damagedTotal",
        "exhausted",
        "complete",
        "note",
      ],
      bus_queries: ["catalogueVersion", "ledger", "headT", "operations", "raw"],
      bus_leave: ["address"],
    };
    expect(
      Object.fromEntries(
        tools.map(({ name, outputSchema }) => [
          name,
          outputSchema && { required: outputSchema.required },
        ])
      )
    ).toEqual(
      Object.fromEntries(
        Object.entries(required).map(([name, fields]) => [
          name,
          structured ? { required: fields } : undefined,
        ])
      )
    );
  });

  test("every tool answers with content its schema accepts", async () => {
    const { succeed } = await connect();
    const a = `${version}/a`;
    const b = `${version}/b`;
    expect(await succeed("bus_join", joining(a))).toEqual({
      address: a,
      topics: [],
      associations: [],
      cursor: expect.any(Number),
    });
    await succeed("bus_join", joining(b));
    const body = `over ${version}`;
    const published = await succeed("bus_publish", { from: b, session: sid(b), to: [a], body });
    expect(published).toEqual({ id: expect.any(String), ts: expect.any(String) });
    expect(await succeed("bus_read", { address: a, session: sid(a) })).toMatchObject({
      messages: [{ id: published.id, from: b, to: [a], body }],
    });
    expect(await succeed("bus_wait", { address: a, session: sid(a), timeoutSeconds: 0 })).toEqual({
      messages: [],
    });
    const { peers } = await succeed("bus_peers", {});
    expect(peers.map((peer: { address: string }) => peer.address)).toEqual(
      expect.arrayContaining([a, b])
    );
    expect(await succeed("bus_history", { participant: b })).toMatchObject({
      messages: [{ id: published.id }],
    });
    const raw = await succeed("bus_query", {
      query: `SELECT ?body WHERE { ?m bus:id "${published.id}" ; bus:body ?body }`,
    });
    expect(raw).toMatchObject({ name: "sparql", unit: "binding", rows: [{ "?body": body }] });
    const page = await succeed("bus_run_query", {
      name: "messages",
      args: { ids: [published.id] },
      t: raw.t,
    });
    expect(page).toMatchObject({ t: raw.t, rows: [{ id: published.id, body }], complete: true });
    const { operations } = await succeed("bus_queries", {});
    expect(operations.length).toBeGreaterThan(0);
    for (const address of [a, b]) {
      expect(await succeed("bus_leave", { address, session: sid(address) })).toEqual({ address });
    }
  });

  test("owned addresses are exact addresses-only text and structured results; invalid identity refuses", async () => {
    const { succeed, refused } = await connect();
    const address = `${version}/owned-observation`;
    const session = `private-owned-${version}`;
    await succeed("bus_join", { ...joining(address), runtime: "codex", session });
    expect(await succeed("bus_owned_addresses", { session, runtime: "codex" })).toEqual({
      addresses: [address],
    });
    expect(await succeed("bus_owned_addresses", { session, runtime: "claude" })).toEqual({
      addresses: [],
    });
    expect(
      await succeed("bus_owned_addresses", { session: "never-joined", runtime: "codex" })
    ).toEqual({ addresses: [] });
    for (const session of [undefined, "", " ", "$CODEX_THREAD_ID"]) {
      await refused("bus_owned_addresses", { session, runtime: "codex" }, /usable session id/);
    }
    await succeed("bus_leave", { address, session });
    expect(await succeed("bus_owned_addresses", { session, runtime: "codex" })).toEqual({
      addresses: [],
    });
  });

  test("peers and ordinary messages omit stored claims in both output encodings", async () => {
    const { succeed, tools } = await connect();
    const reader = `${version}/projection-reader`;
    const claim = `${privateMarker}-${version}`;
    await succeed("bus_join", {
      ...joining(reader),
      runtime: "codex",
      session: claim,
      codexThreadId: claim,
      topics: ["projection"],
      note: "public coordination note",
    });
    const { peers } = await succeed("bus_peers", {});
    expect(peers.find((peer: { address: string }) => peer.address === reader)).toEqual({
      address: reader,
      runtime: "codex",
      topics: ["projection"],
      host: hostname(),
      note: "public coordination note",
      activity: "active",
      activeSince: expect.any(String),
      mutes: [],
    });
    for (const name of ["bus_read", "bus_wait", "bus_history", "bus_peers"]) {
      const schema = JSON.stringify(tools.find((tool) => tool.name === name)?.outputSchema);
      if (structured) {
        for (const field of ["presence", "session", "codexThreadId", "rejoinOf"]) {
          expect(schema).not.toContain(`"${field}":`);
        }
      }
    }
    for (const name of ["bus_read", "bus_wait"]) {
      const expected = { ...publicMessage, id: Bun.randomUUIDv7(), to: [reader] };
      // This is legal in the legacy internal representation despite kind: message.
      const stored = new Message({
        ...expected,
        origin: new Origin(expected.origin),
        presence: privatePresence,
      });
      await server.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.append(stored)));
      const result = await succeed(name, { address: reader, session: claim, timeoutSeconds: 0 });
      expect(result).toEqual({ messages: [expected] });
      expect(JSON.stringify(result)).not.toContain(privateMarker);
      const history = await succeed("bus_history", { participant: reader, limit: 1 });
      expect(history).toEqual({ messages: [expected] });
    }
    // Projection must not rewrite the stored internal representation.
    const internal = await server.runPromise(
      Effect.flatMap(Ledger, (ledger) => ledger.read(0)).pipe(
        Effect.map(({ entries }) =>
          entries.filter((entry) => entry.message.to.includes(reader)).map((entry) => entry.message)
        )
      )
    );
    expect(internal.map((message) => message.presence)).toEqual([privatePresence, privatePresence]);
    expect(await succeed("bus_read", { address: reader, session: claim })).toEqual({
      messages: [],
    });
    await succeed("bus_leave", { address: reader, session: claim });
  });

  test("topic joins echo their effective subscriptions and malformed replacements are tool refusals", async () => {
    const { succeed, refused } = await connect();
    const reader = `${version}/topic-reader`;
    const sender = `${version}/topic-sender`;
    const joined = await succeed("bus_join", {
      ...joining(reader),
      topics: [" #reviews ", "reviews"],
    });
    expect(joined.topics).toEqual(["reviews"]);
    await succeed("bus_join", joining(sender));
    const sent = await succeed("bus_publish", {
      from: sender,
      session: sid(sender),
      to: ["#reviews"],
      body: "unread through a normalized topic",
    });
    await refused(
      "bus_join",
      { ...joining(reader), topics: ["#"] },
      /Each topic must have a non-empty name/
    );
    const rejoined = await succeed("bus_join", joining(reader));
    expect(rejoined).toEqual(joined);
    expect(await succeed("bus_read", { address: reader, session: sid(reader) })).toMatchObject({
      messages: [{ id: sent.id }],
    });
  });

  test("a malformed cursor fails safely without overwriting its stored value", async () => {
    const { succeed, refused } = await connect();
    const address = `${version}/invalid-cursor`;
    await succeed("bus_join", joining(address));
    const path = join(dir, "cursors", `${encodeURIComponent(address)}.json`);
    const original = await Bun.file(path).text();
    const malformed = JSON.stringify({ cursor: privateMarker });
    try {
      await Bun.write(path, malformed);
      await refused(
        "bus_read",
        { address, session: sid(address) },
        /^The cursor could not be read or written\.$/
      );
      expect(await Bun.file(path).text()).toBe(malformed);
    } finally {
      await Bun.write(path, original);
    }
    expect(await succeed("bus_read", { address, session: sid(address) })).toEqual({ messages: [] });
    await succeed("bus_leave", { address, session: sid(address) });
  });

  test("refusals are tool errors that say why, not protocol errors", async () => {
    const { call, succeed, refused } = await connect();
    const owner = `${version}/owner`;
    await succeed("bus_join", { ...joining(owner), note: "public holder note" });
    await refused("bus_read", { address: owner }, /own session id as `session`/);
    await refused("bus_read", { address: owner, session: "x" }, /belongs to another session/);

    // A held address is taken over only through bus_takeover, naming the holder's current join.
    const held = await call("bus_join", { ...joining(owner), session: "other" });
    expect(held.isError).toBe(true);
    const said = text(held);
    expect(said).toContain("bus_takeover");
    expect(said).toContain('note "public holder note"');
    expect(said).not.toContain(sid(owner));
    const joinId = /holder "([^"]+)"/.exec(said)?.[1];
    expect(joinId).toBeDefined();
    const other = { ...joining(owner), session: "other" };
    // A client with an older tool list passing takeover to bus_join is refused, not taken over.
    await refused("bus_join", { ...other, takeover: joinId }, /bus_takeover/);
    const stale = await call("bus_takeover", { ...other, holder: "stale" });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("held by another session");
    expect(text(stale)).toContain('note "public holder note"');
    expect(JSON.stringify(stale)).not.toContain(sid(owner));
    expect(await succeed("bus_takeover", { ...other, holder: joinId })).toEqual({
      address: owner,
      topics: [],
      associations: [],
      cursor: expect.any(Number),
    });
    await refused(
      "bus_read",
      { address: owner, session: sid(owner) },
      /belongs to another session/
    );

    // Arguments the schema rejects were a protocol error until 2025-11-25 made them tool errors.
    const outOfRange = { address: owner, session: sid(owner), timeoutSeconds: 51 };
    if (version === "2025-11-25") {
      await refused("bus_wait", outOfRange, /between 0 and 50/);
    } else {
      await expect(call("bus_wait", outOfRange)).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringMatching(/between 0 and 50/),
      });
    }
  });

  // query.test.ts covers the validator in depth at the SDK's default version; this keeps
  // each refusal kind a tool error without structured content at every advertised version.
  test("bus_query refuses unreadable, outside, malformed and oversized queries as tool errors", async () => {
    const { refused } = await connect();
    await refused(
      "bus_query",
      { query: "SELECT ?j WHERE { ?m bus:json ?j }" },
      /bus:json is not readable/
    );
    await refused(
      "bus_query",
      { query: "SELECT * WHERE { SERVICE <urn:example> { ?s ?p ?o } }" },
      /^SERVICE is not allowed/
    );
    await refused("bus_query", { query: "not SPARQL" }, /^Not valid SPARQL/);
    await refused("bus_query", { query: "é".repeat(65_536) }, /^A query must be 1-/);
  });

  // The CLI opens a connection per call; agents hold one session and keep calling while they wait.
  test("bus_wait holds its request while the same session publishes", async () => {
    const { succeed } = await connect();
    const a = `${version}/waiter`;
    const b = `${version}/sender`;
    await succeed("bus_join", joining(a));
    await succeed("bus_join", joining(b));
    const wait = (timeoutSeconds: number) =>
      succeed("bus_wait", { address: a, session: sid(a), timeoutSeconds });

    let answered = false;
    const waiting = wait(4).finally(() => {
      answered = true;
    });
    await Bun.sleep(200);
    expect(answered).toBe(false);
    const { id } = await succeed("bus_publish", { from: b, session: sid(b), to: [a], body: "hi" });
    expect(await waiting).toMatchObject({ messages: [{ id, body: "hi" }] });

    // A held wait that nothing reaches ends empty at its timeout.
    const before = Date.now();
    expect(await wait(0.5)).toEqual({ messages: [] });
    expect(Date.now() - before).toBeGreaterThanOrEqual(400);
  });
});
