import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Message, MessageJson, Origin } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { Messages } from "../src/mcp.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-byte-admission-"));
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = Number(probe.url.port);
probe.stop(true);
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const config = await freshLedger("byte-admission");
const store = layerFluree(config).pipe(Layer.provide(platform));
const server = ManagedRuntime.make(
  Serve.layerHttp({ port, version: "test" }).pipe(
    Layer.provideMerge(
      Bus.layer("fixture").pipe(
        Layer.provideMerge(store),
        Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(platform)
      )
    )
  )
);
const client = new Client({ name: "byte-admission", version: "1.0.0" });
beforeAll(async () => {
  await server.runPromise(Effect.void);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  await client.listTools();
});
afterAll(async () => {
  await client.close();
  await server.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });
const success = async (name: string, args: Record<string, unknown>) => {
  const result = await call(name, args);
  expect(result.isError).not.toBe(true);
  return result;
};
const messages = (value: unknown) => Schema.decodeUnknownSync(Messages)(value).messages;
const cursor = async (address: string) => {
  const result = await server.runPromise(
    Effect.flatMap(Cursors.Cursors, (cursors) => cursors.get(address))
  );
  if (result._tag !== "Some") throw new Error("Missing cursor.");
  return result.value;
};
const publicMessage = (message: Message) => ({
  id: message.id,
  ts: message.ts,
  from: message.from,
  to: message.to,
  kind: message.kind,
  body: message.body,
  ...(message.subject === undefined ? {} : { subject: message.subject }),
  ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
  ...(message.origin === undefined
    ? {}
    : {
        origin: {
          host: message.origin.host,
          ...(message.origin.cwd === undefined ? {} : { cwd: message.origin.cwd }),
          ...(message.origin.repo === undefined ? {} : { repo: message.origin.repo }),
          ...(message.origin.branch === undefined ? {} : { branch: message.origin.branch }),
        },
      }),
});
const carrierBytes = (rows: ReadonlyArray<Message>) => {
  const structuredContent = { messages: rows.map(publicMessage) };
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    }),
    "utf8"
  );
};
const joining = (address: string) => ({
  address,
  session: address,
  runtime: "other",
  cwd: process.cwd(),
});
const send = (from: string, to: string, body: string) =>
  success("bus_publish", { from, session: from, to: [to], body });

test("byte admission takes only a whole prefix and never moves past an oversized oldest message", async () => {
  const address = "fixture/byte-reader";
  const sender = "fixture/byte-sender";
  await success("bus_join", joining(address));
  await success("bus_join", joining(sender));
  await send(sender, address, 'small " \\ €\n');
  await send(sender, address, 'large " \\ €\n'.repeat(400));
  await send(sender, address, "third");
  const entries = (
    await server.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.read(0)))
  ).entries
    .map((entry) => entry.message)
    .filter((message) => message.from === sender && message.kind === "message");
  expect(entries).toHaveLength(3);
  const [a, b, c] = entries;
  if (!a || !b || !c) throw new Error("Missing fixture messages.");
  const firstSize = carrierBytes([a]);
  expect(firstSize).toBeGreaterThan(128);
  expect(firstSize).toBeGreaterThan(Buffer.byteLength(a.body, "utf8"));
  const before = await cursor(address);
  for (const name of ["bus_read", "bus_wait", "bus_read"]) {
    const result = await call(name, {
      address,
      session: address,
      maxResultBytes: firstSize - 1,
      ...(name === "bus_wait" ? { timeoutSeconds: 0 } : {}),
    });
    expect(result.isError).toBe(true);
    expect(await cursor(address)).toBe(before);
  }
  const invalid = await call("bus_read", { address, session: address, maxResultBytes: 127 });
  expect(invalid.isError).toBe(true);
  expect(await cursor(address)).toBe(before);
  const first = await success("bus_read", {
    address,
    session: address,
    limit: 1,
    maxResultBytes: firstSize,
  });
  expect(messages(first.structuredContent).map((message) => message.body)).toEqual([a.body]);
  expect(first.content).toEqual([{ type: "text", text: JSON.stringify(first.structuredContent) }]);
  expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(firstSize);
  const afterFirst = await cursor(address);
  const refused = await call("bus_read", {
    address,
    session: address,
    maxResultBytes: carrierBytes([b]) - 1,
  });
  expect(refused.isError).toBe(true);
  expect(await cursor(address)).toBe(afterFirst);
  const rest = await success("bus_read", {
    address,
    session: address,
    maxResultBytes: carrierBytes([b, c]),
  });
  expect(messages(rest.structuredContent).map((message) => message.body)).toEqual([b.body, c.body]);
  await send(sender, address, "legacy no budget");
  expect(
    messages((await success("bus_read", { address, session: address })).structuredContent).map(
      (message) => message.body
    )
  ).toEqual(["legacy no budget"]);
});

