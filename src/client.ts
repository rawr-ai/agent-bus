import { Clock, Duration, Effect, Schema } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import type { Message } from "./domain.ts";
import { MAX_WAIT_SECONDS, Messages } from "./mcp.ts";

/** A failed call to the machine's bus process. */
export class BusCallError extends Schema.TaggedError<BusCallError>()("BusCallError", {
  message: Schema.String,
  /** The bus refused the call, as opposed to being unreachable. */
  refused: Schema.Boolean,
}) {}

const CALL_TIMEOUT_SECONDS = 30;
const RETRY_SECONDS = 5;

/** Drops undefined fields, which tool arguments omit rather than send. */
export const defined = <T extends Record<string, unknown>>(fields: T) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/** Calls one bus tool over a fresh MCP connection, decoding its result. */
export const call =
  (url: string) =>
  <S extends Schema.Top & { readonly DecodingServices: never }>(
    name: string,
    schema: S,
    args: Record<string, unknown>,
    timeoutSeconds: number = CALL_TIMEOUT_SECONDS
  ) =>
    Effect.gen(function* () {
      const client = yield* McpClient.McpClient;
      const tool = (yield* client.listTools()).find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return yield* new BusCallError({ message: `The bus has no ${name} tool.`, refused: true });
      }
      return yield* client.callTool(
        { tool, schema, arguments: args },
        { timeout: `${timeoutSeconds} seconds` }
      );
    }).pipe(
      Effect.provide(
        McpClient.layerHttp({
          name: "agent-bus-cli",
          version: "0.2.0",
          url,
          protocol: McpProtocol.v2026_07_28,
        })
      ),
      Effect.mapError(
        (error): BusCallError =>
          error instanceof BusCallError
            ? error
            : new BusCallError({
                message: error.reason.message,
                refused: error.reason._tag === "ToolError",
              })
      )
    );

/**
 * Waits for an address's next messages, in calls no longer than the server
 * holds a request open. While the bus process is unreachable (restarting, say)
 * it retries until the deadline rather than returning, since returning would
 * wake the session.
 */
export const waitFor = (url: string, address: string, timeoutSeconds?: number) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const remaining = Effect.map(Clock.currentTimeMillis, (now) =>
      timeoutSeconds === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, timeoutSeconds - (now - start) / 1000)
    );
    while (true) {
      const seconds = Math.min(MAX_WAIT_SECONDS, yield* remaining);
      const result = yield* Effect.result(
        call(url)("bus_wait", Messages, { address, timeoutSeconds: seconds }, seconds + 5)
      );
      if (result._tag === "Success") {
        const { messages } = result.success;
        if (messages.length > 0 || (yield* remaining) <= 0) return messages;
        continue;
      }
      if (result.failure.refused) return yield* result.failure;
      const left = yield* remaining;
      if (left <= 0) return [] as ReadonlyArray<Message>;
      yield* Effect.logWarning(
        `The bus at ${url} is unreachable (${result.failure.message}); retrying.`
      );
      yield* Effect.sleep(Duration.seconds(Math.min(RETRY_SECONDS, left)));
    }
  });
