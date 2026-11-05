import { Option, Schema } from "effect";
import { HistoryArgs, normalizeHistoryArgs } from "../../src/history-args.ts";
import {
  INVESTIGATION_PAGE_SIZE,
  MAX_CONTINUATION_LENGTH,
  MAX_HISTORY_LIMIT,
  MAX_ID_LENGTH,
  MAX_PAGES,
  MAX_PARTICIPANT_LENGTH,
  MAX_PEERS,
  MAX_PEERS_PAGE,
  MAX_QUERY_LENGTH,
  MAX_THREAD_MESSAGES,
} from "./limits.ts";

export {
  DEFAULT_HISTORY_LIMIT,
  INVESTIGATION_PAGE_SIZE,
  MAX_CONTINUATION_LENGTH,
  MAX_HISTORY_LIMIT,
  MAX_INVESTIGATION_ENTRIES,
  MAX_PAGES,
  MAX_PEERS,
  MAX_PEERS_PAGE,
  MAX_THREAD_MESSAGES,
} from "./limits.ts";

// Public projection of the bus's saved-query pages (bus_run_query envelopes). Envelopes and
// records are validated by hand so no input value can reach an error, and every output is
// rebuilt.

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

const ACTIVITIES = ["active", "inactive", "unknown"] as const;
const ACTIVITY_REASONS = ["damaged-log", "damaged-mail", "incomplete-scan"] as const;

// The serve's mute scopes (src/domain.ts MuteScope); ids are checked for shape only, since the
// serve already checked them.
export const PublicMuteSchema = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("programme") }),
  Schema.Struct({ scope: Schema.Literal("topic"), topic: Schema.String }),
  Schema.Struct({ scope: Schema.Literal("directory"), directory: Schema.String }),
  Schema.Struct({
    scope: Schema.Literal("concern"),
    directory: Schema.String,
    concern: Schema.String,
  }),
]);
export type PublicMute = typeof PublicMuteSchema.Type;

// activity, activeSince, activityReason and mutes are absent from an older serve's rows, and stay
// absent here. A reason accompanies unknown activity only.
export const PublicPeerSchema = Schema.Struct({
  address: Schema.String,
  runtime: Schema.Literals(RUNTIMES),
  topics: Strings,
  host: OptionalText,
  note: OptionalText,
  activity: Schema.optionalKey(Schema.Literals(ACTIVITIES)),
  activeSince: OptionalText,
  activityReason: Schema.optionalKey(Schema.Literals(ACTIVITY_REASONS)),
  mutes: Schema.optionalKey(Schema.mutable(Schema.Array(PublicMuteSchema))),
});
export type PublicPeer = typeof PublicPeerSchema.Type;

export const HistoryInputSchema = Schema.Struct({
  query: Schema.optionalKey(Query),
  participant: Schema.optionalKey(Participant),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY_LIMIT })),
});
export type HistoryInput = typeof HistoryInputSchema.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Commit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * The ledger commit an observation was read at. `ledger` is the incarnation (a ledger
 * replaced under the same name has another); `currentHeadT` is the head when the read
 * finished, present only when it had moved past `t`.
 */
export const SnapshotSchema = Schema.Struct({
  ledger: Schema.String,
  t: Commit,
  currentHeadT: Schema.optionalKey(Commit),
});
export type Snapshot = typeof SnapshotSchema.Type;

/**
 * all: every entry matching the criteria at t, all readable; readable: every matching entry
 * at t was reached, but `damaged` of them could not be read; latest: the newest entries at t,
 * with older ones left out; ranked: best text matches at t, never a complete answer.
 */
export const HISTORY_WINDOWS = ["all", "readable", "latest", "ranked"] as const;
export type HistoryWindow = (typeof HISTORY_WINDOWS)[number];

