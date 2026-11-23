import { Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  directAt,
  type LocatedPresence,
  logAt,
  PRESENCE_NODES,
  presencesOf,
} from "./activity-read.ts";
import { LedgerError, type Message, MessageJson } from "./domain.ts";
import { makeFlureeMailbox } from "./FlureeMailbox.ts";
import { makeOwnershipActivation } from "./FlureeOwnershipActivation.ts";
import {
  makeOwnership,
  ownershipEra,
  predecessor,
  successor,
  type Transition,
  vacantSuccessor,
} from "./FlureePresence.ts";
import {
  type Admission,
  type CommandRead,
  commandIri,
  type Designation,
  type DesignationResult,
  type EntryRead,
  Ledger,
  type LocatedSlice,
  type MailboxCandidate,
  messageIri,
  type PresenceRead,
  revisionIri,
  type Slice,
  scopeIri,
  type WitnessRead,
  witnessIri,
} from "./Ledger.ts";
import { mailboxWindow } from "./mailbox-window.ts";
import { ENTRY_READ_BYTES, storable } from "./message-carrier.ts";
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
const apiFor = (config: FlureeConfig) => `${config.url.replace(/\/$/, "")}/v1/fluree`;
const authenticated = (base: HttpClient.HttpClient, config: FlureeConfig) =>
  config.token === undefined
    ? base
    : HttpClient.mapRequest(base, HttpClientRequest.bearerToken(config.token));

/** Pre-open observation only: an error, unknown response or unauthorized caller never means absent. */
export const flureeLedgerExists = (config: FlureeConfig) =>
  Effect.gen(function* () {
    const client = authenticated(yield* HttpClient.HttpClient, config);
    const response = yield* HttpClient.withScope(client).execute(
      HttpClientRequest.get(`${apiFor(config)}/exists/${encodeURIComponent(config.ledger)}`)
    );
    if (response.status < 200 || response.status >= 300) return yield* httpFailure(response.status);
    const value = yield* response.json;
    return (yield* Schema.decodeUnknownEffect(Exists)(value)).exists;
  }).pipe(
    Effect.mapError((error) => (error instanceof LedgerError ? error : invalidResponse())),
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeoutOrElse({ duration: QUERY_TIMEOUT, orElse: () => Effect.fail(invalidResponse()) })
  );
const Info = Schema.Struct({ ledger: Schema.Struct({ t: Schema.Number }) });
const Commit = Schema.Struct({ id: Schema.String });
const ChildCommit = Schema.Struct({
  id: Schema.String,
  t: Schema.Int,
  parents: Schema.Tuple([Schema.String]),
});
const Tip = Schema.Struct({
  commits: Schema.Tuple([Schema.Struct({ t: Schema.Int, commit_id: Schema.String })]),
});
const Rows = Schema.Array(
  Schema.Tuple([Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))])
);
const CandidateRows = Schema.Array(Schema.Tuple([Schema.String, Schema.Int, Schema.Boolean]));
const RoutingRows = Schema.Array(
  Schema.Tuple([
    Schema.String,
    Schema.String,
    Schema.Unknown,
    Schema.Int,
    Schema.Boolean,
    Schema.Unknown,
  ])
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
const Commits = Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)));
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

const stringAsLiteral = (value: unknown) =>
  typeof value === "string" ? { "@value": value, "@type": "xsd:string" } : value;

/** Conditional INSERT templates treat bare object strings beginning with '?' as variables. */
const toGuardedNode = (message: Message, json: string) => {
  const { "@context": _, "@id": id, "@type": type, ...properties } = toNode(message, json);
  return {
    "@id": id,
    "@type": type,
    ...Object.fromEntries(
      Object.entries(properties).map(([property, value]) => [
        property,
        Array.isArray(value) ? value.map(stringAsLiteral) : stringAsLiteral(value),
      ])
    ),
  };
};

