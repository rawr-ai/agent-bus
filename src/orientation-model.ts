import { isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import { InvalidQuery, OrientationId, topicName } from "./domain.ts";

export const DIRECTORY_BYTES = 16_384;
export const DIRECTORY_METADATA_BYTES = 4_096;
export const BULLETIN_BODY_BYTES = 4_096;
export const BULLETIN_UNIT_BYTES = 16_384;

const Nonempty = Schema.String.check(Schema.isMinLength(1));
const UuidV7 = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
);
export const OperationId = UuidV7.annotate({
  description: "A globally unique UUIDv7 for this operation and all its retries.",
});
const RevisionId = UuidV7.annotate({ description: "The UUIDv7 of an immutable revision." });
const NotificationId = UuidV7.annotate({
  description: "The UUIDv7 of the original ordinary notification.",
});

export const Reference = Schema.Struct({
  label: Nonempty.annotate({ description: "What this authoritative reference identifies." }),
  target: Nonempty.annotate({ description: "Its URL or repository-relative path." }),
});

export const Concern = Schema.Struct({
  id: OrientationId.annotate({ description: "The concern's stable id within this directory." }),
  name: Nonempty.annotate({ description: "The concern's name." }),
  topic: Nonempty.annotate({ description: "The topic used to notify this concern's subscribers." }),
  description: Schema.optionalKey(
    Schema.String.annotate({ description: "What the concern covers." })
  ),
  references: Schema.optionalKey(
    Schema.Array(Reference).annotate({ description: "Authoritative references in reading order." })
  ),
});

export const Directory = Schema.Struct({
  id: OrientationId.annotate({ description: "The directory's stable id." }),
  name: Nonempty.annotate({ description: "The repository or programme's name." }),
  aliases: Schema.Array(Nonempty)
    .check(Schema.isMaxLength(8))
    .annotate({ description: "Up to eight explicit absolute checkout paths." }),
  concerns: Schema.Array(Concern)
    .check(Schema.isMaxLength(20))
    .annotate({ description: "Up to twenty explicitly defined concerns." }),
  description: Schema.optionalKey(
    Schema.String.annotate({ description: "What this directory covers." })
  ),
  references: Schema.optionalKey(
    Schema.Array(Reference).annotate({ description: "Authoritative references in reading order." })
  ),
});
export type Directory = typeof Directory.Type;

export const BulletinScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("programme").annotate({ description: "Bus-wide programme guidance." }),
  }),
  Schema.Struct({
    kind: Schema.Literal("concern").annotate({ description: "One registered concern." }),
    directory: OrientationId.annotate({ description: "The containing directory's id." }),
    concern: OrientationId.annotate({ description: "The registered concern's id." }),
  }),
]);
export type BulletinScope = typeof BulletinScope.Type;

export const DirectoryUpdate = Schema.Struct({
  from: Nonempty.annotate({ description: "Your joined publisher address." }),
  session: Schema.optionalKey(
    Schema.String.annotate({ description: "The publisher address's session id." })
  ),
  operation: OperationId,
  expected: Schema.NullOr(RevisionId).annotate({
    description:
      "The exact current revision, or null only when this directory has never been registered.",
  }),
  directory: Directory.annotate({ description: "The complete replacement directory definition." }),
  audience: Schema.Array(Nonempty)
    .check(Schema.isMinLength(1))
    .annotate({ description: "Nonempty explicit addresses, #topics or * to notify once." }),
});
export type DirectoryUpdate = typeof DirectoryUpdate.Type;

export const BulletinUpdate = Schema.Struct({
  from: Nonempty.annotate({ description: "Your joined publisher address." }),
  session: Schema.optionalKey(
    Schema.String.annotate({ description: "The publisher address's session id." })
  ),
  operation: OperationId,
  expected: Schema.NullOr(RevisionId).annotate({
    description: "The exact current revision, or null only for a first publication.",
  }),
  scope: BulletinScope.annotate({
    description: "The programme or an explicitly registered concern.",
  }),
  action: Schema.Literals(["publish", "withdraw"]).annotate({
    description: "Publish a replacement or retain a withdrawal tombstone.",
  }),
  body: Schema.optionalKey(
    Schema.String.annotate({ description: "Required on publication; at most 4,096 UTF-8 bytes." })
  ),
  expiresAt: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Optional UTC expiry, with at most millisecond precision, normalized to an instant.",
    })
  ),
  recipients: Schema.optionalKey(
    Schema.Array(Nonempty).annotate({
      description:
        "Concern publication only: deliberately named direct recipients in addition to its registered topic.",
    })
  ),
});
export type BulletinUpdate = typeof BulletinUpdate.Type;

const Provenance = {
  publisher: Nonempty.annotate({ description: "The address that wrote this revision." }),
  publishedAt: Nonempty.annotate({ description: "The time the original revision was written." }),
  notification: NotificationId,
  audience: Schema.Array(Nonempty).annotate({ description: "The original notification audience." }),
};

