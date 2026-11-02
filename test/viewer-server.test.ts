import { heapStats } from "bun:jsc";
import { expect, test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { createViewer } from "../viewer/server/host.ts";
import { ViewerPortInUse } from "../viewer/server/port.ts";
import { MAX_MESSAGE_BYTES, ObservationReader, readerLayer } from "../viewer/server/reader.ts";
import type { ViewerClient } from "../viewer/shared/client-types.ts";
import { failureFromStatus } from "../viewer/src/observation-resource.ts";

const marker = "private-fixture-value-never-disclosed";
const LEDGER = "fixture-ledger";
const AT = 9;
const message = {
  t: 5,
  id: "fixture-message",
  ts: "2026-11-01T12:00:00.000Z",
  from: "fixture/a",
  to: ["#fixture", "*"],
  kind: "message",
  body: "Synthetic <script>text</script>",
  origin: { host: "fixture", cwd: "/fixture", repo: "fixture", branch: "main", session: marker },
  session: marker,
};
const peer = {
  address: "fixture/a",
  runtime: "claude",
  status: "joined",
  topics: ["fixture"],
  t: 3,
  session: marker,
};
/** A bus_run_query result page at AT, exhausted unless overridden. */
const envelope = (name: string, rows: unknown, extra: Record<string, unknown> = {}) => ({
  name,
  catalogueVersion: 1,
  ledger: LEDGER,
  t: AT,
  unit: "entry",
  args: {},
  rows,
  damage: "checked",
  damaged: 0,
  damagedTotal: 0,
  exhausted: true,
  complete: true,
  note: "note",
  session: marker,
  ...extra,
});
const QueryCallSchema = Schema.Struct({
  name: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
  t: Schema.optionalKey(Schema.Number),
  cursor: Schema.optionalKey(Schema.String),
});
const RequestSchema = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const CallSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});

