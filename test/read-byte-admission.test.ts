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
import { Messages, MIN_READ_RESULT_BYTES } from "../src/mcp-tools.ts";
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
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const cut = (yield* ledger.presenceAt()).cut;
      return yield* ledger.mailboxAt(address, cut);
    })
  );
  if (result.status !== "FOUND") throw new Error("Missing mailbox position.");
  return result.position;
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
/**
 * The documented size of a complete read result, computed independently of the server: the
 * messages, a receipt (36-character id, the batch's positions, replayed false) and a
 * 36-character nextReadId, as structured content and as its escaped text copy.
 */
const ID = "01a20000-0000-7000-8000-000000000000";
const carrierBytes = (rows: ReadonlyArray<Message>, from: number, through: number) => {
  const structuredContent = {
    messages: rows.map(publicMessage),
    receipt: { readId: ID, from, through, replayed: false },
    nextReadId: ID,
  };
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    }),
    "utf8"
  );
};
const head = () => server.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.end));
const endOf = async (id: string) => {
  const entry = (
    await server.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.read(0)))
  ).entries.find(({ message }) => message.id === id);
  if (entry === undefined) throw new Error("Missing fixture entry.");
  return entry.end;
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
  const before = await cursor(address);
  const firstSize = carrierBytes([a], before, await endOf(a.id));
  expect(firstSize).toBeGreaterThan(MIN_READ_RESULT_BYTES);
  expect(firstSize).toBeGreaterThan(Buffer.byteLength(a.body, "utf8"));
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
  const invalid = await call("bus_read", {
    address,
    session: address,
    maxResultBytes: MIN_READ_RESULT_BYTES - 1,
  });
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
    maxResultBytes: carrierBytes([b], afterFirst, await endOf(b.id)) - 1,
  });
  expect(refused.isError).toBe(true);
  expect(await cursor(address)).toBe(afterFirst);
  const rest = await success("bus_read", {
    address,
    session: address,
    maxResultBytes: carrierBytes([b, c], afterFirst, await head()),
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
  const groupEnd = all[1]?.end ?? 0;
  const first = await success("bus_read", {
    address,
    session: address,
    maxResultBytes: carrierBytes([prior, group[0]], await cursor(address), groupEnd),
  });
  expect(messages(first.structuredContent).map((message) => message.body)).toEqual(["prior"]);
  const saved = await cursor(address);
  for (const args of [
    { limit: 1, maxResultBytes: carrierBytes(group, saved, await head()) },
    { maxResultBytes: carrierBytes([group[0]], saved, groupEnd) },
  ]) {
    expect((await call("bus_read", { address, session: address, ...args })).isError).toBe(true);
    expect(await cursor(address)).toBe(saved);
  }
  const both = await success("bus_read", {
    address,
    session: address,
    maxResultBytes: carrierBytes(group, saved, await head()),
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
