import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Messages } from "../src/mcp.ts";
import { clerkPeerResolver, PEER_PERMISSION, peerSession } from "../src/private-web/identity.ts";
import { busPeer, peerTools } from "../src/private-web/peer.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger } from "./fluree-server.ts";

const key = new Uint8Array(32).fill(42);
const issuer = "https://fixture.invalid";
const subject = "synthetic-owner";
const secondSubject = "synthetic-second";
const resource = "https://fixture.invalid/mcp";
const signal = new AbortController().signal;
const grant = { subject, resource, permissions: [PEER_PERMISSION] };
const resolve = clerkPeerResolver({
  issuer,
  principals: [
    { subject, grantFile: "/first" },
    { subject: secondSubject, grantFile: "/second" },
  ],
  resource,
  key,
  identify: async (token) =>
    ["good", "rotated"].includes(token) ? subject : token === "second" ? secondSubject : "other",
  readGrant: async (path) => ({ ...grant, subject: path === "/first" ? subject : secondSubject }),
});
const identity = (chat?: string, token = "good") => ({
  auth: { authType: "oauth", accessToken: token },
  signal,
  ...(chat === undefined ? {} : { requestMeta: { "openai/session": chat } }),
});

test("principal and conversation are separated, stable and never raw", async () => {
  const original = clerkPeerResolver({
    issuer,
    principals: [{ subject, grantFile: "/first" }],
    resource,
    key,
    identify: async () => subject,
    readGrant: async () => grant,
  });
  const a = await original(identity("a"));
  expect(a.session).toBe("hosted-a45ca60824f2619b325d780fb12037ecf75d08348d5e01bcd1a91e0964579779");
  expect(await resolve(identity("a"))).toEqual(a);
  const restarted = clerkPeerResolver({
    issuer,
    principals: [
      { subject, grantFile: "/first" },
      { subject: secondSubject, grantFile: "/second" },
    ],
    resource,
    key,
    identify: async () => subject,
    readGrant: async () => grant,
  });
  expect(
    await restarted({ ...identity("a"), auth: { authType: "oauth", accessToken: "rotated" } })
  ).toEqual(a);
  expect(a.session).not.toBe((await resolve(identity("b"))).session);
  expect(a.session).not.toBe((await resolve(identity("a", "second"))).session);
  expect(a.session).not.toBe(peerSession(key, `${issuer}/other`, subject, "a"));
  expect(a.session).not.toBe(peerSession(key, issuer, `${subject}/other`, "a"));
  expect(a.session).not.toBe(peerSession(new Uint8Array(32).fill(43), issuer, subject, "a"));
  expect(a.session).not.toContain(subject);
  expect(await resolve(identity())).toEqual({});
  expect(await resolve({ ...identity(), requestMeta: { "openai/session": 9 } })).toEqual({});
  expect(await resolve(identity(" \t"))).toEqual({});
  await expect(
    resolve({ ...identity("a"), auth: { authType: "oauth", accessToken: "bad" } })
  ).rejects.toThrow();
  const denied = clerkPeerResolver({
    issuer,
    principals: [{ subject, grantFile: "/first" }],
    resource,
    key,
    identify: async () => subject,
    readGrant: async () => ({ ...grant, permissions: [] }),
  });
  await expect(denied(identity("a"))).rejects.toThrow();
});

