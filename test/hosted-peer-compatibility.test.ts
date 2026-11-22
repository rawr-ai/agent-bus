import { expect, test } from "bun:test";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter } from "effect/http";
import { MIN_READ_RESULT_BYTES } from "../src/mcp-tools.ts";
import { clerkPeerResolver, PEER_PERMISSION } from "../src/private-web/identity.ts";
import { busPeer, peerTools } from "../src/private-web/peer.ts";

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  return port;
};

/**
 * A stand-in native Bus serving only bus_read and bus_wait, counting every invocation.
 * `hold` keeps an invoked call pending, so a test can fail the exchange after dispatch.
 */
const fakeBus = async (options: {
  readonly version: string;
  readonly readAdmission?: boolean;
  readonly hold?: boolean;
  readonly port?: number;
}) => {
  const port = options.port ?? freePort();
  const legacy = Schema.Struct({ address: Schema.String, session: Schema.String });
  const admitted = Schema.Struct({
    ...legacy.fields,
    maxResultBytes: Schema.Int.check(
      Schema.isBetween({ minimum: MIN_READ_RESULT_BYTES, maximum: 64 * 1024 * 1024 })
    ),
  });
  const input = options.readAdmission === true ? admitted : legacy;
  const output = Schema.Struct({ messages: Schema.Array(Schema.Unknown) });
  const toolkit = Toolkit.make(
    Tool.make("bus_read", { parameters: input, success: output }),
    Tool.make("bus_wait", { parameters: input, success: output })
  );
  const state = { calls: 0 };
  const handle = () =>
    Effect.sync(() => {
      state.calls++;
    }).pipe(
      Effect.andThen(options.hold === true ? Effect.never : Effect.succeed({ messages: [] }))
    );
  const mcp = McpServer.toolkit(toolkit).pipe(
    Layer.provide(toolkit.toLayer({ bus_read: handle, bus_wait: handle })),
    Layer.provide(
      McpServer.layerHttp({
        name: "fixture-bus",
        version: options.version,
        path: "/mcp",
        protocols: [McpProtocol.v2026_07_28],
      })
    )
  );
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(mcp, { disableLogger: true }).pipe(
      Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port }))
    )
  );
  await runtime.runPromise(Effect.void);
  return { port, state, dispose: () => runtime.dispose() };
};

// Sentinels for every caller secret the bridge can see; none may reach either output.
const TOKEN = "SENTINEL-TOKEN-7f3a";
const PRINCIPAL = "SENTINEL-PRINCIPAL-91c2";
const CONVERSATION = "SENTINEL-CONVERSATION-4d8e";
const BODY = "SENTINEL-BODY-b6e0";
const resource = "https://fixture.invalid/mcp";
const signal = new AbortController().signal;
const actor = await clerkPeerResolver({
  issuer: "https://fixture.invalid",
  principals: [{ subject: PRINCIPAL, grantFile: "/grant" }],
  resource,
  key: new Uint8Array(32).fill(9),
  identify: async (token) => (token === TOKEN ? PRINCIPAL : "other"),
  readGrant: async () => ({ subject: PRINCIPAL, resource, permissions: [PEER_PERMISSION] }),
})({
  auth: { authType: "oauth", accessToken: TOKEN },
  signal,
  requestMeta: { "openai/session": CONVERSATION },
});
const SESSION = actor.session;
if (SESSION === undefined) throw new Error("Missing synthetic session.");

const expectNoSecrets = (text: string) => {
  for (const secret of [TOKEN, PRINCIPAL, CONVERSATION, SESSION, BODY, "127.0.0.1", "http"])
    expect(text.includes(secret)).toBe(false);
};
const publicText = (result: { readonly content: ReadonlyArray<Record<string, unknown>> }) =>
  result.content.map((item) => String(item.text)).join("\n");
const PREFIX = "[agent-bus] hosted-peer-preflight ";
const operatorRecords = (lines: ReadonlyArray<string>) =>
  lines.map((line) => {
    expect(line.startsWith(PREFIX)).toBe(true);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(512);
    return JSON.parse(line.slice(PREFIX.length));
  });

/** Calls one hosted tool twice through a fresh peer; returns both public results and operator lines. */
const twice = async (
  port: number,
  expectedBusVersion: string,
  name: string,
  args: Record<string, unknown>
) => {
  const lines: string[] = [];
  const peer = await busPeer({
    busPort: port,
    expectedBusVersion,
    diagnostics: (line) => lines.push(line),
  });
  try {
    const tool = peerTools(peer.exchange, "/bridge").find((item) => item.name === name);
    if (!tool) throw new Error("Missing hosted tool.");
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await tool.execute(args, { actor, signal }));
    return { results, lines };
  } finally {
    await peer.dispose();
  }
};

