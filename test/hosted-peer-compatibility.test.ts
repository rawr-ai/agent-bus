import { expect, test } from "bun:test";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter } from "effect/http";
import { busPeer, peerTools } from "../src/private-web/peer.ts";

test("a same-version Bus without read-byte admission is refused before either consuming tool is called", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  const input = Schema.Struct({ address: Schema.String, session: Schema.String });
  const output = Schema.Struct({ messages: Schema.Array(Schema.Unknown) });
  const toolkit = Toolkit.make(
    Tool.make("bus_read", { parameters: input, success: output }),
    Tool.make("bus_wait", { parameters: input, success: output })
  );
  let calls = 0;
  const handlers = toolkit.toLayer({
    bus_read: () =>
      Effect.sync(() => {
        calls++;
        return { messages: [] };
      }),
    bus_wait: () =>
      Effect.sync(() => {
        calls++;
        return { messages: [] };
      }),
  });
  const mcp = McpServer.toolkit(toolkit).pipe(
    Layer.provide(handlers),
    Layer.provide(
      McpServer.layerHttp({
        name: "old-bus",
        version: "same-version",
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
  const peer = await busPeer({ busPort: port, expectedBusVersion: "same-version" });
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
    expect(calls).toBe(0);
  } finally {
    await peer.dispose();
    await runtime.dispose();
  }
});
