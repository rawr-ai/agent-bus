// Every new message entry fits one reader's carrier, so no committed mail can block a hosted
// reader; its body and subject are each within the 32,768-byte limit for searchable text, so no
// committed mail can break the ledger's full-text index; a joined cwd is bounded up front; and the
// complete hosted read result, as the hosted client receives it over HTTP, stays within 4 MiB. Real Bus and Fluree behind the native MCP
// endpoint, the production hosted peer (busPeer + peerTools) behind the real mcp-openapi host,
// and the JSONL test ledger for storage independence.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { serveTools } from "mcp-openapi";
import { modernRequest } from "../scripts/private-modern-http.ts";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Message, Origin, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { Messages } from "../src/mcp.ts";
import {
  MAX_ENTRY_CARRIER_BYTES,
  MAX_INDEXED_FIELD_BYTES,
  MAX_ORIGIN_CWD_BYTES,
  messageCarrierBytes,
} from "../src/message-carrier.ts";
import type { PeerActor } from "../src/private-web/identity.ts";
import { busPeer, peerTools } from "../src/private-web/peer.ts";
import type { QueryGateway } from "../src/Query.ts";
import * as Serve from "../src/serve.ts";
import { flureeFetch, freshLedger } from "./fluree-server.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

/** The complete hosted result ceiling the peer promises, measured as HTTP response-body bytes. */
const HOSTED_RESULT_BYTES = 4 * 1024 * 1024;
const CAP = MAX_ENTRY_CARRIER_BYTES;
const VERSION = "carrier-fixture";
const HOST = "fixture-host";
const READ_REFUSAL =
  "The oldest unread messages cannot fit this read's limits without splitting a commit; the cursor was not advanced. Use a reader with larger limits.";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-carrier-"));
const senderCwd = join(dir, "sender");
mkdirSync(senderCwd);
const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  return port;
};
const busPort = freePort();
const hostPort = freePort();
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const busOn = (ledger: Layer.Layer<Ledger | QueryGateway, unknown, never>, cursors: string) =>
  Bus.layer("fixture", () => HOST).pipe(
    Layer.provideMerge(ledger),
    Layer.provideMerge(Cursors.layerFiles(cursors)),
    Layer.provide(platform)
  );
