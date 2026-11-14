import { Effect, JsonSchema, ManagedRuntime, Result, Schema } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import type { StandardJSONSchemaV1 } from "effect/StandardSchema";
import type { DirectToolResult } from "mcp-openapi";
import { HostedNativeTools as native } from "../mcp.ts";
import {
  CheckWakeBindingRequest,
  MAX_WAKE_OBSERVATION_BYTES,
  ObserveWakeRequest,
  sameWakeBinding,
  WakeBindingCheck,
  WakeObservation,
  wakeObservationCarrierBytes,
} from "../wake-observation.ts";
import type { PeerActor } from "./identity.ts";

const specs = [
  [native.Join, ["session", "runtime", "cwd", "codexThreadId"], true],
  [native.Takeover, ["session", "runtime", "cwd", "codexThreadId"], true],
  [native.Publish, ["session"], true],
  [native.SetActivity, ["session"], true],
  [native.Directory, ["session"], true],
  [native.Bulletin, ["session"], true],
  [native.Orient, [], false],
  [native.Read, ["session", "maxResultBytes"], true],
  [native.Wait, ["session", "maxResultBytes"], true],
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

export const wire = (schema: Schema.ConstraintDecoder<unknown>, hidden: ReadonlyArray<string>) => {
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
            .filter((key) => key !== "codexThreadId" && key !== "maxResultBytes")
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

export type Exchange = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<DirectToolResult>;

const failure = (message: string) => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

const HOSTED_READ_BYTES = 4 * 1024 * 1024;
class BeforeDispatch extends Error {}

const canonicalTimestamp = (value: string) => {
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})(\d*)Z$/.exec(value);
  const millis = Date.parse(value);
  return (
    parts !== null &&
    !parts[2]?.endsWith("0") &&
    Number.isFinite(millis) &&
    new Date(millis).toISOString() === `${parts[1]}Z`
  );
};

/** Internal wake calls are never added to the hosted tools catalogue. */
export const wakePort = (exchange: Exchange) => ({
  observe: async (request: ObserveWakeRequest, signal: AbortSignal): Promise<WakeObservation> => {
    const input = Schema.decodeUnknownSync(ObserveWakeRequest, { onExcessProperty: "error" })(
      request
    );
    const result = await exchange("bus_observe_wake", { ...input }, signal);
    if (signal.aborted || result.isError || result.structuredContent === undefined)
      throw new Error("Wake observation unavailable.");
    const observation = Schema.decodeUnknownSync(WakeObservation, { onExcessProperty: "error" })(
      result.structuredContent
    );
    const coverage = observation.nextCoverage;
    if (
      observation.binding.address !== input.address ||
      observation.binding.session !== input.session ||
      observation.binding.runtime !== "other" ||
      observation.observationCut.incarnation !== observation.binding.incarnation ||
      !Number.isSafeInteger(observation.observationCut.head) ||
      (input.expectedBinding !== undefined &&
        !sameWakeBinding(input.expectedBinding, observation.binding)) ||
      (coverage !== undefined &&
        (!sameWakeBinding(coverage.binding, observation.binding) ||
          !Number.isSafeInteger(coverage.cursor) ||
          new Set(coverage.rung).size !== coverage.rung.length)) ||
      observation.ready !== (observation.latestEligibleAt !== undefined) ||
      (observation.latestEligibleAt !== undefined &&
        !canonicalTimestamp(observation.latestEligibleAt)) ||
      (observation.news && (!observation.ready || coverage === undefined)) ||
      (input.previousCoverage !== undefined &&
        coverage !== undefined &&
        coverage.cursor < input.previousCoverage.cursor) ||
      wakeObservationCarrierBytes(observation) > MAX_WAKE_OBSERVATION_BYTES
    )
      throw new Error("Invalid wake observation.");
    return observation;
  },
  check: async (
    request: CheckWakeBindingRequest,
    signal: AbortSignal
  ): Promise<WakeBindingCheck> => {
    const input = Schema.decodeUnknownSync(CheckWakeBindingRequest, { onExcessProperty: "error" })(
      request
    );
    const result = await exchange("bus_check_wake_binding", { ...input }, signal);
    if (signal.aborted || result.isError || result.structuredContent === undefined)
      throw new Error("Wake binding unavailable.");
    const checked = Schema.decodeUnknownSync(WakeBindingCheck, { onExcessProperty: "error" })(
      result.structuredContent
    );
    if (
      !sameWakeBinding(checked.binding, input.expectedBinding) ||
      checked.binding.address !== input.address ||
      checked.binding.session !== input.session ||
      checked.binding.runtime !== "other" ||
      checked.observationCut.incarnation !== checked.binding.incarnation ||
      !Number.isSafeInteger(checked.observationCut.head) ||
      wakeObservationCarrierBytes(checked) > MAX_WAKE_OBSERVATION_BYTES
    )
      throw new Error("Invalid wake binding.");
    return checked;
  },
});