// Upstream incompleteness (window, damaged, complete) is reported apart from the viewer's own
// projection omissions (omitted): records its public projection rejected.
export const HistoryObservationSchema = Schema.Struct({
  messages: Schema.mutable(Schema.Array(PublicMessageSchema)),
  criteria: HistoryInputSchema,
  observedAt: Schema.String,
  omitted: Omitted,
  snapshot: SnapshotSchema,
  window: Schema.Literals(HISTORY_WINDOWS),
  /** Unreadable entries the bus met while reading this window. */
  damaged: Count,
  /** The bus's own claim: every matching entry at t, all decoded. */
  complete: Schema.Boolean,
});
export type HistoryObservation = typeof HistoryObservationSchema.Type;

export const PeersObservationSchema = Schema.Struct({
  peers: Schema.mutable(Schema.Array(PublicPeerSchema)),
  observedAt: Schema.String,
  omitted: Omitted,
  snapshot: SnapshotSchema,
  damaged: Count,
  complete: Schema.Boolean,
});
export type PeersObservation = typeof PeersObservationSchema.Type;

/** A reply tree read at an explicit commit of one ledger incarnation. */
export const ThreadInputSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(MAX_ID_LENGTH)),
  ledger: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(MAX_ID_LENGTH)),
  t: Commit,
});
export type ThreadInput = typeof ThreadInputSchema.Type;

export const ThreadObservationSchema = Schema.Struct({
  messages: Schema.mutable(Schema.Array(PublicMessageSchema)),
  request: ThreadInputSchema,
  observedAt: Schema.String,
  omitted: Omitted,
  snapshot: SnapshotSchema,
  /** Replied-to ids that are not entries at t: the bus's answer, not an inference. */
  missingReplyTargets: Strings,
  damaged: Count,
  /** False when the tree has more entries than the viewer read; only the first are here. */
  exhausted: Schema.Boolean,
  complete: Schema.Boolean,
});
export type ThreadObservation = typeof ThreadObservationSchema.Type;

/**
 * A pinned investigation's history criteria: the bus's own echo of `history` arguments
 * without `limit`, for forward message history only. Defaults are present and participants
 * sorted, as the bus echoes them, so the criteria are compared with each page's echo as given.
 */
const InvestigationCriteriaSchema = Schema.Struct({
  participants: HistoryArgs.fields.participants,
  fromTs: HistoryArgs.fields.fromTs,
  toTs: HistoryArgs.fields.toTs,
  kinds: Schema.Tuple([Schema.Literal("message")]),
  direction: Schema.Literal("forward"),
});
export type InvestigationCriteria = typeof InvestigationCriteriaSchema.Type;

/** One closed reference, taken from an agent's own `bus_run_query` result. */
export const InvestigationReferenceSchema = Schema.Struct({
  name: Schema.Literal("history"),
  catalogueVersion: Commit,
  ledger: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(MAX_ID_LENGTH)),
  t: Commit,
  criteria: InvestigationCriteriaSchema,
});
export type InvestigationReference = typeof InvestigationReferenceSchema.Type;

/**
 * The bus decodes continuations of at most MAX_CONTINUATION_LENGTH characters and issues them
 * as `bq1.` and base64url. Only that alphabet is sent, so each character is one serialized
 * byte and the reserved length is the reserved size.
 */
const CONTINUATION = /^[A-Za-z0-9._-]+$/;
export const isSupportedContinuation = (value: string) =>
  value.length <= MAX_CONTINUATION_LENGTH && CONTINUATION.test(value);

export const InvestigationPageInputSchema = Schema.Struct({
  reference: InvestigationReferenceSchema,
  cursor: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(MAX_CONTINUATION_LENGTH)).check(
      Schema.isPattern(CONTINUATION)
    )
  ),
});
export type InvestigationPageInput = typeof InvestigationPageInputSchema.Type;

/** An entry as the investigation keeps it: its commit, then the public message. */
export const InvestigationEntrySchema = Schema.Struct({
  t: Commit,
  message: PublicMessageSchema,
});
export type InvestigationEntry = typeof InvestigationEntrySchema.Type;

