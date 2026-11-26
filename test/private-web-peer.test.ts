import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { type DirectTool, type EventsProgram, type StaticSkill, serveTools } from "mcp-openapi";
import { type ModernHttp, modernHttp } from "../scripts/private-modern-http.ts";
import * as Bus from "../src/Bus.ts";
import { Message } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { Messages } from "../src/mcp-tools.ts";
import {
  authorizationDiagnostics,
  eventsProgram,
  prepareWatchTool,
} from "../src/private-web/events.ts";
import {
  clerkPeerIdentity,
  clerkPeerResolver,
  PEER_PERMISSION,
  type PeerActor,
  peerSession,
} from "../src/private-web/identity.ts";
import { busPeer, peerTools, type wakePort } from "../src/private-web/peer.ts";
import { servePeer } from "../src/private-web/program.ts";
import { decodeServiceConfig, hostConfig } from "../src/private-web/service.ts";
import { initializeWatchAuthority, WatchAuthority } from "../src/private-web/watch-authority.ts";
import * as Serve from "../src/serve.ts";
import { WakeBinding } from "../src/wake-observation.ts";
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
    "bus_ack",
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
    const nativeOnly =
      /\$CLAUDE_CODE_SESSION_ID|\$CODEX_THREAD_ID|codexThreadId|\bhooked\b|\bshell\b|bus_wake/i;
    expect(tool.description).not.toMatch(nativeOnly);
    expect(tool.description).toContain("Calls that act for an address bind conversation identity");
    expect(JSON.stringify(schema)).not.toMatch(nativeOnly);
  }
});