/** Immutable domain payload, kept separate from an ordinary notification message. */
export const DirectoryRecord = Schema.Struct({
  kind: Schema.Literal("directory").annotate({
    description: "This record is a directory revision.",
  }),
  directory: Directory.annotate({ description: "The complete designated directory." }),
  ...Provenance,
});
export type DirectoryRecord = typeof DirectoryRecord.Type;

/** Withdrawals keep their prior audience as a designated tombstone. */
export const BulletinRecord = Schema.Struct({
  kind: Schema.Literal("bulletin"),
  scope: BulletinScope,
  action: Schema.Literals(["publish", "withdraw"]),
  body: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
  ...Provenance,
});
export type BulletinRecord = typeof BulletinRecord.Type;

export const OrientRequest = Schema.Struct({
  directory: Schema.optionalKey(
    OrientationId.annotate({ description: "Select this directory by its stable id." })
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: "Discover directory candidates containing this absolute checkout path.",
    })
  ),
  concern: Schema.optionalKey(
    OrientationId.annotate({ description: "Include this registered concern's full bulletin." })
  ),
  t: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Read this historical ledger commit; defaults to the current head.",
    })
  ),
  candidateCursor: Schema.optionalKey(
    Schema.String.annotate({
      description: "Continue directory candidate discovery at its original cut.",
    })
  ),
});
export type OrientRequest = typeof OrientRequest.Type;

export const OrientationRecovery = Schema.Union([
  Schema.Struct({
    tool: Schema.Literal("bus_orient").annotate({
      description: "Repeat the read-only orientation call.",
    }),
    input: OrientRequest.annotate({ description: "The read-only request to retry." }),
  }),
  Schema.Struct({
    tool: Schema.Literal("bus_run_query").annotate({
      description: "Read the specified saved-query page.",
    }),
    input: Schema.Struct({
      name: Schema.Literals(["orientation_directories", "orientation_associations"]).annotate({
        description: "The query that owns this continuation or recovery traversal.",
      }),
      args: Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "The query arguments.",
      }),
      t: Schema.Int.annotate({ description: "The original ledger cut." }),
      cursor: Schema.optionalKey(
        Schema.String.annotate({ description: "The unconsumed query cursor, when continuing." })
      ),
    }).annotate({ description: "The saved-query request at the same cut." }),
  }),
]);
export type OrientationRecovery = typeof OrientationRecovery.Type;

export const BulletinView = Schema.Struct({
  state: Schema.Literals(["CURRENT", "EXPIRED", "WITHDRAWN", "MISSING"]).annotate({
    description:
      "Designation and freshness at the evaluation time; expiry does not replace a revision.",
  }),
  revision: Schema.optionalKey(RevisionId),
  publisher: Schema.optionalKey(
    Nonempty.annotate({ description: "The original publisher address." })
  ),
  publishedAt: Schema.optionalKey(
    Nonempty.annotate({ description: "When the revision was written." })
  ),
  notification: Schema.optionalKey(NotificationId),
  audience: Schema.optionalKey(
    Schema.Array(Nonempty).annotate({ description: "The original notification audience." })
  ),
  body: Schema.optionalKey(
    Schema.String.annotate({ description: "The full bulletin body when selected." })
  ),
  expiresAt: Schema.optionalKey(
    Schema.String.annotate({ description: "The optional UTC expiry." })
  ),
});

export const Cut = Schema.Struct({
  head: Schema.Int.annotate({ description: "The ledger commit at this observation." }),
  incarnation: Nonempty.annotate({ description: "The ledger incarnation at this observation." }),
});
export const NotificationReceipt = Schema.Struct({
  id: NotificationId,
  ts: Nonempty.annotate({ description: "When the original notification was written." }),
  from: Nonempty.annotate({ description: "Its original sender address." }),
  to: Schema.Array(Nonempty).annotate({ description: "Its original audience." }),
  kind: Schema.Literal("message").annotate({ description: "An ordinary notification message." }),
  body: Schema.String.annotate({ description: "The original notification text." }),
  subject: Schema.optionalKey(
    Schema.String.annotate({ description: "The original subject line." })
  ),
  origin: Schema.optionalKey(
    Schema.Struct({
      host: Schema.String.annotate({ description: "The original publisher's machine." }),
      cwd: Schema.optionalKey(
        Schema.String.annotate({ description: "The original working directory, when known." })
      ),
      repo: Schema.optionalKey(
        Schema.String.annotate({ description: "The original repository, when known." })
      ),
      branch: Schema.optionalKey(
        Schema.String.annotate({ description: "The original branch, when known." })
      ),
    }).annotate({ description: "Original descriptive provenance, not retry identity." })
  ),
});
export const WriteResult = Schema.Struct({
  status: Schema.Literals(["APPLIED", "IDENTITY_MISMATCH", "CONFLICT", "UNKNOWN"]).annotate({
    description:
      "APPLIED means the witness matches this intent; UNKNOWN may still have committed and must retain the same operation id for retry.",
  }),
  operation: OperationId,
  expected: Schema.NullOr(RevisionId).annotate({
    description: "The expectation supplied for this operation.",
  }),
  revision: Schema.optionalKey(RevisionId),
  notification: Schema.optionalKey(
    NotificationReceipt.annotate({ description: "The immutable original notification receipt." })
  ),
  current: Schema.optionalKey(
    Schema.NullOr(RevisionId).annotate({
      description: "The different designation observed for a conflict.",
    })
  ),
  cut: Schema.optionalKey(
    Cut.annotate({ description: "The observation cut for the outcome, when established." })
  ),
});

