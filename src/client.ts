import { Effect, Schema } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { type Runtime, validSession } from "./domain.ts";
import { Peers } from "./mcp.ts";

/** A failed call to the machine's bus process. */
export class BusCallError extends Schema.TaggedError<BusCallError>()("BusCallError", {
  message: Schema.String,
}) {}

const CALL_TIMEOUT_SECONDS = 30;

/** Drops undefined fields, which tool arguments omit rather than send. */
export const defined = <T extends Record<string, unknown>>(fields: T) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/**
 * The session id the CLI presents for a runtime: `--session`, or the runtime's
 * own variable. It never falls back to another runtime's variable, since a
 * Codex process started from a Claude shell inherits the Claude session's id.
 */
export const sessionFor = (
  runtime: Runtime,
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env
) => {
  const variable =
    runtime === "codex"
      ? "CODEX_THREAD_ID"
      : runtime === "claude"
        ? "CLAUDE_CODE_SESSION_ID"
        : "AGENT_BUS_SESSION";
  const session = explicit ?? env[variable];
  return validSession(session)
    ? Effect.succeed(session)
    : Effect.fail(
        new BusCallError({
          message:
            explicit === undefined
              ? `No usable session id for a ${runtime} session: pass --session, or run where $${variable} is set.`
              : "--session is empty or an unexpanded placeholder.",
        })
      );
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
        return yield* new BusCallError({ message: `The bus has no ${name} tool.` });
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
            : new BusCallError({ message: error.reason.message })
      )
    );

/** The runtime an address joined with, which picks the session id the CLI presents for it. */
export const runtimeOf = (url: string, address: string) =>
  Effect.gen(function* () {
    const { peers } = yield* call(url)("bus_peers", Peers, {});
    const peer = peers.find((candidate) => candidate.address === address);
    if (peer !== undefined) return peer.runtime;
    return yield* new BusCallError({
      message: `${address} has not joined the bus; join first, or pass --runtime.`,
    });
  });