/**
 * One validated investigation page. Entries keep the bus's source order. The page's own
 * claims are passed on unjudged; the browser's traversal decides what they mean together.
 */
export const InvestigationPageSchema = Schema.Struct({
  entries: Schema.mutable(Schema.Array(InvestigationEntrySchema)),
  omitted: Omitted,
  damaged: Count,
  damagedTotal: Count,
  exhausted: Schema.Boolean,
  complete: Schema.Boolean,
  next: Schema.optionalKey(Schema.String),
  currentHeadT: Schema.optionalKey(Commit),
});
export type InvestigationPage = typeof InvestigationPageSchema.Type;

/** The identity fields a page is checked on, in the order they are checked. */
export const IDENTITY_FIELDS = [
  "name",
  "catalogueVersion",
  "ledger",
  "t",
  "criteria",
  "limit",
] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

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

// One of the four scopes with exactly its own keys, each text; rebuilt, never passed on.
const toMute = (raw: unknown): PublicMute | undefined => {
  if (!isRecord(raw)) return undefined;
  const scope = own(raw, "scope");
  const size = Object.keys(raw).length;
  const topic = text(raw, "topic");
  const directory = text(raw, "directory");
  const concern = text(raw, "concern");
  switch (scope) {
    case "programme":
      return size === 1 ? { scope } : undefined;
    case "topic":
      return size === 2 && topic !== undefined ? { scope, topic } : undefined;
    case "directory":
      return size === 2 && directory !== undefined ? { scope, directory } : undefined;
    case "concern":
      return size === 3 && directory !== undefined && concern !== undefined
        ? { scope, directory, concern }
        : undefined;
    default:
      return undefined;
  }
};

// undefined: key absent; null: key present with anything but a list of valid mutes.
const optionalMutes = (record: Raw): PublicMute[] | undefined | null => {
  if (!Object.hasOwn(record, "mutes")) return undefined;
  const value = record.mutes;
  if (!Array.isArray(value)) return null;
  const out: PublicMute[] = [];
  for (let index = 0; index < value.length; index++) {
    const mute = toMute(value[index]);
    if (mute === undefined) return null;
    out.push(mute);
  }
  return out;
};

// undefined: key absent; null: key present with anything but one of the three activities.
const optionalActivity = (record: Raw): (typeof ACTIVITIES)[number] | undefined | null => {
  if (!Object.hasOwn(record, "activity")) return undefined;
  const value = record.activity;
  return ACTIVITIES.find((candidate) => candidate === value) ?? null;
};

// undefined: key absent; null: key present with anything but one of the three reasons.
const optionalReason = (record: Raw): (typeof ACTIVITY_REASONS)[number] | undefined | null => {
  if (!Object.hasOwn(record, "activityReason")) return undefined;
  const value = record.activityReason;
  return ACTIVITY_REASONS.find((candidate) => candidate === value) ?? null;
};

const toPeer = (raw: unknown): PublicPeer | undefined => {
  if (!isRecord(raw)) return undefined;
  const address = text(raw, "address");
  const rawRuntime = own(raw, "runtime");
  const runtime = RUNTIMES.find((candidate) => candidate === rawRuntime);
  const topics = stringList(own(raw, "topics"));
  const host = optionalText(raw, "host");
  const note = optionalText(raw, "note");
  const activity = optionalActivity(raw);
  const activeSince = optionalText(raw, "activeSince");
  const activityReason = optionalReason(raw);
  const mutes = optionalMutes(raw);
  if (
    address === undefined ||
    runtime === undefined ||
    topics === undefined ||
    own(raw, "status") !== "joined" ||
    host === null ||
    note === null ||
    activity === null ||
    activeSince === null ||
    activityReason === null ||
    (activityReason !== undefined && activity !== "unknown") ||
    mutes === null
  ) {
    return undefined;
  }
  return {
    address,
    runtime,
    topics,
    ...(host === undefined ? {} : { host }),
    ...(note === undefined ? {} : { note }),
    ...(activity === undefined ? {} : { activity }),
    ...(activeSince === undefined ? {} : { activeSince }),
    ...(activityReason === undefined ? {} : { activityReason }),
    ...(mutes === undefined ? {} : { mutes }),
  };
};