test("hosted catalogue excludes hook and caller-controlled identity fields", () => {
  const tools = peerTools(async () => ({ content: [] }), "/fixture");
  expect(tools.map((tool) => tool.name)).toEqual([
    "bus_join",
    "bus_takeover",
    "bus_publish",
    "bus_activity",
    "bus_directory",
    "bus_bulletin",
    "bus_orient",
    "bus_read",
    "bus_wait",
    "bus_owned_addresses",
    "bus_peers",
    "bus_history",
    "bus_query",
    "bus_run_query",
    "bus_queries",
    "bus_leave",
  ]);
  for (const tool of tools) {
    const schema = tool.parameters["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    const properties =
      typeof schema === "object" && schema !== null && "properties" in schema
        ? schema.properties
        : undefined;
    expect(properties).not.toHaveProperty("session");
    if (["bus_join", "bus_takeover", "bus_owned_addresses"].includes(tool.name))
      expect(properties).not.toHaveProperty("runtime");
    if (["bus_join", "bus_takeover"].includes(tool.name))
      expect(properties).not.toHaveProperty("cwd");
    if (tool.name === "bus_orient") expect(properties).toHaveProperty("cwd");
    if (["bus_read", "bus_wait"].includes(tool.name))
      expect(properties).not.toHaveProperty("maxResultBytes");
    expect(properties).not.toHaveProperty("codexThreadId");
  }
});

test("hosted orientation forwards only an explicitly supplied lexical cwd and reads bind the budget", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tools = peerTools(async (name, args) => {
    calls.push({ name, args });
    return { content: [] };
  }, "/bridge");
  const actor = { session: "fixture-session" };
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error("Missing tool.");
    return tool.execute(args, { actor, signal });
  };
  await call("bus_orient", {});
  await call("bus_orient", { cwd: "/project", candidateCursor: "continuation" });
  await call("bus_join", { address: "chatgpt/test" });
  await call("bus_read", { address: "chatgpt/test" });
  expect(calls[0]).toEqual({ name: "bus_orient", args: {} });
  expect(calls[1]).toEqual({
    name: "bus_orient",
    args: { cwd: "/project", candidateCursor: "continuation" },
  });
  expect(calls[2]?.args).toMatchObject({
    cwd: "/bridge",
    runtime: "other",
    session: actor.session,
  });
  expect(calls[3]?.args).toMatchObject({ session: actor.session, maxResultBytes: 4 * 1024 * 1024 });
  expect(
    (await call("bus_read", { address: "chatgpt/test", maxResultBytes: 8 * 1024 * 1024 })).isError
  ).toBe(true);
  const abort = new AbortController();
  abort.abort();
  const read = tools.find((tool) => tool.name === "bus_read");
  if (!read) throw new Error("Missing read.");
  expect(
    (await read.execute({ address: "chatgpt/test" }, { actor, signal: abort.signal })).isError
  ).toBe(true);
  expect(calls).toHaveLength(4);
});

