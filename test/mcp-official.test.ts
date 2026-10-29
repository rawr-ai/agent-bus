// The bus's MCP endpoint as clients outside Effect see it: driven by the official
// TypeScript SDK, so a spec deviation shared by Effect's client and server still fails.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { Effect, Layer, ManagedRuntime } from "effect";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import * as Serve from "../src/serve.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-official-"));
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
// A port the OS just handed out, so a concurrent run can't hold it.
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = Number(probe.url.port);
probe.stop(true);
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const server = ManagedRuntime.make(
  Serve.layerHttp({ port, version: "test" }).pipe(
    Layer.provide(
      Bus.layer.pipe(
        Layer.provideMerge(layerJsonl(join(dir, "ledger.jsonl"))),
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
      bus_read: changes,
      bus_wait: changes,
      bus_wake: changes,
      bus_peers: lookup,
      bus_history: lookup,
      bus_query: lookup,
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

  test("lists the bus tools, with output schemas from 2025-06-18", async () => {
    const { tools } = await connect();
    const required = {
      bus_join: ["address", "cursor"],
      bus_takeover: ["address", "cursor"],
      bus_publish: ["id", "ts"],
      bus_read: ["messages"],
      bus_wait: ["messages"],
      bus_wake: ["addresses", "owns", "superseded"],
      bus_peers: ["peers"],
      bus_history: ["messages"],
      bus_query: undefined,
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

  test("every tool but bus_query (Fluree only) answers with structured content its schema accepts", async () => {
    const { succeed } = await connect();
    const a = `${version}/a`;
    const b = `${version}/b`;
    expect(await succeed("bus_join", joining(a))).toEqual({
      address: a,
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
    for (const address of [a, b]) {
      expect(await succeed("bus_leave", { address, session: sid(address) })).toEqual({ address });
    }
  });

  test("refusals are tool errors that say why, not protocol errors", async () => {
    const { call, succeed, refused } = await connect();
    const owner = `${version}/owner`;
    await succeed("bus_join", joining(owner));
    await refused("bus_read", { address: owner }, /own session id as `session`/);
    await refused("bus_read", { address: owner, session: "x" }, /belongs to another session/);

    // A held address is taken over only through bus_takeover, naming the holder's current join.
    const held = await call("bus_join", { ...joining(owner), session: "other" });
    expect(held.isError).toBe(true);
    const said = text(held);
    expect(said).toContain("bus_takeover");
    const joinId = /holder "([^"]+)"/.exec(said)?.[1];
    expect(joinId).toBeDefined();
    const other = { ...joining(owner), session: "other" };
    // A client with an older tool list passing takeover to bus_join is refused, not taken over.
    await refused("bus_join", { ...other, takeover: joinId }, /bus_takeover/);
    await refused("bus_takeover", { ...other, holder: "stale" }, /held by another session/);
    expect(await succeed("bus_takeover", { ...other, holder: joinId })).toEqual({
      address: owner,
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