test("hosted descriptions qualify wake and the injected join directory", () => {
  const tools = peerTools(async () => ({ content: [] }), "/bridge");
  const join = tools.find((tool) => tool.name === "bus_join");
  const takeover = tools.find((tool) => tool.name === "bus_takeover");
  const activity = tools.find((tool) => tool.name === "bus_activity");
  if (join === undefined || takeover === undefined || activity === undefined)
    throw new Error("Missing hosted participation tool.");

  expect(join.description).toContain("Without an accepted optional Events watch");
  expect(join.description).toContain("a read does not need a rejoin");
  expect(join.description).not.toContain("not automatically woken");
  expect(activity.description).toContain(
    "direct mail from another peer reactivates the address and is eligible to wake"
  );
  expect(activity.description).toContain("requires an accepted optional Events watch");
  expect(activity.description).toContain("identical intent and the same operation");
  expect(activity.description).not.toContain("direct mail still wakes you");

  for (const name of ["bus_activity", "bus_directory", "bus_bulletin"]) {
    const description = tools.find((tool) => tool.name === name)?.description ?? "";
    expect(description).toContain("UNKNOWN");
    expect(description).toContain("identical intent");
    expect(description).toContain("same operation");
  }

  for (const tool of [join, takeover]) {
    const schema = tool.parameters["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    expect(schema).toHaveProperty(
      "properties.orient.description",
      "After joining, independently read orientation for the join's cwd (the bridge directory for hosted calls). A failed read does not undo the join."
    );
  }
  const schema = activity.parameters["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  expect(schema).toHaveProperty(
    "properties.activity.description",
    "inactive for do-not-disturb; active makes ambient mail eligible for wake when available."
  );
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
  // 4 MiB for the complete hosted result, less the reserve for framing and metadata.
  expect(calls[3]?.args).toMatchObject({
    session: actor.session,
    maxResultBytes: 4 * 1024 * 1024 - 64 * 1024,
  });
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
      Bus.layer("fixture").pipe(Layer.provideMerge(store), Layer.provide(platform))
    )
  )
);
beforeAll(() => server.runPromise(Effect.void));
afterAll(async () => {
  await server.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("hosted keyed reads replay, and a hosted peek is acknowledged by bus_ack with identity injected", async () => {
  const peer = await busPeer({ busPort: port, expectedBusVersion: "hosted-fixture" });
  try {
    const tools = peerTools(peer.exchange, process.cwd());
    const reader = await resolve(identity("keyed-reader"));
    const writer = await resolve(identity("keyed-writer"));
    const ok = async (name: string, args: Record<string, unknown>, actor = reader) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      const result = await tool.execute(args, { actor, signal });
      expect(result.isError).not.toBe(true);
      const structured = "structuredContent" in result ? result.structuredContent : undefined;
      expect(tool.outputSchema["~standard"].validate(structured)).toHaveProperty("value");
      return structured;
    };
    const Result = Schema.Struct({
      messages: Schema.Array(Schema.Struct({ id: Schema.String })),
      receipt: Schema.optionalKey(
        Schema.Struct({
          readId: Schema.String,
          from: Schema.Number,
          through: Schema.Number,
          replayed: Schema.Boolean,
          basis: Schema.optionalKey(Schema.Struct({ ledger: Schema.String, t: Schema.Number })),
          served: Schema.optionalKey(
            Schema.Struct({ count: Schema.Number, digest: Schema.String })
          ),
        })
      ),
      nextReadId: Schema.String,
    });
    const outcome = (value: unknown) => Schema.decodeUnknownSync(Result)(value);
    const joined = Schema.decodeUnknownSync(Schema.Struct({ nextReadId: Schema.String }))(
      await ok("bus_join", { address: "chatgpt/keyed" })
    );
    await ok("bus_join", { address: "chatgpt/keyed-writer" }, writer);
    const send = async (body: string) =>
      Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
        await ok(
          "bus_publish",
          { from: "chatgpt/keyed-writer", to: ["chatgpt/keyed"], body },
          writer
        )
      ).id;
    const first = await send("keyed");
    const served = outcome(
      await ok("bus_read", { address: "chatgpt/keyed", readId: joined.nextReadId })
    );
    expect(served.messages.map(({ id }) => id)).toEqual([first]);
    const replay = outcome(
      await ok("bus_read", { address: "chatgpt/keyed", readId: joined.nextReadId })
    );
    expect(replay.messages.map(({ id }) => id)).toEqual([first]);
    expect(replay.receipt).toMatchObject({ readId: served.receipt?.readId, replayed: true });
    expect(replay.receipt?.through).toBe(served.receipt?.through);

    const second = await send("peeked");
    const peeked = outcome(await ok("bus_read", { address: "chatgpt/keyed", peek: true }));
    expect(peeked.messages.map(({ id }) => id)).toEqual([second]);
    const { receipt } = peeked;
    if (receipt?.basis === undefined || receipt.served === undefined)
      throw new Error("No peek receipt.");
    // Another conversation cannot acknowledge it; the owner's identity is injected, never supplied.
    const tool = tools.find((candidate) => candidate.name === "bus_ack");
    if (!tool) throw new Error("missing bus_ack");
    expect(
      (await tool.execute({ address: "chatgpt/keyed", receipt }, { actor: writer, signal })).isError
    ).toBe(true);
    expect(
      (
        await tool.execute(
          { address: "chatgpt/keyed", receipt, session: "stolen" },
          { actor: reader, signal }
        )
      ).isError
    ).toBe(true);
    expect(await ok("bus_ack", { address: "chatgpt/keyed", receipt })).toMatchObject({
      receipt: { readId: receipt.readId, through: receipt.through, replayed: false },
    });
    expect(outcome(await ok("bus_read", { address: "chatgpt/keyed" })).messages).toEqual([]);
  } finally {
    await peer.dispose();
  }
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
    expect(await ok("bus_read", { address: "chatgpt/a" })).toEqual({
      messages: [],
      nextReadId: expect.any(String),
    });
    expect(await ok("bus_read", { address: "chatgpt/c" }, c)).toEqual({
      messages: [],
      nextReadId: expect.any(String),
    });
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
    expect(await ok("bus_read", { address: "chatgpt/a" })).toEqual({
      messages: [],
      nextReadId: expect.any(String),
    });
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
    expect(await ok("bus_read", { address: "chatgpt/a" }, b)).toEqual({
      messages: [],
      nextReadId: expect.any(String),
    });
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
    // Each fits the 1 MiB per-message carrier, its body within the 32,768-byte limit for
    // searchable text and the rest in an escape-heavy recipient that names no peer; together they
    // exceed the 8 MiB loopback ceiling.
    const bodies = Array.from({ length: 12 }, (_, i) => `${i}:` + '"\\€'.repeat(6_000));
    const padding = `fixture/pad-${'"\\€'.repeat(48_000)}`;
    for (const body of bodies)
      await server.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.publish({ from: sender, session: sender, to: [address, padding], body })
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

test("real Fluree wake capture and continuing authority survive reads but fence a new run", async () => {
  const peer = await busPeer({ busPort: port, expectedBusVersion: "hosted-fixture" });
  let authority: WatchAuthority | undefined;
  try {
    const name = "chatgpt/events-native";
    const sender = "fixture/events-sender";
    const identityService = clerkPeerIdentity({
      issuer,
      resource,
      key,
      principals: [
        { subject, grantFile: "/first" },
        { subject: secondSubject, grantFile: "/second" },
      ],
      identify: async (token) => (token === "second" ? secondSubject : subject),
      readGrant: async (path) => ({
        ...grant,
        subject: path === "/first" ? subject : secondSubject,
      }),
    });
    const invocation = {
      ...identity("events-native"),
      auth: { authType: "oauth" as const, accessToken: "good" },
      client: { version: undefined },
    };
    const actor = await identityService.resolvePeer(invocation);
    const tools = peerTools(peer.exchange, process.cwd());
    const call = async (toolName: string, args: Record<string, unknown>) => {
      const tool = tools.find(({ name: candidate }) => candidate === toolName);
      if (tool === undefined) throw new Error("Missing hosted tool.");
      const result = await tool.execute(args, { actor, signal });
      expect(result.isError).not.toBe(true);
      return result;
    };
    await call("bus_join", { address: name });
    const eventsPath = join(dir, "native-events.sqlite");
    writeFileSync(eventsPath, "", { mode: 0o600, flag: "wx" });
    initializeWatchAuthority({ eventsPath, resource });
    authority = new WatchAuthority({ eventsPath, resource });
    const prepare = prepareWatchTool({ identity: identityService, wake: peer.wake, authority });
    const prepared = await prepare.execute({ address: name }, { ...invocation, actor });
    expect(prepared.isError).not.toBe(true);
    const preparedArgs = prepared.structuredContent?.arguments;
    if (
      typeof preparedArgs !== "object" ||
      preparedArgs === null ||
      !("ticket" in preparedArgs) ||
      typeof preparedArgs.ticket !== "string"
    )
      throw new Error("Missing watch ticket.");
    const ticket = preparedArgs.ticket;
    await server.runPromise(
      Effect.flatMap(Bus.Bus, (bus) =>
        bus.join({ address: sender, session: sender, runtime: "other", cwd: process.cwd() })
      )
    );
    const lines: string[] = [];
    const diagnostics = authorizationDiagnostics(true, (line) => lines.push(line));
    const lastDiagnostic = (): unknown => {
      const line = lines.at(-1);
      const prefix = "[agent-bus] authorization-diagnostic ";
      if (line === undefined || !line.startsWith(prefix)) throw new Error("Missing diagnostic.");
      return JSON.parse(line.slice(prefix.length));
    };
    const program = eventsProgram({
      identity: identityService,
      wake: peer.wake,
      authority,
      resource,
      diagnostics,
      storage: {
        path: eventsPath,
        maxBytes: 1_048_576,
        encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      },
    });
    const account = await program.resolvePrincipal(invocation);
    const foreignConversation = { ...invocation, requestMeta: { "openai/session": "other-chat" } };
    const foreignAccount = {
      ...invocation,
      auth: { authType: "oauth" as const, accessToken: "second" },
    };
    for (const other of [foreignConversation, foreignAccount]) {
      const otherAccount = await program.resolvePrincipal(other);
      expect(
        await program.authorizeSubscription({
          account: otherAccount,
          event: "mail.wake",
          arguments: { address: name, ticket },
          invocation: other,
          signal,
        })
      ).toBeUndefined();
      expect(lastDiagnostic()).toMatchObject({
        type: "authorization",
        callback: "subscription",
        outcome: other === foreignConversation ? "correlation_mismatch" : "watch_authority_refused",
      });
    }
    const event = program.definitions[0];
    if (event === undefined) throw new Error("Missing event.");
    const scope = await program.authorizeSubscription({
      account,
      event: "mail.wake",
      arguments: { address: name, ticket },
      invocation: { ...identity(), auth: invocation.auth, client: invocation.client },
      signal,
    });
    if (scope === undefined) throw new Error("Subscription was refused.");
    expect(lastDiagnostic()).toMatchObject({
      type: "authorization",
      callback: "subscription",
      outcome: "scope_returned",
    });
    await server.runPromise(
      Effect.flatMap(Bus.Bus, (bus) =>
        bus.publish({ from: sender, session: sender, to: [name], body: "body-not-in-event" })
      )
    );
    const captured = await event.source.sample({
      principal: scope,
      filter: { address: name, ticket },
      checkpoint: undefined,
      reason: "activation",
      revision: 7,
      generation: 11,
      waitMs: 0,
      signal,
    });
    expect(captured.kind).toBe("occurrence");
    expect(JSON.stringify(captured)).not.toContain("body-not-in-event");
    const delivery = { event: "mail.wake", arguments: { address: name, ticket }, signal };
    const foreign = await identityService.resolveAuthorized(foreignConversation);
    if (foreign.session === undefined) throw new Error("Missing foreign session.");
    const binding = Schema.decodeUnknownSync(WakeBinding)(scope.binding);
    for (const secret of [ticket, ...Object.values(binding)])
      expect(lines.join("\n").includes(secret)).toBe(false);
    expect(
      await program.authorizeDelivery(
        {
          ...scope,
          binding: { ...binding, session: foreign.session },
        },
        delivery
      )
    ).toEqual({ allowed: false });
    expect(lastDiagnostic()).toMatchObject({
      type: "authorization",
      callback: "delivery",
      outcome: "native_binding_failed",
    });
    const read = await call("bus_read", { address: name });
    expect("structuredContent" in read ? read.structuredContent : undefined).toMatchObject({
      messages: [{ body: "body-not-in-event" }],
    });
    await call("bus_activity", {
      address: name,
      operation: Bun.randomUUIDv7(),
      activity: "inactive",
      mutes: [{ scope: "programme" }],
    });
    expect(await program.authorizeDelivery(scope, delivery)).toEqual({ allowed: true });
    await server.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        for (let i = 0; i < 1025; i++) {
          yield* ledger.append(
            new Message({
              id: `events-capacity-${i}`,
              from: sender,
              to: [name],
              body: "unread",
              kind: "message",
              ts: "2026-01-01T00:00:00Z",
            })
          );
        }
      })
    );
    expect(await program.authorizeDelivery(scope, delivery)).toEqual({ allowed: true });
    await call("bus_activity", {
      address: name,
      operation: Bun.randomUUIDv7(),
      activity: "active",
      mutes: [],
    });
    await expect(
      event.source.sample({
        principal: scope,
        filter: { address: name, ticket },
        checkpoint: undefined,
        reason: "restart",
        revision: 8,
        generation: 11,
        waitMs: 0,
        signal,
      })
    ).rejects.toThrow();
    expect(await program.authorizeDelivery(scope, delivery)).toEqual({ allowed: true });
    await call("bus_read", { address: name });
    await call("bus_leave", { address: name });
    await call("bus_join", { address: name });
    expect(await program.authorizeDelivery(scope, delivery)).toEqual({ allowed: false });
    expect(lastDiagnostic()).toMatchObject({
      type: "authorization",
      callback: "delivery",
      outcome: "native_binding_failed",
    });
    const refresh = (ticket: string) =>
      program.authorizeSubscription({
        account,
        event: "mail.wake",
        arguments: { address: name, ticket },
        invocation: { ...identity(), auth: invocation.auth, client: invocation.client },
        signal,
      });
    expect(await refresh(ticket)).toBeUndefined();
    expect(lastDiagnostic()).toMatchObject({
      type: "authorization",
      callback: "subscription",
      outcome: "native_observation_failed",
    });
    const newPrepared = await prepare.execute({ address: name }, { ...invocation, actor });
    expect(newPrepared.isError).not.toBe(true);
    const newArgs = newPrepared.structuredContent?.arguments;
    if (
      typeof newArgs !== "object" ||
      newArgs === null ||
      !("ticket" in newArgs) ||
      typeof newArgs.ticket !== "string"
    )
      throw new Error("Missing replacement watch ticket.");
    expect(newArgs.ticket !== ticket).toBe(true);
    expect(await refresh(ticket)).toBeUndefined();
    expect(lastDiagnostic()).toMatchObject({
      type: "authorization",
      callback: "subscription",
      outcome: "watch_authority_refused",
    });
    expect(await refresh(newArgs.ticket)).toBeDefined();
    const restarted = eventsProgram({
      identity: identityService,
      wake: peer.wake,
      authority,
      resource,
      diagnostics,
      storage: {
        path: eventsPath,
        maxBytes: 1_048_576,
        encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      },
    });
    expect(await restarted.authorizeDelivery(scope, delivery)).toEqual({ allowed: false });
  } finally {
    try {
      await authority?.close();
    } finally {
      await peer.dispose();
    }
  }
}, 120_000);

