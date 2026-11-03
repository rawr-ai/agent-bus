import { Context, Data, Duration, Effect, Layer, RcRef, Schema, Semaphore } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import {
  type HistoryInput,
  type HistoryObservation,
  type PeersObservation,
  projectHistory,
  projectPeers,
} from "../shared/public.ts";

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const OPERATION_TIMEOUT_MILLIS = 10_000;
export const MAX_CONCURRENT_READS = 8;

export class ObservationUnavailable extends Data.TaggedError("ObservationUnavailable") {}
export class ObservationTimeout extends Data.TaggedError("ObservationTimeout") {}

export class ObservationReader extends Context.Service<
  ObservationReader,
  {
    readonly history: (
      criteria: HistoryInput
    ) => Effect.Effect<HistoryObservation, ObservationUnavailable | ObservationTimeout>;
    readonly peers: () => Effect.Effect<
      PeersObservation,
      ObservationUnavailable | ObservationTimeout
    >;
  }
>()("viewer/ObservationReader") {}

/** Server-owned options only: never derive these from an HTTP request. */
export const readerLayer = (options: {
  readonly busPort: number;
  readonly timeoutMillis?: number;
}) =>
  Layer.effect(ObservationReader)(
    Effect.gen(function* () {
      const permits = Semaphore.makeUnsafe(MAX_CONCURRENT_READS);
      const timeout = options.timeoutMillis ?? OPERATION_TIMEOUT_MILLIS;
      const clientLayer = McpClient.layerHttp({
        name: "agent-bus-viewer",
        version: "1.0.0",
        url: `http://127.0.0.1:${options.busPort}/mcp`,
        protocol: McpProtocol.v2026_07_28,
        timeout,
        maxMessageBytes: MAX_MESSAGE_BYTES,
      }).pipe(Layer.provide(FetchHttpClient.layer));

      // The stateless protocol keeps no session, so one client and its discovered tools serve
      // every read: each observation is one tools/call. The reference-counted client is kept only
      // once discovery succeeds. A missing tool invalidates it, so the next read discovers again;
      // reads still holding the invalidated client finish with it, and the last one closes it.
      const connection = yield* RcRef.make({
        acquire: Effect.gen(function* () {
          const client = Context.get(yield* Layer.build(clientLayer), McpClient.McpClient);
          return { client, tools: yield* client.listTools() };
        }),
        idleTimeToLive: Duration.infinity,
      });

      const lookup = (name: "bus_history" | "bus_peers", args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const { client, tools } = yield* RcRef.get(connection);
          const tool = tools.find((candidate) => candidate.name === name);
          if (tool === undefined) {
            yield* RcRef.invalidate(connection);
            return yield* new ObservationUnavailable();
          }
          return yield* client.callTool({ tool, schema: Schema.Unknown, arguments: args });
        }).pipe(
          Effect.scoped,
          Effect.mapError(() => new ObservationUnavailable()),
          permits.withPermits(1),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new ObservationTimeout()),
          })
        );

      return {
        history: (criteria) =>
          lookup("bus_history", {
            limit: criteria.limit,
            ...(criteria.query === undefined ? {} : { query: criteria.query }),
            ...(criteria.participant === undefined ? {} : { participant: criteria.participant }),
          }).pipe(
            Effect.flatMap((value) =>
              Effect.try({
                try: () => projectHistory(value, criteria, new Date().toISOString()),
                catch: () => new ObservationUnavailable(),
              })
            )
          ),
        peers: () =>
          lookup("bus_peers", {}).pipe(
            Effect.flatMap((value) =>
              Effect.try({
                try: () => projectPeers(value, new Date().toISOString()),
                catch: () => new ObservationUnavailable(),
              })
            )
          ),
      };
    })
  );