const setup = (timeoutMillis = 1_000) => {
  const methods: string[] = [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const capturedHeaders: Array<Headers> = [];
  let mode:
    | "normal"
    | "tool-error"
    | "outage"
    | "hang"
    | "oversized"
    | "malformed"
    | "quarantine"
    | "paged"
    | "endless"
    | "other-ledger"
    | "no-query-tool" = "normal";
  let peersFail = false;
  let remoteAborts = 0;
  const release = new Set<() => void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      capturedHeaders.push(request.headers);
      const input = Schema.decodeUnknownSync(RequestSchema)(await request.json());
      methods.push(input.method);
      const respond = (result: unknown) => Response.json({ jsonrpc: "2.0", id: input.id, result });
      if (mode === "outage") return new Response(marker, { status: 503 });
      if (input.method === "server/discover") {
        return respond({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: "private",
        });
      }
      if (input.method === "tools/list") {
        return respond({
          ttlMs: 0,
          cacheScope: "private",
          tools: (mode === "no-query-tool"
            ? ["bus_history", "bus_peers", "bus_publish"]
            : [
                "bus_peers",
                "bus_history",
                "bus_queries",
                "bus_run_query",
                "bus_query",
                "bus_publish",
              ]
          ).map((name) => ({
            name,
            inputSchema: { type: "object", properties: {} },
          })),
        });
      }
      if (input.method !== "tools/call") return new Response("Unexpected method", { status: 400 });
      const call = Schema.decodeUnknownSync(CallSchema)(input.params);
      calls.push(call);
      if (mode === "hang") {
        await new Promise<void>((resolve) => {
          const finish = () => {
            release.delete(finish);
            resolve();
          };
          release.add(finish);
          request.signal.addEventListener(
            "abort",
            () => {
              remoteAborts++;
              finish();
            },
            { once: true }
          );
        });
      }
      const query = Schema.decodeUnknownSync(QueryCallSchema)(call.arguments);
      if (mode === "tool-error" || (peersFail && query.name === "peers")) {
        return respond({ isError: true, content: [{ type: "text", text: marker }] });
      }
      if (mode === "oversized") {
        return respond({
          content: [],
          structuredContent: envelope(query.name, [
            { ...message, body: "x".repeat(MAX_MESSAGE_BYTES + 1) },
          ]),
        });
      }
      const open = (next: string, extra: Record<string, unknown> = {}) => ({
        exhausted: false,
        complete: false,
        next,
        ...extra,
      });
      const data =
        mode === "malformed"
          ? { messages: "invalid", peers: "invalid", rows: "invalid" }
          : mode === "other-ledger"
            ? envelope(query.name, [], { ledger: "replaced", missingReplyTargets: [] })
            : mode === "endless"
              ? envelope(query.name, [], open(`c${calls.length}`))
              : mode === "paged" && query.cursor === undefined
                ? envelope(query.name, [], open("c1", { damaged: 1, damagedTotal: 1 }))
                : mode === "paged"
                  ? envelope(query.name, [message], { damagedTotal: 1, complete: false })
                  : query.name === "peers"
                    ? envelope("peers", [peer], { unit: "address" })
                    : query.name === "thread"
                      ? envelope("thread", [message], {
                          t: query.t ?? AT,
                          missingReplyTargets: ["gone"],
                        })
                      : envelope(
                          query.name,
                          mode === "quarantine"
                            ? [
                                message,
                                { ...message, body: "duplicate" },
                                { ...message, id: "valid" },
                                { ...message, id: "presence", kind: "presence" },
                              ]
                            : [message],
                          query.name === "search" ? { complete: false } : {}
                        );
      return respond({ content: [], structuredContent: data });
    },
  });
  const viewer = createViewer({
    port: 0,
    busPort: upstream.port ?? 0,
    timeoutMillis,
    assets: new Map([
      [
        "/",
        {
          body: new TextEncoder().encode("<!doctype html><title>Fixture</title>"),
          contentType: "text/html",
        },
      ],
    ]),
  });
  const client: ViewerClient = createORPCClient(new RPCLink({ url: new URL("/rpc", viewer.url) }));
  const direct = (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    if (!headers.has("host")) headers.set("host", viewer.url.host);
    return viewer.fetch(new Request(new URL(path, viewer.url).href, { ...options, headers }));
  };
  return {
    viewer,
    client,
    direct,
    busPort: upstream.port ?? 0,
    calls,
    methods,
    capturedHeaders,
    mode: (value: typeof mode) => {
      mode = value;
    },
    failPeers: () => {
      peersFail = true;
    },
    abortCount: () => remoteAborts,
    release: () => {
      for (const finish of release) finish();
    },
    close: async () => {
      await viewer.close();
      for (const finish of release) finish();
      await upstream.stop(true);
    },
  };
};

const post = (input: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ json: input }),
});

