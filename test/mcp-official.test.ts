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
import { InvalidQuery, latestPresences, Message, Origin, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { mailboxIri } from "../src/mailbox-model.ts";
import { Messages } from "../src/mcp-tools.ts";
import { WAKE_LISTED_BYTES } from "../src/message-carrier.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-official-"));
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
// The real store: bus_history, bus_peers and the query tools need its query engine.
const store = layerFluree(await freshLedger("official")).pipe(Layer.provide(platform));
// A port the OS just handed out, so a concurrent run can't hold it.
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = Number(probe.url.port);
probe.stop(true);
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const leaveRefusal = "Fixture leave was refused before dispatch. Nothing was sent or written.";
const refusedLeaves = new Map<string, Message[]>();
const storeWithLeaveRefusal = Layer.effect(
  Ledger,
  Effect.map(Ledger, (ledger) =>
    Ledger.of({
      ...ledger,
      admit: (entry, basis) => {
        const attempts = refusedLeaves.get(entry.from);
        if (
          attempts === undefined ||
          entry.kind !== "presence" ||
          entry.presence?.status !== "left"
        )
          return ledger.admit(entry, basis);
        return Effect.gen(function* () {
          attempts.push(entry);
          return yield* new InvalidQuery({ message: leaveRefusal });
        });
      },
    })
  )
).pipe(Layer.provideMerge(store));
const fixtureBus = Bus.layer("test-installation").pipe(
  Layer.provideMerge(storeWithLeaveRefusal),
  Layer.provide(platform)
);
const server = ManagedRuntime.make(
  Serve.layerHttp({ port, version: "test" }).pipe(Layer.provideMerge(fixtureBus))
);
beforeAll(() => server.runPromise(Effect.void));
afterAll(async () => {
  await server.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** The SDK always offers its latest protocol; offering another stands in for an older client. */
class Offering extends StreamableHTTPClientTransport {
  constructor(
    private readonly offered: string,
    target: URL = url
  ) {
    super(target);
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
  installation: privateMarker,
  codexThreadId: privateMarker,
  rejoinOf: "synthetic-private-run",
});

/** A serve on its own fresh ledger, for tests that damage stored state. */
const damagedPositionServer = async (name: string) => {
  const config = await freshLedger(name);
  const opened = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const own = Number(opened.url.port);
  opened.stop(true);
  const runtime = ManagedRuntime.make(
    Serve.layerHttp({ port: own, version: "test" }).pipe(
      Layer.provideMerge(
        Bus.layer("test-installation").pipe(
          Layer.provideMerge(layerFluree(config).pipe(Layer.provide(platform))),
          Layer.provide(platform)
        )
      )
    )
  );
  await runtime.runPromise(Effect.void);
  return {
    config,
    url: new URL(`http://127.0.0.1:${own}/mcp`),
    head: () => runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.end)),
    dispose: () => runtime.dispose(),
  };
};

/**
 * Add a second current receipt reference. Neither this damaged value nor unread mail
 * may reach the client, and refusing the read must not write another acknowledgement.
 */