const wakeCapability = (tool: {
  readonly name: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}) => {
  const input = tool.inputSchema;
  const output = tool.outputSchema;
  const annotations = tool.annotations;
  if (!object(input) || !object(input.properties) || !object(output) || !object(annotations))
    return false;
  const required = output.required;
  if (
    annotations.readOnlyHint !== true ||
    annotations.destructiveHint !== false ||
    annotations.openWorldHint !== false ||
    !Array.isArray(required) ||
    !["binding", "observationCut"].every((name) => required.includes(name))
  )
    return false;
  if (tool.name === "bus_check_wake_binding")
    return Array.isArray(input.required) && input.required.includes("expectedBinding");
  const budget = input.properties.maxResultBytes;
  const timeout = input.properties.timeoutSeconds;
  return (
    "expectedBinding" in input.properties &&
    "previousCoverage" in input.properties &&
    object(output.properties) &&
    "latestEligibleAt" in output.properties &&
    object(budget) &&
    budget.type === "integer" &&
    budget.maximum === MAX_WAKE_OBSERVATION_BYTES &&
    object(timeout) &&
    timeout.maximum === 50 &&
    ["ready", "news"].every((name) => required.includes(name))
  );
};

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
    const readLimit =
      name === "bus_read" || name === "bus_wait"
        ? " The oldest whole messages fitting a 4 MiB result carrier are consumed; the rest stay unread. If the first commit cannot fit, the call is refused without moving the cursor."
        : "";
    return {
      name,
      description: `${description}${readLimit} Hosted calls bind conversation identity automatically; joins use the bridge directory. Join and takeover only chatgpt/ addresses; take over only on explicit human instruction.`,
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
        }
        if (name === "bus_read" || name === "bus_wait")
          Object.assign(args, { maxResultBytes: HOSTED_READ_BYTES });
        try {
          return await exchange(name, args, context.signal);
        } catch (error) {
          if (error instanceof BeforeDispatch)
            return failure(
              "The Bus call was not sent; the connection or required tool is unavailable."
            );
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
  const exchange: Exchange = (name, args, signal) => {
    let dispatched = false;
    return runtime
      .runPromise(
        Effect.gen(function* () {
          const client = yield* McpClient.McpClient;
          if (client.serverInfo?.version !== options.expectedBusVersion)
            return yield* Effect.fail(new Error("Unexpected Bus version."));
          const tool = (yield* client.listTools()).find((candidate) => candidate.name === name);
          if (!tool) return yield* Effect.fail(new Error("Bus tool unavailable."));
          if (
            (name === "bus_observe_wake" || name === "bus_check_wake_binding") &&
            !wakeCapability(tool)
          )
            return yield* Effect.fail(new Error("Bus wake observation unavailable."));
          if (name === "bus_read" || name === "bus_wait") {
            const properties = tool.inputSchema.properties;
            const budget = object(properties) ? properties.maxResultBytes : undefined;
            if (
              !object(budget) ||
              budget.type !== "integer" ||
              budget.minimum !== 128 ||
              (budget.maximum !== undefined &&
                (typeof budget.maximum !== "number" || budget.maximum < HOSTED_READ_BYTES))
            )
              return yield* Effect.fail(new Error("Bus read byte admission unavailable."));
          }
          dispatched = true;
          return yield* client.callTool({ tool, arguments: args }, { timeout: "60 seconds" });
        }).pipe(Effect.provide(layer)),
        { signal }
      )
      .then((result) => {
        const { structuredContent, isError, _meta } = result;
        if (structuredContent !== undefined && !object(structuredContent))
          throw new Error("Invalid Bus result.");
        return {
          content: result.content.map((item) => ({ ...item })),
          ...(structuredContent === undefined ? {} : { structuredContent }),
          ...(isError === undefined ? {} : { isError }),
          ...(_meta === undefined ? {} : { _meta }),
        };
      })
      .catch((error: unknown) => {
        if (!dispatched) throw new BeforeDispatch();
        throw error;
      });
  };
  return { exchange, wake: wakePort(exchange), dispose: () => runtime.dispose() };
};