const carrierLedger = await freshLedger("carrier");
const store = layerFluree(carrierLedger).pipe(Layer.provide(platform));
const server = ManagedRuntime.make(
  Serve.layerHttp({ port: busPort, version: VERSION }).pipe(
    Layer.provideMerge(busOn(store, join(dir, "cursors")))
  )
);
const jsonlFile = join(dir, "jsonl", "ledger.jsonl");
const jsonl = ManagedRuntime.make(
  busOn(layerJsonl(jsonlFile).pipe(Layer.provide(platform)), join(dir, "jsonl-cursors"))
);
const client = new Client({ name: "carrier-fixture", version: "1.0.0" });
const injected: Array<unknown> = [];
const apiKey = `fixture-${Bun.randomUUIDv7()}`;
const stopHost = new AbortController();
let peer: Awaited<ReturnType<typeof busPeer>> | undefined;
let host: Promise<void> | undefined;
beforeAll(async () => {
  await server.runPromise(Effect.void);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${busPort}/mcp`))
  );
  await nativeOk("bus_join", {
    address: sender,
    session: sender,
    runtime: "other",
    cwd: senderCwd,
  });
  peer = await busPeer({ busPort, expectedBusVersion: VERSION });
  const exchange = peer.exchange;
  // The production tools, with a passthrough that records the budget they inject.
  const tools = peerTools(async (name, args, signal) => {
    if (name === "bus_read" || name === "bus_wait") injected.push(args.maxResultBytes);
    return exchange(name, args, signal);
  }, dir);
  const ready = Promise.withResolvers<void>();
  host = serveTools<PeerActor>(
    {
      name: "Agent Bus",
      version: "1.0.0",
      transport: "httpStream",
      host: "127.0.0.1",
      port: hostPort,
      endpoint: "/mcp",
      serverAuth: { type: "apiKey", key: apiKey },
    },
    tools,
    {
      signal: stopHost.signal,
      onReady: () => ready.resolve(),
      resolveContext: (identity) => {
        const session = identity.requestMeta?.["fixture/session"];
        return { session: typeof session === "string" ? session : undefined };
      },
    }
  );
  host.catch((error: unknown) => ready.reject(error));
  await ready.promise;
});
afterAll(async () => {
  stopHost.abort();
  await host?.catch(() => undefined);
  await peer?.dispose();
  await client.close();
  await server.dispose();
  await jsonl.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// ---- callers ----------------------------------------------------------------------------------

const native = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
const field = (value: unknown, key: string) =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
const textOf = (result: unknown) => {
  const content = field(result, "content");
  const first = Array.isArray(content) ? content[0] : undefined;
  return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
};
const nativeOk = async (name: string, args: Record<string, unknown>) => {
  const result = await native(name, args);
  if (result.isError) throw new Error(`${name} refused: ${textOf(result).slice(0, 300)}`);
  return result;
};

let requestId = 0;
/** One tools/call through the real hosted MCP host, with the response body's exact size. */
const hosted = async (name: string, args: Record<string, unknown>, session: string) => {
  const response = await modernRequest(
    `http://127.0.0.1:${hostPort}/mcp`,
    "carrier-hosted-client",
    ++requestId,
    "tools/call",
    { name, arguments: args, _meta: { "fixture/session": session } },
    { "x-api-key": apiKey }
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type") ?? "").toContain("application/json");
  const raw = await response.text();
  const body = JSON.parse(raw) as {
    result?: {
      content?: unknown;
      structuredContent?: unknown;
      isError?: boolean;
      [key: string]: unknown;
    };
  };
  if (body.result === undefined) throw new Error(`${name}: no result`);
  return { result: body.result, bytes: Buffer.byteLength(raw, "utf8") };
};
const hostedOk = async (name: string, args: Record<string, unknown>, session: string) => {
  const call = await hosted(name, args, session);
  if (call.result.isError === true)
    throw new Error(`hosted ${name} refused: ${textOf(call.result).slice(0, 300)}`);
  return call;
};
const pageOf = (result: unknown) =>
  Schema.decodeUnknownSync(Messages)(field(result, "structuredContent")).messages;

// ---- ledger state (nonconsuming) --------------------------------------------------------------

const head = () => server.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.end));
const entriesAfter = async (from: number) =>
  (await server.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.read(from)))).entries;
const cursor = async (address: string) => {
  const result = await server.runPromise(
    Effect.flatMap(Cursors.Cursors, (cursors) => cursors.get(address))
  );
  if (result._tag !== "Some") throw new Error("Missing cursor.");
  return result.value;
};
/** A refused write: an error result, and no commit at all by a nonconsuming head read. */
const refusedWithoutWrite = async (attempt: () => Promise<unknown>) => {
  const before = await head();
  const result = await attempt();
  expect(field(result, "isError")).toBe(true);
  expect(await head()).toBe(before);
  return textOf(result);
};

// ---- sizing -----------------------------------------------------------------------------------

const sender = "fixture/carrier-sender";
/** A stand-in with the fixed-width fields the server writes (UUIDv7 id, millisecond ISO ts). */
const template = (to: ReadonlyArray<string>, body: string, from = sender, cwd = senderCwd) =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from,
    to: [...to],
    kind: "message",
    body,
    origin: new Origin({ host: HOST, cwd }),
  });
/**
 * A recipient that names no peer. Recipients are not searchable text, so with the body and
 * subject each held to 32,768 bytes, they are what carries a message to the carrier cap.
 */
const padding = (bytes: number) => `fixture/pad-${"p".repeat(bytes)}`;
/** The carrier bytes left to the body once the padding recipient takes the rest. */
const BODY_ROOM = 16_384;
type Shape = { readonly to: ReadonlyArray<string>; readonly body: string };
/**
 * Recipients and a body for the last of `prefix` + one more message to `recipient` such that the
 * list's carrier is exactly `target`: a padding recipient, then `unit` repeated, padded with 'a'
 * (2 bytes) and at most one newline (5 bytes).
 */