const isCommit = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** One bus_run_query result page, as far as the viewer relies on it. */
interface Page {
  readonly record: Raw;
  readonly ledger: string;
  readonly t: number;
  readonly currentHeadT: number | undefined;
  readonly rows: ReadonlyArray<unknown>;
  readonly damagedTotal: number;
  readonly exhausted: boolean;
  readonly complete: boolean;
}

const pageOf = (value: unknown, maxRows: number): Page => {
  if (!isRecord(value)) return fail();
  const ledger = text(value, "ledger");
  const t = own(value, "t");
  const currentHeadT = own(value, "currentHeadT");
  const rows = own(value, "rows");
  const damagedTotal = own(value, "damagedTotal");
  const exhausted = own(value, "exhausted");
  const complete = own(value, "complete");
  const next = optionalText(value, "next");
  if (
    ledger === undefined ||
    !isCommit(t) ||
    (currentHeadT !== undefined && (!isCommit(currentHeadT) || currentHeadT <= t)) ||
    !Array.isArray(rows) ||
    // Never truncate a page: more rows than asked for means the source broke its bound.
    rows.length > maxRows ||
    !isCount(damagedTotal) ||
    typeof exhausted !== "boolean" ||
    typeof complete !== "boolean" ||
    next === null ||
    exhausted !== (next === undefined) ||
    (complete && (!exhausted || damagedTotal > 0))
  ) {
    return fail();
  }
  return { record: value, ledger, t, currentHeadT, rows, damagedTotal, exhausted, complete };
};

/**
 * A traversal: pages read in order at one commit of one ledger, each but the last pointing
 * at the next. Its snapshot is that commit, with the furthest head reported while reading.
 */
const traversal = (value: unknown, maxRows: number) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PAGES) return fail();
  const pages: Page[] = [];
  for (let index = 0; index < value.length; index++) {
    const page = pageOf(value[index], maxRows);
    const previous = pages[index - 1];
    if (
      previous !== undefined &&
      (page.ledger !== previous.ledger ||
        page.t !== previous.t ||
        previous.exhausted ||
        page.damagedTotal < previous.damagedTotal)
    ) {
      return fail();
    }
    pages.push(page);
  }
  const last = pages[pages.length - 1] ?? fail();
  let head: number | undefined;
  for (const page of pages) {
    if (page.currentHeadT !== undefined && (head === undefined || page.currentHeadT > head))
      head = page.currentHeadT;
  }
  const snapshot: Snapshot = {
    ledger: last.ledger,
    t: last.t,
    ...(head === undefined ? {} : { currentHeadT: head }),
  };
  // Index by index, so a hole is a row (and is counted as omitted), never skipped.
  const rows: unknown[] = [];
  for (const page of pages)
    for (let index = 0; index < page.rows.length; index++) rows.push(page.rows[index]);
  return { snapshot, rows, last };
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

/**
 * Messages in the bus's own order: commit t, then id (several entries can share a commit).
 * A row without a commit at or before the snapshot is invalid. Timestamps are never parsed.
 */