type Published = {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: (options: { readonly target: "draft-2020-12" | "draft-07" }) => unknown;
      readonly output: (options: { readonly target: "draft-2020-12" | "draft-07" }) => unknown;
    };
  };
};
const published = (schema: Published) =>
  (["draft-2020-12", "draft-07"] as const).map((target) => ({
    target,
    input: schema["~standard"].jsonSchema.input({ target }),
    output: schema["~standard"].jsonSchema.output({ target }),
  }));
/** The service's host configuration for a fixture listener; instructions come from here. */
const fixtureHost = (hostPort: number) =>
  hostConfig(
    decodeServiceConfig({
      schema: "agent-bus-private-web-v2",
      baseUrl: "https://fixture.invalid",
      resource,
      port: hostPort,
      principals: [{ subject, grantFile: "/first" }],
      provider: {
        issuer,
        userInfo: `${issuer}/userinfo`,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
      },
      sessionKeyFile: "/key",
      binding: "fixture",
      sources: {
        fixture: { port, expectedBusVersion: "hosted-fixture" },
        live: { port: hostPort === 1 ? 2 : 1, expectedBusVersion: "unused" },
      },
      oauth: {
        clientId: "fixture",
        clientSecret: "fixture",
        jwtSigningKey: "fixture",
        encryptionKey: "fixture",
        tokenStorageDir: "/oauth",
        allowedRedirectUris: ["https://fixture.invalid/callback"],
      },
    })
  );