const fit = (
  recipient: string,
  unit: string,
  target: number,
  prefix: ReadonlyArray<Message> = [],
  from = sender,
  cwd = senderCwd
): Shape => {
  const size = (to: ReadonlyArray<string>, body: string) =>
    messageCarrierBytes([...prefix, template(to, body, from, cwd)]);
  // Each padding byte is carried twice, once in each copy.
  const pad = Math.floor((target - size([recipient, padding(0)], "") - BODY_ROOM) / 2);
  const to = [recipient, padding(pad)];
  const room = target - size(to, "");
  const unitCost = size(to, unit) - size(to, "");
  for (let count = Math.floor(room / unitCost); count >= 0; count--) {
    const rest = room - count * unitCost;
    const body =
      rest % 2 === 0
        ? unit.repeat(count) + "a".repeat(rest / 2)
        : rest >= 5
          ? `${unit.repeat(count)}\n${"a".repeat((rest - 5) / 2)}`
          : undefined;
    if (body === undefined) continue;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_INDEXED_FIELD_BYTES);
    return { to, body };
  }
  throw new Error("Unreachable target.");
};
const shaped = ({ to, body }: Shape, from = sender, cwd = senderCwd) =>
  template(to, body, from, cwd);
const UNITS = {
  ascii: "plain ascii words ",
  escapes: '"\\\n\t',
  nonAscii: "€漢字é🙂",
} as const;
const observations: Record<string, unknown> = {};

// ---- per-entry admission ----------------------------------------------------------------------

test("publish admits a message at exactly the carrier cap and refuses one byte over, writing nothing", async () => {
  const recipient = "fixture/carrier-reader";
  await nativeOk("bus_join", {
    address: recipient,
    session: recipient,
    runtime: "other",
    cwd: senderCwd,
  });
  const refusals = new Set<string>();
  for (const [label, unit] of Object.entries(UNITS)) {
    const exact = fit(recipient, unit, CAP);
    const before = await head();
    const sent = await nativeOk("bus_publish", {
      from: sender,
      session: sender,
      to: exact.to,
      body: exact.body,
    });
    const id = (sent.structuredContent as { id: string }).id;
    const committed = (await entriesAfter(before)).map((entry) => entry.message);
    expect(committed.map((message) => message.id)).toEqual([id]);
    expect(committed[0]?.body).toBe(exact.body);
    // The bound is on the exact public carrier of the stored entry, escaping included: the
    // reader's actual result for it alone is CAP bytes, refused one byte short of that.
    expect(messageCarrierBytes(committed)).toBe(CAP);
    const short = await native("bus_read", {
      address: recipient,
      session: recipient,
      maxResultBytes: CAP - 1,
    });
    expect(short.isError).toBe(true);
    expect(textOf(short)).toContain(READ_REFUSAL);
    const read = await nativeOk("bus_read", {
      address: recipient,
      session: recipient,
      maxResultBytes: CAP,
    });
    expect(pageOf(read).map((message) => message.id)).toEqual([id]);
    const carried = { content: read.content, structuredContent: read.structuredContent };
    expect(Buffer.byteLength(JSON.stringify({ ...carried, isError: false }), "utf8")).toBe(CAP);

    const over = fit(recipient, unit, CAP + 1);
    expect(messageCarrierBytes([shaped(over)])).toBe(CAP + 1);
    const text = await refusedWithoutWrite(() =>
      native("bus_publish", { from: sender, session: sender, to: over.to, body: over.body })
    );
    expect(text).toContain(`${CAP + 1} bytes, over the ${CAP}-byte limit`);
    expect(text).toContain("Nothing was sent");
    refusals.add(text);
    observations[`${label}.exactBodyUtf8Bytes`] = Buffer.byteLength(exact.body, "utf8");
  }
  // Every variant reports the same measured size, so the texts are identical.
  expect(refusals.size).toBe(1);
  // A pierce of all is refused for size before it can offer a NOT_SENT digest to confirm.
  const over = fit(recipient, UNITS.ascii, CAP + 1);
  const pierced = await refusedWithoutWrite(() =>
    native("bus_publish", {
      from: sender,
      session: sender,
      to: over.to,
      body: over.body,
      pierce: "all",
    })
  );
  expect(refusals.has(pierced)).toBe(true);
}, 300_000);

