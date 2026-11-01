import { Option, Schema } from "effect";
import { MAX_HISTORY_LIMIT, MAX_PARTICIPANT_LENGTH, MAX_QUERY_LENGTH } from "./limits.ts";

export { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./limits.ts";

// Public projection of the bus's already-decoded history and peers results. Records are
// validated by hand so no input value can reach an error, and every output is rebuilt.

const MAX_PEERS = 1000;
const RUNTIMES = ["claude", "codex", "human", "other"] as const;
const FAILURE = "Public observation rejected";

const OptionalText = Schema.optionalKey(Schema.String);
const Strings = Schema.mutable(Schema.Array(Schema.String));
const Omitted = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
// Exact lengths only: no trimming, normalization or casefolding.
const Query = Schema.String.check(Schema.isMinLength(1)).check(
  Schema.isMaxLength(MAX_QUERY_LENGTH)
);
const Participant = Schema.String.check(Schema.isMinLength(1)).check(
  Schema.isMaxLength(MAX_PARTICIPANT_LENGTH)
);

const OriginSchema = Schema.Struct({
  host: Schema.String,
  cwd: OptionalText,
  repo: OptionalText,
  branch: OptionalText,
});

export const PublicMessageSchema = Schema.Struct({
  id: Schema.String,
  ts: Schema.String,
  from: Schema.String,
  to: Strings,
  kind: Schema.Literal("message"),
  body: Schema.String,
  subject: OptionalText,
  replyTo: OptionalText,
  origin: Schema.optionalKey(OriginSchema),
});
export type PublicMessage = typeof PublicMessageSchema.Type;

export const PublicPeerSchema = Schema.Struct({
  address: Schema.String,
  runtime: Schema.Literals(RUNTIMES),
  topics: Strings,
  host: OptionalText,
  note: OptionalText,
});
export type PublicPeer = typeof PublicPeerSchema.Type;

export const HistoryInputSchema = Schema.Struct({
  query: Schema.optionalKey(Query),
  participant: Schema.optionalKey(Participant),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY_LIMIT })),
});
export type HistoryInput = typeof HistoryInputSchema.Type;

export const HistoryObservationSchema = Schema.Struct({
  messages: Schema.mutable(Schema.Array(PublicMessageSchema)),
  criteria: HistoryInputSchema,
  observedAt: Schema.String,
  omitted: Omitted,
});
export type HistoryObservation = typeof HistoryObservationSchema.Type;

export const PeersObservationSchema = Schema.Struct({
  peers: Schema.mutable(Schema.Array(PublicPeerSchema)),
  observedAt: Schema.String,
  omitted: Omitted,
});
export type PeersObservation = typeof PeersObservationSchema.Type;

type Raw = Readonly<Record<string, unknown>>;
type PublicOrigin = NonNullable<PublicMessage["origin"]>;

const fail = (): never => {
  throw new Error(FAILURE);
};

// Any internal failure, including a throwing getter, becomes one fresh generic Error.
const guarded = <A>(run: () => A): A => {
  try {
    return run();
  } catch {
    return fail();
  }
};

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Raw, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const text = (record: Raw, key: string): string | undefined => {
  const value = own(record, key);
  return typeof value === "string" ? value : undefined;
};

// undefined: key absent; null: key present with a non-string value (invalid record).
const optionalText = (record: Raw, key: string): string | undefined | null => {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === "string" ? value : null;
};

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index];
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
};

const toOrigin = (raw: unknown): PublicOrigin | undefined => {
  if (!isRecord(raw)) return undefined;
  const host = text(raw, "host");
  const cwd = optionalText(raw, "cwd");
  const repo = optionalText(raw, "repo");
  const branch = optionalText(raw, "branch");
  if (host === undefined || cwd === null || repo === null || branch === null) return undefined;
  return {
    host,
    ...(cwd === undefined ? {} : { cwd }),
    ...(repo === undefined ? {} : { repo }),
    ...(branch === undefined ? {} : { branch }),
  };
};

