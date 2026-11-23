import { createHash } from "node:crypto";
import { Option, Schema } from "effect";

/** The address itself, rather than a projected property, identifies its mailbox. */
export const mailboxIri = (address: string): string =>
  `urn:agent-bus:mailbox:${createHash("sha256").update(Buffer.from(address, "utf16le")).digest("hex")}`;

/** Each operation has its own immutable receipt; it is not a mailbox head pointer. */
export const mailboxReceiptIri = (operation: string): string =>
  `urn:agent-bus:mailbox-receipt:${operation}`;

/** Versioned, domain-separated references preserve exact JavaScript UTF-16 code units. */
const identityRef = (domain: "run" | "presence", value: string): string =>
  `v1:${createHash("sha256")
    .update(`agent-bus:mailbox-ref:v1:${domain}\0`, "utf8")
    .update(Buffer.from(value, "utf16le"))
    .digest("hex")}`;
export const mailboxRunRef = (run: string): string => identityRef("run", run);
export const mailboxPresenceRef = (id: string): string => identityRef("presence", id);

const Operation = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
);
const Position = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);

/** A reset written in the same transaction as the presence that starts it. */
export const MailboxStart = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("start"),
  operation: Operation,
  address: Schema.String,
  run: Schema.String,
  origin: Schema.Literals(["join", "replay", "import", "reconcile", "restart"]),
  position: Position,
});

/** An import could not establish a position; it must never be treated as an empty mailbox. */
export const MailboxUnresolved = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("unresolved"),
  operation: Operation,
  address: Schema.String,
  reason: Schema.Literals([
    "missing",
    "conflict",
    "stale",
    "unreadable",
    "unattributable",
    "ahead",
    "wrong-incarnation",
  ]),
});

/** A raw storage fact, not an authorization or proof that this range was served. */
export const MailboxAck = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("ack"),
  operation: Operation,
  address: Schema.String,
  mode: Schema.Literals(["read", "checkpoint"]),
  run: Schema.String,
  from: Position,
  through: Position,
  dataCut: Schema.Struct({ incarnation: Schema.String, head: Position }),
  subscription: Schema.Struct({
    presenceId: Schema.String.check(Schema.isMinLength(1)),
    topicsDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  }),
  servedCount: Position,
  servedDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  carrierBytes: Position,
});

/** The exact ordered-ID digest retained with a read or an empty checkpoint. */
export const mailboxServedDigest = (ids: ReadonlyArray<string>): string =>
  createHash("sha256").update(JSON.stringify(ids), "utf8").digest("hex");

/** Digest of the exact ordered topics in the referenced presence. */
export const mailboxTopicsDigest = (topics: ReadonlyArray<string>): string =>
  createHash("sha256").update(JSON.stringify(topics), "utf8").digest("hex");

export const MailboxRecord = Schema.Union([MailboxStart, MailboxUnresolved, MailboxAck]);
export type MailboxRecord = typeof MailboxRecord.Type;
export type MailboxStart = typeof MailboxStart.Type;
export type MailboxUnresolved = typeof MailboxUnresolved.Type;
export type MailboxAck = typeof MailboxAck.Type;
export const MailboxRecordJson = Schema.fromJsonString(MailboxRecord);
export const encodeMailboxRecord = Schema.encodeSync(MailboxRecordJson);