test("a hosted publish is refused with the same reason, and an over-wide join cwd is refused up front", async () => {
  const session = "carrier-hosted-sender";
  const from = "chatgpt/carrier-sender";
  await hostedOk("bus_join", { address: from }, session);
  const recipient = "fixture/carrier-reader";
  const over = fit(recipient, UNITS.ascii, CAP + 1, [], from, dir);
  const before = await head();
  const refused = await hosted("bus_publish", { from, to: over.to, body: over.body }, session);
  expect(refused.result.isError).toBe(true);
  expect(await head()).toBe(before);
  expect(textOf(refused.result)).toContain(`${CAP + 1} bytes, over the ${CAP}-byte limit`);
  const exact = fit(recipient, UNITS.ascii, CAP, [], from, dir);
  await hostedOk("bus_publish", { from, to: exact.to, body: exact.body }, session);

  // UTF-8 bytes, not characters: 2-byte é makes 2,049 characters 4,097 bytes.
  const wide = `/${"é".repeat(2048)}`;
  const widest = `/${"é".repeat(2047)}a`;
  expect(Buffer.byteLength(wide, "utf8")).toBe(MAX_ORIGIN_CWD_BYTES + 1);
  expect(Buffer.byteLength(widest, "utf8")).toBe(MAX_ORIGIN_CWD_BYTES);
  const address = "fixture/carrier-wide-join";
  const text = await refusedWithoutWrite(() =>
    native("bus_join", { address, session: address, runtime: "other", cwd: wide })
  );
  expect(text).toContain(`cannot exceed ${MAX_ORIGIN_CWD_BYTES} UTF-8 bytes`);
  await nativeOk("bus_join", { address, session: address, runtime: "other", cwd: widest });
  // The widest admitted directory still leaves room to send.
  await nativeOk("bus_publish", { from: address, session: address, to: [recipient], body: "ok" });
}, 300_000);

test("directory and bulletin notices that cannot fit commit nothing, and every message is its own commit", async () => {
  // An owner whose presence predates the cwd bound, written directly to the disposable ledger.
  const legacy = "fixture/carrier-legacy-wide";
  const wideCwd = `/${'"'.repeat(180_000)}`;
  await server.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const read = yield* ledger.presenceAt();
      const admission = yield* ledger.admit(
        new Message({
          id: Bun.randomUUIDv7(),
          ts: new Date().toISOString(),
          from: legacy,
          to: ["*"],
          kind: "presence",
          body: `${legacy} joined`,
          origin: new Origin({ host: HOST, cwd: wideCwd }),
          presence: new Presence({
            runtime: "other",
            status: "joined",
            topics: [],
            session: legacy,
          }),
        }),
        read.cut
      );
      if (admission.status !== "ADMITTED") throw new Error("Legacy presence not admitted.");
    })
  );
  const start = await head();
  const directory = {
    id: "carrier-directory",
    name: "Carrier directory",
    aliases: [],
    concerns: [],
  };
  const directoryRefusal = await refusedWithoutWrite(() =>
    native("bus_directory", {
      from: legacy,
      session: legacy,
      operation: Bun.randomUUIDv7(),
      expected: null,
      directory,
      audience: ["fixture/carrier-reader"],
    })
  );
  expect(directoryRefusal).toContain(`over the ${CAP}-byte limit`);
  const bulletinRefusal = await refusedWithoutWrite(() =>
    native("bus_bulletin", {
      from: legacy,
      session: legacy,
      operation: Bun.randomUUIDv7(),
      expected: null,
      scope: { kind: "programme" },
      action: "publish",
      body: "Bounded bulletin body.",
    })
  );
  expect(bulletinRefusal).toContain(`over the ${CAP}-byte limit`);
  const publishRefusal = await refusedWithoutWrite(() =>
    native("bus_publish", { from: legacy, session: legacy, to: [sender], body: "tiny" })
  );
  expect(publishRefusal).toContain("Nothing was sent");

  // The same first registrations then apply from an ordinary owner: no designation, record or
  // notice was left behind (expected: null would otherwise conflict).
  const registered = await nativeOk("bus_directory", {
    from: sender,
    session: sender,
    operation: Bun.randomUUIDv7(),
    expected: null,
    directory,
    audience: ["fixture/carrier-reader"],
  });
  expect(registered.structuredContent).toMatchObject({ status: "APPLIED" });
  const bulletin = await nativeOk("bus_bulletin", {
    from: sender,
    session: sender,
    operation: Bun.randomUUIDv7(),
    expected: null,
    scope: { kind: "programme" },
    action: "publish",
    body: "Bounded bulletin body.",
  });
  expect(bulletin.structuredContent).toMatchObject({ status: "APPLIED" });

  // One message entry per commit, which the per-entry bound relies on, across every message
  // committed in this file: publishes, the hosted publish and both notices.
  const messages = (await entriesAfter(0)).filter((entry) => entry.message.kind === "message");
  expect(messages.length).toBeGreaterThanOrEqual(2);
  expect(new Set(messages.map((entry) => entry.end)).size).toBe(messages.length);
  expect(
    (await entriesAfter(start)).filter((entry) => entry.message.kind === "message")
  ).toHaveLength(2);
}, 300_000);