const injectMalformedPosition = (
  config: Awaited<ReturnType<typeof freshLedger>>,
  address: string
) =>
  insertRaw(config, {
    "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
    "@id": mailboxIri(address),
    "bus:mailboxHead": privateMarker,
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

  const connect = async (target: URL = url) => {
    const client = new Client({ name: "official-sdk-test", version: "1" });
    clients.push(client);
    const transport = new Offering(version, target);
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

  test("carries a definite ledger refusal through leave as an MCP tool error", async () => {
    const { call, succeed } = await connect();
    const address = `fixture/leave-admission-refusal/${version}`;
    const session = sid(address);
    await succeed("bus_join", joining(address));

    const state = () =>
      server.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const { entries, cut } = yield* ledger.presenceAt();
          return { cut, holder: latestPresences(entries).get(address) };
        })
      );
    const before = await state();
    expect(before.holder?.presence).toMatchObject({ status: "joined", session });
    const attempts: Message[] = [];
    refusedLeaves.set(address, attempts);
    try {
      const result = await call("bus_leave", { address, session });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        kind: "presence",
        from: address,
        presence: { status: "left", session },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(text(result)).toBe(leaveRefusal);
      expect(await state()).toEqual(before);
    } finally {
      refusedLeaves.delete(address);
    }
    await succeed("bus_leave", { address, session });
  });

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
      bus_ack: changes,
      bus_wake: changes,
      bus_observe_wake: lookup,
      bus_check_wake_binding: lookup,
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
      bus_join: ["address", "associations", "cursor", "nextReadId"],
      bus_takeover: ["address", "associations", "cursor", "nextReadId"],
      // A NOT_SENT answer has no id or ts, so nothing is required.
      bus_publish: undefined,
      bus_activity: ["status", "operation"],
      bus_directory: ["status", "operation", "expected"],
      bus_bulletin: ["status", "operation", "expected"],
      bus_orient: ["status"],
      bus_read: ["messages", "nextReadId"],
      bus_wait: ["messages", "nextReadId"],
      bus_ack: ["receipt", "nextReadId"],
      bus_wake: ["addresses", "owns", "superseded"],
      bus_observe_wake: ["binding", "observationCut", "ready", "news"],
      bus_check_wake_binding: ["binding", "observationCut"],
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
      nextReadId: expect.any(String),
    });
    await succeed("bus_join", joining(b));
    const body = `over ${version}`;
    const published = await succeed("bus_publish", { from: b, session: sid(b), to: [a], body });
    expect(published).toEqual({ id: expect.any(String), ts: expect.any(String) });
    const observed = await succeed("bus_observe_wake", { address: a, session: sid(a) });
    expect(observed).toMatchObject({
      ready: true,
      news: true,
      nextCoverage: { rung: [published.id] },
    });
    expect(
      await succeed("bus_check_wake_binding", {
        address: a,
        session: sid(a),
        expectedBinding: observed.binding,
      })
    ).toMatchObject({ binding: observed.binding });
    expect(await succeed("bus_read", { address: a, session: sid(a) })).toMatchObject({
      messages: [{ id: published.id, from: b, to: [a], body }],
    });
    expect(await succeed("bus_wait", { address: a, session: sid(a), timeoutSeconds: 0 })).toEqual({
      messages: [],
      nextReadId: expect.any(String),
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
    const absent = `${version}/absent`;
    expect(
      await succeed("bus_publish", { from: b, session: sid(b), to: [absent, b, absent], body })
    ).toEqual({
      id: expect.any(String),
      ts: expect.any(String),
      wake: {
        ledger: page.ledger,
        t: expect.any(Number),
        lacking: [{ address: absent, standing: "not-joined" }],
      },
    });
    // The notice stays bounded and says how many it left out.
    const long = `${absent}-${"x".repeat(WAKE_LISTED_BYTES)}`;
    const bounded = await succeed("bus_publish", {
      from: b,
      session: sid(b),
      to: [absent, long],
      body,
    });
    expect(bounded.wake).toEqual({
      ledger: page.ledger,
      t: expect.any(Number),
      lacking: [{ address: absent, standing: "not-joined" }],
      unlisted: 1,
    });
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
      // Derived from the stored installation and thread, neither of which is returned.
      wake: "recorded",
      activity: "active",
      activeSince: expect.any(String),
      mutes: [],
    });
    for (const name of ["bus_read", "bus_wait", "bus_history", "bus_peers"]) {
      const schema = JSON.stringify(tools.find((tool) => tool.name === name)?.outputSchema);
      if (structured) {
        for (const field of ["presence", "session", "installation", "codexThreadId", "rejoinOf"]) {
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
      expect(result).toMatchObject({ messages: [expected] });
      expect(Object.keys(result).sort()).toEqual(["messages", "nextReadId", "receipt"]);
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
      nextReadId: expect.any(String),
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
    expect({ ...rejoined, nextReadId: "" }).toEqual({ ...joined, nextReadId: "" });
    expect(await succeed("bus_read", { address: reader, session: sid(reader) })).toMatchObject({
      messages: [{ id: sent.id }],
    });
  });

  test("a malformed stored position fails safely, discloses nothing and writes nothing", async () => {
    // Its own disposable ledger and serve, so the damage cannot reach the shared fixture.
    const damaged = await damagedPositionServer(`official-damaged-position-${version}`);
    try {
      const { call, succeed } = await connect(damaged.url);
      const address = `${version}/invalid-position`;
      const sender = `${version}/invalid-position-sender`;
      await succeed("bus_join", joining(address));
      await succeed("bus_join", joining(sender));
      await succeed("bus_publish", {
        from: sender,
        session: sid(sender),
        to: [address],
        body: "x",
      });
      await injectMalformedPosition(damaged.config, address);
      const before = await damaged.head();
      const result = await call("bus_read", { address, session: sid(address) });
      expect([result.isError, result.structuredContent]).toEqual([true, undefined]);
      expect(text(result).length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(privateMarker);
      expect(await damaged.head()).toBe(before);
    } finally {
      await damaged.dispose();
    }
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
      nextReadId: expect.any(String),
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
    expect(await wait(0.5)).toEqual({ messages: [], nextReadId: expect.any(String) });
    expect(Date.now() - before).toBeGreaterThanOrEqual(400);
  });
});

