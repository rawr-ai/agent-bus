import { Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { LedgerError, type Message, MessageJson } from "./domain.ts";
import { Ledger, type SearchInput, type Slice } from "./Ledger.ts";
import { BUS, validateSelect } from "./sparql.ts";
import { POLL_INTERVAL, RECONNECT_INTERVAL } from "./timing.ts";

export interface FlureeConfig {
  /** Transaction server origin, e.g. http://127.0.0.1:8095 */
  readonly url: string;
  /** Ledger id, e.g. agent-bus:main */
  readonly ledger: string;
  /** Bearer token for a server that requires authentication. Never logged. */
  readonly token?: string | undefined;
}

const context = { bus: BUS, xsd: "http://www.w3.org/2001/XMLSchema#" };
/** Commits read per query, so no response is large enough to be cut short. */
const READ_WINDOW = 500;
/** Agent JSON: a compact, self-describing result envelope that Fluree truncates to a byte budget. */
const AGENT_JSON = "application/vnd.fluree.agent+json";
const QUERY_MAX_BYTES = 32_768;
/**
 * Queries are bounded by this deadline and the byte budget. A fuel limit would
 * not help: in Fluree 4.2.4 it switches on fuel tracking, which replaces Agent
 * JSON with an unbudgeted SPARQL JSON result.
 */
const QUERY_TIMEOUT = "10 seconds";
const MAX_ERROR_TEXT = 500;

/** Messages are immutable, so each one is a subject named by its id. */
const messageIri = (id: string) => `urn:agent-bus:message:${id}`;

const ledgerError = (cause: unknown) =>
  new LedgerError({ message: cause instanceof Error ? cause.message : String(cause) });

const Exists = Schema.Struct({ exists: Schema.Boolean });
const Info = Schema.Struct({ ledger: Schema.Struct({ t: Schema.Number }) });
const Commit = Schema.Struct({ id: Schema.String });
const Rows = Schema.Array(Schema.Tuple([Schema.String, Schema.Number]));
const JsonRows = Schema.Array(Schema.Tuple([Schema.String]));

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : { [key]: value };

/**
 * The graph projection of a message. `bus:json` keeps the exact encoded
 * message, which is what the bus reads back; the other predicates exist so the
 * ledger can be queried, searched and joined (replies link to the message they
 * answer).
 */
const toNode = (message: Message, json: string) => ({
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
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const base = yield* HttpClient.HttpClient;
      const client =
        config.token === undefined
          ? base
          : HttpClient.mapRequest(base, HttpClientRequest.bearerToken(config.token));
      const api = `${config.url.replace(/\/$/, "")}/v1/fluree`;
      const ledger = encodeURIComponent(config.ledger);

      /** Sends a request and returns its JSON body, failing with the server's error text. */
      const send = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          const response = yield* client.execute(request);
          if (response.status >= 400) {
            const text = yield* response.text;
            return yield* Effect.fail(
              new LedgerError({
                message: `Fluree ${response.status}: ${text.slice(0, MAX_ERROR_TEXT)}`,
              })
            );
          }
          return yield* response.json;
        }).pipe(
          Effect.catchTag("HttpClientError", (error) => Effect.fail(ledgerError(error))),
          Effect.scoped
        );

      const decode =
        <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
        (value: unknown) =>
          Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(ledgerError));

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
            (error) => error.message.startsWith("Fluree 409"),
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
      const instance = yield* send(
        HttpClientRequest.get(`${api}/show/${ledger}?commit=${encodeURIComponent("t:1")}`)
      ).pipe(
        Effect.flatMap(decode(Commit)),
        Effect.map((commit) => commit.id)
      );

      const encode = Schema.encodeEffect(MessageJson);
      const decodeMessage = Schema.decodeUnknownEffect(MessageJson);

      const append = Effect.fn("Ledger.append")(function* (message: Message) {
        const json = yield* encode(message).pipe(Effect.mapError(ledgerError));
        yield* postJson(`/insert?ledger=${ledger}`, toNode(message, json));
      });

      const decodeAll = Effect.fn("Ledger.decodeAll")(function* (texts: ReadonlyArray<string>) {
        const messages: Array<Message> = [];
        for (const text of texts) {
          const decoded = yield* Effect.option(decodeMessage(text));
          if (Option.isSome(decoded)) messages.push(decoded.value);
          else yield* Effect.logWarning("Skipping undecodable message in the Fluree ledger");
        }
        return messages;
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
            const [message] = yield* decodeAll([text]);
            if (message !== undefined) entries.push({ message, end: t });
          }
        }
        return { entries, next: head } satisfies Slice;
      });

      const presence = query({
        select: ["?json"],
        where: [
          { "@id": "?m", "@type": "bus:Presence", "bus:json": { "@value": "?json", "@t": "?t" } },
        ],
        orderBy: "?t",
      }).pipe(
        Effect.flatMap(decode(JsonRows)),
        Effect.flatMap((rows) => decodeAll(rows.map(([json]) => json))),
        Effect.withSpan("Ledger.presence")
      );

      // Search text and participant are bound with `values`, never spliced into the query.
      const search = Effect.fn("Ledger.search")(function* (input: SearchInput) {
        const where: Array<unknown> = [
          {
            "@id": "?m",
            "@type": "bus:Message",
            "bus:json": "?json",
            "bus:ts": "?ts",
            "bus:id": "?id",
          },
        ];
        const vars: Array<string> = [];
        const values: Array<string> = [];
        if (input.participant !== undefined) {
          vars.push("?p");
          values.push(input.participant);
          where.push(["union", { "@id": "?m", "bus:from": "?p" }, { "@id": "?m", "bus:to": "?p" }]);
        }
        if (input.query !== undefined) {
          vars.push("?q");
          values.push(input.query);
          where.push(
            [
              "union",
              { "@id": "?m", "bus:body": "?text" },
              { "@id": "?m", "bus:subject": "?text" },
            ],
            ["bind", "?score", "(fulltext ?text ?q)"],
            ["filter", "(> ?score 0)"]
          );
        }
        const rows = yield* query({
          select: ["?json"],
          ...(vars.length === 0 ? {} : { values: [vars, [values]] }),
          where,
          // Unions can repeat a message, so ask for spare rows and deduplicate.
          orderBy:
            input.query === undefined
              ? [
                  ["desc", "?ts"],
                  ["desc", "?id"],
                ]
              : [["desc", "?score"]],
          limit: input.limit * 2,
        }).pipe(Effect.flatMap(decode(JsonRows)));
        const unique = [...new Set(rows.map(([json]) => json))].slice(0, input.limit);
        const messages = yield* decodeAll(unique);
        // Ids are time-ordered UUIDv7s, which break ties between messages sent in the same millisecond.
        return messages.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
      });

      // The ledger and time are pinned in the path, so a validated query cannot reach other data.
      const select = Effect.fn("Ledger.select")(function* (text: string, t?: number) {
        const sparql = yield* validateSelect(text);
        const head = yield* end;
        const at = t ?? head;
        // Fluree waits for a future t to arrive, so only existing commits are accepted.
        if (!Number.isInteger(at) || at < 1 || at > head) {
          return yield* new LedgerError({ message: `t must be a commit from 1 to ${head}.` });
        }
        return yield* send(
          HttpClientRequest.post(
            `${api}/query/${encodeURIComponent(`${config.ledger}@t:${at}`)}`
          ).pipe(
            HttpClientRequest.setHeaders({
              accept: AGENT_JSON,
              "fluree-max-bytes": `${QUERY_MAX_BYTES}`,
            }),
            HttpClientRequest.bodyText(sparql, "application/sparql-query")
          )
        ).pipe(
          Effect.timeoutOrElse({
            duration: QUERY_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new LedgerError({
                  message: `The query did not finish within ${QUERY_TIMEOUT}; narrow it or add a LIMIT.`,
                })
              ),
          })
        );
      });

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
        Stream.tapError((error) =>
          Effect.logWarning(`Fluree events disconnected, reconnecting: ${String(error)}`)
        ),
        Stream.retry(Schedule.spaced(RECONNECT_INTERVAL)),
        Stream.catchCause(() => Stream.empty)
      );
      // One event stream serves every reader in this process.
      const changes = yield* Stream.share(Stream.merge(events, Stream.tick(POLL_INTERVAL)), {
        capacity: 1,
        strategy: "sliding",
      });

      return Ledger.of({ instance, append, read, end, changes, presence, search, select });
    })
  );