test("viewer calls only fixed modern public tools and explicitly projects nested fields", async () => {
  const fixture = setup();
  try {
    const history = await fixture.client.history({ limit: 50 });
    const peers = await fixture.client.peers({});
    expect(history.messages[0]?.id).toBe(message.id);
    expect(history.criteria).toEqual({ limit: 50 });
    expect(history.omitted).toBe(0);
    expect(peers.peers[0]?.address).toBe(peer.address);
    expect(Number.isFinite(Date.parse(history.observedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(peers.observedAt))).toBe(true);
    expect(JSON.stringify({ history, peers })).not.toContain(marker);
    expect(history.snapshot).toEqual({ ledger: LEDGER, t: AT });
    expect(history.window).toBe("all");
    expect(peers.snapshot).toEqual({ ledger: LEDGER, t: AT });
    expect(fixture.calls).toEqual([
      {
        name: "bus_run_query",
        arguments: { name: "history", args: { direction: "backward", limit: 50 } },
      },
      { name: "bus_run_query", arguments: { name: "peers", args: { limit: 500 } } },
    ]);
    // One client and its discovered tools serve every read.
    expect(fixture.methods).toEqual(["server/discover", "tools/list", "tools/call", "tools/call"]);
    await fixture.client.history({ limit: 50 });
    expect(fixture.methods.slice(4)).toEqual(["tools/call"]);
    expect(
      fixture.capturedHeaders.every(
        (headers) => headers.get("mcp-protocol-version") === "2026-07-28"
      )
    ).toBe(true);
    expect(
      fixture.capturedHeaders.every(
        (headers) => !headers.has("mcp-session-id") && !headers.has("origin")
      )
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("exact submitted criteria are forwarded without inbox/topic expansion", async () => {
  const fixture = setup();
  try {
    await fixture.client.history({ limit: 200, query: "adapter", participant: "#Exact" });
    await fixture.client.history({ limit: 7, participant: "#Exact" });
    expect(fixture.calls).toEqual([
      {
        name: "bus_run_query",
        arguments: {
          name: "search",
          args: { participants: ["#Exact"], text: "adapter", limit: 200 },
        },
      },
      {
        name: "bus_run_query",
        arguments: {
          name: "history",
          args: { participants: ["#Exact"], direction: "backward", limit: 7 },
        },
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test("a window follows next with the same args at one commit, and stops at the page bound", async () => {
  const fixture = setup();
  try {
    fixture.mode("paged");
    const paged = await fixture.client.history({ limit: 50 });
    expect(paged.messages.map((item) => item.id)).toEqual([message.id]);
    expect(paged.damaged).toBe(1);
    expect(paged.omitted).toBe(0);
    expect(paged.window).toBe("all");
    expect(paged.complete).toBe(false);
    const args = { direction: "backward", limit: 50 };
    expect(fixture.calls).toEqual([
      { name: "bus_run_query", arguments: { name: "history", args } },
      { name: "bus_run_query", arguments: { name: "history", args, cursor: "c1" } },
    ]);
    // A bus that never finishes is read for at most eight pages, and never called all.
    fixture.mode("endless");
    const endless = await fixture.client.history({ limit: 50 });
    expect(fixture.calls).toHaveLength(2 + 8);
    expect(endless.window).toBe("latest");
    expect(endless.messages).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a thread is read at the requested commit and refused from another ledger", async () => {
  const fixture = setup();
  try {
    const tree = await fixture.client.thread({ id: message.id, ledger: LEDGER, t: 7 });
    expect(tree.snapshot).toEqual({ ledger: LEDGER, t: 7 });
    expect(tree.missingReplyTargets).toEqual(["gone"]);
    expect(tree.messages.map((item) => item.id)).toEqual([message.id]);
    expect(JSON.stringify(tree)).not.toContain(marker);
    expect(fixture.calls).toEqual([
      {
        name: "bus_run_query",
        arguments: { name: "thread", args: { id: message.id, limit: 200 }, t: 7 },
      },
    ]);
    fixture.mode("other-ledger");
    const refused = await fixture.direct(
      "/rpc/thread",
      post({ id: message.id, ledger: LEDGER, t: 7 })
    );
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain(marker);
  } finally {
    await fixture.close();
  }
});

test("all duplicate IDs and invalid kinds are visibly quarantined", async () => {
  const fixture = setup();
  fixture.mode("quarantine");
  try {
    const observation = await fixture.client.history({ limit: 50 });
    expect(observation.messages.map((item) => item.id)).toEqual(["valid"]);
    expect(observation.omitted).toBe(3);
  } finally {
    await fixture.close();
  }
});

test("host, origin, paths, methods, media, bytes and schema bounds refuse before upstream", async () => {
  const fixture = setup();
  try {
    expect((await fixture.direct("/", { headers: { host: "rebound.invalid" } })).status).toBe(403);
    for (const origin of ["null", "http://hostile.invalid", "http://localhost:4317"]) {
      expect((await fixture.direct("/", { headers: { origin } })).status).toBe(403);
      expect(
        (
          await fixture.direct("/rpc/history", {
            ...post({ limit: 50 }),
            headers: { "content-type": "application/json", origin },
          })
        ).status
      ).toBe(403);
    }
    for (const path of [
      "/rpc/bus_read",
      "/rpc/bus_query",
      "/rpc/bus_run_query",
      "/rpc/bus_publish",
      "/rpc/history/",
      "/rpc-other/history",
      "/server/main.ts",
      "/%2e%2e/package.json",
      "/rpc/history?tool=bus_publish",
    ]) {
      expect((await fixture.direct(path, post({ limit: 50 }))).status).toBe(404);
    }
    expect((await fixture.direct("/rpc/history")).status).toBe(405);
    expect((await fixture.direct("/rpc/history", { method: "POST", body: "{}" })).status).toBe(415);
    expect(
      (await fixture.direct("/rpc/history", { ...post({ limit: 50 }), body: "x".repeat(4097) }))
        .status
    ).toBe(413);
    for (const input of [
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { limit: 50, tool: "bus_read" },
      { limit: 50, query: "x".repeat(257) },
      { limit: 50, participant: "x".repeat(513) },
    ]) {
      expect((await fixture.direct("/rpc/history", post(input))).status).toBe(400);
    }
    expect((await fixture.direct("/rpc/peers", post({ session: marker }))).status).toBe(400);
    for (const input of [
      {},
      { id: "", ledger: LEDGER, t: 1 },
      { id: "x", ledger: LEDGER, t: 0 },
      { id: "x", ledger: LEDGER, t: 1.5 },
      { id: "x", t: 1 },
      { id: "x", ledger: LEDGER, t: 1, name: "history" },
      { id: "x".repeat(513), ledger: LEDGER, t: 1 },
    ]) {
      expect((await fixture.direct("/rpc/thread", post(input))).status).toBe(400);
    }
    expect(fixture.calls).toEqual([]);
    expect(fixture.methods).toEqual([]);
    const asset = await fixture.direct("/", { headers: { origin: fixture.viewer.url.origin } });
    expect(asset.status).toBe(200);
    expect(asset.headers.has("access-control-allow-origin")).toBe(false);
    expect(asset.headers.get("content-security-policy")).toContain("form-action 'none'");
  } finally {
    await fixture.close();
  }
});

test("tool, transport, invalid-root and byte-cap failures are safe and independently recoverable", async () => {
  const fixture = setup();
  try {
    for (const mode of ["tool-error", "outage", "malformed", "oversized"] as const) {
      fixture.mode(mode);
      const response = await fixture.direct("/rpc/history", post({ limit: 50 }));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(marker);
    }
    fixture.mode("normal");
    fixture.failPeers();
    await expect(fixture.client.peers({})).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect((await fixture.client.history({ limit: 50 })).messages).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("a failed discovery is not kept, and a missing tool is discovered again", async () => {
  const fixture = setup();
  try {
    fixture.mode("outage");
    const outage = fixture.client.history({ limit: 50 });
    await expect(outage).rejects.toMatchObject({ status: 503 });
    // The browser labels this rejection as unavailability, not a timeout.
    expect(await outage.catch(failureFromStatus)).toBe("unavailable");
    // A bus without bus_run_query (an older deployment) is unavailable, not called another way.
    fixture.mode("no-query-tool");
    await expect(fixture.client.peers({})).rejects.toMatchObject({ status: 503 });
    fixture.mode("normal");
    expect((await fixture.client.peers({})).peers).toHaveLength(1);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.methods).toEqual([
      "server/discover",
      "server/discover",
      "tools/list",
      "server/discover",
      "tools/list",
      "tools/call",
    ]);
  } finally {
    await fixture.close();
  }
});

/** Objects still reachable after full collections: what a long-running reader keeps. */
const liveObjects = () => {
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().objectCount;
};

test("a client without the query tool is released, and the next read discovers again", async () => {
  const fixture = setup();
  const scope = Scope.makeUnsafe();
  try {
    const reader = await Effect.runPromise(
      Layer.buildWithScope(readerLayer({ busPort: fixture.busPort }), scope).pipe(
        Effect.map((context) => Context.get(context, ObservationReader))
      )
    );
    const read = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect));
    // Each peers read discovers a client without bus_run_query, which that read then supersedes.
    fixture.mode("no-query-tool");
    const failPeers = async (reads: number) => {
      for (let attempt = 0; attempt < reads; attempt++) {
        expect(Exit.isFailure(await read(reader.peers()))).toBe(true);
      }
    };
    await failPeers(50);
    const before = liveObjects();
    await failPeers(200);
    expect(fixture.methods.filter((method) => method === "server/discover")).toHaveLength(250);
    // A retained client keeps about 300 objects alive; this bound admits only fixture records.
    expect((liveObjects() - before) / 200).toBeLessThan(50);

    // The next read discovers a current client.
    fixture.mode("normal");
    const discovered = fixture.methods.length;
    expect(Exit.isSuccess(await read(reader.peers()))).toBe(true);
    expect(fixture.methods.slice(discovered)).toEqual([
      "server/discover",
      "tools/list",
      "tools/call",
    ]);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await fixture.close();
  }
});

test("whole-operation deadline and real client cancellation close upstream work", async () => {
  const fixture = setup(100);
  fixture.mode("hang");
  try {
    const deadline = fixture.client.history({ limit: 50 });
    await expect(deadline).rejects.toMatchObject({ status: 504 });
    // The browser labels this rejection as a timeout, not as unavailability.
    expect(await deadline.catch(failureFromStatus)).toBe("timeout");
    const controller = new AbortController();
    const pending = fixture.client
      .history({ limit: 50 }, { signal: controller.signal })
      .catch(() => undefined);
    while (fixture.calls.length < 2) await Bun.sleep(2);
    controller.abort();
    await pending;
    for (let attempt = 0; attempt < 100 && fixture.abortCount() < 2; attempt++) await Bun.sleep(2);
    expect(fixture.abortCount()).toBe(2);
  } finally {
    await fixture.close();
  }
});

test("eight active reads bound load and overflow fails without another upstream call", async () => {
  const fixture = setup();
  fixture.mode("hang");
  try {
    const pending = Array.from({ length: 8 }, () => fixture.client.history({ limit: 50 }));
    while (fixture.calls.length < 8) await Bun.sleep(2);
    const overflow = await fixture.direct("/rpc/peers", post({}));
    expect(overflow.status).toBe(503);
    expect(fixture.calls).toHaveLength(8);
    fixture.release();
    expect((await Promise.all(pending)).length).toBe(8);
  } finally {
    await fixture.close();
  }
});

test("stalled chunked input is cancelled by deadline, releasing intake slots", async () => {
  const fixture = setup(40);
  let cancelled = 0;
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"json":'));
      },
      cancel() {
        cancelled++;
      },
    });
  try {
    const pending = Array.from({ length: 8 }, () =>
      fixture.direct("/rpc/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream(),
      })
    );
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual(
      Array(8).fill(504)
    );
    expect(cancelled).toBe(8);
    expect(fixture.calls).toHaveLength(0);
    expect((await fixture.direct("/rpc/history", post({ limit: 50 }))).status).toBe(200);
  } finally {
    await fixture.close();
  }
});

test("close cancels stalled intake and active calls, is idempotent and prevents later work", async () => {
  const fixture = setup();
  let cancelled = 0;
  const input = fixture.direct("/rpc/history", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      cancel() {
        cancelled++;
      },
    }),
  });
  fixture.mode("hang");
  const call = fixture.client.peers({}).catch(() => undefined);
  while (fixture.calls.length === 0) await Bun.sleep(2);
  await Promise.all([fixture.viewer.close(), fixture.viewer.close()]);
  expect((await input).status).toBe(499);
  expect(cancelled).toBe(1);
  await call;
  expect((await fixture.direct("/rpc/history", post({ limit: 50 }))).status).toBe(503);
  expect(fixture.calls).toHaveLength(1);
  await fixture.close();
});

test("a port another owner holds on any interface is refused, leaving that owner's traffic", async () => {
  const assets = new Map();
  for (const hostname of ["0.0.0.0", "::", "127.0.0.1"]) {
    const holder = Bun.serve({ hostname, port: 0, fetch: () => new Response("holder") });
    const port = holder.port ?? 0;
    try {
      expect(() => createViewer({ port, busPort: 1, assets })).toThrow(ViewerPortInUse);
      const answer = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "holder" } });
      expect(await answer.text()).toBe("holder");
    } finally {
      await holder.stop(true);
    }
  }
  // Once released, the same port is accepted.
  const released = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response() });
  const port = released.port ?? 0;
  await released.stop(true);
  const viewer = createViewer({ port, busPort: 1, assets });
  expect(viewer.url.port).toBe(String(port));
  await viewer.close();
});
