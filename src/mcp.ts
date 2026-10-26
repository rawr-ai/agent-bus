import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { Bus } from "./Bus.ts";
import { LedgerError, Message, NotJoined, Runtime } from "./domain.ts";
import { Ledger } from "./Ledger.ts";

const Failure = Schema.Union([LedgerError, NotJoined]);
export const Messages = Schema.Struct({ messages: Schema.Array(Message) });
export const Joined = Schema.Struct({ address: Schema.String, cursor: Schema.Number });
export const Published = Schema.Struct({ id: Schema.String, ts: Schema.String });
export const Peers = Schema.Struct({
  peers: Schema.Array(
    Schema.Struct({
      address: Schema.String,
      runtime: Runtime,
      topics: Schema.Array(Schema.String),
      host: Schema.optionalKey(Schema.String),
      note: Schema.optionalKey(Schema.String),
    })
  ),
});

/** The longest a single wait holds its HTTP request open. */
export const MAX_WAIT_SECONDS = 50;

const Address = Schema.String.annotate({
  description:
    "Your bus address, stable for this session, e.g. claude/opa-website or codex/fluree-runtime.",
});

const Join = Tool.make("bus_join", {
  description:
    "Join the agent bus (or rejoin after a restart) before reading. Announces your address, runtime and topics to every peer. Codex sessions pass their own thread id so the bus can wake them with new messages; Claude sessions run `agent-bus wait --address <address>` as a background command to be woken.",
  parameters: Schema.Struct({
    address: Address,
    runtime: Runtime,
    cwd: Schema.String.check(Schema.isStartingWith("/")).annotate({
      description: "Your absolute working directory. Messages you send record its repo and branch.",
    }),
    topics: Schema.optionalKey(Schema.Array(Schema.String)),
    codexThreadId: Schema.optionalKey(Schema.String),
    note: Schema.optionalKey(
      Schema.String.annotate({ description: "What you are working on, for other peers." })
    ),
    replay: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Also deliver messages sent before you joined." })
    ),
  }),
  success: Joined,
  failure: Failure,
});

const Publish = Tool.make("bus_publish", {
  description:
    "Send a message. `to` takes peer addresses, #topic for topic subscribers, or * for everyone. Set replyTo to the id of the message you are answering.",
  parameters: Schema.Struct({
    from: Address,
    to: Schema.Array(Schema.String),
    body: Schema.String,
    subject: Schema.optionalKey(Schema.String),
    replyTo: Schema.optionalKey(Schema.String),
  }),
  success: Published,
  failure: Failure,
});

const Read = Tool.make("bus_read", {
  description: "Return your unread messages and mark them read. Returns immediately.",
  parameters: Schema.Struct({ address: Address, limit: Schema.optionalKey(Schema.Number) }),
  success: Messages,
  failure: Failure,
});

const Wait = Tool.make("bus_wait", {
  description:
    "Wait for your next unread messages (marking them read), up to timeoutSeconds (default and maximum 50). Use while you expect a reply; returns an empty list on timeout.",
  parameters: Schema.Struct({
    address: Address,
    timeoutSeconds: Schema.optionalKey(
      Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_SECONDS }))
    ),
  }),
  success: Messages,
  failure: Failure,
});

const ListPeers = Tool.make("bus_peers", {
  description:
    "List the peers currently joined to the bus, with their runtimes, topics, machines and notes.",
  success: Peers,
  failure: Failure,
});

const History = Tool.make("bus_history", {
  description:
    "Search past messages, newest last. Filter by text and/or a participant address. Does not change what is unread.",
  parameters: Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    participant: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Number),
  }),
  success: Messages,
  failure: Failure,
});

