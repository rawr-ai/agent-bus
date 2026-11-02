import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import {
  InvalidQuery,
  LedgerError,
  latestPresences,
  type Message,
  MessageJson,
  Runtime,
} from "./domain.ts";
import { type Pin, QueryGateway } from "./Query.ts";
import {
  largestFitting,
  MAX_QUERY_LENGTH,
  MAX_SPARQL_ROWS,
  PREFIXES,
  READABLE_PREDICATES,
} from "./sparql.ts";

/**
 * The saved-query catalogue: each operation's metadata, argument and row
 * schemas, and execution live in one definition. `bus_queries`, the
 * `bus_run_query` name enum, argument validation and dispatch all derive from
 * `operations` below. Every query is pinned to one commit `t` of one ledger
 * incarnation; see docs/frames/turnaround-query-design.md.
 */

/** Bumped by any change to an operation's rows, order, unit, defaults or arguments. */
export const CATALOGUE_VERSION = 1;
/** The largest `bus_run_query` or `bus_query` result, as UTF-8 JSON. */
export const MAX_ENVELOPE_BYTES = 65_536;
const MAX_CURSOR_LENGTH = 1024;
const MAX_DAMAGED_AT = 20;
const MAX_THREAD_MEMBERS = 10_000;
const MAX_GROUPS = 10_000;
const MAX_DAY_ROWS = 100_000;
const MAX_WINDOW_DAYS = 366;

const MESSAGE_IRI = "urn:agent-bus:message:";

const invalid = (message: string) => new InvalidQuery({ message });
const invalidResponse = () => new LedgerError({ message: "Fluree returned an invalid response." });

// ---- Rows -------------------------------------------------------------------------------------

const Int = Schema.Int;
const Text = Schema.String;

export const EntryRow = Schema.Struct({
  t: Int.annotate({ description: "The commit that wrote the entry." }),
  id: Text,
  ts: Text.annotate({ description: "When it was sent (ISO 8601); not the order key." }),
  from: Text,
  to: Schema.Array(Text).annotate({ description: "The recipients as recorded." }),
  kind: Schema.Literals(["message", "presence"]),
  subject: Schema.optionalKey(Text),
  body: Text,
  replyTo: Schema.optionalKey(Text),
  origin: Schema.optionalKey(
    Schema.Struct({
      host: Text,
      cwd: Schema.optionalKey(Text),
      repo: Schema.optionalKey(Text),
      branch: Schema.optionalKey(Text),
    })
  ),
  presence: Schema.optionalKey(
    Schema.Struct({
      runtime: Runtime,
      status: Schema.Literals(["joined", "left"]),
      topics: Schema.Array(Text),
      note: Schema.optionalKey(Text),
    })
  ),
});
export type EntryRow = typeof EntryRow.Type;

const entryRow = (message: Message, t: number): EntryRow => ({
  t,
  id: message.id,
  ts: message.ts,
  from: message.from,
  to: [...message.to],
  kind: message.kind,
  body: message.body,
  ...(message.subject === undefined ? {} : { subject: message.subject }),
  ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
  ...(message.origin === undefined
    ? {}
    : {
        origin: {
          host: message.origin.host,
          ...(message.origin.cwd === undefined ? {} : { cwd: message.origin.cwd }),
          ...(message.origin.repo === undefined ? {} : { repo: message.origin.repo }),
          ...(message.origin.branch === undefined ? {} : { branch: message.origin.branch }),
        },
      }),
  // Session, wake and takeover claims stay out of saved-query rows.
  ...(message.presence === undefined
    ? {}
    : {
        presence: {
          runtime: message.presence.runtime,
          status: message.presence.status,
          topics: [...message.presence.topics],
          ...(message.presence.note === undefined ? {} : { note: message.presence.note }),
        },
      }),
});

export const SearchRow = Schema.Struct({
  ...EntryRow.fields,
  score: Schema.Finite.annotate({ description: "Full-text relevance at t; higher is better." }),
});
export type SearchRow = typeof SearchRow.Type;

export const CountRow = Schema.Struct({
  sender: Schema.optionalKey(Text),
  recipient: Schema.optionalKey(Text),
  day: Schema.optionalKey(Text.annotate({ description: "UTC day, YYYY-MM-DD." })),
  count: Int,
});
export type CountRow = typeof CountRow.Type;

export const PeerRow = Schema.Struct({
  address: Text,
  runtime: Runtime,
  status: Schema.Literals(["joined", "left"]),
  topics: Schema.Array(Text),
  since: Schema.optionalKey(Text.annotate({ description: "When that presence was written." })),
  t: Int.annotate({ description: "The commit of that presence." }),
  host: Schema.optionalKey(Text),
  note: Schema.optionalKey(Text),
});
export type PeerRow = typeof PeerRow.Type;

export const DayRow = Schema.Struct({
  day: Text.annotate({ description: "UTC day, YYYY-MM-DD." }),
  directorToCohort: Int,
  observedTraffic: Schema.Boolean,
});
export type DayRow = typeof DayRow.Type;

// ---- Arguments --------------------------------------------------------------------------------

const Limit = (fallback: number, maximum: number) =>
  Schema.optionalKey(
    Int.check(Schema.isBetween({ minimum: 1, maximum })).annotate({
      description: `Page size, 1 to ${maximum}; defaults to ${fallback}.`,
    })
  );
const Token = Text.check(Schema.isMinLength(1)).check(Schema.isMaxLength(512));
const Tokens = (description: string, maximum = 50) =>
  Schema.Array(Token)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(maximum))
    .annotate({ description });
const Instant = Text.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/)
).annotate({ description: "A UTC instant, e.g. 2026-11-01T09:00:00Z." });
const Day = Text.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
  description: "A UTC day, YYYY-MM-DD.",
});
const Participants = Schema.optionalKey(
  Tokens(
    "1 to 50 literal tokens (addresses, #topic, *); an entry matches when its sender or any recorded recipient equals one."
  )
);
const Window = {
  fromTs: Schema.optionalKey(
    Instant.annotate({ description: "Only entries with ts at or after this." })
  ),
  toTs: Schema.optionalKey(Instant.annotate({ description: "Only entries with ts before this." })),
};