/**
 * Inline full-text scoring over message bodies and subjects. Declared in the
 * ledger's config graph before any message is written, so no reindex is needed.
 */
const fullTextConfig = (ledger: string) => ({
  "@context": { ...context, f: "https://ns.flur.ee/db#" },
  insert: {
    "@graph": [
      ownershipEra,
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

export type FlureeCreation =
  | { readonly status: "CREATED"; readonly cut: Pin }
  | { readonly status: "CONFLICT" | "UNKNOWN" };
const CreationReceipt = Schema.Struct({
  ledger_id: Schema.String,
  t: Schema.Int,
  commit: Schema.Struct({ hash: Schema.String }),
});

/**
 * Dispatch once after the caller durably consumes its creation grant. The caller excludes other
 * writers until it opens this incarnation. At t=0 there is no commit CID to identify a replacement.
 */
export const createFlureeLedgerOnce = (
  config: FlureeConfig
): Effect.Effect<FlureeCreation, never, HttpClient.HttpClient> => {
  const unknown = { status: "UNKNOWN" } as const;
  return Effect.gen(function* () {
    const client = HttpClient.withScope(authenticated(yield* HttpClient.HttpClient, config));
    const post = (path: string, body: unknown) =>
      client.execute(
        HttpClientRequest.post(apiFor(config) + path).pipe(HttpClientRequest.bodyJsonUnsafe(body))
      );
    const normalized = config.ledger.includes(":") ? config.ledger : config.ledger + ":main";
    const created = yield* post("/create", { ledger: config.ledger });
    if (created.status === 409) return { status: "CONFLICT" } as const;
    if (created.status !== 201) return unknown;
    const zero = yield* Schema.decodeUnknownEffect(CreationReceipt)(yield* created.json);
    if (zero.ledger_id !== normalized || zero.t !== 0 || zero.commit.hash !== "") return unknown;
    const updated = yield* post(
      "/update?ledger=" + encodeURIComponent(normalized),
      fullTextConfig(normalized)
    );
    if (updated.status !== 200) return unknown;
    const first = yield* Schema.decodeUnknownEffect(CreationReceipt)(yield* updated.json);
    if (first.ledger_id !== normalized || first.t !== 1 || !first.commit.hash) return unknown;
    const cut: Pin = { head: 1, incarnation: first.commit.hash };
    return yield* Effect.gen(function* () {
      const ledger = yield* Ledger;
      if (
        ledger.instance !== cut.incarnation ||
        (yield* ledger.ownershipEraAt(cut)) !== 1 ||
        (yield* ledger.end) !== 1
      )
        return unknown;
      return { status: "CREATED", cut } as const;
    }).pipe(Effect.provide(layerFluree({ ...config, ledger: normalized }, { existingOnly: true })));
  }).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeoutOrElse({ duration: QUERY_TIMEOUT, orElse: () => Effect.succeed(unknown) }),
    Effect.catch(() => Effect.succeed(unknown))
  );
};

/**
 * A ledger on one Fluree transaction server, shared over HTTP by every bus
 * process; the server serializes writers. Each message is one commit, and a
 * cursor is the last commit `t` read. The server's event stream only wakes
 * readers: reading from the cursor decides what is delivered.
 */
export const layerFluree = (
  config: FlureeConfig,
  options?: {
    readonly existingOnly?: boolean;
    /** Lower the mailbox carrier response limit for a constrained reader; never raises the ceiling. */
    readonly mailboxHistoryBytes?: number;
  }
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const base = yield* HttpClient.HttpClient;
      const client = authenticated(base, config);
      const api = apiFor(config);
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

      const capacity = (bytes: number) =>
        new LedgerError({
          message: `Fluree's response exceeded ${bytes} bytes; narrow the query.`,
        });
      /**
       * A pinned query: at most `maxBytes` of response are read, and the request
       * is interrupted after QUERY_TIMEOUT. Upstream error bodies are never read. As in
       * `guardedSend`, the request belongs to this call's scope, so an early refusal, an
       * over-bound body or a timeout closes the connection instead of leaving the body flowing.
       */
      const sendBounded = (
        request: HttpClientRequest.HttpClientRequest,
        maxBytes: number,
        overflow?: LedgerError
      ) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.withScope(client).execute(request);
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
                  ? Effect.fail(overflow ?? capacity(maxBytes))
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
        if (yield* flureeLedgerExists(config)) return;
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

      if (options?.existingOnly !== true) {
        yield* ensureLedger;
        // A creator that stopped before writing the config leaves an empty ledger; finish it.
        if ((yield* end) === 0) yield* writeConfig;
      }
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
        const notification = toGuardedNode(input.notification, json);
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
          // Checked before the send, where a failure is still definite; after it, only UNKNOWN.
          yield* storable(input.notification);
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
        if (message.kind === "presence") {
          const read = yield* presenceAt();
          const admission = yield* admitEntry(message, read.cut, true);
          if (admission.status !== "ADMITTED")
            return yield* new LedgerError({
              message: "The presence append could not be confirmed.",
            });
          return;
        }
        yield* storable(message);
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

      const checkEntryCut = (from: number, cut: Pin) =>
        Effect.gen(function* () {
          if (
            cut.incarnation !== instance ||
            !Number.isSafeInteger(cut.head) ||
            !Number.isSafeInteger(from) ||
            from < 0 ||
            from > cut.head ||
            (yield* guardedIncarnation) !== instance ||
            (yield* guardedHead) < cut.head
          ) {
            return yield* new LedgerError({
              message: "The entry snapshot is unavailable or the ledger was replaced.",
            });
          }
        });

      const entryHistory = (
        start: number,
        stop: number,
        body: Record<string, unknown>,
        bytes = JSONLD_RESPONSE_BYTES,
        overflow?: LedgerError
      ) =>
        sendBounded(
          HttpClientRequest.post(`${api}/query`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              "@context": context,
              from: `${config.ledger}@t:${start}`,
              to: `${config.ledger}@t:${stop}`,
              ...body,
            })
          ),
          bytes,
          overflow
        );

      const witnesses = new WeakMap<Pin, ReadonlyArray<LocatedPresence>>();
      const budget = options?.mailboxHistoryBytes;
      const carrierBytes =
        budget !== undefined && Number.isSafeInteger(budget) && budget > 0
          ? Math.min(budget, JSONLD_RESPONSE_BYTES)
          : JSONLD_RESPONSE_BYTES;
      const carrierOverflow = capacity(carrierBytes);
      const readAt = (from: number, cut: Pin) =>
        bounded(
          Effect.gen(function* () {
            yield* checkEntryCut(from, cut);
            const entries: Array<LocatedSlice["entries"][number]> = [];
            for (let start = from + 1; start <= cut.head; start += READ_WINDOW) {
              const stop = Math.min(cut.head, start + READ_WINDOW - 1);
              const window = yield* mailboxWindow(
                start,
                stop,
                (body) => entryHistory(start, stop, body, carrierBytes, carrierOverflow),
                carrierOverflow,
                (subjects) => {
                  const warm = witnesses.get(cut);
                  if (warm !== undefined) return Effect.succeed(warm);
                  // A caller may supply an independently reconstructed pin. Use the same
                  // validated presence read at that cut, restricted to the known subjects.
                  return query({
                    from: `${config.ledger}@t:${cut.head}`,
                    ...PRESENCE_NODES,
                    values: [
                      ["?m"],
                      subjects.map((subject) => [{ "@value": subject, "@type": "@id" }]),
                    ],
                  }).pipe(Effect.flatMap((response) => presencesOf(response, cut.head)));
                },
                decodeMessage
              );
              for (const entry of window) entries.push(entry);
            }
            yield* checkEntryCut(from, cut);
            entries.sort(
              (a, b) =>
                a.end - b.end ||
                (a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0)
            );
            return { entries, next: cut.head } satisfies LocatedSlice;
          })
        ).pipe(Effect.withSpan("Ledger.readAt"));

      const mailboxCandidatesAt = (from: number, cut: Pin) =>
        bounded(
          Effect.gen(function* () {
            yield* checkEntryCut(from, cut);
            const candidates: Array<MailboxCandidate> = [];
            for (let start = from + 1; start <= cut.head; start += READ_WINDOW) {
              const stop = Math.min(cut.head, start + READ_WINDOW - 1);
              // Filtering a matched type preserves @t and @op; prebinding ?type with VALUES does not.
              const typed = yield* entryHistory(start, stop, {
                select: ["?m", "?t", "?op"],
                where: [
                  {
                    "@id": "?m",
                    "http://www.w3.org/1999/02/22-rdf-syntax-ns#type": {
                      "@type": "@id",
                      "@value": "?type",
                      "@t": "?t",
                      "@op": "?op",
                    },
                  },
                  ["filter", `(= ?type <${BUS}Message>)`],
                ],
              }).pipe(Effect.flatMap(decode(CandidateRows)));
              for (let offset = 0; offset < typed.length; offset += 100) {
                const batch = typed.slice(offset, offset + 100);
                const iri = (value: string) => ({ "@type": "@id", "@value": value });
                const subjects = [...new Set(batch.map(([subject]) => subject))];
                // A generic snapshot predicate can report t=0 for freshly guarded writes. History exposes
                // the actual routing assertions and any later retraction up to the same cut.
                const rows = yield* entryHistory(start, cut.head, {
                  select: ["?m", "?p", "?value", "?t", "?op", "?datatype"],
                  values: [["?m"], subjects.map((subject) => [iri(subject)])],
                  where: [
                    ["values", ["?p", ["id", "from", "to"].map((p) => iri(`bus:${p}`))]],
                    { "@id": "?m", "?p": { "@value": "?value", "@t": "?t", "@op": "?op" } },
                    ["bind", "?datatype", "(datatype ?value)"],
                  ],
                }).pipe(Effect.flatMap(decode(RoutingRows)));
                for (const [subject, end, asserted] of batch) {
                  if (end < start || end > stop) return yield* invalidResponse();
                  const projection = rows.filter(([node]) => node === subject);
                  const fields = new Map<string, Array<string>>();
                  let intact = asserted;
                  for (const [, p, value, t, assertion, datatype] of projection) {
                    if (
                      !assertion ||
                      t !== end ||
                      typeof value !== "string" ||
                      (datatype !== "xsd:string" &&
                        datatype !== "http://www.w3.org/2001/XMLSchema#string")
                    ) {
                      intact = false;
                      break;
                    }
                    const key = p.startsWith(BUS)
                      ? p.slice(BUS.length)
                      : p.startsWith("bus:")
                        ? p.slice("bus:".length)
                        : undefined;
                    if (key !== "id" && key !== "from" && key !== "to") {
                      intact = false;
                      break;
                    }
                    const values = fields.get(key) ?? [];
                    values.push(value);
                    fields.set(key, values);
                  }
                  const ids = fields.get("id") ?? [];
                  const senders = fields.get("from") ?? [];
                  const to = fields.get("to") ?? [];
                  const id = ids.length === 1 ? ids[0] : undefined;
                  const sender = senders.length === 1 ? senders[0] : undefined;
                  const routing =
                    intact && id !== undefined && sender !== undefined
                      ? { id, from: sender, to }
                      : undefined;
                  candidates.push({ subject, end, ...optional("routing", routing) });
                }
              }
            }
            yield* checkEntryCut(from, cut);
            return candidates;
          })
        ).pipe(Effect.withSpan("Ledger.mailboxCandidatesAt"));

      const replaced = () =>
        new LedgerError({
          message:
            "The ledger was replaced while this call read it; nothing was written. Call again.",
        });

      /**
       * Presence at one cut, under the activity log's law (`presencesOf`): every typed presence
       * node must hold one entry and one id that agree, and an entry that holds a session must
       * also be the node its id names, recorded under its own sender. The guard keys on that
       * sender, so a node it could miss, or one the activity relation refuses, fails the read
       * rather than letting an ownership decision rest on a standing that read can't establish.
       */
      const transitions = new WeakMap<Pin, Map<string, Transition>>();
      const presenceAt = (at?: number) =>
        bounded(
          Effect.gen(function* () {
            const id = yield* guardedIncarnation;
            if (id !== instance) return yield* replaced();
            const head = at ?? (yield* guardedHead);
            // The complete history through the ordinary query, uncapped as every presence read
            // has been, pinned at the cut: no application byte cap, so a complete result or a failure.
            const read = yield* query({
              from: `${config.ledger}@t:${head}`,
              ...PRESENCE_NODES,
            }).pipe(Effect.flatMap((response) => presencesOf(response, head)));
            const entries = read.map((entry) => entry.message);
            if ((yield* guardedIncarnation) !== id) return yield* replaced();
            const cut = { head, incarnation: id };
            witnesses.set(cut, read);
            const latest = new Map<string, Transition>();
            for (const { t, message } of read) {
              const prior = latest.get(message.from);
              if (prior?.t === t)
                return yield* new LedgerError({
                  message: "Ambiguous address transitions in one ledger commit.",
                });
              latest.set(message.from, { id: message.id, previous: prior?.id ?? null, t });
            }
            transitions.set(cut, latest);
            return { entries, cut } satisfies PresenceRead;
          })
        ).pipe(Effect.withSpan("Ledger.presenceAt"));

      /** The commit of the attempted entry at `head`, if it is there. */
      const attemptAt = (id: string, head: number) =>
        guardedQuery(head, {
          select: "?t",
          where: { "@id": messageIri(id), "bus:json": { "@value": "?json", "@t": "?t" } },
        }).pipe(Effect.flatMap(decode(Commits)));

      /**
       * The predecessor slot remains empty through sends; a presence consumes it atomically.
       * Read the result from the attempted entry, not the HTTP response. Fails only before sending.
       */
      const admitEntry = (entry: Message, basis: Pin, appendLegacy: boolean) =>
        Effect.gen(function* () {
          if (!appendLegacy && !validOperation(entry.id)) {
            return yield* new LedgerError({ message: "Invalid guarded entry id." });
          }
          yield* storable(entry);
          const json = yield* encode(entry).pipe(
            Effect.mapError(
              () => new LedgerError({ message: "The ledger entry could not be encoded." })
            )
          );
          const node = toGuardedNode(entry, json);
          // Narrows, without closing, the window in which a replaced ledger takes the insert.
          if ((yield* bounded(guardedIncarnation)) !== basis.incarnation) return yield* replaced();
          const slot = yield* ownership.prepare(entry.from, basis);
          const before = yield* bounded(guardedHead);
          if (before < basis.head) return yield* replaced();
          const current = { head: before, incarnation: basis.incarnation };
          const ready =
            before === basis.head ||
            Option.contains(yield* Effect.option(ownership.prepare(entry.from, current)), slot);
          const update = guardedSend(
            HttpClientRequest.post(`${api}/update?ledger=${ledger}`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                "@context": context,
                where: [
                  ...vacantSuccessor(slot),
                  ["optional", { "@id": messageIri(entry.id), "?predicate": "?object" }],
                  ["filter", "(not (bound ?object))"],
                ],
                insert:
                  entry.kind === "presence"
                    ? [{ ...node, ...predecessor(slot) }, successor(slot, entry.id)]
                    : node,
              })
            )
          ).pipe(Effect.flatMap(decode(UpdateResponse)));
          // A failed or undecodable response says nothing about whether Fluree committed.
          const response = ready ? yield* Effect.option(bounded(update)) : Option.none();
          return yield* bounded(
            Effect.gen(function* () {
              const id = yield* guardedIncarnation;
              if (id !== basis.incarnation) return { status: "UNKNOWN" } satisfies Admission;
              const acknowledged =
                Option.isSome(response) && response.value.t >= before && response.value.t > 0;
              const answered = acknowledged || !ready;
              const head = !ready ? before : acknowledged ? response.value.t : yield* guardedHead;
              let commits: ReadonlyArray<number>;
              if (entry.kind === "presence") {
                const stored = yield* mailbox.knownEntry(
                  entry,
                  json,
                  { head, incarnation: id },
                  { slot, after: basis.head }
                );
                if (stored.status === "MALFORMED") return { status: "UNKNOWN" } satisfies Admission;
                if (stored.status === "DIFFERENT") {
                  return { status: "REFUSED", cut: { head, incarnation: id } } satisfies Admission;
                }
                commits = stored.status === "SAME" ? [stored.t] : [];
              } else commits = yield* attemptAt(entry.id, head);
              if ((yield* guardedIncarnation) !== id)
                return { status: "UNKNOWN" } satisfies Admission;
              const commit = commits[0];
              // Only this request's own commit admits it, which lies past the basis: an entry with
              // the id at or before the basis, or at a commit other than the answered one,
              // refused this insert.
              const own =
                commit !== undefined && commit > basis.head && (!answered || commit === head);
              if (commits.length === 1 && commit !== undefined && own) {
                return {
                  status: "ADMITTED",
                  cut: { head: commit, incarnation: id },
                } satisfies Admission;
              }
              if (answered || (commit !== undefined && commit <= basis.head)) {
                return { status: "REFUSED", cut: { head, incarnation: id } } satisfies Admission;
              }
              return { status: "UNKNOWN" } satisfies Admission;
            })
          ).pipe(Effect.catch(() => Effect.succeed({ status: "UNKNOWN" } satisfies Admission)));
        }).pipe(Effect.withSpan("Ledger.admit"));

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
        pin: bounded(
          Effect.gen(function* () {
            const id = yield* guardedIncarnation;
            const head = yield* guardedHead;
            return { head, incarnation: id };
          })
        ).pipe(Effect.withSpan("QueryGateway.pin")),
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

      /** The command at one cut; a partial node is never an absent one. */
      const commandAt = (operation: string, cut: Pin) =>
        Effect.gen(function* () {
          const subject = commandIri(operation);
          const predicates = yield* guardedQuery(cut.head, {
            select: "?predicate",
            where: { "@id": subject, "?predicate": "?object" },
          }).pipe(Effect.flatMap(decode(Strings)));
          if (predicates.length === 0) return { status: "ABSENT", cut } satisfies CommandRead;
          // A literal subject binds a zero `@t`: bind the IRI through a typed `values` instead.
          const rows = yield* guardedQuery(cut.head, {
            select: ["?json", "?t"],
            values: [["?c"], [[{ "@type": "@id", "@value": subject }]]],
            where: {
              "@id": "?c",
              "@type": "bus:AddressCommand",
              "bus:command": { "@value": "?json", "@t": "?t" },
            },
          }).pipe(Effect.flatMap(decode(Rows)), Effect.option);
          const row = Option.isSome(rows) && rows.value.length === 1 ? rows.value[0] : undefined;
          if (row === undefined) return { status: "MALFORMED", cut } satisfies CommandRead;
          const [json, t] = row;
          return { status: "FOUND", json, t, cut } satisfies CommandRead;
        });

      const readCommand = (operation: string) =>
        bounded(
          Effect.gen(function* () {
            const id = yield* guardedIncarnation;
            if (id !== instance) return { status: "UNAVAILABLE" } satisfies CommandRead;
            const head = yield* guardedHead;
            const result = yield* commandAt(operation, { head, incarnation: id });
            if ((yield* guardedIncarnation) !== id) {
              return { status: "UNAVAILABLE" } satisfies CommandRead;
            }
            return result;
          })
        ).pipe(
          Effect.catch(() => Effect.succeed({ status: "UNAVAILABLE" } satisfies CommandRead)),
          Effect.withSpan("Ledger.readCommand")
        );

      /**
       * The entry at one cut, by its id: whether its node has any fact first, so a partial node
       * is never an absent one, then its one stored encoding, which must decode to that id.
       *
       * Both queries read whole stored entries, bounded by ENTRY_READ_BYTES (32 MiB, the bound of
       * whole-entry JSON-LD reads), not the guarded writes' 256 KiB. Every new send is sized
       * against the same constant before its write (`readableEntry` in message-carrier.ts): its
       * stored encoding, pierce set included and escaped as a response escapes it, fits this
       * read. An older entry that doesn't reads as UNAVAILABLE.
       *
       * A transport failure, an over-bound response or a timeout fails the read (UNAVAILABLE).
       * Only a node read completely that is not one decodable entry of the id is MALFORMED.
       */
      const entryQuery = (t: number, body: Record<string, unknown>) =>
        sendBounded(
          HttpClientRequest.post(pinned(t)).pipe(
            HttpClientRequest.bodyJsonUnsafe({ "@context": context, ...body })
          ),
          ENTRY_READ_BYTES
        );
      const entryAt = (id: string, cut: Pin) =>
        Effect.gen(function* () {
          const subject = messageIri(id);
          const facts = yield* entryQuery(cut.head, {
            select: "?predicate",
            where: { "@id": subject, "?predicate": "?object" },
            limit: 1,
          }).pipe(Effect.flatMap(decode(Strings)));
          if (facts.length === 0) return { status: "ABSENT", cut } satisfies EntryRead;
          // As in commandAt: bind the IRI through a typed `values`, so `@t` is the real commit.
          const response = yield* entryQuery(cut.head, {
            select: ["?json", "?t"],
            values: [["?m"], [[{ "@type": "@id", "@value": subject }]]],
            where: { "@id": "?m", "bus:json": { "@value": "?json", "@t": "?t" } },
          });
          const rows = Schema.decodeUnknownOption(Rows)(response);
          const row = Option.isSome(rows) && rows.value.length === 1 ? rows.value[0] : undefined;
          if (row === undefined) return { status: "MALFORMED", cut } satisfies EntryRead;
          const [json, t] = row;
          const message = Schema.decodeUnknownOption(MessageJson)(json);
          if (Option.isNone(message) || message.value.id !== id) {
            return { status: "MALFORMED", cut } satisfies EntryRead;
          }
          return { status: "FOUND", message: message.value, t, cut } satisfies EntryRead;
        });

      const readEntry = (id: string) =>
        bounded(
          Effect.gen(function* () {
            const incarnationId = yield* guardedIncarnation;
            if (incarnationId !== instance) return { status: "UNAVAILABLE" } satisfies EntryRead;
            const head = yield* guardedHead;
            const result = yield* entryAt(id, { head, incarnation: incarnationId });
            if ((yield* guardedIncarnation) !== incarnationId) {
              return { status: "UNAVAILABLE" } satisfies EntryRead;
            }
            return result;
          })
        ).pipe(
          Effect.catch(() => Effect.succeed({ status: "UNAVAILABLE" } satisfies EntryRead)),
          Effect.withSpan("Ledger.readEntry")
        );

      /** One update that inserts the command only while its node holds none. */
      const appendCommand = (operation: string, json: string) =>
        bounded(
          guardedSend(
            HttpClientRequest.post(`${api}/update?ledger=${ledger}`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                "@context": context,
                where: [
                  ["optional", { "@id": commandIri(operation), "bus:command": "?existing" }],
                  ["filter", "(not (bound ?existing))"],
                ],
                insert: {
                  "@id": commandIri(operation),
                  "@type": "bus:AddressCommand",
                  "bus:command": json,
                },
              })
            )
          )
        ).pipe(Effect.asVoid, Effect.withSpan("Ledger.appendCommand"));

      const at = (head: number, body: Readonly<Record<string, unknown>>) =>
        sendBounded(
          HttpClientRequest.post(pinned(head)).pipe(
            HttpClientRequest.bodyJsonUnsafe({ "@context": context, ...body })
          ),
          JSONLD_RESPONSE_BYTES
        );
      const ownership = makeOwnership(at, entryHistory, (address, basis) =>
        Effect.gen(function* () {
          let map = transitions.get(basis);
          if (!map) {
            const read = yield* presenceAt(basis.head);
            if (read.cut.incarnation !== basis.incarnation) return yield* replaced();
            map = transitions.get(read.cut);
          }
          if (!map) return yield* replaced();
          return map.get(address);
        })
      );
      const update = (body: Readonly<Record<string, unknown>>) =>
        bounded(
          guardedSend(
            HttpClientRequest.post(`${api}/update?ledger=${ledger}`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ "@context": context, ...body })
            )
          ).pipe(
            Effect.flatMap(decode(UpdateResponse)),
            Effect.map((response) => response.t)
          )
        );
      const activate = makeOwnershipActivation(
        {
          incarnation: bounded(guardedIncarnation),
          tip: bounded(guardedSend(HttpClientRequest.get(`${api}/log/${ledger}?limit=1`))).pipe(
            Effect.flatMap(decode(Tip)),
            Effect.map(({ commits: [tip] }) => ({ t: tip.t, id: tip.commit_id }))
          ),
          commitAt: (t) =>
            bounded(guardedSend(HttpClientRequest.get(`${api}/show/${ledger}?commit=t:${t}`))).pipe(
              Effect.flatMap(decode(ChildCommit))
            ),
          at,
          history: entryHistory,
          eraAt: ownership.eraAt,
          update,
        },
        instance
      );
      const mailbox = makeFlureeMailbox({
        ownership,
        instance,
        timeout: QUERY_TIMEOUT,
        head: bounded(guardedHead),
        incarnation: bounded(guardedIncarnation),
        at,
        history: entryHistory,
        update,
        messageNode: toGuardedNode,
      });

      return Context.make(
        Ledger,
        Ledger.of({
          instance,
          append,
          readWitness,
          designate,
          read,
          readAt,
          mailboxCandidatesAt,
          end,
          changes,
          presenceAt,
          ownershipEraAt: (cut) =>
            bounded(
              Effect.gen(function* () {
                yield* checkEntryCut(1, cut);
                const era = yield* ownership.eraAt(cut);
                yield* checkEntryCut(1, cut);
                return era;
              })
            ).pipe(Effect.withSpan("Ledger.ownershipEraAt")),
          activateOwnershipEra: (intent) =>
            options?.existingOnly === true
              ? activate(intent).pipe(
                  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
                  Effect.withSpan("Ledger.activateOwnershipEra")
                )
              : Effect.fail(
                  new LedgerError({
                    message: "Ownership activation requires an existing-only ledger binding.",
                  })
                ),
          admit: (entry, basis) => admitEntry(entry, basis, false),
          ...mailbox,
          appendCommand,
          readCommand,
          log: (t) => logAt(gateway, t).pipe(Effect.withSpan("Ledger.log")),
          direct: (address, after, upTo) =>
            directAt(gateway, address, after, upTo).pipe(Effect.withSpan("Ledger.direct")),
          readEntry,
        })
      ).pipe(Context.add(QueryGateway, gateway));
    })
  );
