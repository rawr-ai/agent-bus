import {
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  RcRef,
  Schema,
  type Scope,
  Semaphore,
} from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import {
  type HistoryInput,
  type HistoryObservation,
  MAX_PAGES,
  MAX_PEERS,
  MAX_PEERS_PAGE,
  MAX_THREAD_MESSAGES,
  type PeersObservation,
  projectHistory,
  projectPeers,
  projectThread,
  type ThreadInput,
  type ThreadObservation,
} from "../shared/public.ts";

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const OPERATION_TIMEOUT_MILLIS = 10_000;
export const MAX_CONCURRENT_READS = 8;
/** The one business tool the viewer calls. */
export const QUERY_TOOL = "bus_run_query";

export class ObservationUnavailable extends Data.TaggedError("ObservationUnavailable") {}
export class ObservationTimeout extends Data.TaggedError("ObservationTimeout") {}

type Failure = ObservationUnavailable | ObservationTimeout;

export class ObservationReader extends Context.Service<
  ObservationReader,
  {
    readonly history: (criteria: HistoryInput) => Effect.Effect<HistoryObservation, Failure>;
    readonly peers: () => Effect.Effect<PeersObservation, Failure>;
    readonly thread: (request: ThreadInput) => Effect.Effect<ThreadObservation, Failure>;
  }
>()("viewer/ObservationReader") {}

/** A page's continuation, read without trusting the page: projection validates it whole. */
const nextOf = (page: unknown): string | undefined => {
  if (typeof page !== "object" || page === null || !Object.hasOwn(page, "next")) return undefined;
  const next: unknown = Reflect.get(page, "next");
  return typeof next === "string" ? next : undefined;
};
const rowCount = (page: unknown): number => {
  if (typeof page !== "object" || page === null || !Object.hasOwn(page, "rows")) return 0;
  const rows: unknown = Reflect.get(page, "rows");
  return Array.isArray(rows) ? rows.length : 0;
};

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
      // every read: each page is one tools/call. The reference-counted client is kept only
      // once discovery succeeds. A missing tool invalidates it, so the next read discovers again;
      // reads still holding the invalidated client finish with it, and the last one closes it.
      const connection = yield* RcRef.make({
        acquire: Effect.gen(function* () {
          const client = Context.get(yield* Layer.build(clientLayer), McpClient.McpClient);
          return { client, tools: yield* client.listTools() };
        }),
        idleTimeToLive: Duration.infinity,
      });

      /** One saved-query page: the operation name, args and position are fixed here. */
      const runQuery = (call: {
        readonly name: "history" | "search" | "peers" | "thread";
        readonly args: Record<string, unknown>;
        readonly t?: number;
        readonly cursor?: string;
      }) =>
        Effect.gen(function* () {
          const { client, tools } = yield* RcRef.get(connection);
          const tool = tools.find((candidate) => candidate.name === QUERY_TOOL);
          if (tool === undefined) {
            yield* RcRef.invalidate(connection);
            return yield* new ObservationUnavailable();
          }
          return yield* client.callTool({
            tool,
            schema: Schema.Unknown,
            arguments: {
              name: call.name,
              args: call.args,
              ...(call.t === undefined ? {} : { t: call.t }),
              ...(call.cursor === undefined ? {} : { cursor: call.cursor }),
            },
          });
        });

      /**
       * Follows `next` with the same name and args, so every page reads the first page's
       * commit (or `t`, when given), until `enough` rows or the traversal ends; at most
       * MAX_PAGES pages.
       */
      const traverse = (
        name: "history" | "search" | "peers" | "thread",
        args: Record<string, unknown>,
        enough: number,
        t?: number
      ) =>
        Effect.gen(function* () {
          const pages: unknown[] = [];
          let rows = 0;
          let cursor: string | undefined;
          do {
            const page = yield* runQuery({
              name,
              args,
              ...(t === undefined ? {} : { t }),
              ...(cursor === undefined ? {} : { cursor }),
            });
            pages.push(page);
            rows += rowCount(page);
            cursor = nextOf(page);
          } while (cursor !== undefined && rows < enough && pages.length < MAX_PAGES);
          return pages;
        });

      /** One observation: one permit and one deadline, however many pages it reads. */
      const observe = <A>(read: Effect.Effect<A, unknown, Scope.Scope>) =>
        read.pipe(
          Effect.scoped,
          Effect.mapError(() => new ObservationUnavailable()),
          permits.withPermits(1),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new ObservationTimeout()),
          })
        );
      const projected = <A>(project: () => A) =>
        Effect.try({ try: project, catch: () => new ObservationUnavailable() });

      return {
        history: (criteria) =>
          observe(
            Effect.gen(function* () {
              const participants =
                criteria.participant === undefined ? {} : { participants: [criteria.participant] };
              const pages =
                criteria.query === undefined
                  ? yield* traverse(
                      "history",
                      { ...participants, direction: "backward", limit: criteria.limit },
                      criteria.limit
                    )
                  : yield* traverse(
                      "search",
                      { ...participants, text: criteria.query, limit: criteria.limit },
                      criteria.limit
                    );
              return yield* projected(() =>
                projectHistory(pages, criteria, new Date().toISOString())
              );
            })
          ),
        peers: () =>
          observe(
            Effect.gen(function* () {
              const pages = yield* traverse("peers", { limit: MAX_PEERS_PAGE }, MAX_PEERS);
              return yield* projected(() => projectPeers(pages, new Date().toISOString()));
            })
          ),
        thread: (request) =>
          observe(
            Effect.gen(function* () {
              const pages = yield* traverse(
                "thread",
                { id: request.id, limit: MAX_THREAD_MESSAGES },
                MAX_THREAD_MESSAGES,
                request.t
              );
              return yield* projected(() =>
                projectThread(pages, request, new Date().toISOString())
              );
            })
          ),
      };
    })
  );