const HistoryArgs = Schema.Struct({
  participants: Participants,
  ...Window,
  kinds: Schema.optionalKey(
    Schema.Array(Schema.Literals(["message", "presence"]))
      .check(Schema.isMinLength(1))
      .annotate({ description: 'Entry kinds; defaults to ["message"].' })
  ),
  direction: Schema.optionalKey(
    Schema.Literals(["forward", "backward"]).annotate({
      description: "forward from the oldest entry, backward from the newest; defaults to forward.",
    })
  ),
  limit: Limit(50, 200),
});
const MessagesArgs = Schema.Struct({
  ids: Tokens("1 to 100 message ids, unique; rows keep this order.", 100),
});
const ThreadArgs = Schema.Struct({
  id: Token.annotate({ description: "Any message in the thread." }),
  limit: Limit(100, 200),
});
const SearchArgs = Schema.Struct({
  text: Text.check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(1000))
    .annotate({ description: "Words to rank subjects and bodies by, with stemming." }),
  participants: Participants,
  limit: Limit(50, 200),
});
const CountsArgs = Schema.Struct({
  groupBy: Schema.Array(Schema.Literals(["sender", "recipient", "day"]))
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(3))
    .annotate({
      description: "Group keys: sender, recipient (one recorded recipient), day (UTC).",
    }),
  unit: Schema.Literals(["message", "recipient-pair"]).annotate({
    description:
      "message counts distinct messages per group; recipient-pair counts each recorded recipient of each message.",
  }),
  participants: Participants,
  ...Window,
  limit: Limit(200, 1000),
});
const PeersArgs = Schema.Struct({
  includeLeft: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Also list addresses whose latest presence is a leave.",
    })
  ),
  limit: Limit(100, 500),
});
const DirectorArgs = Schema.Struct({
  director: Token.annotate({ description: "The director's address." }),
  cohort: Tokens("1 to 50 literal addresses, not the director, no #topic or *."),
  concernTopics: Schema.Array(Token).check(Schema.isMaxLength(50)).annotate({
    description: "#topic tokens whose traffic marks an observed-traffic day.",
  }),
  fromDay: Day.annotate({ description: "First UTC day of the window." }),
  toDay: Day.annotate({ description: "UTC day after the window (half-open); at most 366 days." }),
  excludeTopics: Schema.optionalKey(
    Schema.Array(Token).check(Schema.isMaxLength(50)).annotate({
      description:
        "#topic tokens; a message addressed to any of them counts toward neither measure.",
    })
  ),
});

// ---- Pages ------------------------------------------------------------------------------------

/** An entry's keyset key: commit t, then id, so entries sharing a commit stay ordered. */
export type Key = readonly [t: number, id: string];

export type Position =
  | { readonly after: Key }
  | { readonly before: Key }
  | { readonly offset: number };

type Item<Row> =
  | { readonly kind: "row"; readonly row: Row; readonly at: Position; readonly label: string }
  | { readonly kind: "damaged"; readonly t: number; readonly at: Position }
  | { readonly kind: "absent"; readonly id: string; readonly at: Position };

