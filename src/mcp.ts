import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { Bus } from "./Bus.ts";
import { ThreadHosts } from "./codex.ts";
import { CodexHost, LedgerError, Message, NotJoined, NotOwner, Runtime } from "./domain.ts";
import { Ledger } from "./Ledger.ts";

const Failure = Schema.Union([LedgerError, NotJoined, NotOwner]);
export const Messages = Schema.Struct({ messages: Schema.Array(Message) });
export const Joined = Schema.Struct({
  address: Schema.String,
  cursor: Schema.Number,
  codexHost: Schema.optionalKey(
    CodexHost.annotate({
      description:
        "daemon: the bus can wake this thread, resuming it if needed. other: it runs in another app-server (such as the desktop app's), so the bus wakes it only while this machine's daemon has it loaded.",
    })
  ),
});
export const Published = Schema.Struct({ id: Schema.String, ts: Schema.String });
export const Peers = Schema.Struct({
  peers: Schema.Array(
    Schema.Struct({
      address: Schema.String,
      runtime: Runtime,
      topics: Schema.Array(Schema.String),
      host: Schema.optionalKey(Schema.String),
      codexThreadId: Schema.optionalKey(Schema.String),
      note: Schema.optionalKey(Schema.String),
    })
  ),
});

/** The longest a single wait holds its HTTP request open. */
export const MAX_WAIT_SECONDS = 50;

const Address = Schema.String.annotate({
  description:
    "Your bus address: one session's private inbox, e.g. claude/opa-website-journeys or codex/fluree-runtime. Pick one specific to this session; groups use #topics.",
});

// Optional in the schema so a call without it gets the bus's refusal, which says what to pass.
const Session = Schema.optionalKey(
  Schema.String.annotate({
    description:
      "Required: your runtime's own session id, read from your shell — $CODEX_THREAD_ID in Codex, $CLAUDE_CODE_SESSION_ID in Claude Code; other clients pass a stable id of their own. Only the session that joined an address may use it.",
  })
);

const Join = Tool.make("bus_join", {
  description:
    "Join the agent bus (or rejoin after a restart) before reading. Claims your address for your session and announces your runtime and topics to every peer; an address another session holds is refused, so pick one specific to this session. Codex sessions pass their own thread id so the bus can wake them with new messages, and learn whether it can (codexHost); Claude sessions run `agent-bus wait --address <address>` as a background command to be woken.",
  parameters: Schema.Struct({
    address: Address,
    runtime: Runtime,
    session: Session,
    takeover: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Only to replace a session that has ended, when the human says so: the holder's join id from the refusal. Its unread messages carry over and it is refused from then on.",
      })
    ),
    cwd: Schema.String.check(Schema.isStartingWith("/")).annotate({
      description: "Your absolute working directory. Messages you send record its repo and branch.",
    }),
    topics: Schema.optionalKey(Schema.Array(Schema.String)),
    codexThreadId: Schema.optionalKey(
      Schema.String.annotate({ description: "Codex only: your thread id, the same as session." })
    ),
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
    session: Session,
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
  parameters: Schema.Struct({
    address: Address,
    session: Session,
    limit: Schema.optionalKey(Schema.Number),
  }),
  success: Messages,
  failure: Failure,
});

const Wait = Tool.make("bus_wait", {
  description:
    "Wait for your next unread messages (marking them read), up to timeoutSeconds (default and maximum 50). Use while you expect a reply; returns an empty list on timeout.",
  parameters: Schema.Struct({
    address: Address,
    session: Session,
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
  parameters: Schema.Struct({ address: Address, session: Session }),
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
    const hosts = yield* ThreadHosts;
    return {
      bus_join: (params) =>
        Effect.gen(function* () {
          const codexHost =
            params.runtime === "codex" && params.codexThreadId !== undefined
              ? yield* hosts.classify(params.codexThreadId)
              : undefined;
          const joined = yield* bus.join({ ...params, session: params.session, codexHost });
          return codexHost === undefined ? joined : { ...joined, codexHost };
        }),
      bus_publish: (params) =>
        bus
          .publish({ ...params, session: params.session })
          .pipe(Effect.map(({ id, ts }) => ({ id, ts }))),
      bus_read: ({ address, session, limit }) =>
        bus.take(address, session, limit).pipe(Effect.map((messages) => ({ messages }))),
      bus_wait: ({ address, session, timeoutSeconds }) =>
        bus
          .wait(address, session, timeoutSeconds ?? MAX_WAIT_SECONDS)
          .pipe(Effect.map((messages) => ({ messages }))),
      bus_peers: () =>
        bus.peers.pipe(
          Effect.map((peers) => ({
            peers: peers.map(({ address, presence, host }) => ({
              address,
              runtime: presence.runtime,
              topics: presence.topics,
              ...(host === undefined ? {} : { host }),
              ...(presence.codexThreadId === undefined
                ? {}
                : { codexThreadId: presence.codexThreadId }),
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
      bus_leave: ({ address, session }) => bus.leave(address, session),
    };
  })
);

const instructions = `agent-bus lets Claude and Codex sessions message each other.
1. Join once per session with bus_join, giving your working directory and an address specific to this session, such as claude/<project>-<task> or codex/<team>. An address is one session's private inbox; groups share a #topic instead.
   Pass your runtime's session id as session on every call (join, publish, read, wait, leave): read it from your shell, $CODEX_THREAD_ID in Codex or $CLAUDE_CODE_SESSION_ID in Claude Code. A different session can't use your address, and you can't use one another session holds: choose another address rather than taking it over.
   Codex sessions also pass their thread id as codexThreadId so the bus can wake them with new messages.
   Claude sessions then run \`agent-bus wait --address <address> --runtime claude\` as a background command, one per address; it exits when messages arrive, which wakes you. Re-run it after handling them. Subagents act for their parent and share its id, so a subagent that reads independently needs its own address.
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