test("an oversized entry from before the bound stays readable natively and refuses the hosted read", async () => {
  const session = "carrier-legacy-reader";
  const reader = "chatgpt/carrier-legacy-reader";
  await hostedOk("bus_join", { address: reader }, session);
  // Written directly, bypassing admission: larger than any hosted read budget through its
  // recipients, since the ledger itself refuses searchable text over its limit.
  const body = "An entry from before the carrier bound.";
  const old = template([reader, padding(HOSTED_RESULT_BYTES / 2 + 1024)], body);
  expect(messageCarrierBytes([old])).toBeGreaterThan(HOSTED_RESULT_BYTES);
  await server.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.append(old)));
  const later = await nativeOk("bus_publish", {
    from: sender,
    session: sender,
    to: [reader],
    body: "Normal mail after the oversized entry.",
  });
  const laterId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
    later.structuredContent
  ).id;
  const saved = await cursor(reader);
  const read = await hosted("bus_read", { address: reader }, session);
  expect(read.result.isError).toBe(true);
  expect(textOf(read.result)).toContain(READ_REFUSAL);
  const wait = await hosted("bus_wait", { address: reader, timeoutSeconds: 1 }, session);
  expect(wait.result.isError).toBe(true);
  expect(textOf(wait.result)).toContain(READ_REFUSAL);
  expect(await cursor(reader)).toBe(saved);
  // The same synthetic holder's native read has no byte admission and drains the first group.
  const drained = await nativeOk("bus_read", { address: reader, session, limit: 1 });
  const messages = pageOf(drained);
  expect(messages.map((message) => message.id)).toEqual([old.id]);
  expect(messages[0]?.body).toBe(body);
  expect(Bun.hash(JSON.stringify(messages[0]?.to))).toBe(Bun.hash(JSON.stringify(old.to)));
  expect(await cursor(reader)).toBeGreaterThan(saved);
  const resumed = await hostedOk("bus_read", { address: reader }, session);
  expect(pageOf(resumed.result).map((message) => message.id)).toEqual([laterId]);
}, 300_000);

// ---- the complete hosted result ---------------------------------------------------------------

/** Publishes five messages to `reader` whose combined carrier is exactly `target`. */
const fillTo = async (reader: string, target: number) => {
  const share = Math.floor(target / 5);
  const shapes: Array<Shape> = [];
  const prefix: Array<Message> = [];
  for (let i = 0; i < 4; i++) {
    const shape = fit(reader, UNITS.ascii, share);
    shapes.push(shape);
    prefix.push(shaped(shape));
  }
  shapes.push(fit(reader, UNITS.escapes, target, prefix));
  const before = await head();
  for (const { to, body } of shapes)
    await nativeOk("bus_publish", { from: sender, session: sender, to, body });
  const committed = (await entriesAfter(before)).map((entry) => entry.message);
  expect(committed.map((message) => message.body)).toEqual(shapes.map((shape) => shape.body));
  expect(committed.every((message) => messageCarrierBytes([message]) <= CAP)).toBe(true);
  expect(messageCarrierBytes(committed)).toBe(target);
  return committed;
};