interface Fetched<Row> {
  /** Candidates after the position, in order, up to the page size. */
  readonly items: ReadonlyArray<Item<Row>>;
  /** Whether candidates remain after these at t. */
  readonly more: boolean;
  /** Damaged entries met on this page that hold no position (peers folds them all at once). */
  readonly damagedOutside?: ReadonlyArray<number>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

interface At {
  readonly t: number;
  readonly position: Position;
}

type Fetch<A, Row> = (
  args: A,
  at: At
) => Effect.Effect<Fetched<Row>, LedgerError | InvalidQuery, QueryGateway>;

interface Spec<S extends Schema.Top & { readonly DecodingServices: never }, Row> {
  readonly name: string;
  readonly purpose: string;
  readonly unit: string;
  readonly paging: "keyset" | "offset" | "none";
  /** Without pages: what a caller narrows when the whole result is over the byte limit. */
  readonly narrow?: string;
  /**
   * entries: complete when exhausted with no damage met; ranked: never
   * complete; predicates: never complete, since damaged bus:json is not checked.
   */
  readonly coverage: "entries" | "ranked" | "predicates";
  readonly note: string;
  readonly Args: S;
  readonly Row: Schema.Top;
  readonly example: Readonly<Record<string, unknown>>;
  /** Defaults applied and set-valued lists sorted; refuses semantic errors. */
  readonly normalize: (args: S["Type"]) => Effect.Effect<S["Type"], InvalidQuery>;
  readonly pageSize: (args: S["Type"]) => number;
  readonly start: (args: S["Type"], t: number) => Position;
  readonly fetch: Fetch<S["Type"], Row>;
}

export interface Envelope<Row> {
  readonly name: string;
  readonly catalogueVersion: number;
  readonly ledger: string;
  readonly t: number;
  readonly currentHeadT?: number;
  readonly unit: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly rows: ReadonlyArray<Row>;
  readonly damage: "checked" | "not-checked";
  readonly damaged: number;
  readonly damagedAt?: ReadonlyArray<number>;
  readonly damagedTotal: number;
  readonly exhausted: boolean;
  readonly complete: boolean;
  readonly next?: string;
  readonly note: string;
  readonly notFound?: ReadonlyArray<string>;
  readonly [extra: string]: unknown;
}

export interface RunInput {
  readonly t?: number | undefined;
  readonly cursor?: string | undefined;
}

// ---- Cursors ----------------------------------------------------------------------------------

const PositionSchema = Schema.Union([
  Schema.Struct({ after: Schema.Tuple([Int, Text]) }),
  Schema.Struct({ before: Schema.Tuple([Int, Text]) }),
  Schema.Struct({ offset: Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
]);
const CursorSchema = Schema.Struct({
  v: Schema.Literal(1),
  cv: Int,
  op: Text,
  h: Text,
  i: Text,
  t: Int.check(Schema.isGreaterThanOrEqualTo(1)),
  n: Int.check(Schema.isGreaterThanOrEqualTo(1)),
  p: PositionSchema,
  u: Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
type Cursor = typeof CursorSchema.Type;
const decodeCursorJson = Schema.decodeUnknownEffect(Schema.fromJsonString(CursorSchema), {
  onExcessProperty: "error",
});

const CURSOR_PREFIX = "bq1.";

const encodeCursor = (cursor: Cursor) =>
  `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;

const decodeCursor = (text: string) =>
  Effect.gen(function* () {
    if (text.length > MAX_CURSOR_LENGTH || !text.startsWith(CURSOR_PREFIX)) {
      return yield* invalid("The cursor is not one this bus issued.");
    }
    const json = Buffer.from(text.slice(CURSOR_PREFIX.length), "base64url").toString("utf8");
    return yield* decodeCursorJson(json).pipe(
      Effect.mapError(() => invalid("The cursor is not one this bus issued."))
    );
  });

/** JSON with object keys sorted, so equal arguments hash equally. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const argsHash = (args: Readonly<Record<string, unknown>>) => {
  const { limit: _, ...rest } = args;
  return createHash("sha256")
    .update(canonical(rest))
    .digest()
    .subarray(0, 16)
    .toString("base64url");
};

const samePositionForm = (a: Position, b: Position) =>
  ("after" in a && "after" in b) ||
  ("before" in a && "before" in b) ||
  ("offset" in a && "offset" in b);

// ---- Running ----------------------------------------------------------------------------------

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Pins the snapshot: an explicit t, the cursor's, or head, all checked against the pin. */
const choose = (pin: Pin, input: RunInput, cursor: Cursor | undefined) =>
  Effect.gen(function* () {
    if (
      input.t !== undefined &&
      (!Number.isInteger(input.t) || input.t < 1 || input.t > pin.head)
    ) {
      return yield* invalid(`t must be a commit from 1 to ${pin.head}.`);
    }
    if (cursor === undefined) return input.t ?? pin.head;
    if (cursor.i !== pin.incarnation) {
      return yield* invalid(
        "The ledger was replaced since this cursor was issued; start the traversal again."
      );
    }
    if (cursor.t > pin.head) {
      return yield* invalid(`The cursor's t=${cursor.t} is ahead of the ledger (t=${pin.head}).`);
    }
    if (input.t !== undefined && input.t !== cursor.t) {
      return yield* invalid(`t=${input.t} differs from the cursor's t=${cursor.t}.`);
    }
    return cursor.t;
  });

const run = <S extends Schema.Top & { readonly DecodingServices: never }, Row>(
  spec: Spec<S, Row>,
  args: S["Type"],
  input: RunInput,
  budget: number | undefined
) =>
  Effect.gen(function* () {
    const gateway = yield* QueryGateway;
    const normalized: Readonly<Record<string, unknown>> = { ...(args as object) };
    const hash = argsHash(normalized);
    const size = spec.pageSize(args);
    const cursor = input.cursor === undefined ? undefined : yield* decodeCursor(input.cursor);
    if (cursor !== undefined) {
      if (spec.paging === "none") return yield* invalid(`${spec.name} has no pages to continue.`);
      if (cursor.cv !== CATALOGUE_VERSION) {
        return yield* invalid(
          `The cursor is from catalogue version ${cursor.cv}; this bus runs version ${CATALOGUE_VERSION}. Start again, passing t=${cursor.t} to keep the snapshot.`
        );
      }
      if (cursor.op !== spec.name) {
        return yield* invalid(`The cursor belongs to ${cursor.op}, not ${spec.name}.`);
      }
      if (cursor.h !== hash) {
        return yield* invalid("The cursor was issued for different args; resend the same args.");
      }
      if (cursor.n !== size) {
        return yield* invalid(`The cursor was issued for page size ${cursor.n}, not ${size}.`);
      }
    }

    // Pin first: every name and input below resolves at this commit.
    const pin = yield* gateway.pin;
    const t = yield* choose(pin, input, cursor);
    const start = spec.start(args, t);
    if (cursor !== undefined && !samePositionForm(cursor.p, start)) {
      return yield* invalid("The cursor's position does not fit this operation.");
    }
    const position = cursor?.p ?? start;
    const fetched = yield* spec.fetch(args, { t, position });
    const after = yield* gateway.pin;
    if (after.incarnation !== pin.incarnation) {
      return yield* new LedgerError({
        message: "The ledger was replaced while the query ran; run it again.",
      });
    }

    const previous = cursor?.u ?? 0;
    const outside = fetched.damagedOutside ?? [];
    const envelope = (kept: number): Envelope<Row> => {
      const items = fetched.items.slice(0, kept);
      const rows: Array<Row> = [];
      const damagedAt: Array<number> = [...outside];
      const notFound: Array<string> = [];
      for (const item of items) {
        if (item.kind === "row") rows.push(item.row);
        else if (item.kind === "damaged") damagedAt.push(item.t);
        else notFound.push(item.id);
      }
      const more = fetched.more || kept < fetched.items.length;
      const last = items.at(-1);
      const damagedTotal = previous + damagedAt.length;
      const exhausted = !more;
      return {
        name: spec.name,
        catalogueVersion: CATALOGUE_VERSION,
        ledger: pin.incarnation,
        t,
        ...(after.head > t ? { currentHeadT: after.head } : {}),
        unit: spec.unit,
        args: normalized,
        rows,
        damage: spec.coverage === "predicates" ? "not-checked" : "checked",
        damaged: damagedAt.length,
        ...(damagedAt.length === 0 ? {} : { damagedAt: damagedAt.slice(0, MAX_DAMAGED_AT) }),
        damagedTotal,
        exhausted,
        complete: exhausted && damagedTotal === 0 && spec.coverage === "entries",
        ...(more && last !== undefined
          ? {
              next: encodeCursor({
                v: 1,
                cv: CATALOGUE_VERSION,
                op: spec.name,
                h: hash,
                i: pin.incarnation,
                t,
                n: size,
                p: last.at,
                u: damagedTotal,
              }),
            }
          : {}),
        note: spec.note,
        ...(spec.name === "messages" ? { notFound } : {}),
        ...fetched.extra,
      };
    };

    const all = fetched.items.length;
    if (budget === undefined || bytes(envelope(all)) <= budget) return envelope(all);
    // Without pages, a result is whole or refused: a trimmed one would pair some rows with
    // totals over all of them, and offer a cursor that nothing accepts.
    if (spec.paging === "none") {
      return yield* invalid(
        `The ${spec.name} result exceeds the ${budget}-byte limit and has no pages; narrow ${spec.narrow ?? "the arguments"}.`
      );
    }
    // Trimmed: the page consumes candidates only up to its last emitted row, so a
    // damaged candidate after it is neither counted nor skipped, and the next page
    // starts right after that row.
    let consumed = largestFitting(all - 1, (k) => bytes(envelope(k)) <= budget);
    while (consumed > 0 && fetched.items[consumed - 1]?.kind !== "row") consumed -= 1;
    if (consumed === 0) {
      const first = fetched.items.find((item) => item.kind === "row");
      return yield* invalid(
        first?.kind === "row"
          ? `The entry ${first.label} alone exceeds the ${budget}-byte result limit; read it with bus_query, selecting fewer fields.`
          : `The result exceeds the ${budget}-byte limit; narrow the query.`
      );
    }
    return envelope(consumed);
  });

/** One catalogue operation, with typed access for the presets and erased access for dispatch. */
export interface Operation {
  readonly name: string;
  readonly purpose: string;
  readonly unit: string;
  readonly paging: "keyset" | "offset" | "none";
  readonly coverage: "entries" | "ranked" | "predicates";
  readonly note: string;
  readonly Args: Schema.Top;
  readonly Row: Schema.Top;
  readonly example: Readonly<Record<string, unknown>>;
  readonly invoke: (
    args: unknown,
    input: RunInput,
    budget: number | undefined
  ) => Effect.Effect<Envelope<unknown>, LedgerError | InvalidQuery, QueryGateway>;
}

const define = <S extends Schema.Top & { readonly DecodingServices: never }, Row>(
  spec: Spec<S, Row>
) => {
  const decodeArgs = Schema.decodeUnknownEffect(spec.Args, { onExcessProperty: "error" });
  const prepare = (raw: unknown) =>
    decodeArgs(raw ?? {}).pipe(
      Effect.mapError((error) => invalid(`Invalid args for ${spec.name}: ${error.message}`)),
      Effect.flatMap(spec.normalize)
    );
  return {
    ...spec,
    /** Typed execution for the presets. */
    run: (args: S["Encoded"], input: RunInput, budget: number | undefined) =>
      Effect.flatMap(prepare(args), (decoded) => run(spec, decoded, input, budget)),
    invoke: (raw: unknown, input: RunInput, budget: number | undefined) =>
      Effect.flatMap(prepare(raw), (decoded) => run(spec, decoded, input, budget)),
  };
};

// ---- Query helpers ----------------------------------------------------------------------------

const decodeRows =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalidResponse));

const decodeMessage = Schema.decodeUnknownOption(MessageJson);

