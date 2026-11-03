import { Context, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { LedgerError, type Message, MessageJson } from "./domain.ts";
import {
  type Designation,
  type DesignationResult,
  Ledger,
  messageIri,
  revisionIri,
  type Slice,
  scopeIri,
  type WitnessRead,
  witnessIri,
} from "./Ledger.ts";
import { type Pin, QueryGateway } from "./Query.ts";
import { POLL_INTERVAL, RECONNECT_INTERVAL } from "./timing.ts";

export interface FlureeConfig {
  /** Transaction server origin, e.g. http://127.0.0.1:8095 */
  readonly url: string;
  /** Ledger id, e.g. agent-bus:main */
  readonly ledger: string;
  /** Bearer token for a server that requires authentication. Never logged. */
  readonly token?: string | undefined;
}

const BUS = "https://rawr.ai/ns/agent-bus#";
const context = { bus: BUS, xsd: "http://www.w3.org/2001/XMLSchema#" };
/** Commits read per query, so no response is large enough to be cut short. */
const READ_WINDOW = 500;
/** Agent JSON: a self-describing result envelope that Fluree trims to a byte budget. */
const AGENT_JSON = "application/vnd.fluree.agent+json";
/** Fluree's row budget for raw SPARQL; the bus's own envelope cap applies on top. */
const SPARQL_MAX_BYTES = 49_152;
/** The largest raw SPARQL response read; anything larger is refused unparsed. */
const SPARQL_RESPONSE_BYTES = 256 * 1024;
/** The largest catalogue query response read; page sizes and caps keep real ones far smaller. */
const JSONLD_RESPONSE_BYTES = 32 * 1024 * 1024;
/**
 * Each query request's deadline; the request is interrupted after it. A fuel
 * limit would not help: in Fluree 4.2.4 it switches on fuel tracking, which
 * replaces Agent JSON with an unbudgeted result.
 */
const QUERY_TIMEOUT = "10 seconds";

const invalidResponse = () => new LedgerError({ message: "Fluree returned an invalid response." });
const httpFailure = (status: number) =>
  new LedgerError({ message: `Fluree request failed (HTTP ${status}).` });

const Exists = Schema.Struct({ exists: Schema.Boolean });
const Info = Schema.Struct({ ledger: Schema.Struct({ t: Schema.Number }) });
const Commit = Schema.Struct({ id: Schema.String });
const Rows = Schema.Array(
  Schema.Tuple([Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))])
);
const JsonRows = Schema.Array(Schema.Tuple([Schema.String]));
const Strings = Schema.Array(Schema.String);
const WitnessRows = Schema.Array(
  Schema.Tuple([
    Schema.String,
    Schema.String,
    Schema.String,
    Schema.String,
    Schema.String,
    Schema.String,
    Schema.String,
  ])
);
const UpdateResponse = Schema.Struct({ t: Schema.Int });
const AgentJson = Schema.Struct({
  // A column whose values have several datatypes lists them all.
  schema: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)]))
  ),
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  t: Schema.Number,
  hasMore: Schema.optionalKey(Schema.Boolean),
});

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : { [key]: value };

/**
 * The graph projection of a message. `bus:json` keeps the exact encoded
 * message, which is what the bus reads back; the other predicates exist so the
 * ledger can be queried, searched and joined (replies link to the message they
 * answer).
 */
export const toNode = (message: Message, json: string) => ({
  "@context": context,
  "@id": messageIri(message.id),
  "@type": message.kind === "presence" ? "bus:Presence" : "bus:Message",
  "bus:id": message.id,
  "bus:ts": { "@value": message.ts, "@type": "xsd:dateTime" },
  "bus:from": message.from,
  "bus:to": [...message.to],
  "bus:body": message.body,
  "bus:json": json,
  ...optional("bus:subject", message.subject),
  ...optional(
    "bus:replyTo",
    message.replyTo === undefined ? undefined : { "@id": messageIri(message.replyTo) }
  ),
  ...optional("bus:host", message.origin?.host),
  ...optional("bus:cwd", message.origin?.cwd),
  ...optional("bus:repo", message.origin?.repo),
  ...optional("bus:branch", message.origin?.branch),
  ...optional("bus:runtime", message.presence?.runtime),
  ...optional("bus:status", message.presence?.status),
});

/**
 * Inline full-text scoring over message bodies and subjects. Declared in the
 * ledger's config graph before any message is written, so no reindex is needed.
 */