const Query = Tool.make("bus_query", {
  description: `Query the bus ledger with one read-only SPARQL 1.1 SELECT (Fluree store only). Prefixes bus:, xsd:, rdf: and f: need no declaration; FROM and SERVICE are not allowed.
Each entry is a node typed bus:Message or bus:Presence with bus:id, bus:ts (xsd:dateTime), bus:from, bus:to (one value per recipient: an address, #topic or *), bus:subject, bus:body, bus:replyTo (the answered message's node), and where it was written: bus:host, bus:cwd, bus:repo, bus:branch. Presence entries add bus:runtime and bus:status (joined or left).
Rank text with BIND(f:fulltext(?body, "words") AS ?score) FILTER(?score > 0). Pass t to read the ledger as of an earlier commit.
Results are rows with a schema and the commit t they reflect, cut off at 32 KB (hasMore: true), so use LIMIT. Example: SELECT ?from (COUNT(?m) AS ?sent) WHERE { ?m a bus:Message ; bus:from ?from } GROUP BY ?from`,
  parameters: Schema.Struct({
    query: Schema.String,
    t: Schema.optionalKey(
      Schema.Number.annotate({ description: "Commit to read as of; defaults to the latest." })
    ),
  }),
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: Failure,
});

const Leave = Tool.make("bus_leave", {
  description: "Leave the bus; peers stop seeing you and the bus stops waking you.",
  parameters: Schema.Struct({ address: Address }),
  failure: Failure,
});

const BusToolkit = Toolkit.make(Join, Publish, Read, Wait, ListPeers, History, Query, Leave);

const decodeRecord = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));
const toLedgerError = (error: LedgerError | Schema.SchemaError) =>
  error._tag === "LedgerError" ? error : new LedgerError({ message: error.message });

const DEFAULT_HISTORY_LIMIT = 50;

const BusHandlers = BusToolkit.toLayer(
  Effect.gen(function* () {
    const bus = yield* Bus;
    const ledger = yield* Ledger;
    return {
      bus_join: (params) => bus.join(params),
      bus_publish: (params) => bus.publish(params).pipe(Effect.map(({ id, ts }) => ({ id, ts }))),
      bus_read: ({ address, limit }) =>
        bus.take(address, limit).pipe(Effect.map((messages) => ({ messages }))),
      bus_wait: ({ address, timeoutSeconds }) =>
        bus
          .wait(address, timeoutSeconds ?? MAX_WAIT_SECONDS)
          .pipe(Effect.map((messages) => ({ messages }))),
      bus_peers: () =>
        bus.peers.pipe(
          Effect.map((peers) => ({
            peers: peers.map(({ address, presence, host }) => ({
              address,
              runtime: presence.runtime,
              topics: presence.topics,
              ...(host === undefined ? {} : { host }),
              ...(presence.note === undefined ? {} : { note: presence.note }),
            })),
          }))
        ),
      bus_history: ({ query, participant, limit }) =>
        bus
          .history({ query, participant, limit: limit ?? DEFAULT_HISTORY_LIMIT })
          .pipe(Effect.map((messages) => ({ messages }))),
      bus_query: ({ query, t }) =>
        ledger.select(query, t).pipe(Effect.flatMap(decodeRecord), Effect.mapError(toLedgerError)),
      bus_leave: ({ address }) => bus.leave(address),
    };
  })
);

const instructions = `agent-bus lets Claude and Codex sessions message each other.
1. Join once per session with bus_join, choosing a stable address such as claude/<project> or codex/<team>, and giving your working directory.
   Codex sessions pass their own thread id (codexThreadId) so the bus can wake them with new messages.
   Claude sessions then run \`agent-bus wait --address <address>\` as a background command; it exits when messages arrive, which wakes you. Re-run it after handling them.
2. Send with bus_publish; answer a message by setting replyTo to its id.
3. bus_read returns unread messages now; bus_wait blocks until a reply arrives. bus_peers shows who is on the bus; bus_history searches past messages; bus_query runs SPARQL over the whole ledger.`;

/** The bus tools as a streamable HTTP MCP endpoint at `/mcp` on the surrounding router. */
export const layerHttp = (version: string) =>
  McpServer.toolkit(BusToolkit).pipe(
    Layer.provide(BusHandlers),
    Layer.provide(
      McpServer.layerHttp({
        name: "agent-bus",
        version,
        instructions,
        path: "/mcp",
        protocols: [
          McpProtocol.v2026_07_28,
          McpProtocol.v2025_11_25,
          McpProtocol.v2025_06_18,
          McpProtocol.v2025_03_26,
        ],
        allowSessionTermination: true,
        // The tool list never changes, so there is nothing to subscribe to.
        allowSubscriptions: false,
      })
    )
  );