/** A decoded entry, or nothing when its stored JSON is missing, malformed or names another id. */
const decodeEntry = (id: string, json: string | null) => {
  if (json === null) return Option.none<Message>();
  return Option.filter(decodeMessage(json), (message) => message.id === id);
};

const dateTime = (value: string) => ({ "@value": value, "@type": "xsd:dateTime" });

/**
 * Ids are looked up by their subject IRI, which keeps the index lookup and the
 * commit t of bus:id. A token that cannot be part of an entry IRI names no entry.
 */
const isEntryId = (id: string) => /^[A-Za-z0-9._~:@-]+$/.test(id);
const entryIri = (id: string) => ({ "@type": "@id", "@value": `${MESSAGE_IRI}${id}` });

/** Every combination of the given variable columns, for one JSON-LD `values` clause. */
const valuesOf = (
  columns: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>
): Record<string, unknown> => {
  const used = columns.filter(([, options]) => options.length > 0);
  if (used.length === 0) return {};
  let rows: Array<Array<unknown>> = [[]];
  for (const [, options] of used) {
    rows = rows.flatMap((row) => options.map((option) => [...row, option]));
  }
  return { values: [used.map(([name]) => name), rows] };
};

const typed = (subject: string, kinds: ReadonlyArray<"message" | "presence">) => {
  const pattern = (kind: "message" | "presence") => ({
    "@id": subject,
    "@type": kind === "message" ? "bus:Message" : "bus:Presence",
  });
  const [only] = kinds;
  return kinds.length === 1 && only !== undefined
    ? [pattern(only)]
    : [["union", pattern("message"), pattern("presence")]];
};

/** A candidate entry: any typed node with an id, whose commit `t` is the id's. */
const candidate = (subject: string) => ({
  "@id": subject,
  "bus:id": { "@value": "?id", "@t": "?t" },
});
const storedJson = (subject: string) => ["optional", { "@id": subject, "bus:json": "?json" }];

const participantMatch = (subject: string) => [
  "union",
  { "@id": subject, "bus:from": "?p" },
  { "@id": subject, "bus:to": "?p" },
];

const windowPatterns = (
  subject: string,
  window: { readonly fromTs?: string | undefined; readonly toTs?: string | undefined }
) =>
  window.fromTs === undefined && window.toTs === undefined
    ? []
    : [
        { "@id": subject, "bus:ts": "?ts" },
        ...(window.fromTs === undefined ? [] : [["filter", "(>= ?ts ?fromTs)"]]),
        ...(window.toTs === undefined ? [] : [["filter", "(< ?ts ?toTs)"]]),
      ];
const windowValues = (window: {
  readonly fromTs?: string | undefined;
  readonly toTs?: string | undefined;
}) =>
  [
    ["?fromTs", window.fromTs === undefined ? [] : [dateTime(window.fromTs)]],
    ["?toTs", window.toTs === undefined ? [] : [dateTime(window.toTs)]],
  ] as const;

const CandidateRows = Schema.Array(
  Schema.Tuple([Schema.Number, Schema.String, Schema.NullOr(Schema.String)])
);

/** Keyset filters on (?t, ?id) against a bound key (?bt, ?bid). */
const AFTER_KEY = "(or (> ?t ?bt) (and (= ?t ?bt) (> ?id ?bid)))";
const BEFORE_KEY = "(or (< ?t ?bt) (and (= ?t ?bt) (< ?id ?bid)))";
const keyOf = (position: Position): Key =>
  "after" in position ? position.after : "before" in position ? position.before : [0, ""];

type Candidate = readonly [t: number, id: string, json: string | null, ...rest: unknown[]];

interface Group<R extends Candidate> {
  readonly first: R;
  /** How many rows share this entry's key: more than one means several bus:json values. */
  copies: number;
  /** The index of the group's last row in the query result. */
  last: number;
}

/**
 * Candidate rows grouped by entry key (t, id). A subject holding two bus:json values comes back
 * as two rows with one key: that is one damaged entry, never two rows or a silent pick. The
 * queries order by key, so a key's rows are adjacent. When the result reached its row limit,
 * its last group may be cut short, so it is left to the next page unless it is the only one.
 */
const groupCandidates = <R extends Candidate>(
  rows: ReadonlyArray<R>,
  size: number
): ReadonlyArray<Group<R>> => {
  const groups: Array<Group<R>> = [];
  for (const [index, row] of rows.entries()) {
    const previous = groups[groups.length - 1];
    if (previous !== undefined && previous.first[0] === row[0] && previous.first[1] === row[1]) {
      previous.copies += 1;
      previous.last = index;
    } else groups.push({ first: row, copies: 1, last: index });
  }
  const whole = rows.length > size && groups.length > 1 ? groups.slice(0, -1) : groups;
  return whole.slice(0, size);
};

const TotalRows = Schema.Array(Schema.Tuple([Schema.Number]));

/** How many bus:json values one entry holds at t (search's rows for it, one per copy). */
const storedCopies = (t: number, id: string) =>
  Effect.flatMap(QueryGateway, (gateway) =>
    gateway
      .jsonld(t, {
        select: ["(as (count-distinct ?json) ?n)"],
        values: [["?m"], [[entryIri(id)]]],
        where: [{ "@id": "?m", "bus:json": "?json" }],
      })
      .pipe(
        Effect.flatMap(decodeRows(TotalRows)),
        Effect.map((rows) => rows[0]?.[0] ?? 0)
      )
  );

/** A grouped candidate's entry, or nothing when it is damaged or stored more than once. */
const decodeGroup = <R extends Candidate>(group: Group<R>) =>
  group.copies > 1 ? Option.none<Message>() : decodeEntry(group.first[1], group.first[2]);

/** Keyset items from (t, id, json) rows fetched with limit size + 1, damaged ones in place. */
const entryItems = (
  rows: ReadonlyArray<readonly [number, string, string | null]>,
  size: number,
  key: "after" | "before"
): { readonly items: Array<Item<EntryRow>>; readonly more: boolean } => ({
  items: groupCandidates(rows, size).map((group) => {
    const [t, id] = group.first;
    const at: Position = key === "after" ? { after: [t, id] } : { before: [t, id] };
    const message = decodeGroup(group);
    return Option.isSome(message)
      ? { kind: "row", row: entryRow(message.value, t), at, label: `${id} (t=${t})` }
      : { kind: "damaged", t, at };
  }),
  more: rows.length > size,
});

const unique = (name: string, values: ReadonlyArray<string> | undefined) =>
  values === undefined || new Set(values).size === values.length
    ? Effect.void
    : Effect.fail(invalid(`${name} has duplicates.`));
const sorted = <A extends string>(values: ReadonlyArray<A>) => [...values].sort();
/** An Instant padded to nanoseconds, so equal instants compare equal whatever their spelling. */
const instantKey = (value: string) => {
  const [seconds, fraction = ""] = value.slice(0, -1).split(".");
  return `${seconds}.${fraction.padEnd(9, "0")}`;
};
const checkWindow = (window: { fromTs?: string | undefined; toTs?: string | undefined }) => {
  for (const value of [window.fromTs, window.toTs]) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) {
      return Effect.fail(invalid(`${value} is not a valid instant.`));
    }
  }
  return window.fromTs !== undefined &&
    window.toTs !== undefined &&
    instantKey(window.fromTs) >= instantKey(window.toTs)
    ? Effect.fail(invalid("fromTs must be before toTs."))
    : Effect.void;
};
const optionalKey = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : { [key]: value };