/**
 * What the pinned host is handed to publish for one profile: the ordered tool catalogue with
 * descriptions, annotations and both schema drafts, the skill files by canonical URI and
 * content hash, and any Events definitions. Deep-copied at capture, so later mutation of the
 * live objects cannot change an earlier snapshot.
 */
const hostedSurface = (
  tools: ReadonlyArray<DirectTool<PeerActor>>,
  lifecycle: { readonly skills: ReadonlyArray<StaticSkill>; readonly events?: EventsProgram }
) =>
  structuredClone({
    instructions: fixtureHost(1).instructions,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
      meta: tool._meta,
      timeoutMs: tool.timeoutMs,
      parameters: published(tool.parameters),
      output: tool.outputSchema === undefined ? undefined : published(tool.outputSchema),
    })),
    resources: lifecycle.skills.flatMap((skill) =>
      Object.entries(skill.files).map(([path, text]) => ({
        uri: new URL(path, skill.uri).href,
        sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
      }))
    ),
    events:
      lifecycle.events === undefined
        ? undefined
        : {
            namespace: lifecycle.events.namespace,
            limits: lifecycle.events.limits,
            definitions: lifecycle.events.definitions.map((definition) => ({
              name: definition.name,
              description: definition.description,
              input: published(definition.inputSchema),
              payload: published(definition.payloadSchema),
            })),
          },
  });