const Reference = Schema.String.check(Schema.isPattern(/^v1:[0-9a-f]{64}$/));
const MailboxKey = Schema.String.check(Schema.isPattern(/^urn:agent-bus:mailbox:[0-9a-f]{64}$/));
const Previous = Schema.NullOr(Operation);
const MailboxFactStart = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("start"),
  operation: Operation,
  mailbox: MailboxKey,
  previous: Previous,
  runRef: Reference,
  origin: MailboxStart.fields.origin,
  position: Position,
});
const MailboxFactUnresolved = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("unresolved"),
  operation: Operation,
  mailbox: MailboxKey,
  previous: Previous,
  reason: MailboxUnresolved.fields.reason,
});
const MailboxFactAck = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("ack"),
  operation: Operation,
  mailbox: MailboxKey,
  previous: Previous,
  mode: MailboxAck.fields.mode,
  runRef: Reference,
  from: Position,
  through: Position,
  dataCut: MailboxAck.fields.dataCut,
  subscription: Schema.Struct({
    presenceRef: Reference,
    topicsDigest: MailboxAck.fields.subscription.fields.topicsDigest,
  }),
  servedCount: Position,
  servedDigest: MailboxAck.fields.servedDigest,
  carrierBytes: Position,
});
export const MailboxFact = Schema.Union([MailboxFactStart, MailboxFactUnresolved, MailboxFactAck]);
export type MailboxFact = typeof MailboxFact.Type;
const MailboxFactJson = Schema.fromJsonString(MailboxFact);
export const encodeMailboxFact = Schema.encodeSync(MailboxFactJson);
const decodeFact = Schema.decodeUnknownOption(MailboxFactJson, { onExcessProperty: "error" });
export const decodeMailboxFact = (input: unknown) =>
  Option.filter(
    decodeFact(input),
    (fact) => typeof input === "string" && encodeMailboxFact(fact) === input
  );

/** The sole logical-intent to compact immutable-receipt mapping. */
export const mailboxFactOf = (record: MailboxRecord, previous: string | null): MailboxFact => {
  const base = {
    version: 1 as const,
    kind: record.kind,
    operation: record.operation,
    mailbox: mailboxIri(record.address),
    previous,
  };
  switch (record.kind) {
    case "unresolved":
      return { ...base, kind: record.kind, reason: record.reason };
    case "start":
      return {
        ...base,
        kind: record.kind,
        runRef: mailboxRunRef(record.run),
        origin: record.origin,
        position: record.position,
      };
    case "ack":
      return {
        ...base,
        kind: record.kind,
        mode: record.mode,
        runRef: mailboxRunRef(record.run),
        from: record.from,
        through: record.through,
        dataCut: record.dataCut,
        subscription: {
          presenceRef: mailboxPresenceRef(record.subscription.presenceId),
          topicsDigest: record.subscription.topicsDigest,
        },
        servedCount: record.servedCount,
        servedDigest: record.servedDigest,
        carrierBytes: record.carrierBytes,
      };
  }
};

/** Compare full caller intent without treating a historical result as new authorization. */
export const mailboxIntentMatches = (record: MailboxRecord, fact: MailboxFact): boolean =>
  encodeMailboxFact(mailboxFactOf(record, fact.previous)) === encodeMailboxFact(fact);

/** Intrinsic current-receipt checks; predecessor history and served membership are separate. */
export const validMailboxFactAt = (fact: MailboxFact, t: number, incarnation: string): boolean => {
  if (!Number.isSafeInteger(t) || t < 1 || fact.previous === fact.operation) return false;
  if (fact.kind === "unresolved") return fact.previous === null;
  if (fact.runRef === mailboxRunRef("")) return false;
  if (fact.kind === "start") {
    return (
      fact.position < t &&
      (fact.origin !== "replay" || fact.position === 0) &&
      (fact.origin !== "import" || fact.previous === null) &&
      ((fact.origin !== "reconcile" && fact.origin !== "restart") || fact.previous !== null)
    );
  }
  return (
    fact.previous !== null &&
    fact.subscription.presenceRef !== mailboxPresenceRef("") &&
    fact.from < fact.through &&
    fact.through <= fact.dataCut.head &&
    fact.dataCut.head < t &&
    fact.dataCut.incarnation === incarnation &&
    (fact.mode === "read"
      ? fact.servedCount > 0 && fact.carrierBytes > 0
      : fact.servedCount === 0 &&
        fact.carrierBytes === 0 &&
        fact.servedDigest === mailboxServedDigest([]))
  );
};

export interface StoredMailboxRecord {
  readonly record: MailboxFact;
  readonly t: number;
}

export type MailboxState =
  | { readonly status: "ABSENT" }
  | {
      readonly status: "UNRESOLVED";
      readonly reason: MailboxUnresolved["reason"];
      readonly current: StoredMailboxRecord;
    }
  | {
      readonly status: "FOUND";
      readonly position: number;
      readonly current: StoredMailboxRecord;
    };