// ---- Operations -------------------------------------------------------------------------------

export const history = define({
  name: "history",
  purpose: "Entries in commit order, from the oldest (forward) or the newest (backward).",
  unit: "entry",
  paging: "keyset",
  coverage: "entries",
  note: "Entries visible at t, one row per entry, ordered by commit t (ts is reported, not used for order). participants match the sender or a recorded recipient exactly; mail received through a topic or * shows under that token.",
  Args: HistoryArgs,
  Row: EntryRow,
  example: { participants: ["#coordination"], direction: "backward", limit: 20 },
  normalize: (args) =>
    Effect.gen(function* () {
      yield* unique("participants", args.participants);
      yield* unique("kinds", args.kinds);
      yield* checkWindow(args);
      return {
        ...optionalKey("participants", args.participants && sorted(args.participants)),
        ...optionalKey("fromTs", args.fromTs),
        ...optionalKey("toTs", args.toTs),
        kinds: sorted(args.kinds ?? ["message"]),
        direction: args.direction ?? "forward",
        limit: args.limit ?? 50,
      };
    }),
  pageSize: (args) => args.limit ?? 50,
  start: (args, t) =>
    args.direction === "backward" ? { before: [t + 1, ""] } : { after: [0, ""] },
  fetch: (args, at) =>
    Effect.gen(function* () {
      const gateway = yield* QueryGateway;
      const size = args.limit ?? 50;
      const backward = "before" in at.position;
      const [boundT, boundId] = keyOf(at.position);
      const rows = yield* gateway
        .jsonld(at.t, {
          selectDistinct: ["?t", "?id", "?json"],
          ...valuesOf([
            ["?p", args.participants ?? []],
            ["?bt", [boundT]],
            ["?bid", [boundId]],
            ...windowValues(args),
          ]),
          where: [
            ...typed("?m", args.kinds ?? ["message"]),
            candidate("?m"),
            ...(args.participants === undefined ? [] : [participantMatch("?m")]),
            ...windowPatterns("?m", args),
            ["filter", backward ? BEFORE_KEY : AFTER_KEY],
            storedJson("?m"),
          ],
          orderBy: backward
            ? [
                ["desc", "?t"],
                ["desc", "?id"],
              ]
            : ["?t", "?id"],
          limit: size + 1,
        })
        .pipe(Effect.flatMap(decodeRows(CandidateRows)));
      return entryItems(rows, size, backward ? "before" : "after");
    }),
});

export const messages = define({
  name: "messages",
  purpose: "Entries by id, in the order asked; ids absent at t are listed in notFound.",
  unit: "entry",
  paging: "offset",
  coverage: "entries",
  note: "Each id is resolved at t: an id written after t, or never written, is in notFound.",
  Args: MessagesArgs,
  Row: EntryRow,
  example: { ids: ["<message id>"] },
  normalize: (args) => Effect.as(unique("ids", args.ids), { ids: [...args.ids] }),
  pageSize: (args) => args.ids.length,
  start: () => ({ offset: 0 }),
  fetch: (args, at) =>
    Effect.gen(function* () {
      const gateway = yield* QueryGateway;
      const offset = "offset" in at.position ? at.position.offset : 0;
      const wanted = args.ids.slice(offset);
      const lookup = wanted.filter(isEntryId);
      const rows =
        lookup.length === 0
          ? []
          : yield* gateway
              .jsonld(at.t, {
                selectDistinct: ["?t", "?id", "?json"],
                values: [["?m"], lookup.map((id) => [entryIri(id)])],
                where: [candidate("?m"), storedJson("?m")],
              })
              .pipe(Effect.flatMap(decodeRows(CandidateRows)));
      // An id with more than one stored row (several bus:json values) is damaged, not a pick.
      const found = new Map<string, Group<(typeof rows)[number]>>();
      for (const [index, row] of rows.entries()) {
        const group = found.get(row[1]);
        if (group === undefined) found.set(row[1], { first: row, copies: 1, last: index });
        else group.copies += 1;
      }
      const items = wanted.map((id, index): Item<EntryRow> => {
        const position = { offset: offset + index + 1 };
        const group = found.get(id);
        if (group === undefined) return { kind: "absent", id, at: position };
        const row = group.first;
        const message = decodeGroup(group);
        return Option.isSome(message)
          ? {
              kind: "row",
              row: entryRow(message.value, row[0]),
              at: position,
              label: `${id} (t=${row[0]})`,
            }
          : { kind: "damaged", t: row[0], at: position };
      });
      return { items, more: false };
    }),
});

const threadContext = { up: { "@path": "bus:replyTo*" } };
const MemberRows = Schema.Array(
  Schema.Tuple([Schema.String, Schema.NullOr(Schema.String), Schema.NullOr(Schema.String)])
);
const ResolvedRows = Schema.Array(Schema.Tuple([Schema.Number]));

export const thread = define({
  name: "thread",
  purpose:
    "The reply tree containing a message, from the nearest top its replyTo links reach at t, in commit order.",
  unit: "entry",
  paging: "keyset",
  coverage: "entries",
  note: "The tree follows replyTo links only, up to the nearest top they reach at t: a reply to an id that is not an entry at t cuts it there, so mail above that gap is outside it, and so is related mail without a reply link; whole-job coverage pairs thread with history. root is absent when the tree is cut; missingReplyTargets are the replied-to ids that are not entries at t.",
  Args: ThreadArgs,
  Row: EntryRow,
  example: { id: "<message id>" },
  normalize: (args) => Effect.succeed({ id: args.id, limit: args.limit ?? 100 }),
  pageSize: (args) => args.limit ?? 100,
  start: () => ({ after: [0, ""] }),
  fetch: (args, at) =>
    Effect.gen(function* () {
      const gateway = yield* QueryGateway;
      const size = args.limit ?? 100;
      if (!isEntryId(args.id)) {
        return yield* invalid(`Message ${args.id} is not in the ledger at t=${at.t}.`);
      }
      const focusIri = entryIri(args.id);
      const focus = { values: [["?f"], [[focusIri]]] };
      const resolved = yield* gateway
        .jsonld(at.t, {
          select: ["?t"],
          ...focus,
          where: [{ "@id": "?f", "bus:id": { "@value": "?fid", "@t": "?t" } }],
        })
        .pipe(Effect.flatMap(decodeRows(ResolvedRows)));
      if (resolved.length === 0) {
        return yield* invalid(`Message ${args.id} is not in the ledger at t=${at.t}.`);
      }
      const tree = [
        { "@id": "?f", up: "?top" },
        { "@id": "?d", up: "?top" },
      ];
      const members = yield* gateway
        .jsonld(at.t, {
          "@context": threadContext,
          selectDistinct: ["?d", "?r", "?did"],
          ...focus,
          where: [
            ...tree,
            ["optional", { "@id": "?d", "bus:id": "?did" }],
            ["optional", { "@id": "?d", "bus:replyTo": "?r" }],
          ],
          limit: MAX_THREAD_MEMBERS * 2 + 1,
        })
        .pipe(Effect.flatMap(decodeRows(MemberRows)));
      const entries = members.filter(([, , id]) => id !== null);
      const memberIris = new Set(entries.map(([iri]) => iri));
      if (memberIris.size > MAX_THREAD_MEMBERS) {
        return yield* invalid(
          `The thread has more than ${MAX_THREAD_MEMBERS} messages; read it with history.`
        );
      }
      const missing = new Set<string>();
      let root: string | undefined;
      for (const [, target, id] of entries) {
        if (target === null) root = id ?? undefined;
        else if (!memberIris.has(target)) {
          missing.add(target.startsWith(MESSAGE_IRI) ? target.slice(MESSAGE_IRI.length) : target);
        }
      }
      const [boundT, boundId] = keyOf(at.position);
      const rows = yield* gateway
        .jsonld(at.t, {
          "@context": threadContext,
          selectDistinct: ["?t", "?id", "?json"],
          values: [["?f", "?bt", "?bid"], [[focusIri, boundT, boundId]]],
          where: [...tree, candidate("?d"), ["filter", AFTER_KEY], storedJson("?d")],
          orderBy: ["?t", "?id"],
          limit: size + 1,
        })
        .pipe(Effect.flatMap(decodeRows(CandidateRows)));
      return {
        ...entryItems(rows, size, "after"),
        extra: {
          ...optionalKey("root", root),
          members: memberIris.size,
          missingReplyTargets: [...missing].sort(),
        },
      };
    }),
});