test("the largest admitted hosted read fits 4 MiB as received over HTTP; one carrier byte more is not taken", async () => {
  const session = "carrier-boundary-reader";
  const exactReader = "chatgpt/carrier-boundary-exact";
  const overReader = "chatgpt/carrier-boundary-over";
  await hostedOk("bus_join", { address: exactReader }, session);
  await hostedOk("bus_join", { address: overReader }, session);
  injected.length = 0;
  const empty = await hostedOk("bus_read", { address: exactReader }, session);
  expect(pageOf(empty.result)).toEqual([]);
  const [budget] = injected;
  if (typeof budget !== "number") throw new Error("No injected read budget.");
  expect(budget).toBeGreaterThanOrEqual(CAP);

  // Exactly at the budget: all five messages in one complete result within the ceiling.
  const exact = await fillTo(exactReader, budget);
  const largest = await hostedOk("bus_read", { address: exactReader }, session);
  expect(pageOf(largest.result).map((message) => Bun.hash(message.body))).toEqual(
    exact.map((message) => Bun.hash(message.body))
  );
  expect(largest.bytes).toBeLessThanOrEqual(HOSTED_RESULT_BYTES);
  observations.budget = budget;
  observations.largestCompleteResultBytes = largest.bytes;
  observations.overheadBytes = largest.bytes - budget;
  observations.resultKeys = Object.keys(largest.result).sort();

  // One byte over: the whole-prefix admission takes four and leaves the fifth unread.
  const over = await fillTo(overReader, budget + 1);
  const first = await hostedOk("bus_wait", { address: overReader, timeoutSeconds: 1 }, session);
  expect(pageOf(first.result).map((message) => message.id)).toEqual(
    over.slice(0, 4).map((message) => message.id)
  );
  expect(first.bytes).toBeLessThanOrEqual(HOSTED_RESULT_BYTES);
  const second = await hostedOk("bus_read", { address: overReader }, session);
  expect(pageOf(second.result).map((message) => message.id)).toEqual(
    over.slice(4).map((message) => message.id)
  );
  expect(new Set(injected)).toEqual(new Set([budget]));
  console.log(JSON.stringify(observations));
}, 300_000);

// ---- searchable text --------------------------------------------------------------------------

// Fluree 4.2.4 stores a full-text term's byte length and a value's distinct-term count in 16 bits
// (FTA1), so the body and the subject are each held to 32,768 UTF-8 bytes: bytes, not characters.
const L = MAX_INDEXED_FIELD_BYTES;
const fieldRefusal = (field: string, bytes: number) =>
  `This message's ${field} takes ${bytes} UTF-8 bytes, over the 32768-byte limit for searchable text. Nothing was sent or written. Keep it shorter and link to longer content (a file path, URL or commit).`;
const STORE_REFUSAL =
  "This entry's body or subject is over the 32768-byte limit for searchable text, so the ledger did not send it. Nothing was sent or written.";
type FieldCase = {
  readonly label: string;
  readonly body?: string;
  readonly subject?: string;
  /** The exact refusal, or undefined when it is admitted. */
  readonly refusal?: string;
};
const FIELD_CASES: ReadonlyArray<FieldCase> = [
  { label: "a body at the limit", body: "a".repeat(L) },
  { label: "a body one byte over", body: "a".repeat(L + 1), refusal: fieldRefusal("body", L + 1) },
  // 3-byte € and 4-byte 🙂: far fewer characters (and UTF-16 units) than the limit.
  { label: "a multibyte body at the limit", body: `${"€".repeat((L - 2) / 3)}ab` },
  {
    label: "a multibyte body over",
    body: "€".repeat((L + 1) / 3),
    refusal: fieldRefusal("body", L + 1),
  },
  {
    label: "an astral body over",
    body: `${"🙂".repeat(L / 4)}a`,
    refusal: fieldRefusal("body", L + 1),
  },
  { label: "a subject at the limit", body: "s", subject: "a".repeat(L) },
  {
    label: "a subject one byte over",
    body: "s",
    subject: "a".repeat(L + 1),
    refusal: fieldRefusal("subject", L + 1),
  },
  { label: "a multibyte subject at the limit", body: "s", subject: `${"€".repeat((L - 2) / 3)}ab` },
  {
    label: "a multibyte subject one byte over",
    body: "s",
    subject: "€".repeat((L + 1) / 3),
    refusal: fieldRefusal("subject", L + 1),
  },
  {
    label: "a multibyte subject over",
    body: "s",
    subject: "é".repeat(L / 2 + 1),
    refusal: fieldRefusal("subject", L + 2),
  },
];