const fullTextConfig = (ledger: string) => ({
  "@context": { ...context, f: "https://ns.flur.ee/db#" },
  insert: {
    "@graph": [
      {
        "@id": `urn:fluree:${ledger}:config:ledger`,
        "@type": "f:LedgerConfig",
        "@graph": `urn:fluree:${ledger}#config`,
        "f:fullTextDefaults": {
          "@type": "f:FullTextDefaults",
          "f:defaultLanguage": "en",
          "f:property": [
            { "@type": "f:FullTextProperty", "f:target": { "@id": "bus:body" } },
            { "@type": "f:FullTextProperty", "f:target": { "@id": "bus:subject" } },
          ],
        },
      },
    ],
  },
});

/**
 * A ledger on one Fluree transaction server, shared over HTTP by every bus
 * process; the server serializes writers. Each message is one commit, and a
 * cursor is the last commit `t` read. The server's event stream only wakes
 * readers: reading from the cursor decides what is delivered.
 */
export const layerFluree = (config: FlureeConfig) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const base = yield* HttpClient.HttpClient;
      const client =
        config.token === undefined
          ? base
          : HttpClient.mapRequest(base, HttpClientRequest.bearerToken(config.token));
      const api = `${config.url.replace(/\/$/, "")}/v1/fluree`;
      const ledger = encodeURIComponent(config.ledger);

      /** Upstream bodies and transport details are never safe tool error messages. */
      const send = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          const response = yield* client.execute(request);
          if (response.status >= 400) {
            return yield* httpFailure(response.status);
          }
          return yield* response.json;
        }).pipe(
          Effect.catchTag("HttpClientError", (error) =>
            Effect.fail(
              error.reason._tag === "DecodeError"
                ? invalidResponse()
                : new LedgerError({ message: "Fluree could not complete the request." })
            )
          ),
          Effect.scoped
        );

      /**
       * A pinned query: at most `maxBytes` of response are read, and the request
       * is interrupted after QUERY_TIMEOUT. Upstream error bodies are never read.
       */
      const sendBounded = (request: HttpClientRequest.HttpClientRequest, maxBytes: number) =>
        Effect.gen(function* () {
          const response = yield* client.execute(request);
          if (response.status >= 400) {
            return yield* httpFailure(response.status);
          }
          const chunks = yield* response.stream.pipe(
            Stream.runFoldEffect(
              () => ({ parts: [] as Array<Uint8Array>, size: 0 }),
              (acc, chunk) => {
                acc.parts.push(chunk);
                acc.size += chunk.length;
                return acc.size > maxBytes
                  ? Effect.fail(
                      new LedgerError({
                        message: `Fluree's response exceeded ${maxBytes} bytes; narrow the query.`,
                      })
                    )
                  : Effect.succeed(acc);
              }
            )
          );
          const text = new TextDecoder().decode(Buffer.concat(chunks.parts));
          return yield* Effect.try({
            try: (): unknown => JSON.parse(text),
            catch: invalidResponse,
          });
        }).pipe(
          Effect.catchTag("HttpClientError", () =>
            Effect.fail(new LedgerError({ message: "Fluree could not complete the request." }))
          ),
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: QUERY_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new LedgerError({
                  message: `The query did not finish within ${QUERY_TIMEOUT}; narrow it.`,
                })
              ),
          })
        );

      const decode =
        <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
        (value: unknown) =>
          Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalidResponse));

      const postJson = (path: string, body: unknown) =>
        send(HttpClientRequest.post(`${api}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)));

      const query = (body: Record<string, unknown>) =>
        postJson("/query", { "@context": context, from: config.ledger, ...body });

      const ensureLedger = Effect.gen(function* () {
        const { exists } = yield* send(HttpClientRequest.get(`${api}/exists/${ledger}`)).pipe(
          Effect.flatMap(decode(Exists))
        );
        if (exists) return;
        const created = yield* postJson("/create", { ledger: config.ledger }).pipe(
          Effect.as(true),
          // Another process created it first; that process writes the config.
          Effect.catchIf(
            (error) => error.message === httpFailure(409).message,
            () => Effect.succeed(false)
          )
        );
        if (created) yield* writeConfig;
      });

      const writeConfig = postJson(`/update?ledger=${ledger}`, fullTextConfig(config.ledger));

      const end = send(HttpClientRequest.get(`${api}/info/${ledger}`)).pipe(
        Effect.flatMap(decode(Info)),
        Effect.map((info) => info.ledger.t),
        Effect.withSpan("Ledger.end")
      );

      yield* ensureLedger;
      // A creator that stopped before writing the config leaves an empty ledger; finish it.
      if ((yield* end) === 0) yield* writeConfig;
      // The first commit's id names this incarnation of the ledger.
      const incarnation = send(
        HttpClientRequest.get(`${api}/show/${ledger}?commit=${encodeURIComponent("t:1")}`)
      ).pipe(
        Effect.flatMap(decode(Commit)),
        Effect.map((commit) => commit.id)
      );
      const instance = yield* incarnation;

      const encode = Schema.encodeEffect(MessageJson);
      const decodeMessage = (text: string, t: number) =>
        Schema.decodeUnknownEffect(MessageJson)(text).pipe(
          Effect.mapError(
            () => new LedgerError({ message: `A ledger entry at t=${t} could not be decoded.` })
          )
        );
      const pinned = (t: number) => `${api}/query/${encodeURIComponent(`${config.ledger}@t:${t}`)}`;

      // Unlike the general-purpose sender, every guarded request owns its transport until its
      // body is consumed or the enclosing scope is interrupted. Errors never expose upstream data.
      const guardedSend = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.withScope(client).execute(request);
          if (response.status < 200 || response.status >= 300) {
            return yield* httpFailure(response.status);
          }
          const chunks = yield* response.stream.pipe(
            Stream.runFoldEffect(
              () => ({ parts: [] as Array<Uint8Array>, size: 0 }),
              (acc, chunk) => {
                acc.parts.push(chunk);
                acc.size += chunk.length;
                return acc.size > SPARQL_RESPONSE_BYTES
                  ? Effect.fail(invalidResponse())
                  : Effect.succeed(acc);
              }
            )
          );
          return yield* Effect.try({
            try: (): unknown => JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.parts))),
            catch: invalidResponse,
          });
        }).pipe(
          Effect.catchTag("HttpClientError", () =>
            Effect.fail(new LedgerError({ message: "Fluree could not complete the request." }))
          ),
          Effect.scoped
        );

      const guardedQuery = (t: number, body: Record<string, unknown>) =>
        guardedSend(
          HttpClientRequest.post(pinned(t)).pipe(
            HttpClientRequest.bodyJsonUnsafe({ "@context": context, ...body })
          )
        );
      const guardedIncarnation = guardedSend(
        HttpClientRequest.get(`${api}/show/${ledger}?commit=${encodeURIComponent("t:1")}`)
      ).pipe(
        Effect.flatMap(decode(Commit)),
        Effect.map((commit) => commit.id)
      );
      const guardedHead = guardedSend(HttpClientRequest.get(`${api}/info/${ledger}`)).pipe(
        Effect.flatMap(decode(Info)),
        Effect.map((info) => info.ledger.t)
      );
      const validOperation = (id: string) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
      const validScopeId = (id: string) =>
        typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
      const validScope = (scope: Designation["scope"]) => {
        switch (scope.kind) {
          case "programme":
            return true;
          case "directory":
            return validScopeId(scope.directory);
          case "concern":
            return validScopeId(scope.directory) && validScopeId(scope.concern);
        }
      };
      const invalidDesignation = () =>
        new LedgerError({ message: "Invalid guarded designation input." });

      /** Read all facts for the subject first: a partial witness is never an absent witness. */
      const witnessAt = (operation: string, cut: Pin) =>
        Effect.gen(function* () {
          const subject = witnessIri(operation);
          const predicates = yield* guardedQuery(cut.head, {
            select: "?predicate",
            where: { "@id": subject, "?predicate": "?object" },
          }).pipe(Effect.flatMap(decode(Strings)));
          if (predicates.length === 0) return { status: "ABSENT", cut } satisfies WitnessRead;
          const rawRows = yield* guardedQuery(cut.head, {
            select: [
              "?intent",
              "?revision",
              "?entry",
              "?json",
              "?scope",
              "?record",
              "?revisionEntry",
            ],
            where: [
              {
                "@id": subject,
                "@type": "bus:OrientationWitness",
                "bus:intent": "?intent",
                "bus:revision": "?revision",
                "bus:notification": "?entry",
              },
              {
                "@id": revisionIri(operation),
                "@type": "bus:OrientationRevision",
                "bus:scope": "?scope",
                "bus:record": "?record",
                "bus:notification": "?revisionEntry",
              },
              { "@id": "?entry", "@type": "bus:Message", "bus:json": "?json" },
            ],
          });
          const decodedRows = yield* Effect.option(decode(WitnessRows)(rawRows));
          if (Option.isNone(decodedRows)) return { status: "MALFORMED", cut } satisfies WitnessRead;
          const rows = decodedRows.value;
          const row = rows[0];
          if (rows.length !== 1 || row === undefined) {
            return { status: "MALFORMED", cut } satisfies WitnessRead;
          }
          const [intent, revision, entry, json, , , revisionEntry] = row;
          const decoded = yield* Effect.option(Schema.decodeUnknownEffect(MessageJson)(json));
          if (
            revision !== operation ||
            Option.isNone(decoded) ||
            decoded.value.kind !== "message" ||
            !validOperation(decoded.value.id) ||
            decoded.value.id === operation ||
            entry !== messageIri(decoded.value.id) ||
            revisionEntry !== entry
          ) {
            return { status: "MALFORMED", cut } satisfies WitnessRead;
          }
          return {
            status: "FOUND",
            intent,
            revision,
            notification: decoded.value,
            cut,
          } satisfies WitnessRead;
        });

      const bounded = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: QUERY_TIMEOUT,
            orElse: () => Effect.fail(new LedgerError({ message: "Fluree request timed out." })),
          })
        );

      const readWitness = (operation: string) => {
        if (!validOperation(operation)) return Effect.fail(invalidDesignation());
        return bounded(
          Effect.gen(function* () {
            const id = yield* guardedIncarnation;
            if (id !== instance) return { status: "UNAVAILABLE" } satisfies WitnessRead;
            const head = yield* guardedHead;
            const cut = { head, incarnation: id };
            const result = yield* witnessAt(operation, cut);
            if ((yield* guardedIncarnation) !== id) {
              return { status: "UNAVAILABLE" } satisfies WitnessRead;
            }
            return result;
          })
        ).pipe(Effect.catch(() => Effect.succeed({ status: "UNAVAILABLE" } satisfies WitnessRead)));
      };

      /** A damaged or multi-valued pointer cannot establish a conflict. */
      const currentAt = (scope: Designation["scope"], cut: Pin) =>
        Effect.gen(function* () {
          const subject = scopeIri(scope);
          const predicates = yield* guardedQuery(cut.head, {
            select: "?predicate",
            where: { "@id": subject, "?predicate": "?object" },
          }).pipe(Effect.flatMap(decode(Strings)));
          const rows = yield* guardedQuery(cut.head, {
            select: "?current",
            where: { "@id": subject, "bus:currentRevision": "?current" },
          }).pipe(Effect.flatMap(decode(Strings)));
          if (rows.length === 0 && predicates.length === 0)
            return { valid: true, current: null } as const;
          const current = rows[0];
          if (rows.length !== 1 || current === undefined || !validOperation(current)) {
            return { valid: false } as const;
          }
          return { valid: true, current } as const;
        });

      const designationBody = (input: Designation, json: string) => {
        const subject = scopeIri(input.scope);
        const current = { "@id": subject, "bus:currentRevision": input.expected };
        const target =
          input.expected === null
            ? [
                ["optional", { "@id": subject, "?scopePredicate": "?scopeObject" }],
                ["filter", "(not (bound ?scopeObject))"],
              ]
            : [
                current,
                [
                  "optional",
                  { "@id": subject, "bus:currentRevision": "?otherCurrent" },
                  ["filter", `(!= ?otherCurrent ${JSON.stringify(input.expected)})`],
                ],
                ["filter", "(not (bound ?otherCurrent))"],
              ];
        const fence =
          input.directoryRevision === undefined || input.scope.kind !== "concern"
            ? []
            : [
                {
                  "@id": scopeIri({ kind: "directory", directory: input.scope.directory }),
                  "bus:currentRevision": input.directoryRevision,
                },
                [
                  "optional",
                  {
                    "@id": scopeIri({ kind: "directory", directory: input.scope.directory }),
                    "bus:currentRevision": "?otherDirectory",
                  },
                  ["filter", `(!= ?otherDirectory ${JSON.stringify(input.directoryRevision)})`],
                ],
                ["filter", "(not (bound ?otherDirectory))"],
              ];
        const { "@context": _, ...notification } = toNode(input.notification, json);
        return {
          "@context": context,
          where: [
            ...target,
            ...fence,
            [
              "optional",
              { "@id": witnessIri(input.operation), "?witnessPredicate": "?witnessObject" },
            ],
            ["filter", "(not (bound ?witnessObject))"],
            [
              "optional",
              { "@id": revisionIri(input.operation), "?revisionPredicate": "?revisionObject" },
            ],
            ["filter", "(not (bound ?revisionObject))"],
            [
              "optional",
              { "@id": messageIri(input.notification.id), "?messagePredicate": "?messageObject" },
            ],
            ["filter", "(not (bound ?messageObject))"],
          ],
          ...(input.expected === null ? {} : { delete: current }),
          insert: [
            {
              "@id": subject,
              "bus:scopeKind": input.scope.kind,
              ...(input.scope.kind === "programme"
                ? {}
                : { "bus:directory": input.scope.directory }),
              ...(input.scope.kind === "concern" ? { "bus:concern": input.scope.concern } : {}),
              "bus:currentRevision": input.operation,
            },
            {
              "@id": revisionIri(input.operation),
              "@type": "bus:OrientationRevision",
              "bus:scope": { "@id": subject },
              "bus:record": input.record,
              ...(input.expected === null ? {} : { "bus:supersedes": input.expected }),
              "bus:notification": { "@id": messageIri(input.notification.id) },
            },
            {
              "@id": witnessIri(input.operation),
              "@type": "bus:OrientationWitness",
              "bus:intent": input.intent,
              "bus:revision": input.operation,
              "bus:notification": { "@id": messageIri(input.notification.id) },
            },
            notification,
          ],
        };
      };

      const witnessOutcome = (witness: WitnessRead, intent: string): DesignationResult => {
        if (witness.status !== "FOUND") return { status: "UNKNOWN" };
        if (witness.intent !== intent) return { status: "IDENTITY_MISMATCH", cut: witness.cut };
        return {
          status: "APPLIED",
          revision: witness.revision,
          notification: witness.notification,
          cut: witness.cut,
        };
      };

      const designate = (input: Designation) =>
        Effect.gen(function* () {
          if (
            !validScope(input.scope) ||
            !validOperation(input.operation) ||
            typeof input.intent !== "string" ||
            typeof input.record !== "string" ||
            (input.expected !== null && !validOperation(input.expected)) ||
            input.expected === input.operation ||
            (input.directoryRevision !== undefined &&
              (input.scope.kind !== "concern" || !validOperation(input.directoryRevision))) ||
            input.notification.kind !== "message" ||
            !validOperation(input.notification.id) ||
            input.notification.id === input.operation
          )
            return yield* invalidDesignation();
          const json = yield* encode(input.notification).pipe(Effect.mapError(invalidDesignation));
          const update = guardedSend(
            HttpClientRequest.post(`${api}/update?ledger=${ledger}`).pipe(
              HttpClientRequest.bodyJsonUnsafe(designationBody(input, json))
            )
          ).pipe(Effect.flatMap(decode(UpdateResponse)));
          // A failed or undecodable response says nothing about whether Fluree committed.
          const response = yield* Effect.option(bounded(update));
          if (Option.isNone(response) || response.value.t < 1) {
            return witnessOutcome(yield* readWitness(input.operation), input.intent);
          }
          return yield* bounded(
            Effect.gen(function* () {
              const id = yield* guardedIncarnation;
              if (id !== instance) return { status: "UNKNOWN" } satisfies DesignationResult;
              const cut = { head: response.value.t, incarnation: id };
              const witness = yield* witnessAt(input.operation, cut);
              let outcome = witnessOutcome(witness, input.intent);
              if (witness.status === "ABSENT") {
                const current = yield* currentAt(input.scope, cut);
                if (current.valid && current.current !== input.expected) {
                  outcome = { status: "CONFLICT", current: current.current, cut };
                }
              }
              if ((yield* guardedIncarnation) !== id)
                return { status: "UNKNOWN" } satisfies DesignationResult;
              return outcome;
            })
          ).pipe(
            Effect.catch(() => Effect.succeed({ status: "UNKNOWN" } satisfies DesignationResult))
          );
        }).pipe(Effect.withSpan("Ledger.designate"));

      const append = Effect.fn("Ledger.append")(function* (message: Message) {
        const json = yield* encode(message).pipe(
          Effect.mapError(
            () => new LedgerError({ message: "The ledger entry could not be encoded." })
          )
        );
        yield* postJson(`/insert?ledger=${ledger}`, toNode(message, json));
      });

      const read = Effect.fn("Ledger.read")(function* (from: number) {
        const head = yield* end;
        if (from > head) {
          return yield* new LedgerError({
            message: `Cursor t=${from} is ahead of ${config.ledger} (t=${head}): the ledger was restored from an earlier copy, or the cursor was edited. A plain rejoin keeps this cursor; a rejoin with replay restarts it at 0, delivering all the address's past mail again.`,
          });
        }
        const entries = [];
        // Each message is its own commit, so a window of commits bounds each response.
        for (let start = from + 1; start <= head; start += READ_WINDOW) {
          const stop = Math.min(head, start + READ_WINDOW - 1);
          const rows = yield* query({
            from: `${config.ledger}@t:${start}`,
            to: `${config.ledger}@t:${stop}`,
            select: ["?json", "?t"],
            where: [{ "@id": "?m", "bus:json": { "@value": "?json", "@t": "?t", "@op": true } }],
            orderBy: "?t",
          }).pipe(Effect.flatMap(decode(Rows)));
          for (const [text, t] of rows) {
            const message = yield* decodeMessage(text, t);
            entries.push({ message, end: t });
          }
        }
        return { entries, next: head } satisfies Slice;
      });

      const presence = query({
        select: ["?json", "?t"],
        where: [
          { "@id": "?m", "@type": "bus:Presence", "bus:json": { "@value": "?json", "@t": "?t" } },
        ],
        orderBy: "?t",
      }).pipe(
        Effect.flatMap(decode(Rows)),
        Effect.flatMap((rows) => Effect.forEach(rows, ([json, t]) => decodeMessage(json, t))),
        Effect.withSpan("Ledger.presence")
      );

      // Each (re)connection wakes readers once, since commits may have landed while disconnected.
      const events = HttpClientResponse.stream(
        // The event stream needs no token (it only carries change notices), so none is sent.
        base.execute(HttpClientRequest.get(`${api}/events?ledger=${ledger}`))
      ).pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.map((): void => undefined),
        Stream.prepend([undefined]),
        Stream.concat(Stream.fail(new LedgerError({ message: "Fluree event stream closed" }))),
        Stream.tapError(() => Effect.logWarning("Fluree events disconnected, reconnecting")),
        Stream.retry(Schedule.spaced(RECONNECT_INTERVAL)),
        Stream.catchCause(() => Stream.empty)
      );
      // One event stream serves every reader in this process.
      const changes = yield* Stream.share(Stream.merge(events, Stream.tick(POLL_INTERVAL)), {
        capacity: 1,
        strategy: "sliding",
      });

      const gateway = QueryGateway.of({
        // The incarnation first: a head read after it belongs to that incarnation or a later
        // one, and a later one is caught by the incarnation check that follows every read.
        pin: Effect.gen(function* () {
          const id = yield* incarnation;
          const head = yield* end;
          return { head, incarnation: id };
        }).pipe(Effect.withSpan("QueryGateway.pin")),
        jsonld: (t, body) =>
          sendBounded(
            HttpClientRequest.post(pinned(t)).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                ...body,
                "@context": { ...context, ...(body["@context"] as object | undefined) },
              })
            ),
            JSONLD_RESPONSE_BYTES
          ).pipe(Effect.withSpan("QueryGateway.jsonld")),
        sparql: (t, text) =>
          sendBounded(
            HttpClientRequest.post(pinned(t)).pipe(
              HttpClientRequest.setHeaders({
                accept: AGENT_JSON,
                "fluree-max-bytes": `${SPARQL_MAX_BYTES}`,
              }),
              HttpClientRequest.bodyText(text, "application/sparql-query")
            ),
            SPARQL_RESPONSE_BYTES
          ).pipe(
            Effect.flatMap(decode(AgentJson)),
            Effect.map((result) => ({
              columns: result.schema ?? {},
              rows: result.rows,
              t: result.t,
              truncated: result.hasMore === true,
            })),
            Effect.withSpan("QueryGateway.sparql")
          ),
      });

      return Context.make(
        Ledger,
        Ledger.of({ instance, append, readWitness, designate, read, end, changes, presence })
      ).pipe(Context.add(QueryGateway, gateway));
    })
  );