const SearchRows = Schema.Array(
  Schema.Tuple([Schema.Number, Schema.String, Schema.NullOr(Schema.String), Schema.Finite])
);

export const search = define({
  name: "search",
  purpose: "Messages ranked by full-text relevance over subjects and bodies.",
  unit: "ranked match",
  paging: "offset",
  coverage: "ranked",
  note: "Ranked matches with stemming, best first, ties in commit order; never a complete relation. A new ledger's index can briefly find nothing. Joins and leaves are not searched.",
  Args: SearchArgs,
  Row: SearchRow,
  example: { text: "deploy rollback", limit: 10 },
  normalize: (args) =>
    Effect.as(unique("participants", args.participants), {
      text: args.text,
      ...optionalKey("participants", args.participants && sorted(args.participants)),
      limit: args.limit ?? 50,
    }),
  pageSize: (args) => args.limit ?? 50,
  start: () => ({ offset: 0 }),
  fetch: (args, at) =>
    Effect.gen(function* () {
      const gateway = yield* QueryGateway;
      const size = args.limit ?? 50;
      const offset = "offset" in at.position ? at.position.offset : 0;
      const rows = yield* gateway
        .jsonld(at.t, {
          select: ["?t", "?id", "?json", "(as (max ?score) ?best)"],
          ...valuesOf([
            ["?q", [args.text]],
            ["?p", args.participants ?? []],
          ]),
          where: [
            ...typed("?m", ["message"]),
            candidate("?m"),
            [
              "union",
              { "@id": "?m", "bus:body": "?text" },
              { "@id": "?m", "bus:subject": "?text" },
            ],
            ["bind", "?score", "(fulltext ?text ?q)"],
            ["filter", "(> ?score 0)"],
            ...(args.participants === undefined ? [] : [["exists", participantMatch("?m")]]),
            storedJson("?m"),
          ],
          groupBy: ["?t", "?id", "?json"],
          // Every stored copy of an entry scores the same, so ordering by key after the
          // score keeps its rows adjacent.
          orderBy: [["desc", "?best"], "?t", "?id"],
          limit: size + 1,
          offset,
        })
        .pipe(Effect.flatMap(decodeRows(SearchRows)));
      const groups = groupCandidates(rows, size);
      // Offsets count result rows (one per stored copy), so a position is just past the
      // group's last row. A lone group that filled the page may continue past it: its copies
      // are counted at the same t, so the next page starts after the whole entry and never
      // decodes the rest of it as an entry of its own.
      const lone = rows.length > size && groups.length === 1 ? groups[0] : undefined;
      if (lone !== undefined) {
        lone.last = Math.max(lone.last, (yield* storedCopies(at.t, lone.first[1])) - 1);
      }
      const items = groups.map((group): Item<SearchRow> => {
        const [t, id, , score] = group.first;
        const position = { offset: offset + group.last + 1 };
        const message = decodeGroup(group);
        return Option.isSome(message)
          ? {
              kind: "row",
              row: { ...entryRow(message.value, t), score },
              at: position,
              label: `${id} (t=${t})`,
            }
          : { kind: "damaged", t, at: position };
      });
      return { items, more: rows.length > size };
    }),
});

const GROUP_VARS = { sender: "?from", recipient: "?r", day: "?day" } as const;
const CountRows = Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number])));

/** The messages in scope of a predicate-only measure, as where-clauses over ?m. */
const scopeOf = (args: {
  readonly participants?: ReadonlyArray<string> | undefined;
  readonly fromTs?: string | undefined;
  readonly toTs?: string | undefined;
}) => ({
  values: valuesOf([["?p", args.participants ?? []], ...windowValues(args)]),
  where: [
    ...typed("?m", ["message"]),
    ...(args.participants === undefined ? [] : [["exists", participantMatch("?m")]]),
    ...windowPatterns("?m", args),
  ],
});

/** A lower bound on the damage a predicate-only measure cannot see: entries in scope without bus:json. */
const missingJson = (t: number, scope: ReturnType<typeof scopeOf>) =>
  Effect.flatMap(QueryGateway, (gateway) =>
    gateway
      .jsonld(t, {
        select: ["(as (count-distinct ?m) ?n)"],
        ...scope.values,
        where: [...scope.where, ["minus", { "@id": "?m", "bus:json": "?json" }]],
      })
      .pipe(
        Effect.flatMap(decodeRows(TotalRows)),
        Effect.map((rows) => rows[0]?.[0] ?? 0)
      )
  );