test("a same-version Bus without read-byte admission is refused before either consuming tool is called", async () => {
  const bus = await fakeBus({ version: "same-version" });
  const peer = await busPeer({
    busPort: bus.port,
    expectedBusVersion: "same-version",
    diagnostics: () => {},
  });
  try {
    const tools = peerTools(peer.exchange, "/bridge");
    for (const name of ["bus_read", "bus_wait"]) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error("Missing hosted tool.");
      const result = await tool.execute(
        { address: "chatgpt/fixture" },
        {
          actor: { session: "fixture-session" },
          signal: new AbortController().signal,
        }
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("not sent");
    }
    expect(bus.state.calls).toBe(0);
  } finally {
    await peer.dispose();
    await bus.dispose();
  }
});

test("a native version mismatch is its own not-sent reason, before any tool call, and leaks nothing", async () => {
  const bus = await fakeBus({ version: "native-2.0.0", readAdmission: true });
  const hostile = await fakeBus({
    version: `native ${TOKEN} http://127.0.0.1/${SESSION}`,
    readAdmission: true,
  });
  try {
    const { results, lines } = await twice(bus.port, "native-1.0.0", "bus_read", {
      address: `chatgpt/${BODY}`,
    });
    for (const result of results) {
      expect(result.isError).toBe(true);
      const text = publicText(result);
      expect(text).toContain("not sent");
      expect(text).toContain("different versions");
      expect(text).toContain("rebind or upgrade");
      expect(text).not.toContain("connection or required tool");
      expect(text).not.toContain("may have committed");
      // The upstream identifier stays in the operator line only.
      expect(text).not.toContain("native-2.0.0");
      expectNoSecrets(JSON.stringify(result));
    }
    expect(bus.state.calls).toBe(0);
    // A persisting outcome is reported once, not per call.
    expect(operatorRecords(lines)).toEqual([
      {
        reason: "version_mismatch",
        expected: "native-1.0.0",
        observed: "native-2.0.0",
        timestamp: expect.any(String),
      },
    ]);
    expectNoSecrets(lines.join("\n"));

    // Upstream-controlled version text is never copied into the operator line.
    const hostileRun = await twice(hostile.port, "native-1.0.0", "bus_read", {
      address: `chatgpt/${BODY}`,
    });
    expect(hostile.state.calls).toBe(0);
    for (const result of hostileRun.results) {
      expect(publicText(result)).toContain("different versions");
      expectNoSecrets(JSON.stringify(result));
    }
    expect(operatorRecords(hostileRun.lines)).toEqual([
      {
        reason: "version_mismatch",
        expected: "native-1.0.0",
        observed: "unrecognized",
        timestamp: expect.any(String),
      },
    ]);
    expectNoSecrets(hostileRun.lines.join("\n"));
  } finally {
    await bus.dispose();
    await hostile.dispose();
  }
});

test("a missing connection or tool keeps its own not-sent reason and calls nothing", async () => {
  const bus = await fakeBus({ version: "native-1.0.0", readAdmission: true });
  try {
    // The fixture Bus serves no bus_publish.
    const { results, lines } = await twice(bus.port, "native-1.0.0", "bus_publish", {
      from: "chatgpt/sender",
      to: ["chatgpt/reader"],
      body: BODY,
    });
    for (const result of results) {
      expect(result.isError).toBe(true);
      const text = publicText(result);
      expect(text).toContain("not sent");
      expect(text).toContain("connection or required tool is unavailable");
      expect(text).not.toContain("different versions");
      expectNoSecrets(JSON.stringify(result));
    }
    expect(bus.state.calls).toBe(0);
    expect(operatorRecords(lines)).toEqual([
      { reason: "unavailable", timestamp: expect.any(String) },
    ]);
    expectNoSecrets(lines.join("\n"));
  } finally {
    await bus.dispose();
  }

  // Nothing listens on a port that was just released.
  const closed = await twice(freePort(), "native-1.0.0", "bus_read", {
    address: `chatgpt/${BODY}`,
  });
  for (const result of closed.results) {
    expect(result.isError).toBe(true);
    expect(publicText(result)).toContain("connection or required tool is unavailable");
    expectNoSecrets(JSON.stringify(result));
  }
  expect(operatorRecords(closed.lines)).toEqual([
    { reason: "unavailable", timestamp: expect.any(String) },
  ]);
  expectNoSecrets(closed.lines.join("\n"));
});

