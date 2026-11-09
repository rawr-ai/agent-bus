import { randomBytes } from "node:crypto";
import { Effect, ManagedRuntime, Schema } from "effect";
import { McpClient, McpProtocol, McpSchema } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { MAX_ENVELOPE_BYTES } from "../catalogue.ts";
import { SavedQueryRefusal } from "../domain.ts";
import { SAVED_QUERY_DEADLINE_SECONDS } from "../timing.ts";
import { cursorCodec } from "./cursor.ts";
import { type EvidencePage, NativePage, type Operation } from "./model.ts";

export interface Query {
  readonly name: Operation;
  readonly args: Record<string, unknown>;
  readonly snapshot?: { readonly ledger: string; readonly t: number } | undefined;
  readonly cursor?: string | undefined;
}
type RefusalCode = (typeof SavedQueryRefusal.Type)["code"];
export type ReadResult =
  | { readonly page: typeof EvidencePage.Type }
  | { readonly refusal: RefusalCode | "INVALID_CURSOR" };
export type ReadEvidence = (query: Query) => Promise<ReadResult>;

const decodePage = Schema.decodeUnknownEffect(NativePage);
const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(SavedQueryRefusal));
const tool = new McpSchema.Tool({ name: "bus_run_query", inputSchema: { type: "object" } });
const DISCOVERY_TIMEOUT_SECONDS = 5;
const EXCHANGE_TIMEOUT_SECONDS = SAVED_QUERY_DEADLINE_SECONDS + 5;

export const busReader = async (options: {
  readonly busPort: number;
  readonly pageBytes: number;
  readonly expectedBusVersion: string;
}) => {
  if (!Number.isInteger(options.busPort) || options.busPort < 1 || options.busPort > 65535) {
    throw new Error("Evidence reader requires a loopback Bus port.");
  }
  if (
    !Number.isInteger(options.pageBytes) ||
    options.pageBytes < 1 ||
    options.pageBytes > MAX_ENVELOPE_BYTES
  ) {
    throw new Error("Invalid evidence page budget.");
  }
  if (options.expectedBusVersion.length === 0) throw new Error("Expected Bus version is required.");
  const cursors = cursorCodec(randomBytes(32));
  const runtime = ManagedRuntime.make(FetchHttpClient.layer);
  const layer = McpClient.layerHttp({
    name: "agent-bus-private-evidence",
    version: "1.0.0",
    url: `http://127.0.0.1:${options.busPort}/mcp`,
    protocol: McpProtocol.v2026_07_28,
    timeout: `${DISCOVERY_TIMEOUT_SECONDS} seconds`,
    maxMessageBytes: 512 * 1024,
  });
  // Never retain a failed initialization or assume the Bus behind this port has not changed.
  const checkedClient = McpClient.McpClient.pipe(
    Effect.filterOrFail(
      (client) => client.serverInfo?.version === options.expectedBusVersion,
      () => new Error("Unexpected Bus version.")
    )
  );
  try {
    await runtime.runPromise(checkedClient.pipe(Effect.provide(layer), Effect.asVoid));
  } catch {
    await runtime.dispose();
    throw new Error("Could not open the loopback evidence reader.");
  }

  const read: ReadEvidence = async (input) => {
    const cursor = input.cursor === undefined ? undefined : cursors.open(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) return { refusal: "INVALID_CURSOR" };
    return runtime
      .runPromise(
        Effect.gen(function* (): Effect.fn.Return<ReadResult, Error, McpClient.McpClient> {
          const client = yield* checkedClient;
          const result = yield* client
            .callTool(
              {
                tool,
                arguments: {
                  name: input.name,
                  args: input.args,
                  projection: "message-evidence",
                  maxPageBytes: options.pageBytes,
                  ...input.snapshot,
                  ...(cursor === undefined ? {} : { cursor }),
                },
              },
              { timeout: `${EXCHANGE_TIMEOUT_SECONDS} seconds` }
            )
            .pipe(Effect.option);
          if (result._tag === "None") return { refusal: "UNAVAILABLE" };
          if (result.value.isError) {
            const [content, ...rest] = result.value.content;
            const decoded =
              rest.length === 0 && content?.type === "text"
                ? decodeRefusal(content.text)
                : undefined;
            return { refusal: decoded?._tag === "Some" ? decoded.value.code : "UNAVAILABLE" };
          }
          const decoded = yield* decodePage(result.value.structuredContent).pipe(Effect.option);
          if (decoded._tag === "None") return { refusal: "UNAVAILABLE" };
          const { name, ledger, t, rows, next, damage: _damage, ...signals } = decoded.value;
          if (
            name !== input.name ||
            (next === undefined) !== signals.exhausted ||
            rows.some((row) => row.t > t || (row.score !== undefined) !== (name === "search"))
          )
            return { refusal: "UNAVAILABLE" };
          if (input.snapshot !== undefined) {
            if (ledger !== input.snapshot.ledger) return { refusal: "STALE_LEDGER" };
            if (t !== input.snapshot.t) return { refusal: "UNAVAILABLE" };
          }
          const page = {
            ...signals,
            operation: name,
            snapshot: { ledger, t },
            rows: rows.map(({ t: writtenT, kind: _kind, ...row }) => ({ ...row, writtenT })),
            ...(next === undefined ? {} : { next: cursors.seal(next) }),
          };
          return Buffer.byteLength(JSON.stringify(page)) > options.pageBytes
            ? { refusal: "EVIDENCE_TOO_LARGE" }
            : { page };
        }).pipe(Effect.provide(layer), Effect.timeout(`${EXCHANGE_TIMEOUT_SECONDS} seconds`))
      )
      .catch((): ReadResult => ({ refusal: "UNAVAILABLE" }));
  };

  return { read, dispose: () => runtime.dispose() };
};