export const counts = define({
  name: "counts",
  purpose: "Message counts grouped by sender, recipient and/or UTC day.",
  unit: "group",
  paging: "offset",
  coverage: "predicates",
  note: "Counted from graph predicates without decoding bus:json, so damaged entries are not checked (damage: not-checked; missingJson is a lower bound). With unit message, a message counts once in every group it falls in, so group sums can exceed total. day is the UTC day of ts.",
  Args: CountsArgs,
  Row: CountRow,
  example: { groupBy: ["sender", "day"], unit: "message", fromTs: "2026-11-01T00:00:00Z" },
  normalize: (args) =>
    Effect.gen(function* () {
      yield* unique("groupBy", args.groupBy);
      yield* unique("participants", args.participants);
      yield* checkWindow(args);
      return {
        groupBy: (["sender", "recipient", "day"] as const).filter((key) =>
          args.groupBy.includes(key)
        ),
        unit: args.unit,
        ...optionalKey("participants", args.participants && sorted(args.participants)),
        ...optionalKey("fromTs", args.fromTs),
        ...optionalKey("toTs", args.toTs),
        limit: args.limit ?? 200,
      };
    }),
  pageSize: (args) => args.limit ?? 200,
  start: () => ({ offset: 0 }),
  fetch: (args, at) =>
    Effect.gen(function* () {
      const gateway = yield* QueryGateway;
      const size = args.limit ?? 200;
      const offset = "offset" in at.position ? at.position.offset : 0;
      const scope = scopeOf(args);
      const keys = args.groupBy;
      const vars = keys.map((key) => GROUP_VARS[key]);
      const needsRecipient = keys.includes("recipient") || args.unit === "recipient-pair";
      const shape = [
        ...(keys.includes("sender") ? [{ "@id": "?m", "bus:from": "?from" }] : []),
        ...(needsRecipient ? [{ "@id": "?m", "bus:to": "?r" }] : []),
        ...(keys.includes("day")
          ? [{ "@id": "?m", "bus:ts": "?ts" }, ["bind", "?day", "(subStr (str ?ts) 1 10)"]]
          : []),
        ...(args.unit === "recipient-pair" ? [["bind", "?pair", '(concat (str ?m) " " ?r)']] : []),
      ];
      const counted = args.unit === "message" ? "?m" : "?pair";
      const groups = yield* gateway
        .jsonld(at.t, {
          select: [...vars, `(as (count-distinct ${counted}) ?n)`],
          ...scope.values,
          where: [...scope.where, ...shape],
          groupBy: vars,
          orderBy: vars,
          limit: MAX_GROUPS + 1,
        })
        .pipe(Effect.flatMap(decodeRows(CountRows)));
      if (groups.length > MAX_GROUPS) {
        return yield* invalid(`More than ${MAX_GROUPS} groups; narrow the window or the grouping.`);
      }
      const total = yield* gateway
        .jsonld(at.t, {
          select: [`(as (count-distinct ${counted}) ?n)`],
          ...scope.values,
          where: [
            ...scope.where,
            ...(args.unit === "recipient-pair"
              ? [{ "@id": "?m", "bus:to": "?r" }, ["bind", "?pair", '(concat (str ?m) " " ?r)']]
              : []),
          ],
        })
        .pipe(
          Effect.flatMap(decodeRows(TotalRows)),
          Effect.map((rows) => rows[0]?.[0] ?? 0)
        );
      const missing = yield* missingJson(at.t, scope);
      const items = groups.slice(offset, offset + size).map((group, index): Item<CountRow> => {
        const row: Record<string, unknown> = { count: Number(group[keys.length]) };
        keys.forEach((key, column) => {
          row[key] = String(group[column]);
        });
        return {
          kind: "row",
          row: {
            ...optionalKey("sender", keys.includes("sender") ? String(row.sender) : undefined),
            ...optionalKey(
              "recipient",
              keys.includes("recipient") ? String(row.recipient) : undefined
            ),
            ...optionalKey("day", keys.includes("day") ? String(row.day) : undefined),
            count: Number(row.count),
          },
          at: { offset: offset + index + 1 },
          label: `group ${offset + index + 1}`,
        };
      });
      return {
        items,
        more: offset + size < groups.length,
        extra: { total, missingJson: missing },
      };
    }),
});

export const peers = define({
  name: "peers",
  purpose: "The latest recorded presence per address at t.",
  unit: "address",
  paging: "offset",
  coverage: "entries",
  note: "The latest presence each address recorded at or before t, decoded at t: not membership at send time and not receipt. Presences without a session (from before addresses had owners) are ignored, as delivery ignores them.",
  Args: PeersArgs,
  Row: PeerRow,
  example: { includeLeft: true },
  normalize: (args) =>
    Effect.succeed({ includeLeft: args.includeLeft ?? false, limit: args.limit ?? 100 }),
  pageSize: (args) => args.limit ?? 100,
  start: () => ({ offset: 0 }),
  fetch: (args, at) =>
    Effect.gen(function* () {
      const gateway = yield* QueryGateway;
      const size = args.limit ?? 100;
      const offset = "offset" in at.position ? at.position.offset : 0;
      const rows = yield* gateway
        .jsonld(at.t, {
          selectDistinct: ["?t", "?id", "?json"],
          where: [...typed("?m", ["presence"]), candidate("?m"), storedJson("?m")],
          orderBy: "?t",
        })
        .pipe(Effect.flatMap(decodeRows(CandidateRows)));
      const decoded: Array<Message> = [];
      const commits = new Map<string, number>();
      const damaged: Array<number> = [];
      // Grouped by key, so a presence stored with several bus:json values is damaged once.
      const keyed = new Map<string, Group<(typeof rows)[number]>>();
      for (const [index, row] of rows.entries()) {
        const key = JSON.stringify([row[0], row[1]]);
        const group = keyed.get(key);
        if (group === undefined) keyed.set(key, { first: row, copies: 1, last: index });
        else group.copies += 1;
      }
      for (const group of keyed.values()) {
        const [t, id] = group.first;
        const message = decodeGroup(group);
        if (Option.isSome(message)) {
          decoded.push(message.value);
          commits.set(id, t);
        } else damaged.push(t);
      }
      const all = [...latestPresences(decoded).values()]
        .filter((peer) => args.includeLeft === true || peer.presence.status === "joined")
        .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
      const items = all.slice(offset, offset + size).map((peer, index): Item<PeerRow> => {
        const t = commits.get(peer.joinId) ?? 0;
        return {
          kind: "row",
          row: {
            address: peer.address,
            runtime: peer.presence.runtime,
            status: peer.presence.status,
            topics: [...peer.presence.topics],
            ...optionalKey("since", peer.since),
            t,
            ...optionalKey("host", peer.host),
            ...optionalKey("note", peer.presence.note),
          },
          at: { offset: offset + index + 1 },
          label: `${peer.address} (t=${t})`,
        };
      });
      // Every page folds every presence; damage is reported once, on the first page.
      return {
        items,
        more: offset + size < all.length,
        ...(offset === 0 ? { damagedOutside: damaged } : {}),
      };
    }),
});

const DayRows = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
const isAddress = (token: string) => token !== "*" && !token.startsWith("#");
const isTopic = (token: string) => token.startsWith("#") && token.length > 1;