const invalid = (message: string) => new InvalidQuery({ message });
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const uniqueSorted = (values: ReadonlyArray<string>) => [...new Set(values)].sort(compare);
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
export const textBytes = (value: string) => Buffer.byteLength(value, "utf8");

/** Project one designated bulletin at an evaluation time, with full content only when selected. */
export const bulletinView = (
  revision: { readonly revision: string; readonly value: BulletinRecord } | undefined,
  time: number,
  full: boolean
) => {
  if (revision === undefined) return { state: "MISSING" as const };
  const { value } = revision;
  const state =
    value.action === "withdraw"
      ? ("WITHDRAWN" as const)
      : value.expiresAt !== undefined && time >= Date.parse(value.expiresAt)
        ? ("EXPIRED" as const)
        : ("CURRENT" as const);
  if (!full) {
    return {
      state,
      revision: revision.revision,
      ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    };
  }
  return {
    state,
    revision: revision.revision,
    publisher: value.publisher,
    publishedAt: value.publishedAt,
    notification: value.notification,
    audience: value.audience,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    ...(value.body === undefined ? {} : { body: value.body }),
  };
};

/** Both the immutable record and its complete public projection must fit as whole units. */
export const bulletinFits = (record: BulletinRecord, revision: string, time: number) => {
  const expiry = record.expiresAt === undefined ? undefined : Date.parse(record.expiresAt);
  const times = expiry === undefined ? [time] : [time, expiry - 1, expiry];
  return (
    jsonBytes(record) <= BULLETIN_UNIT_BYTES &&
    times.every(
      (at) => jsonBytes(bulletinView({ revision, value: record }, at, true)) <= BULLETIN_UNIT_BYTES
    )
  );
};

/** Lexical checkout matching: never resolve symlinks or inspect a foreign path. */
export const checkoutMatches = (alias: string, cwd: string) => {
  if (!isAbsolute(alias) || !isAbsolute(cwd)) return false;
  const suffix = relative(resolve(alias), resolve(cwd));
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
};

/** Stable JSON for validated intent; only arrays explicitly normalized as sets are reordered. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** Directory definitions and aliases are sets; reference order remains meaningful. */
export const normalizeDirectory = (directory: Directory) =>
  Effect.gen(function* () {
    if (directory.aliases.some((alias) => !alias.startsWith("/") || alias.trim() !== alias)) {
      return yield* invalid("Directory aliases must be absolute paths without outer whitespace.");
    }
    const concerns = [...directory.concerns];
    if (new Set(concerns.map(({ id }) => id)).size !== concerns.length) {
      return yield* invalid("Concern ids must be unique within a directory.");
    }
    const normalized = [];
    for (const concern of concerns) {
      const topic = topicName(concern.topic);
      if (topic === undefined) return yield* invalid(`Concern ${concern.id} has an invalid topic.`);
      const { references, ...rest } = concern;
      normalized.push({
        ...rest,
        topic,
        ...(references === undefined || references.length === 0 ? {} : { references }),
      });
    }
    const { references, ...rest } = directory;
    const result = {
      ...rest,
      ...(references === undefined || references.length === 0 ? {} : { references }),
      aliases: uniqueSorted(directory.aliases.map((alias) => resolve(alias))),
      concerns: normalized.sort((a, b) => compare(a.id, b.id)),
    };
    if (jsonBytes(result) > DIRECTORY_BYTES) {
      return yield* invalid(`The directory exceeds ${DIRECTORY_BYTES} UTF-8 bytes.`);
    }
    return result;
  });

/** Publish recipients are literal; rejecting malformed tokens never silently changes delivery. */
export const normalizeAudience = (
  values: ReadonlyArray<string>,
  directOnly = false
): Effect.Effect<Array<string>, InvalidQuery> => {
  if (
    values.some(
      (value) =>
        value === "" ||
        value.trim() !== value ||
        (value.startsWith("#") && topicName(value) !== value.slice(1)) ||
        (directOnly && (value === "*" || value.startsWith("#")))
    )
  ) {
    return Effect.fail(invalid("The audience contains a malformed or disallowed recipient."));
  }
  return Effect.succeed(uniqueSorted(values));
};

/** Reject normalized invalid calendar dates, not only strings Date.parse accepts. */
export const utcInstant = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const instant = Date.parse(value);
  return (
    Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 19) === value.slice(0, 19)
  );
};
