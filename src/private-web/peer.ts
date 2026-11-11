import { Effect, JsonSchema, ManagedRuntime, Result, Schema } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import type { StandardJSONSchemaV1 } from "effect/StandardSchema";
import { HostedNativeTools as native } from "../mcp.ts";
import type { PeerActor } from "./identity.ts";

const specs = [
  [native.Join, ["session", "runtime", "cwd", "codexThreadId"], true],
  [native.Takeover, ["session", "runtime", "cwd", "codexThreadId"], true],
  [native.Publish, ["session"], true],
  [native.SetActivity, ["session"], true],
  [native.Directory, ["session"], true],
  [native.Bulletin, ["session"], true],
  [native.Orient, ["cwd"], false],
  [native.Read, ["session"], true],
  [native.Wait, ["session"], true],
  [native.Owned, ["session", "runtime"], true],
  [native.ListPeers, [], false],
  [native.History, [], false],
  [native.Query, [], false],
  [native.RunQuery, [], false],
  [native.Queries, [], false],
  [native.Leave, ["session"], true],
] as const;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const wire = (schema: Schema.ConstraintDecoder<unknown>, hidden: ReadonlyArray<string>) => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  const shape = document.schema;
  if (object(shape.properties)) {
    for (const key of hidden) delete shape.properties[key];
  }
  if (Array.isArray(shape.required))
    shape.required = shape.required.filter((key) => !hidden.includes(key));
  const json: StandardJSONSchemaV1.Converter["input"] = ({ target }) => {
    if (target === "draft-2020-12")
      return {
        $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
        ...document.schema,
        ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
      };
    if (target === "draft-07") {
      const draft = JsonSchema.toDocumentDraft07(document);
      return {
        $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
        ...draft.schema,
        ...(Object.keys(draft.definitions).length ? { definitions: draft.definitions } : {}),
      };
    }
    throw new Error("Unsupported schema target.");
  };
  const decode = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
    reportInput: false,
  });
  return {
    "~standard": {
      version: 1 as const,
      vendor: "effect",
      jsonSchema: { input: json, output: json },
      validate: (value: unknown) => {
        if (!object(value) || hidden.some((key) => key in value))
          return { issues: [{ message: "Invalid tool input." }] };
        const injected = Object.fromEntries(
          hidden
            .filter((key) => key !== "codexThreadId")
            .map((key) => [
              key,
              key === "runtime" ? "other" : key === "cwd" ? "/" : "hosted-placeholder",
            ])
        );
        const decoded = decode({ ...value, ...injected });
        if (!Result.isSuccess(decoded) || !object(decoded.success))
          return { issues: [{ message: "Invalid tool input." }] };
        return {
          value: Object.fromEntries(
            Object.entries(decoded.success).filter(([key]) => !hidden.includes(key))
          ),
        };
      },
    },
  };
};

type Exchange = (
  name: string,
  args: Record<string, unknown>
) => Promise<{
  readonly content: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly structuredContent?: Record<string, unknown> | undefined;
  readonly isError?: boolean | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}>;

const failure = (message: string) => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

/** Ownership parameters are never accepted from a caller, even as excess input. */
export const peerTools = (exchange: Exchange, cwd: string) =>
  specs.map(([tool, hidden, sessionRequired]) => {
    const parameters = wire(tool.parametersSchema, hidden);
    const name = tool.name;
    const description =
      name === "bus_join"
        ? "Join a chatgpt/ address for this conversation as runtime other. Rejoin your own address to update topics, associations or note. Another conversation's holding is refused. This interactive peer is not automatically woken."
        : name === "bus_owned_addresses"
          ? "List addresses held by this conversation as runtime other. This read does not change mail, activity or ownership."
          : (tool.description ?? "");
    return {
      name,
      description: `${description} Hosted calls bind conversation identity and bridge directory automatically. Join and takeover only chatgpt/ addresses; take over only on explicit human instruction.`,
      annotations: {
        openWorldHint: false,
        readOnlyHint: [
          "bus_orient",
          "bus_owned_addresses",
          "bus_peers",
          "bus_history",
          "bus_query",
          "bus_run_query",
          "bus_queries",
        ].includes(name),
        destructiveHint: name === "bus_takeover",
      },
      timeoutMs: 70_000,
      parameters,
      outputSchema: wire(tool.successSchema, []),
      execute: async (
        input: unknown,
        context: { readonly actor: PeerActor; readonly signal: AbortSignal }
      ) => {
        const checked = parameters["~standard"].validate(input);
        if (
          !("value" in checked) ||
          typeof checked.value !== "object" ||
          checked.value === null ||
          Array.isArray(checked.value)
        )
          return failure("Invalid tool input.");
        if (context.signal.aborted) return failure("Invocation was cancelled before the Bus call.");
        if (sessionRequired && !context.actor.session)
          return failure(
            "This call requires supported conversation correlation metadata. No Bus call was sent."
          );
        const args = { ...checked.value };
        if (name === "bus_join" || name === "bus_takeover") {
          if (
            typeof args.address !== "string" ||
            !args.address.startsWith("chatgpt/") ||
            args.address.length <= 8
          )
            return failure("Hosted joins and takeovers require a chatgpt/ address.");
          Object.assign(args, { session: context.actor.session, runtime: "other", cwd });
        } else if (name === "bus_owned_addresses") {
          Object.assign(args, { session: context.actor.session, runtime: "other" });
        } else if (sessionRequired) {
          Object.assign(args, { session: context.actor.session });
        } else if (name === "bus_orient") {
          Object.assign(args, { cwd });
        }
        try {
          return await exchange(name, args);
        } catch {
          return failure(
            "The Bus result is unavailable. The operation may have committed or consumed messages; inspect state and do not automatically retry an ambiguous write."
          );
        }
      },
    };
  });

/** Fresh loopback transport per call; discovery checks version before every exchange. */
export const busPeer = async (options: {
  readonly busPort: number;
  readonly expectedBusVersion: string;
}) => {
  if (
    !Number.isInteger(options.busPort) ||
    options.busPort < 1 ||
    options.busPort > 65535 ||
    !options.expectedBusVersion
  )
    throw new Error("Invalid Bus connection.");
  const runtime = ManagedRuntime.make(FetchHttpClient.layer);
  const layer = McpClient.layerHttp({
    name: "agent-bus-hosted-peer",
    version: "1.0.0",
    url: `http://127.0.0.1:${options.busPort}/mcp`,
    protocol: McpProtocol.v2026_07_28,
    timeout: "5 seconds",
    maxMessageBytes: 8 * 1024 * 1024,
  });
  const exchange: Exchange = (name, args) =>
    runtime
      .runPromise(
        Effect.gen(function* () {
          const client = yield* McpClient.McpClient;
          if (client.serverInfo?.version !== options.expectedBusVersion)
            return yield* Effect.fail(new Error("Unexpected Bus version."));
          const tool = (yield* client.listTools()).find((candidate) => candidate.name === name);
          if (!tool) return yield* Effect.fail(new Error("Bus tool unavailable."));
          return yield* client.callTool({ tool, arguments: args }, { timeout: "60 seconds" });
        }).pipe(Effect.provide(layer))
      )
      .then((result) => {
        const { structuredContent, ...rest } = result;
        if (structuredContent !== undefined && !object(structuredContent))
          throw new Error("Invalid Bus result.");
        return {
          ...rest,
          content: result.content.map((item) => ({ ...item })),
          ...(structuredContent === undefined ? {} : { structuredContent }),
        };
      });
  return { exchange, dispose: () => runtime.dispose() };
};