test("publish admits a body or subject of 32,768 UTF-8 bytes and refuses one byte more, writing nothing", async () => {
  expect(L).toBe(32_768);
  const recipient = "fixture/searchable-reader";
  for (const { label, body = "s", subject, refusal } of FIELD_CASES) {
    // The multibyte cases are over in bytes only.
    if (refusal !== undefined && label.includes("multibyte"))
      expect((subject ?? body).length).toBeLessThan(L);
    const args = {
      from: sender,
      session: sender,
      to: [recipient],
      body,
      ...(subject === undefined ? {} : { subject }),
    };
    if (refusal === undefined) {
      const before = await head();
      const sent = await native("bus_publish", args);
      expect({ label, refused: sent.isError ? textOf(sent).slice(0, 120) : false }).toEqual({
        label,
        refused: false,
      });
      const committed = (await entriesAfter(before)).map((entry) => entry.message);
      expect(committed.map((message) => [message.body, message.subject])).toEqual([
        [body, subject],
      ]);
    } else {
      const text = await refusedWithoutWrite(() => native("bus_publish", args));
      expect({ label, text }).toEqual({ label, text: refusal });
    }
  }
}, 300_000);

test("the Fluree ledger itself refuses searchable text over the limit before sending", async () => {
  const run = <A, E>(effect: Effect.Effect<A, E, Ledger>) => server.runPromise(effect);
  const over = "a".repeat(L + 1);
  const bodyOver = template(["fixture/searchable-reader"], over);
  const subjectOver = new Message({
    ...template(["fixture/searchable-reader"], "s"),
    subject: over,
  });
  for (const message of [bodyOver, subjectOver]) {
    const before = await head();
    const error = await run(
      Effect.flip(Effect.flatMap(Ledger, (ledger) => ledger.append(message)))
    );
    expect({ tag: error._tag, message: error.message }).toEqual({
      tag: "InvalidQuery",
      message: STORE_REFUSAL,
    });
    expect(await head()).toBe(before);
  }
  // The presence admission and the designation behind the notices: definite, nothing sent.
  const before = await head();
  const presence = new Message({
    ...template(["*"], over),
    kind: "presence",
    presence: new Presence({ runtime: "other", status: "joined", topics: [], session: "s" }),
  });
  const admitted = await run(
    Effect.flip(
      Effect.flatMap(Ledger, (ledger) =>
        Effect.flatMap(ledger.presenceAt(), (read) => ledger.admit(presence, read.cut))
      )
    )
  );
  expect(admitted.message).toBe(STORE_REFUSAL);
  const designated = await run(
    Effect.flip(
      Effect.flatMap(Ledger, (ledger) =>
        ledger.designate({
          scope: { kind: "programme" },
          expected: null,
          operation: Bun.randomUUIDv7(),
          intent: "{}",
          record: "{}",
          notification: bodyOver,
        })
      )
    )
  );
  expect(designated.message).toBe(STORE_REFUSAL);
  expect(await head()).toBe(before);
  // At the limit the ledger sends it.
  await run(Effect.flatMap(Ledger, (ledger) => ledger.append(template([sender], "a".repeat(L)))));
  expect(await head()).toBe(before + 1);
}, 300_000);

/** The ledger's index time, polled until it covers `t`. */
const indexedThrough = async (t: number) => {
  const path = `/v1/fluree/info/${encodeURIComponent(carrierLedger.ledger)}`;
  for (let attempt = 0; attempt < 300; attempt++) {
    const info = (await (await flureeFetch(path)).json()) as { ledger: { "index-t": number } };
    if (info.ledger["index-t"] >= t) return info.ledger["index-t"];
    await Bun.sleep(100);
  }
  throw new Error(`The ledger was not indexed through t=${t}.`);
};

/** As many distinct short words as `bytes` holds: base-36 numbers, shortest first, then padded. */
const distinctWords = (bytes: number) => {
  const words: Array<string> = [];
  let used = -1;
  for (let i = 0; used + 1 + i.toString(36).length <= bytes; i++) {
    words.push(i.toString(36));
    used += 1 + i.toString(36).length;
  }
  const text = words.join(" ");
  return { text: text + "z".repeat(bytes - Buffer.byteLength(text, "utf8")), count: words.length };
};