test("a failure after the call reached the Bus is unknown, never not sent", async () => {
  const bus = await fakeBus({ version: "native-1.0.0", readAdmission: true, hold: true });
  const lines: string[] = [];
  const peer = await busPeer({
    busPort: bus.port,
    expectedBusVersion: "native-1.0.0",
    diagnostics: (line) => lines.push(line),
  });
  try {
    const tool = peerTools(peer.exchange, "/bridge").find((item) => item.name === "bus_read");
    if (!tool) throw new Error("Missing hosted tool.");
    const abort = new AbortController();
    const pending = tool.execute({ address: `chatgpt/${BODY}` }, { actor, signal: abort.signal });
    for (let attempt = 0; attempt < 200 && bus.state.calls === 0; attempt++) await Bun.sleep(10);
    expect(bus.state.calls).toBe(1);
    abort.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    const text = publicText(result);
    expect(text).toContain("The read may have consumed messages: repeat it with the same readId");
    expect(text).not.toContain("not sent");
    expectNoSecrets(JSON.stringify(result));
    expect(bus.state.calls).toBe(1);
    expect(lines).toEqual([]);
  } finally {
    await peer.dispose();
    await bus.dispose();
  }
});

test("each refusal reason keeps its own budget and re-arms only on its own evidence", async () => {
  const port = freePort();
  const lines: string[] = [];
  const peer = await busPeer({
    busPort: port,
    expectedBusVersion: "native-1.0.0",
    diagnostics: (line) => lines.push(line),
  });
  const tools = peerTools(peer.exchange, "/bridge");
  const call = async (name: string, args: Record<string, unknown>, callSignal = signal) => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error("Missing hosted tool.");
    return publicText(await tool.execute(args, { actor, signal: callSignal }));
  };
  const read = (callSignal = signal) => call("bus_read", { address: "chatgpt/reader" }, callSignal);
  const serving = async (version: string, hold = false) =>
    fakeBus({ version, readAdmission: true, hold, port });
  try {
    let bus = await serving("native-1.0.0");
    // The fixture serves no bus_publish; another tool's success does not re-arm it.
    expect(
      await call("bus_publish", { from: "chatgpt/a", to: ["chatgpt/b"], body: BODY })
    ).toContain("connection or required tool");
    expect(await read()).toBe('{"messages":[]}');
    await call("bus_publish", { from: "chatgpt/a", to: ["chatgpt/b"], body: BODY });
    expect(lines).toHaveLength(1);
    await bus.dispose();
    expect(await read()).toContain("connection or required tool");
    expect(lines).toHaveLength(2);
    // A call that reached the Bus re-arms its tool even though its result was lost.
    bus = await serving("native-1.0.0", true);
    const abort = new AbortController();
    const held = read(abort.signal);
    for (let attempt = 0; attempt < 200 && bus.state.calls === 0; attempt++) await Bun.sleep(10);
    abort.abort();
    expect(await held).toContain("may have consumed messages");
    await bus.dispose();
    expect(await read()).toContain("connection or required tool");
    expect(lines).toHaveLength(3);
    // Ordinary churn: seven more recover-then-fail cycles exhaust only the unavailable budget.
    for (let cycle = 0; cycle < 7; cycle++) {
      bus = await serving("native-1.0.0");
      expect(await read()).toBe('{"messages":[]}');
      await bus.dispose();
      expect(await read()).toContain("connection or required tool");
    }
    expect(lines).toHaveLength(9);
    // A later mismatch is still reported, once per change of observed version.
    for (const version of ["native-2.0.0", "native-2.0.0", "native-1.0.0", "native-2.0.0"]) {
      bus = await serving(version);
      await read();
      await bus.dispose();
    }
    const unavailable = { reason: "unavailable", timestamp: expect.any(String) };
    const mismatch = {
      reason: "version_mismatch",
      expected: "native-1.0.0",
      observed: "native-2.0.0",
      timestamp: expect.any(String),
    };
    expect(operatorRecords(lines)).toEqual([
      ...Array.from({ length: 8 }, () => unavailable),
      { type: "exhausted", reason: "unavailable" },
      mismatch,
      mismatch,
    ]);
    expectNoSecrets(lines.join("\n"));
  } finally {
    await peer.dispose();
  }
}, 30_000);