test("same-commit rows cannot be split by either byte or count admission", async () => {
  const address = "fixture/group-reader";
  const sender = "fixture/group-sender";
  await success("bus_join", joining(address));
  await success("bus_join", joining(sender));
  await send(sender, address, "prior");
  const group = ["group-a", "group-b"].map(
    (body) =>
      new Message({
        id: `byte-${body}`,
        ts: new Date().toISOString(),
        from: sender,
        to: [address],
        kind: "message",
        body,
        origin: new Origin({ host: "fixture" }),
      })
  );
  const encode = Schema.encodeSync(MessageJson);
  const nodes = group.map((message) => toNode(message, encode(message)));
  await insertRaw(config, {
    "@context": nodes[0]?.["@context"],
    "@graph": nodes.map(({ "@context": _context, ...node }) => node),
  });
  const all = (
    await server.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.read(0)))
  ).entries.filter((entry) => entry.message.from === sender && entry.message.kind === "message");
  expect(all).toHaveLength(3);
  expect(all[1]?.end).toBe(all[2]?.end);
  const prior = all[0]?.message;
  if (!prior || !group[0] || !group[1]) throw new Error("Missing group fixtures.");
  const first = await success("bus_read", {
    address,
    session: address,
    maxResultBytes: carrierBytes([prior, group[0]]),
  });
  expect(messages(first.structuredContent).map((message) => message.body)).toEqual(["prior"]);
  const saved = await cursor(address);
  for (const args of [
    { limit: 1, maxResultBytes: carrierBytes(group) },
    { maxResultBytes: carrierBytes([group[0]]) },
  ]) {
    expect((await call("bus_read", { address, session: address, ...args })).isError).toBe(true);
    expect(await cursor(address)).toBe(saved);
  }
  const both = await success("bus_read", {
    address,
    session: address,
    maxResultBytes: carrierBytes(group),
  });
  expect(messages(both.structuredContent).map((message) => message.body)).toEqual([
    "group-a",
    "group-b",
  ]);
});

test("a count-only read stops before a same-commit group and never exceeds its limit", async () => {
  const address = "fixture/count-group-reader";
  const sender = "fixture/count-group-sender";
  await success("bus_join", joining(address));
  await success("bus_join", joining(sender));
  await send(sender, address, "prior count message");
  const group = ["a", "b"].map(
    (suffix) =>
      new Message({
        id: `count-group-${suffix}`,
        ts: new Date().toISOString(),
        from: sender,
        to: [address],
        kind: "message",
        body: `count-${suffix}`,
        origin: new Origin({ host: "fixture" }),
      })
  );
  const encode = Schema.encodeSync(MessageJson);
  const nodes = group.map((message) => toNode(message, encode(message)));
  await insertRaw(config, {
    "@context": nodes[0]?.["@context"],
    "@graph": nodes.map(({ "@context": _context, ...node }) => node),
  });
  const first = await success("bus_read", { address, session: address, limit: 2 });
  expect(messages(first.structuredContent).map((message) => message.body)).toEqual([
    "prior count message",
  ]);
  const saved = await cursor(address);
  for (let i = 0; i < 2; i++) {
    expect((await call("bus_read", { address, session: address, limit: 1 })).isError).toBe(true);
    expect(await cursor(address)).toBe(saved);
  }
  const both = await success("bus_read", { address, session: address, limit: 2 });
  expect(
    messages(both.structuredContent)
      .map((message) => message.body)
      .sort()
  ).toEqual(["count-a", "count-b"]);
  await send(sender, address, "unlimited-a");
  await send(sender, address, "unlimited-b");
  const all = await success("bus_read", { address, session: address });
  expect(messages(all.structuredContent).map((message) => message.body)).toEqual([
    "unlimited-a",
    "unlimited-b",
  ]);
});
