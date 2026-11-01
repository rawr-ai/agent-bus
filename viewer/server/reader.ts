import { Context, Data, Duration, Effect, Exit, Layer, Schema, Scope, Semaphore } from "effect";
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
      const layerScope = yield* Effect.scope;
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
      // every read: each observation is one tools/call. A connection is kept only once discovery
      // succeeds, and a missing tool makes the next read discover again.
      const connect = Effect.gen(function* () {
        const scope = yield* Scope.fork(layerScope);
        return yield* Layer.buildWithScope(clientLayer, scope).pipe(
          Effect.flatMap((context) => {
            const client = Context.get(context, McpClient.McpClient);
            return Effect.map(client.listTools(), (tools) => ({ client, tools }));
          }),
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit)))
        );
      });
      const [connection, rediscover] = yield* Effect.cachedInvalidateWithTTL(connect, (exit) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.zero
      );

      const lookup = (name: "bus_history" | "bus_peers", args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const { client, tools } = yield* connection;
          const tool = tools.find((candidate) => candidate.name === name);
          if (tool === undefined) {
            yield* rediscover;
            return yield* new ObservationUnavailable();
          }
          return yield* client.callTool({ tool, schema: Schema.Unknown, arguments: args });
        }).pipe(
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