test("a throwing operator writer changes neither the refusal nor the zero-call guarantee", async () => {
  const bus = await fakeBus({ version: "native-2.0.0", readAdmission: true });
  try {
    const peer = await busPeer({
      busPort: bus.port,
      expectedBusVersion: "native-1.0.0",
      diagnostics: () => {
        throw new Error("writer failed");
      },
    });
    try {
      const tool = peerTools(peer.exchange, "/bridge").find((item) => item.name === "bus_read");
      if (!tool) throw new Error("Missing hosted tool.");
      const result = await tool.execute({ address: "chatgpt/reader" }, { actor, signal });
      expect(result.isError).toBe(true);
      expect(publicText(result)).toContain("different versions");
      expect(publicText(result)).toContain("not sent");
    } finally {
      await peer.dispose();
    }
    expect(bus.state.calls).toBe(0);
  } finally {
    await bus.dispose();
  }
});

test("a caller's cancellation before preflight is not sent and writes no operator line", async () => {
  const bus = await fakeBus({ version: "native-2.0.0", readAdmission: true });
  const lines: string[] = [];
  const peer = await busPeer({
    busPort: bus.port,
    expectedBusVersion: "native-1.0.0",
    diagnostics: (line) => lines.push(line),
  });
  try {
    const abort = new AbortController();
    abort.abort();
    await expect(
      peer.exchange("bus_read", { address: "chatgpt/reader", session: SESSION }, abort.signal)
    ).rejects.toBeDefined();
    expect(lines).toEqual([]);
    expect(bus.state.calls).toBe(0);
  } finally {
    await peer.dispose();
    await bus.dispose();
  }
});

test("a Bus that reports no version is refused as unconfirmed, not as a known difference", async () => {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const message = (await request.json()) as { id?: unknown; method?: unknown };
      if (message.method !== "server/discover") calls++;
      return Response.json(
        message.method === "server/discover"
          ? {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                supportedVersions: ["2026-07-28"],
                capabilities: { tools: {} },
                ttlMs: 0,
                cacheScope: "private",
              },
            }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "fixture" } }
      );
    },
  });
  const lines: string[] = [];
  const peer = await busPeer({
    busPort: Number(server.port),
    expectedBusVersion: "native-1.0.0",
    diagnostics: (line) => lines.push(line),
  });
  try {
    const tool = peerTools(peer.exchange, "/bridge").find((item) => item.name === "bus_read");
    if (!tool) throw new Error("Missing hosted tool.");
    const result = await tool.execute({ address: `chatgpt/${BODY}` }, { actor, signal });
    const text = publicText(result);
    expect(result.isError).toBe(true);
    expect(text).toContain("not sent");
    expect(text).toContain("could not confirm the native Bus version");
    expect(text).not.toContain("different versions");
    expectNoSecrets(JSON.stringify(result));
    expect(calls).toBe(0);
    expect(operatorRecords(lines)).toEqual([
      {
        reason: "version_mismatch",
        expected: "native-1.0.0",
        observed: "absent",
        timestamp: expect.any(String),
      },
    ]);
  } finally {
    await peer.dispose();
    server.stop(true);
  }
});

test("an older Bus descriptor without keyed reads refuses readId, peek and bus_ack before dispatch", async () => {
  // The fixture is a Bus from before keyed reads: byte admission, but no readId, peek or
  // bus_ack. It would ignore both fields and consume the mail, so nothing may reach it.
  const bus = await fakeBus({ version: "native-old", readAdmission: true });
  const peer = await busPeer({
    busPort: bus.port,
    expectedBusVersion: "native-old",
    diagnostics: () => {},
  });
  try {
    const tools = peerTools(peer.exchange, "/bridge");
    const run = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error("Missing hosted tool.");
      return publicText(await tool.execute(args, { actor, signal }));
    };
    const readId = "01a20000-0000-7000-8000-000000000001";
    for (const [name, args] of [
      ["bus_read", { address: "chatgpt/reader", readId }],
      ["bus_read", { address: "chatgpt/reader", peek: true }],
      ["bus_wait", { address: "chatgpt/reader", readId, timeoutSeconds: 0 }],
      [
        "bus_ack",
        {
          address: "chatgpt/reader",
          receipt: {
            readId,
            from: 1,
            through: 2,
            basis: { ledger: "fixture", t: 2 },
            served: { count: 1, digest: "0".repeat(64) },
          },
        },
      ],
    ] as const) {
      expect(await run(name, args)).toBe(
        "The Bus call was not sent; the connection or required tool is unavailable."
      );
    }
    expect(bus.state.calls).toBe(0);
    // An ordinary read is unchanged on that Bus.
    expect(await run("bus_read", { address: "chatgpt/reader" })).toBe('{"messages":[]}');
    expect(bus.state.calls).toBe(1);
  } finally {
    await peer.dispose();
    await bus.dispose();
  }
});
