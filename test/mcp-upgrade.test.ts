// Exercise the MCP server with the official SDK, independently of Effect's client.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CallToolResult,
  isInitializeRequest,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import * as Serve from "../src/serve.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-mcp-upgrade-"));
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = Number(probe.url.port);
probe.stop(true);
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const server = ManagedRuntime.make(
  Serve.layerHttp({ port, version: "test" }).pipe(
    Layer.provideMerge(
      Bus.layer.pipe(
        Layer.provideMerge(layerJsonl(join(dir, "ledger.jsonl"))),
        Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
      )
    )
  )
);
const clients: Client[] = [];

beforeAll(() => server.runPromise(Effect.void));
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
afterAll(async () => {
  try {
    await server.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

class OlderTransport extends StreamableHTTPClientTransport {
  override send(
    message: JSONRPCMessage,
    options?: Parameters<StreamableHTTPClientTransport["send"]>[1]
  ) {
    return super.send(
      isInitializeRequest(message)
        ? { ...message, params: { ...message.params, protocolVersion: "2025-06-18" } }
        : message,
      options
    );
  }
}

async function connect(older = false) {
  const client = new Client({ name: "mcp-upgrade-test", version: "1" });
  clients.push(client);
  const transport = older ? new OlderTransport(url) : new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  await client.listTools();
  return { client, transport };
}

const session = (address: string) => `session:${address}`;
const joining = (address: string, owner = session(address)) => ({
  address,
  runtime: "claude",
  session: owner,
  cwd: process.cwd(),
});
const readArgs = (address: string) => ({ address, session: session(address) });
const cursor = (address: string) =>
  Bun.file(join(dir, "cursors", `${encodeURIComponent(address)}.json`)).text();
const text = (result: CallToolResult) => {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
};
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 2_000,
  })) as CallToolResult;
const succeed = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await call(client, name, args);
  expect(result.isError).not.toBe(true);
  const decoded = JSON.parse(text(result)) as Record<string, unknown>;
  expect(result.structuredContent).toEqual(decoded);
  return decoded;
};

// A refused competing join observes the server's wait count without changing the ledger.
async function observeWait(client: Client, address: string, open: boolean) {
  const deadline = Date.now() + 4_000;
  const wanted = open ? "a wait open now" : "no wait open on this machine";
  while (Date.now() < deadline) {
    const result = await call(client, "bus_join", joining(address, "other-session"));
    expect(result.isError).toBe(true);
    if (text(result).includes(wanted)) return;
  }
  throw new Error(`Timed out waiting for ${wanted}`);
}

function pendingWait(client: Client, address: string, controller: AbortController) {
  let settled = false;
  const outcome = client
    .callTool(
      { name: "bus_wait", arguments: { ...readArgs(address), timeoutSeconds: 30 } },
      undefined,
      { signal: controller.signal, timeout: 20_000 }
    )
    .then(
      () => "resolved" as const,
      () => "rejected" as const
    )
    .finally(() => {
      settled = true;
    });
  return { outcome, isSettled: () => settled };
}

test("SDK cancellation interrupts a pending wait before later mail is published", async () => {
  const { client } = await connect();
  const id = Bun.randomUUIDv7();
  const reader = `upgrade/${id}/reader`;
  const sender = `upgrade/${id}/sender`;
  await succeed(client, "bus_join", joining(reader));
  await succeed(client, "bus_join", joining(sender));
  expect(await succeed(client, "bus_read", readArgs(reader))).toEqual({ messages: [] });
  const before = await cursor(reader);

  const controller = new AbortController();
  const waiting = pendingWait(client, reader, controller);
  try {
    await observeWait(client, reader, true);
    expect(waiting.isSettled()).toBe(false);
    controller.abort();
    expect(await waiting.outcome).toBe("rejected");
    await observeWait(client, reader, false);
    expect(await cursor(reader)).toBe(before);

    const body = "mail after cancellation";
    const sent = await succeed(client, "bus_publish", {
      from: sender,
      session: session(sender),
      to: [reader],
      body,
    });
    expect(await succeed(client, "bus_read", readArgs(reader))).toMatchObject({
      messages: [{ id: sent.id, body }],
    });
    expect(await succeed(client, "bus_read", readArgs(reader))).toEqual({ messages: [] });
  } finally {
    controller.abort();
    await waiting.outcome;
  }
}, 15_000);