/**
 * One release's catalogue as a client discovers it: every listed tool object, the initialize
 * instructions and server identity, and each listed resource with its read content hashed.
 * Array order is kept; protocol request ids never enter the record.
 */
const discovered = async (client: Client) => {
  const tools = await client.listTools();
  const resources = await client.listResources();
  expect([tools.nextCursor, resources.nextCursor]).toEqual([undefined, undefined]);
  const read = [];
  for (const resource of resources.resources) {
    const { contents } = await client.readResource({ uri: resource.uri });
    read.push({
      resource,
      contents: contents.map((content) => {
        const { uri, mimeType, _meta } = content;
        const body = "text" in content ? content.text : content.blob;
        return {
          uri,
          mimeType,
          _meta,
          sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
        };
      }),
    });
  }
  return {
    server: client.getServerVersion(),
    capabilities: client.getServerCapabilities(),
    instructions: client.getInstructions(),
    tools: tools.tools,
    resources: read,
  };
};

test("one release's native catalogue is identical across ordinary mail and a fresh connection", async () => {
  const clients: Array<Client> = [];
  const connect = async () => {
    const client = new Client({ name: "catalogue-stability", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url));
    return client;
  };
  try {
    const first = await connect();
    const before = await discovered(first);
    expect(before.tools.length).toBeGreaterThan(10);
    expect(before.instructions?.length ?? 0).toBeGreaterThan(0);
    expect(before.resources.map(({ resource }) => resource.uri)).toContain(
      "skill://agent-bus/SKILL.md"
    );

    const succeed = async (name: string, args: Record<string, unknown>) => {
      const result = (await first.callTool({ name, arguments: args })) as CallToolResult;
      if (result.isError) throw new Error(`${name} refused: ${text(result)}`);
      return JSON.parse(text(result));
    };
    const [a, b] = ["catalogue/a", "catalogue/b"];
    await succeed("bus_join", { ...joining(a), topics: ["catalogue"] });
    await succeed("bus_join", joining(b));
    const sent = await succeed("bus_publish", { from: b, session: sid(b), to: [a], body: "one" });
    await succeed("bus_publish", { from: a, session: sid(a), to: ["#catalogue"], body: "two" });
    expect(await succeed("bus_read", { address: a, session: sid(a) })).toMatchObject({
      messages: [{ id: sent.id }],
    });
    await succeed("bus_wait", { address: b, session: sid(b), timeoutSeconds: 0 });
    await succeed("bus_activity", {
      address: a,
      session: sid(a),
      operation: Bun.randomUUIDv7(),
      activity: "inactive",
    });
    await succeed("bus_history", { participant: a });
    for (const address of [a, b]) await succeed("bus_leave", { address, session: sid(address) });

    expect(await discovered(first)).toEqual(before);
    expect(await discovered(await connect())).toEqual(before);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});