const freePort = () => {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const value = Number(listener.url.port);
  listener.stop(true);
  return value;
};
const asRecord = { parse: (value: unknown) => value as Record<string, unknown> };
/** What a modern client discovers through the real host; request ids never enter it. */
const wireSurface = async (client: ModernHttp) => {
  const discovered = await client.discover();
  const tools = await client.listTools();
  const listed = await client.request({ method: "resources/list", params: {} }, asRecord);
  expect([tools.nextCursor, listed.nextCursor]).toEqual([undefined, undefined]);
  const resources = [];
  for (const item of listed.resources as ReadonlyArray<{ readonly uri: string }>) {
    const read = await client.request(
      { method: "resources/read", params: { uri: item.uri } },
      asRecord
    );
    resources.push({
      item,
      contents: (read.contents as ReadonlyArray<Record<string, unknown>>).map(
        ({ text, blob, ...rest }) => ({
          ...rest,
          sha256: new Bun.CryptoHasher("sha256").update(String(text ?? blob)).digest("hex"),
        })
      ),
    });
  }
  return structuredClone({ discovered, tools: tools.tools, resources });
};

test("each hosted profile's catalogue is identical across ordinary mail and a fresh rediscovery", async () => {
  const eventsPath = join(dir, "catalogue-events.sqlite");
  writeFileSync(eventsPath, "", { mode: 0o600, flag: "wx" });
  initializeWatchAuthority({ eventsPath, resource });
  const authority = new WatchAuthority({ eventsPath, resource });
  const identityService = clerkPeerIdentity({
    issuer,
    resource,
    key,
    principals: [{ subject, grantFile: "/first" }],
    identify: async () => subject,
    readGrant: async () => grant,
  });
  const profiles = {
    tools: {},
    events: {
      prepareWatch: (wake: ReturnType<typeof wakePort>) =>
        prepareWatchTool({ identity: identityService, wake, authority }),
      events: (wake: ReturnType<typeof wakePort>) =>
        eventsProgram({
          identity: identityService,
          wake,
          authority,
          resource,
          storage: {
            path: join(dir, "catalogue-events-host.sqlite"),
            maxBytes: 1_048_576,
            encryptionKey: Buffer.alloc(32, 1).toString("base64"),
          },
        }),
    },
  };
  const apiKey = Buffer.alloc(32, 5).toString("hex");
  type HostInput = Parameters<Parameters<typeof servePeer>[0]["runHost"]>;
  /**
   * Starts the peer as the service does. The tools-only profile runs behind the real direct
   * host on loopback with a synthetic API key; the shutdown signal is passed, so the host
   * installs no process signal handlers, and the fixture lifts only the HTTP rate limit.
   * The host refuses Events without native OAuth HTTP, so that profile is held open at the
   * host boundary instead and its mail goes through the handed tools.
   */
  const discover = async (profile: keyof typeof profiles) => {
    const hostPort = freePort();
    const shutdown = new AbortController();
    let handed: ((value: HostInput) => void) | undefined;
    const ready = new Promise<HostInput>((settle) => {
      handed = settle;
    });
    const base = fixtureHost(hostPort);
    const held = new Promise<void>((settle) =>
      shutdown.signal.addEventListener("abort", () => settle(), { once: true })
    );
    const serving = servePeer({
      busPort: port,
      expectedBusVersion: "hosted-fixture",
      cwd: process.cwd(),
      resolveContext: resolve,
      signal: shutdown.signal,
      ...profiles[profile],
      runHost: async (tools, lifecycle) => {
        handed?.([tools, lifecycle]);
        if (profile !== "tools") return held;
        return serveTools(
          {
            ...base,
            serverAuth: { type: "apiKey", key: apiKey },
            httpLimits: { ...base.httpLimits, rate: { requestsPerSecond: 1000, burst: 1000 } },
          },
          tools,
          {
            ...lifecycle,
            resolveContext: (invocation) =>
              lifecycle.resolveContext({
                ...invocation,
                auth: { authType: "oauth", accessToken: "good" },
              }),
          }
        );
      },
    });
    const ended = serving.then(() => {
      throw new Error("The peer ended before discovery.");
    });
    // After a deliberate close the peer ends normally; only an early end is a failure.
    ended.catch(() => undefined);
    const [tools, lifecycle] = await Promise.race([ready, ended]);
    const connect = async () => {
      let last: unknown;
      for (let attempt = 0; attempt < 50; attempt++) {
        const client = modernHttp(
          `http://127.0.0.1:${hostPort}/mcp`,
          "catalogue-stability",
          { "x-api-key": apiKey },
          { name: base.name, version: base.version }
        );
        try {
          await client.discover();
          return client;
        } catch (error) {
          last = error;
          await Bun.sleep(100);
        }
      }
      throw last;
    };
    const client = profile === "tools" ? await Promise.race([connect(), ended]) : undefined;
    return {
      client,
      tools,
      surface: () => hostedSurface(tools, lifecycle),
      wire: async () => (client === undefined ? undefined : wireSurface(client)),
      close: () => {
        shutdown.abort();
        return serving;
      },
    };
  };
  const handlers = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const handlersBefore = handlers();
  try {
    for (const profile of ["tools", "events"] as const) {
      const first = await discover(profile);
      try {
        const before = first.surface();
        const wireBefore = await first.wire();
        // The in-process host must not take over this process's signal handling.
        expect(handlers()).toEqual(handlersBefore);
        expect(before.tools.length).toBe(profile === "tools" ? 17 : 18);
        expect(before.events?.definitions.length).toBe(profile === "tools" ? undefined : 1);
        expect(before.resources.map(({ uri }) => uri)).toContain("skill://agent-bus/SKILL.md");
        if (profile === "tools") {
          if (wireBefore === undefined) throw new Error("Missing host discovery.");
          expect(wireBefore.tools.map(({ name }) => name)).toEqual(
            before.tools.map(({ name }) => name)
          );
          expect(wireBefore.resources.map(({ item }) => item.uri)).toContain(
            "skill://agent-bus/SKILL.md"
          );
        }

        const ok = async (name: string, args: Record<string, unknown>, chat: string) => {
          const correlation = `catalogue-${profile}-${chat}`;
          if (first.client !== undefined) {
            const result = await first.client.callTool({
              name,
              arguments: args,
              _meta: { "openai/session": correlation },
            });
            expect(result.isError).not.toBe(true);
            return result.structuredContent;
          }
          const tool = first.tools.find((candidate) => candidate.name === name);
          if (!tool) throw new Error(`missing ${name}`);
          const result = await tool.execute(args, {
            actor: await resolve(identity(correlation)),
            signal,
            auth: undefined,
            client: { version: undefined },
          });
          expect(result.isError).not.toBe(true);
          return "structuredContent" in result ? result.structuredContent : undefined;
        };
        const [a, b] = [`chatgpt/catalogue-${profile}-a`, `chatgpt/catalogue-${profile}-b`];
        await ok("bus_join", { address: a, topics: [`catalogue-${profile}`] }, "a");
        await ok("bus_join", { address: b }, "b");
        const sent = await ok("bus_publish", { from: b, to: [a], body: "one" }, "b");
        await ok("bus_publish", { from: a, to: [`#catalogue-${profile}`], body: "two" }, "a");
        expect(await ok("bus_read", { address: a }, "a")).toMatchObject({
          messages: [{ id: sent?.id }],
        });
        await ok("bus_wait", { address: b, timeoutSeconds: 0 }, "b");
        await ok(
          "bus_activity",
          { address: a, operation: Bun.randomUUIDv7(), activity: "inactive" },
          "a"
        );
        await ok("bus_history", { participant: a }, "a");
        await ok("bus_leave", { address: a }, "a");
        await ok("bus_leave", { address: b }, "b");

        expect(first.surface()).toEqual(before);
        expect(await first.wire()).toEqual(wireBefore);
        const fresh = await discover(profile);
        try {
          expect(fresh.surface()).toEqual(before);
          expect(await fresh.wire()).toEqual(wireBefore);
        } finally {
          await fresh.close();
        }
      } finally {
        await first.close();
      }
    }
    expect(handlers()).toEqual(handlersBefore);
  } finally {
    await authority.close();
  }
}, 60_000);