export const directorDmVolume = define({
  name: "director-dm-volume",
  purpose:
    "Per UTC day: the director's direct messages to a cohort, beside whether the day had observed cohort or concern-topic traffic.",
  unit: "UTC day",
  paging: "none",
  narrow: "the window, cohort or topics",
  coverage: "predicates",
  note: "directorToCohort counts distinct messages from the director with at least one cohort address literally among the recipients, mixed topic recipients included. An observed-traffic day is any UTC day with a message from or to a cohort address, or to a concern topic: observed traffic, not evidence of eligible concern work, and unrelated cohort or outsider topic traffic moves it. The predeclared comparable-window, workload and coverage checks still apply; a falling ratio alone never passes adoption. Counted from graph predicates: damage is not checked (missingJson is a lower bound).",
  Args: DirectorArgs,
  Row: DayRow,
  example: {
    director: "<director address>",
    cohort: ["<address>"],
    concernTopics: ["#<topic>"],
    fromDay: "2026-11-01",
    toDay: "2026-11-08",
  },
  normalize: (args) =>
    Effect.gen(function* () {
      yield* unique("cohort", args.cohort);
      yield* unique("concernTopics", args.concernTopics);
      yield* unique("excludeTopics", args.excludeTopics);
      if (!args.cohort.every(isAddress)) {
        return yield* invalid("cohort holds literal addresses only, not #topic or *.");
      }
      if (args.cohort.includes(args.director)) {
        return yield* invalid("The director cannot be in the cohort.");
      }
      if (!isAddress(args.director)) return yield* invalid("director must be an address.");
      if (![...args.concernTopics, ...(args.excludeTopics ?? [])].every(isTopic)) {
        return yield* invalid("concernTopics and excludeTopics are #topic tokens.");
      }
      const from = Date.parse(`${args.fromDay}T00:00:00Z`);
      const to = Date.parse(`${args.toDay}T00:00:00Z`);
      const valid = (day: string, millis: number) =>
        Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === day;
      if (!valid(args.fromDay, from) || !valid(args.toDay, to)) {
        return yield* invalid("fromDay and toDay must be real UTC days.");
      }
      const days = (to - from) / 86_400_000;
      if (days < 1 || days > MAX_WINDOW_DAYS) {
        return yield* invalid(
          `The window must be 1 to ${MAX_WINDOW_DAYS} days, fromDay before toDay.`
        );
      }
      return {
        director: args.director,
        cohort: sorted(args.cohort),
        concernTopics: sorted(args.concernTopics),
        fromDay: args.fromDay,
        toDay: args.toDay,
        ...optionalKey("excludeTopics", args.excludeTopics && sorted(args.excludeTopics)),
      };
    }),
  pageSize: () => MAX_WINDOW_DAYS,
  start: () => ({ offset: 0 }),
  fetch: (args, at) =>
    Effect.gen(function* () {
      const gateway = yield* QueryGateway;
      const window = { fromTs: `${args.fromDay}T00:00:00Z`, toTs: `${args.toDay}T00:00:00Z` };
      const base = [
        ...typed("?m", ["message"]),
        { "@id": "?m", "bus:id": "?id" },
        ...windowPatterns("?m", window),
        ["bind", "?day", "(subStr (str ?ts) 1 10)"],
      ];
      const days = (values: Record<string, unknown>, where: ReadonlyArray<unknown>) =>
        gateway
          .jsonld(at.t, {
            selectDistinct: ["?id", "?day"],
            ...values,
            where: [...base, ...where],
            limit: MAX_DAY_ROWS + 1,
          })
          .pipe(
            Effect.flatMap(decodeRows(DayRows)),
            Effect.flatMap((rows) =>
              rows.length > MAX_DAY_ROWS
                ? Effect.fail(invalid(`More than ${MAX_DAY_ROWS} messages; narrow the window.`))
                : Effect.succeed(rows)
            )
          );
      const audience = [...args.cohort, ...args.concernTopics];
      const numerator = yield* days(
        valuesOf([["?d", [args.director]], ["?c", args.cohort], ...windowValues(window)]),
        [
          { "@id": "?m", "bus:from": "?d" },
          { "@id": "?m", "bus:to": "?c" },
        ]
      );
      const traffic = yield* days(valuesOf([["?p", audience], ...windowValues(window)]), [
        participantMatch("?m"),
      ]);
      const excluded =
        args.excludeTopics === undefined || args.excludeTopics.length === 0
          ? []
          : yield* days(valuesOf([["?x", args.excludeTopics], ...windowValues(window)]), [
              { "@id": "?m", "bus:to": "?x" },
            ]);
      const skip = new Set(excluded.map(([id]) => id));
      const perDay = new Map<string, { messages: Set<string>; traffic: boolean }>();
      const dayOf = (day: string) => {
        let entry = perDay.get(day);
        if (entry === undefined) {
          entry = { messages: new Set(), traffic: false };
          perDay.set(day, entry);
        }
        return entry;
      };
      for (const [id, day] of numerator) if (!skip.has(id)) dayOf(day).messages.add(id);
      for (const [id, day] of traffic) if (!skip.has(id)) dayOf(day).traffic = true;
      const rows = [...perDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
          ([day, entry]): DayRow => ({
            day,
            directorToCohort: entry.messages.size,
            observedTraffic: entry.traffic,
          })
        );
      const numeratorTotal = rows.reduce((sum, row) => sum + row.directorToCohort, 0);
      const trafficDays = rows.filter((row) => row.observedTraffic).length;
      const missing = yield* missingJson(at.t, {
        values: valuesOf([["?p", audience], ...windowValues(window)]),
        where: [
          ...typed("?m", ["message"]),
          ["exists", participantMatch("?m")],
          ...windowPatterns("?m", window),
        ],
      });
      return {
        items: rows.map(
          (row, index): Item<DayRow> => ({
            kind: "row",
            row,
            at: { offset: index + 1 },
            label: row.day,
          })
        ),
        more: false,
        extra: {
          totals: {
            directorToCohort: numeratorTotal,
            observedTrafficDays: trafficDays,
            ratio: trafficDays === 0 ? null : numeratorTotal / trafficDays,
          },
          missingJson: missing,
        },
      };
    }),
});

/** The catalogue, in listing order. */
export const operations: ReadonlyArray<Operation> = [
  history,
  messages,
  thread,
  search,
  counts,
  peers,
  directorDmVolume,
];

export const operationNames = [
  "history",
  "messages",
  "thread",
  "search",
  "counts",
  "peers",
  "director-dm-volume",
] as const;

export const byName = (name: string) => operations.find((operation) => operation.name === name);

const jsonSchema = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

/** The `bus_queries` listing, derived from the operation definitions. */
export const listing = (pin: Pin) => ({
  catalogueVersion: CATALOGUE_VERSION,
  ledger: pin.incarnation,
  headT: pin.head,
  operations: operations.map((operation) => ({
    name: operation.name,
    purpose: operation.purpose,
    unit: operation.unit,
    paging: operation.paging,
    coverage: operation.coverage,
    note: operation.note,
    args: jsonSchema(operation.Args),
    row: jsonSchema(operation.Row),
    example: { name: operation.name, args: operation.example },
  })),
  raw: {
    tool: "bus_query" as const,
    prefixes: PREFIXES,
    maxRows: MAX_SPARQL_ROWS,
    maxQueryLength: MAX_QUERY_LENGTH,
    predicates: READABLE_PREDICATES,
    note: "One SPARQL SELECT over the bus ledger at t: no FROM, GRAPH or SERVICE, and only the listed predicates, each named (no variable predicates or negated property sets). Entries are bus:Message and bus:Presence nodes; bus:json is not readable here, so use bus_run_query for decoded entries and damage counts. A predicate's commit is readable with RDF-star, e.g. << ?m bus:id ?id >> f:t ?t.",
  },
});