const entriesInCommitOrder = (raw: ReadonlyArray<unknown>, snapshotT: number) => {
  const { items, omitted } = project(raw, "id", (record) => {
    const message = toMessage(record);
    const t = isRecord(record) ? own(record, "t") : undefined;
    return message === undefined || !isCommit(t) || t > snapshotT ? undefined : { message, t };
  });
  items.sort((a, b) =>
    a.t !== b.t ? a.t - b.t : a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0
  );
  return { messages: items.map((item) => item.message), omitted };
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

/**
 * `pages` are the history (newest first) or search (best first) pages the reader followed
 * at one commit. The window keeps the first `limit` rows, so a last page that overshoots is
 * cut here and the window is then the latest, not all. Messages are shown in commit order.
 */
export const projectHistory = (
  pages: unknown,
  criteria: HistoryInput,
  observedAt: string
): HistoryObservation =>
  guarded(() => {
    const copied = validCriteria(criteria);
    if (typeof observedAt !== "string") return fail();
    const { snapshot, rows, last } = traversal(pages, copied.limit);
    const ranked = copied.query !== undefined;
    if (ranked && last.complete) return fail();
    const cut = rows.length > copied.limit;
    const { messages, omitted } = entriesInCommitOrder(rows.slice(0, copied.limit), snapshot.t);
    const whole = last.exhausted && !cut;
    return {
      messages,
      criteria: copied,
      observedAt,
      omitted,
      snapshot,
      window: ranked ? "ranked" : !whole ? "latest" : last.damagedTotal === 0 ? "all" : "readable",
      damaged: last.damagedTotal,
      complete: last.complete && !cut,
    };
  });

/** `pages` are every page of current (joined) peers at one commit. */
export const projectPeers = (pages: unknown, observedAt: string): PeersObservation =>
  guarded(() => {
    if (typeof observedAt !== "string") return fail();
    const { snapshot, rows, last } = traversal(pages, MAX_PEERS_PAGE);
    if (rows.length > MAX_PEERS || !last.exhausted) return fail();
    const { items, omitted } = project(rows, "address", toPeer);
    return {
      peers: items,
      observedAt,
      omitted,
      snapshot,
      damaged: last.damagedTotal,
      complete: last.complete,
    };
  });

const decodeThreadInput = Schema.decodeUnknownOption(ThreadInputSchema);

/**
 * `pages` are the pages of a reply tree the reader followed, at the request's own commit and
 * ledger, in commit order. The reading keeps the first MAX_THREAD_MESSAGES entries, so a last
 * page that overshoots is cut here and the tree is then not exhausted.
 */
export const projectThread = (
  pages: unknown,
  request: ThreadInput,
  observedAt: string
): ThreadObservation =>
  guarded(() => {
    const decoded = decodeThreadInput(request, { onExcessProperty: "error" });
    if (Option.isNone(decoded) || typeof observedAt !== "string") return fail();
    const copied = { id: decoded.value.id, ledger: decoded.value.ledger, t: decoded.value.t };
    const { snapshot, rows, last } = traversal(pages, MAX_THREAD_MESSAGES);
    if (snapshot.ledger !== copied.ledger || snapshot.t !== copied.t) return fail();
    const missingReplyTargets = stringList(own(last.record, "missingReplyTargets"));
    if (missingReplyTargets === undefined) return fail();
    const cut = rows.length > MAX_THREAD_MESSAGES;
    const { messages, omitted } = entriesInCommitOrder(
      rows.slice(0, MAX_THREAD_MESSAGES),
      snapshot.t
    );
    return {
      messages,
      request: copied,
      observedAt,
      omitted,
      snapshot,
      missingReplyTargets,
      damaged: last.damagedTotal,
      exhausted: last.exhausted && !cut,
      complete: last.complete && !cut,
    };
  });

// ---- Pinned investigation ----------------------------------------------------------------------

const decodeReference = Schema.decodeUnknownOption(InvestigationReferenceSchema);
const decodeHistoryArgs = Schema.decodeUnknownOption(HistoryArgs);

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export type ReferenceCheck =
  | { readonly reference: InvestigationReference }
  | { readonly refused: "unsupported" | "invalid" };

/**
 * A pinned reference, accepted only in the bus's own echoed form: criteria the shared
 * definition accepts and leaves unchanged when it normalises them. A reference that is valid
 * except for its kinds or direction is unsupported; anything else is invalid.
 */
export const checkReference = (value: unknown): ReferenceCheck =>
  guarded((): ReferenceCheck => {
    if (!isRecord(value)) return { refused: "invalid" };
    const criteria = own(value, "criteria");
    const decoded = decodeHistoryArgs(criteria, { onExcessProperty: "error" });
    if (Option.isNone(decoded) || Object.hasOwn(decoded.value, "limit")) {
      return { refused: "invalid" };
    }
    const normalized = normalizeHistoryArgs({ ...decoded.value, limit: 1 });
    if ("problem" in normalized) return { refused: "invalid" };
    const { limit: _, ...echoed } = normalized.args;
    if (canonical(echoed) !== canonical(decoded.value)) return { refused: "invalid" };
    const reference = decodeReference(value, { onExcessProperty: "error" });
    if (Option.isSome(reference)) return { reference: reference.value };
    const forward = { ...echoed, kinds: ["message"], direction: "forward" };
    return Option.isSome(
      decodeReference({ ...value, criteria: forward }, { onExcessProperty: "error" })
    )
      ? { refused: "unsupported" }
      : { refused: "invalid" };
  });

export type InvestigationPageCheck =
  | { readonly page: InvestigationPage }
  | { readonly mismatch: IdentityField };

/**
 * One raw `history` page read for `reference`, checked against it field by field. A field
 * that differs is reported as a mismatch; a page that is not a valid result is rejected.
 * Rows that fail projection, or share an id within the page, are counted as omitted.
 */
export const projectInvestigationPage = (
  raw: unknown,
  reference: InvestigationReference
): InvestigationPageCheck =>
  guarded((): InvestigationPageCheck => {
    if (!isRecord(raw)) return fail();
    const args = own(raw, "args");
    if (!isRecord(args)) return fail();
    const { limit, ...echoed } = args;
    const fields: Record<IdentityField, boolean> = {
      name: own(raw, "name") === reference.name,
      catalogueVersion: own(raw, "catalogueVersion") === reference.catalogueVersion,
      ledger: own(raw, "ledger") === reference.ledger,
      t: own(raw, "t") === reference.t,
      criteria: canonical(echoed) === canonical(reference.criteria),
      limit: limit === INVESTIGATION_PAGE_SIZE,
    };
    const mismatch = IDENTITY_FIELDS.find((field) => !fields[field]);
    if (mismatch !== undefined) return { mismatch };

    const rows = own(raw, "rows");
    const damaged = own(raw, "damaged");
    const damagedTotal = own(raw, "damagedTotal");
    const exhausted = own(raw, "exhausted");
    const complete = own(raw, "complete");
    const currentHeadT = own(raw, "currentHeadT");
    const next = optionalText(raw, "next");
    if (
      own(raw, "damage") !== "checked" ||
      !Array.isArray(rows) ||
      rows.length > INVESTIGATION_PAGE_SIZE ||
      !isCount(damaged) ||
      !isCount(damagedTotal) ||
      damaged > damagedTotal ||
      typeof exhausted !== "boolean" ||
      typeof complete !== "boolean" ||
      (complete && (!exhausted || damagedTotal > 0)) ||
      next === null ||
      (currentHeadT !== undefined && (!isCommit(currentHeadT) || currentHeadT <= reference.t))
    ) {
      return fail();
    }
    const { items, omitted } = project(rows, "id", (record) => {
      const message = toMessage(record);
      const t = isRecord(record) ? own(record, "t") : undefined;
      return message === undefined || !isCommit(t) || t > reference.t ? undefined : { t, message };
    });
    return {
      page: {
        entries: items,
        omitted,
        damaged,
        damagedTotal,
        exhausted,
        complete,
        ...(next === undefined ? {} : { next }),
        ...(currentHeadT === undefined ? {} : { currentHeadT }),
      },
    };
  });
