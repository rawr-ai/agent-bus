import { Effect, Schema } from "effect";
import { McpClient, McpProtocol, type McpSchema } from "effect/ai";
import { type Association, canonicalAssociations, type Runtime, validSession } from "./domain.ts";
import { Joined, Peers } from "./mcp.ts";
import { CALL_TIMEOUT_SECONDS } from "./timing.ts";
import { VERSION } from "./version.ts";

/** A failed call to the machine's bus process. */
export class BusCallError extends Schema.TaggedError<BusCallError>()("BusCallError", {
  message: Schema.String,
}) {}

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
              ? `No usable session id for runtime ${runtime}: pass --session, or run where $${variable} is set.`
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
          version: VERSION,
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

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Refuse descriptors which do not unambiguously advertise both the input and effective echo. */
export const supportsAssociations = (tool: McpSchema.Tool): boolean => {
  const associationArray = (schema: unknown): boolean => {
    if (!object(schema) || schema.type !== "array" || !object(schema.items)) return false;
    const item = schema.items;
    if (item.type !== "object" || !object(item.properties) || !Array.isArray(item.required)) {
      return false;
    }
    const directory = item.properties.directory;
    const concerns = item.properties.concerns;
    return (
      item.required.includes("directory") &&
      item.required.includes("concerns") &&
      object(directory) &&
      directory.type === "string" &&
      object(concerns) &&
      concerns.type === "array" &&
      object(concerns.items) &&
      concerns.items.type === "string"
    );
  };
  const input = tool.inputSchema;
  const output = tool.outputSchema;
  return (
    object(input.properties) &&
    associationArray(input.properties.associations) &&
    object(output) &&
    object(output.properties) &&
    Array.isArray(output.required) &&
    output.required.includes("associations") &&
    associationArray(output.properties.associations)
  );
};

/** Join on one fresh connection; verify advertised capability before sending associations. */
export const join =
  (url: string) =>
  (
    name: "bus_join" | "bus_takeover",
    args: Record<string, unknown> & { readonly associations?: ReadonlyArray<Association> }
  ) =>
    Effect.gen(function* () {
      const client = yield* McpClient.McpClient;
      const tool = (yield* client.listTools()).find((candidate) => candidate.name === name);
      if (tool === undefined)
        return yield* new BusCallError({ message: `The bus has no ${name} tool.` });
      const requested = args.associations;
      if (requested !== undefined && !supportsAssociations(tool)) {
        return yield* new BusCallError({
          message:
            "The server does not unambiguously advertise association input and effective output; no join was sent. Reconnect to an upgraded server.",
        });
      }
      const joined = yield* client
        .callTool(
          { tool, schema: Joined, arguments: args },
          { timeout: `${CALL_TIMEOUT_SECONDS} seconds` }
        )
        .pipe(
          Effect.mapError((error) =>
            requested === undefined
              ? new BusCallError({ message: error.reason.message })
              : error.reason._tag === "ToolError"
                ? new BusCallError({
                    message: `${error.reason.message}\nIf the server reported a storage failure, the join may have committed; inspect it read-only rather than automatically rejoining.`,
                  })
                : new BusCallError({
                    message:
                      "The association join outcome is uncertain and may have committed. Inspect it read-only; do not automatically rejoin.",
                  })
          )
        );
      if (
        requested !== undefined &&
        (joined.associations === undefined ||
          JSON.stringify(canonicalAssociations(joined.associations)) !==
            JSON.stringify(canonicalAssociations(requested)))
      ) {
        return yield* new BusCallError({
          message: `Joined as ${joined.address}, but the effective associations were absent or mismatched. Inspect them read-only; do not automatically rejoin.`,
        });
      }
      return joined;
    }).pipe(
      Effect.provide(
        McpClient.layerHttp({
          name: "agent-bus-cli",
          version: VERSION,
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