test("the largest admitted searchable text leaves the indexed ledger readable and searchable", async () => {
  // Each field at exactly the limit: one message with an unbroken word for its body and the most
  // distinct words the limit holds for its subject, and one the other way round.
  const word = "a".repeat(L);
  const many = distinctWords(L);
  expect(Buffer.byteLength(many.text, "utf8")).toBe(L);
  const sends = [
    { body: word, subject: many.text },
    { body: many.text, subject: "b".repeat(L) },
  ];
  const before = await head();
  const ids: Array<string> = [];
  for (const args of sends) {
    const sent = await nativeOk("bus_publish", {
      from: sender,
      session: sender,
      to: ["fixture/searchable-reader"],
      ...args,
    });
    ids.push((sent.structuredContent as { id: string }).id);
  }
  const t = await head();
  expect(t).toBe(before + 2);
  await indexedThrough(t);
  // The complete history read, the one a full-text index fault breaks, still returns both whole.
  const entries = await entriesAfter(0);
  const stored = ids.map((id) => entries.find((entry) => entry.message.id === id)?.message);
  expect(
    stored.map((message) => [Bun.hash(message?.body ?? ""), Bun.hash(message?.subject ?? "")])
  ).toEqual(sends.map(({ body, subject }) => [Bun.hash(body), Bun.hash(subject)]));
  // And the public search scores both: one of the distinct words finds the first message by its
  // subject alone (its body is the unbroken word) and the second by its body.
  const probe = (many.count - 2).toString(36);
  const found = await nativeOk("bus_history", { query: probe, limit: 10 });
  const hits = pageOf(found).map((message) => message.id);
  expect(hits).toEqual(expect.arrayContaining(ids));
  expect(ids).toHaveLength(2);
  console.log(JSON.stringify({ distinctWordsAtLimit: many.count }));
}, 300_000);

// ---- storage independence ---------------------------------------------------------------------

test("the JSONL ledger admits and refuses exactly as Fluree does", async () => {
  const recipient = "fixture/carrier-reader";
  const joinFrom = (cwd: string) =>
    Effect.flatMap(Bus.Bus, (bus) =>
      bus.join({ address: sender, session: sender, runtime: "other", cwd })
    );
  const publish = ({ to, body }: Shape, subject?: string) =>
    Effect.flatMap(Bus.Bus, (bus) =>
      bus.publish({
        from: sender,
        session: sender,
        to: [...to],
        body,
        ...(subject === undefined ? {} : { subject }),
      })
    );
  const end = Effect.flatMap(Ledger, (ledger) => ledger.end);
  const exact = fit(recipient, UNITS.nonAscii, CAP);
  const over = fit(recipient, UNITS.nonAscii, CAP + 1);

  const empty = await jsonl.runPromise(end);
  const wideJoin = await jsonl.runPromise(Effect.flip(joinFrom(`/${"é".repeat(2048)}`)));
  expect(wideJoin.message).toContain(`cannot exceed ${MAX_ORIGIN_CWD_BYTES} UTF-8 bytes`);
  expect(await jsonl.runPromise(end)).toBe(empty);
  await jsonl.runPromise(joinFrom(senderCwd));
  const afterJoin = await jsonl.runPromise(end);
  await jsonl.runPromise(publish(exact));
  const afterCarrier = await jsonl.runPromise(end);
  expect(afterCarrier).toBeGreaterThan(afterJoin);
  // Searchable text at the limit is stored too.
  await jsonl.runPromise(publish({ to: [recipient], body: "a".repeat(L) }, "b".repeat(L)));
  const afterExact = await jsonl.runPromise(end);
  expect(afterExact).toBeGreaterThan(afterCarrier);

  // The carrier refusal, and each searchable-text refusal, from both stores.
  const refused: ReadonlyArray<[Shape, string | undefined]> = [
    [over, undefined],
    ...FIELD_CASES.filter((fieldCase) => fieldCase.refusal !== undefined).map(
      ({ body = "s", subject }): [Shape, string | undefined] => [{ to: [recipient], body }, subject]
    ),
  ];
  for (const [shape, subject] of refused) {
    const jsonlRefusal = await jsonl.runPromise(Effect.flip(publish(shape, subject)));
    expect(await jsonl.runPromise(end)).toBe(afterExact);
    const before = await head();
    const flureeRefusal = await server.runPromise(Effect.flip(publish(shape, subject)));
    expect(await head()).toBe(before);
    expect(jsonlRefusal._tag).toBe("InvalidQuery");
    expect(jsonlRefusal.message).toBe(flureeRefusal.message);
  }
}, 300_000);