test("session DELETE interrupts its wait without changing unrelated unread mail", async () => {
  const owner = await connect();
  const observer = await connect();
  const id = Bun.randomUUIDv7();
  const reader = `upgrade/${id}/reader`;
  const sender = `upgrade/${id}/sender`;
  const other = `upgrade/${id}/other`;
  await succeed(owner.client, "bus_join", joining(reader));
  await succeed(observer.client, "bus_join", joining(sender));
  await succeed(observer.client, "bus_join", joining(other));
  const unrelated = await succeed(observer.client, "bus_publish", {
    from: sender,
    session: session(sender),
    to: [other],
    body: "unrelated unread mail",
  });
  expect(await succeed(observer.client, "bus_read", readArgs(reader))).toEqual({ messages: [] });
  const before = await Promise.all([cursor(reader), cursor(sender), cursor(other)]);

  const controller = new AbortController();
  const waiting = pendingWait(owner.client, reader, controller);
  try {
    await observeWait(observer.client, reader, true);
    expect(waiting.isSettled()).toBe(false);
    expect(owner.transport.sessionId).toBeDefined();
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        "mcp-session-id": owner.transport.sessionId!,
        "mcp-protocol-version": owner.transport.protocolVersion!,
      },
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(204);
    await response.body?.cancel();
    await observeWait(observer.client, reader, false);
    expect(await Promise.all([cursor(reader), cursor(sender), cursor(other)])).toEqual(before);
    expect(await succeed(observer.client, "bus_read", readArgs(other))).toMatchObject({
      messages: [{ id: unrelated.id, body: "unrelated unread mail" }],
    });
    const sent = await succeed(observer.client, "bus_publish", {
      from: sender,
      session: session(sender),
      to: [reader],
      body: "mail after session deletion",
    });
    expect(await succeed(observer.client, "bus_read", readArgs(reader))).toMatchObject({
      messages: [{ id: sent.id, body: "mail after session deletion" }],
    });
  } finally {
    controller.abort();
    await waiting.outcome;
  }
}, 15_000);

test("success and declared or invalid tool failures have honest encodings", async () => {
  const { client } = await connect();
  const id = Bun.randomUUIDv7();
  const reader = `upgrade/${id}/reader`;
  const sender = `upgrade/${id}/sender`;
  await succeed(client, "bus_join", joining(reader));
  await succeed(client, "bus_join", joining(sender));
  const body = 'Literal "_tag":"Cause", quotes and a backslash \\';
  const sent = await succeed(client, "bus_publish", {
    from: sender,
    session: session(sender),
    to: [reader],
    body,
  });
  expect(await succeed(client, "bus_read", readArgs(reader))).toMatchObject({
    messages: [{ id: sent.id, body }],
  });

  const refused = await call(client, "bus_read", { address: `upgrade/${id}/absent`, session: "x" });
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent).toBeUndefined();
  expect(text(refused)).toMatch(/has not joined the bus/);
  const invalid = await call(client, "bus_wait", { ...readArgs(reader), timeoutSeconds: 51 });
  expect(invalid.isError).toBe(true);
  expect(invalid.structuredContent).toBeUndefined();
  expect(text(invalid)).toMatch(/between 0 and 50/);
});

test("invalid parameters produce a JSON-RPC error without an Effect Cause on the wire", async () => {
  const { transport } = await connect(true);
  expect(transport.protocolVersion).toBe("2025-06-18");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": transport.sessionId!,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 831,
      method: "tools/call",
      params: { name: "bus_wait", arguments: { address: "absent", timeoutSeconds: 51 } },
    }),
    signal: AbortSignal.timeout(2_000),
  });
  expect(response.ok).toBe(true);
  const wire = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? wire
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
    : wire;
  expect(payload).toBeDefined();
  const message = JSON.parse(payload!) as { id: number; error: { code: number; message: string } };
  expect(message.id).toBe(831);
  expect(message.error.code).toBe(-32602);
  expect(message.error.message).toMatch(/between 0 and 50/);
  expect(JSON.stringify(message.error)).not.toContain('"_tag":"Cause"');
});