const dir = mkdtempSync(join(tmpdir(), "agent-bus-hosted-peer-"));
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = Number(probe.url.port);
probe.stop(true);
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const store = layerFluree(await freshLedger("hosted-peer")).pipe(Layer.provide(platform));
const server = ManagedRuntime.make(
  Serve.layerHttp({ port, version: "hosted-fixture" }).pipe(
    Layer.provideMerge(
      Bus.layer("fixture").pipe(
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

test("real Bus peer ownership, complete mail and reconnect", async () => {
  let peer = await busPeer({ busPort: port, expectedBusVersion: "hosted-fixture" });
  try {
    let tools = peerTools(peer.exchange, process.cwd());
    const a = await resolve(identity("a"));
    const b = await resolve(identity("a", "second"));
    const c = await resolve(identity("b"));
    expect(c.session).not.toBe(a.session);
    expect(b.session).not.toBe(a.session);
    const call = async (name: string, args: Record<string, unknown>, actor = a) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      return tool.execute(args, { actor, signal });
    };
    const ok = async (name: string, args: Record<string, unknown>, actor = a) => {
      const result = await call(name, args, actor);
      expect(result.isError).not.toBe(true);
      const structured = "structuredContent" in result ? result.structuredContent : undefined;
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      expect(tool.outputSchema["~standard"].validate(structured)).toHaveProperty("value");
      return structured;
    };
    expect((await call("bus_join", { address: "codex/not-hosted" })).isError).toBe(true);
    expect((await call("bus_join", { address: "chatgpt/a", session: "stolen" })).isError).toBe(
      true
    );
    expect((await call("bus_join", { address: "chatgpt/a", runtime: "codex" })).isError).toBe(true);
    expect((await call("bus_join", { address: "chatgpt/a", cwd: "/fake" })).isError).toBe(true);
    expect((await call("bus_join", { address: "chatgpt/a", codexThreadId: "fake" })).isError).toBe(
      true
    );
    expect((await call("bus_join", { address: "chatgpt/a" }, {})).isError).toBe(true);
    expect((await call("bus_peers", {}, {})).isError).not.toBe(true);
    await ok("bus_join", { address: "chatgpt/a", topics: ["fixture"] });
    await ok("bus_join", { address: "chatgpt/b" }, b);
    await ok("bus_join", { address: "chatgpt/c" }, c);
    const toC = await ok("bus_publish", {
      from: "chatgpt/a",
      to: ["chatgpt/c"],
      body: "a to c",
    });
    const toA = await ok(
      "bus_publish",
      { from: "chatgpt/c", to: ["chatgpt/a"], body: "c to a" },
      c
    );
    expect(toC?.id).toBeDefined();
    expect(toA?.id).toBeDefined();
    expect(toA?.id).not.toBe(toC?.id);
    expect((await call("bus_read", { address: "chatgpt/a" }, c)).isError).toBe(true);
    expect((await call("bus_read", { address: "chatgpt/c" })).isError).toBe(true);
    expect(await ok("bus_read", { address: "chatgpt/a" })).toMatchObject({
      messages: [{ id: toA?.id, from: "chatgpt/c", body: "c to a" }],
    });
    expect(await ok("bus_read", { address: "chatgpt/c" }, c)).toMatchObject({
      messages: [{ id: toC?.id, from: "chatgpt/a", body: "a to c" }],
    });
    expect(await ok("bus_read", { address: "chatgpt/a" })).toEqual({ messages: [] });
    expect(await ok("bus_read", { address: "chatgpt/c" }, c)).toEqual({ messages: [] });
    const peers = await ok("bus_peers", {});
    expect(peers).toMatchObject({
      peers: expect.arrayContaining([
        expect.objectContaining({ address: "chatgpt/a", runtime: "other" }),
      ]),
    });
    const sent = await ok(
      "bus_publish",
      { from: "chatgpt/b", to: ["#fixture"], body: "full body", subject: "subject" },
      b
    );
    expect((await call("bus_read", { address: "chatgpt/a" }, b)).isError).toBe(true);
    expect(
      (
        await call(
          "bus_publish",
          { from: "chatgpt/a", to: ["chatgpt/b"], body: "impersonation" },
          b
        )
      ).isError
    ).toBe(true);
    expect((await call("bus_leave", { address: "chatgpt/a" }, b)).isError).toBe(true);
    expect(
      (
        await call(
          "bus_activity",
          { address: "chatgpt/a", operation: Bun.randomUUIDv7(), activity: "inactive" },
          b
        )
      ).isError
    ).toBe(true);
    const conflict = await call("bus_join", { address: "chatgpt/a" }, b);
    expect(conflict.isError).toBe(true);
    const text = conflict.content[0]?.text;
    const holder = typeof text === "string" ? /holder "([^"]+)"/.exec(text)?.[1] : undefined;
    expect(holder).toBeDefined();
    await peer.dispose();
    peer = await busPeer({ busPort: port, expectedBusVersion: "hosted-fixture" });
    tools = peerTools(peer.exchange, process.cwd());
    const resumed = await resolve(identity("a"));
    expect(await ok("bus_owned_addresses", {}, resumed)).toEqual({ addresses: ["chatgpt/a"] });
    const read = await ok("bus_read", { address: "chatgpt/a" }, resumed);
    expect(read).toMatchObject({
      messages: [{ id: sent?.id, body: "full body", subject: "subject" }],
    });
    expect(JSON.stringify(read)).not.toContain(a.session);
    expect(await ok("bus_read", { address: "chatgpt/a" })).toEqual({ messages: [] });
    const reply = await ok("bus_publish", {
      from: "chatgpt/a",
      to: ["chatgpt/b"],
      body: "reply body",
      subject: "reply subject",
      replyTo: sent?.id,
    });
    const readReply = await call("bus_read", { address: "chatgpt/b" }, b);
    expect(readReply.isError).not.toBe(true);
    const replyContent = "structuredContent" in readReply ? readReply.structuredContent : undefined;
    const replyText = readReply.content[0]?.text;
    expect(typeof replyText).toBe("string");
    if (typeof replyText !== "string") throw new Error("Missing native text carrier.");
    expect(JSON.parse(replyText)).toEqual(replyContent);
    expect(replyContent).toMatchObject({
      messages: [
        {
          id: reply?.id,
          body: "reply body",
          subject: "reply subject",
          replyTo: sent?.id,
          origin: { cwd: process.cwd() },
        },
      ],
    });
    const page = await ok("bus_run_query", { name: "messages", args: { ids: [sent?.id] } });
    expect(page).toMatchObject({ rows: [{ id: sent?.id, body: "full body" }], complete: true });

    await ok("bus_publish", { from: "chatgpt/b", to: ["chatgpt/a"], body: "carry over" }, b);
    // A bounded wake notice passes the hosted wire's closed output schema, omissions counted.
    const unwoken = await ok(
      "bus_publish",
      {
        from: "chatgpt/b",
        to: ["chatgpt/absent", `chatgpt/${"x".repeat(4096)}`],
        body: "to absent",
      },
      b
    );
    expect(unwoken?.wake).toMatchObject({
      lacking: [{ address: "chatgpt/absent", standing: "not-joined" }],
      unlisted: 1,
    });
    expect((await call("bus_takeover", { address: "chatgpt/a", holder: "stale" }, b)).isError).toBe(
      true
    );
    // This is an intentionally authorized cross-principal transfer, not an isolation proof.
    await ok("bus_takeover", { address: "chatgpt/a", holder }, b);
    expect((await call("bus_read", { address: "chatgpt/a" })).isError).toBe(true);
    expect(await ok("bus_read", { address: "chatgpt/a" }, b)).toMatchObject({
      messages: [{ body: "carry over" }],
    });
    expect(
      (await call("bus_publish", { from: "chatgpt/a", to: ["chatgpt/c"], body: "fenced" })).isError
    ).toBe(true);
    const transferred = await ok(
      "bus_publish",
      { from: "chatgpt/a", to: ["chatgpt/c"], body: "after transfer" },
      b
    );
    expect(await ok("bus_read", { address: "chatgpt/c" }, c)).toMatchObject({
      messages: [{ id: transferred?.id, from: "chatgpt/a", body: "after transfer" }],
    });

    let writes = 0;
    const failing = peerTools(async (name, args) => {
      const result = await peer.exchange(name, args);
      if (name === "bus_publish") {
        writes++;
        throw new Error("lost result after commit");
      }
      return result;
    }, process.cwd());
    const publish = failing.find((tool) => tool.name === "bus_publish");
    if (!publish) throw new Error("publish unavailable");
    const lost = await publish.execute(
      { from: "chatgpt/b", to: ["chatgpt/a"], body: "lost-receipt" },
      { actor: b, signal }
    );
    expect(lost.isError).toBe(true);
    expect(JSON.stringify(lost)).toContain("may have committed");
    expect(writes).toBe(1);
    const history = await ok("bus_history", { participant: "chatgpt/b" }, b);
    const messages = history?.messages;
    expect(
      Array.isArray(messages) && messages.filter((message) => message.body === "lost-receipt")
    ).toHaveLength(1);
    const lostReadTools = peerTools(async (name, args) => {
      const result = await peer.exchange(name, args);
      if (name === "bus_read") throw new Error("lost result after consumption");
      return result;
    }, process.cwd());
    const readTool = lostReadTools.find((tool) => tool.name === "bus_read");
    if (!readTool) throw new Error("read unavailable");
    const lostRead = await readTool.execute({ address: "chatgpt/a" }, { actor: b, signal });
    expect(lostRead.isError).toBe(true);
    expect(JSON.stringify(lostRead)).toContain("consumed messages");
    expect(await ok("bus_read", { address: "chatgpt/a" }, b)).toEqual({ messages: [] });
    await ok("bus_leave", { address: "chatgpt/a" }, b);
    expect((await call("bus_read", { address: "chatgpt/a" }, b)).isError).toBe(true);
    await ok("bus_join", { address: "chatgpt/a" }, b);
  } finally {
    await peer.dispose();
  }
}, 60_000);

test("hosted reads drain a carrier larger than the loopback ceiling without losing messages", async () => {
  const peer = await busPeer({ busPort: port, expectedBusVersion: "hosted-fixture" });
  try {
    const actor = { session: "large-hosted-session" };
    const tools = peerTools(peer.exchange, process.cwd());
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error("Missing hosted tool.");
      const result = await tool.execute(args, { actor, signal });
      expect(result.isError).not.toBe(true);
      return result;
    };
    const address = "chatgpt/large-reader";
    const sender = "fixture/large-sender";
    await call("bus_join", { address });
    await server.runPromise(
      Effect.flatMap(Bus.Bus, (bus) =>
        bus.join({
          address: sender,
          session: sender,
          runtime: "other",
          cwd: process.cwd(),
        })
      )
    );
    const bodies = Array.from({ length: 6 }, (_, i) => `${i}:` + '"\\€'.repeat(120_000));
    for (const body of bodies)
      await server.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.publish({ from: sender, session: sender, to: [address], body })
        )
      );
    const received: Array<(typeof Messages.Type)["messages"][number]> = [];
    let drained = false;
    for (let attempt = 0; attempt <= bodies.length; attempt++) {
      const result = await call("bus_read", { address });
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
        4 * 1024 * 1024
      );
      const structured = "structuredContent" in result ? result.structuredContent : undefined;
      const page = Schema.decodeUnknownSync(Messages)(structured).messages;
      if (page.length === 0) {
        drained = true;
        break;
      }
      received.push(...page);
      expect(received.length).toBeLessThanOrEqual(bodies.length);
    }
    expect(drained).toBe(true);
    expect(received.length).toBe(bodies.length);
    expect(received.map((message) => Bun.hash(message.body))).toEqual(
      bodies.map((body) => Bun.hash(body))
    );
    const complete = { messages: received };
    const fullCarrier = {
      content: [{ type: "text", text: JSON.stringify(complete) }],
      structuredContent: complete,
      isError: false,
    };
    expect(Buffer.byteLength(JSON.stringify(fullCarrier), "utf8")).toBeGreaterThan(8 * 1024 * 1024);
  } finally {
    await peer.dispose();
  }
}, 60_000);