const toMessage = (raw: unknown): PublicMessage | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = text(raw, "id");
  const ts = text(raw, "ts");
  const from = text(raw, "from");
  const body = text(raw, "body");
  const to = stringList(own(raw, "to"));
  const subject = optionalText(raw, "subject");
  const replyTo = optionalText(raw, "replyTo");
  const hasOrigin = Object.hasOwn(raw, "origin");
  const origin = hasOrigin ? toOrigin(raw.origin) : undefined;
  if (
    id === undefined ||
    ts === undefined ||
    from === undefined ||
    body === undefined ||
    to === undefined ||
    own(raw, "kind") !== "message" ||
    subject === null ||
    replyTo === null ||
    (hasOrigin && origin === undefined)
  ) {
    return undefined;
  }
  return {
    id,
    ts,
    from,
    to,
    kind: "message",
    body,
    ...(subject === undefined ? {} : { subject }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(origin === undefined ? {} : { origin }),
  };
};

const toPeer = (raw: unknown): PublicPeer | undefined => {
  if (!isRecord(raw)) return undefined;
  const address = text(raw, "address");
  const rawRuntime = own(raw, "runtime");
  const runtime = RUNTIMES.find((candidate) => candidate === rawRuntime);
  const topics = stringList(own(raw, "topics"));
  const host = optionalText(raw, "host");
  const note = optionalText(raw, "note");
  if (
    address === undefined ||
    runtime === undefined ||
    topics === undefined ||
    host === null ||
    note === null
  ) {
    return undefined;
  }
  return {
    address,
    runtime,
    topics,
    ...(host === undefined ? {} : { host }),
    ...(note === undefined ? {} : { note }),
  };
};

const collection = (value: unknown, key: string): ReadonlyArray<unknown> => {
  if (!isRecord(value)) return fail();
  const items = own(value, key);
  return Array.isArray(items) ? items : fail();
};

const identityOf = (raw: unknown, key: string): string | undefined =>
  isRecord(raw) ? text(raw, key) : undefined;

// A string identity on any raw record counts, even when the rest of it is malformed; every
// record sharing one is withheld, so no arbitrary winner is chosen.
const project = <T>(
  raw: ReadonlyArray<unknown>,
  key: string,
  convert: (record: unknown) => T | undefined
): { readonly items: T[]; readonly omitted: number } => {
  const counts = new Map<string, number>();
  for (let index = 0; index < raw.length; index++) {
    const identity = identityOf(raw[index], key);
    if (identity !== undefined) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  const items: T[] = [];
  for (let index = 0; index < raw.length; index++) {
    const record = raw[index];
    const identity = identityOf(record, key);
    if (identity !== undefined && (counts.get(identity) ?? 0) > 1) continue;
    const item = convert(record);
    if (item !== undefined) items.push(item);
  }
  return { items, omitted: raw.length - items.length };
};

const decodeCriteria = Schema.decodeUnknownOption(HistoryInputSchema);

const validCriteria = (value: unknown): HistoryInput => {
  const decoded = decodeCriteria(value, { onExcessProperty: "error" });
  if (Option.isNone(decoded)) return fail();
  const criteria = decoded.value;
  return {
    ...(criteria.query === undefined ? {} : { query: criteria.query }),
    ...(criteria.participant === undefined ? {} : { participant: criteria.participant }),
    limit: criteria.limit,
  };
};

export const projectHistory = (
  value: unknown,
  criteria: HistoryInput,
  observedAt: string
): HistoryObservation =>
  guarded(() => {
    const copied = validCriteria(criteria);
    if (typeof observedAt !== "string") return fail();
    const raw = collection(value, "messages");
    // Never truncate: more rows than requested means the source broke its bound.
    if (raw.length > copied.limit) return fail();
    const { items, omitted } = project(raw, "id", toMessage);
    return { messages: items, criteria: copied, observedAt, omitted };
  });

export const projectPeers = (value: unknown, observedAt: string): PeersObservation =>
  guarded(() => {
    if (typeof observedAt !== "string") return fail();
    const raw = collection(value, "peers");
    if (raw.length > MAX_PEERS) return fail();
    const { items, omitted } = project(raw, "address", toPeer);
    return { peers: items, observedAt, omitted };
  });
