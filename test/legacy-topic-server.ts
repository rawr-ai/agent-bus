import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter } from "effect/http";

/**
 * The join/topic contract before canonicalisation (bb46696): store topics as
 * received, keep them on omission, return no topics, and match #topic literally.
 * This deliberately uses neither today's Bus nor its topic matcher: either
 * would hide a CLI regression by normalising what the older server stored.
 * Only the join surface needed by these compatibility tests is served.
 */
const Join = Tool.make("bus_join", {
  parameters: Schema.Struct({
    address: Schema.String,
    runtime: Schema.Literals(["claude", "codex", "human", "other"]),
    session: Schema.optionalKey(Schema.String),
    cwd: Schema.String,
    topics: Schema.optionalKey(Schema.Array(Schema.String)),
    replay: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({ address: Schema.String, cursor: Schema.Finite }),
});
const toolkit = Toolkit.make(Join);

export const legacyTopicServer = (port: number) => {
  const subscriptions = new Map<string, ReadonlyArray<string>>();
  const handlers = toolkit.toLayer({
    bus_join: ({ address, topics }) =>
      Effect.sync(() => {
        subscriptions.set(address, topics ?? subscriptions.get(address) ?? []);
        return { address, cursor: 0 };
      }),
  });
  const mcp = McpServer.toolkit(toolkit).pipe(
    Layer.provide(handlers),
    Layer.provide(
      McpServer.layerHttp({
        name: "legacy-topic-test",
        version: "test",
        path: "/mcp",
        protocols: [McpProtocol.v2026_07_28],
      })
    )
  );
  return {
    layer: HttpRouter.serve(mcp, { disableLogger: true }).pipe(
      Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port }))
    ),
    topicsOf: (address: string) => subscriptions.get(address),
    recipients: (to: string) =>
      Array.from(subscriptions).flatMap(([address, topics]) =>
        to === "*" || to === address || (to.startsWith("#") && topics.includes(to.slice(1)))
          ? [address]
          : []
      ),
  };
};
