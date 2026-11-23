import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import { LedgerError } from "./domain.ts";

/** The address itself, rather than a projected property, identifies its mailbox. */
export const mailboxIri = (address: string): string =>
  `urn:agent-bus:mailbox:${createHash("sha256").update(Buffer.from(address, "utf16le")).digest("hex")}`;

/** Each operation has its own immutable receipt; it is not a mailbox head pointer. */
export const mailboxReceiptIri = (operation: string): string =>
  `urn:agent-bus:mailbox-receipt:${operation}`;

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

/** A value of one of the address-scoped predicates at its assertion commit. */
export interface RawMailboxRecord {
  readonly predicate: "start" | "ack";
  readonly json: string;
  readonly t: number;
}

export interface StoredMailboxRecord {
  readonly record: MailboxRecord;
  readonly t: number;
}

export type MailboxState =
  | { readonly status: "ABSENT" }
  | {
      readonly status: "UNRESOLVED";
      readonly reason: MailboxUnresolved["reason"];
      readonly records: ReadonlyArray<StoredMailboxRecord>;
    }
  | {
      readonly status: "FOUND";
      readonly position: number;
      readonly records: ReadonlyArray<StoredMailboxRecord>;
    };

const decode = Schema.decodeUnknownOption(MailboxRecordJson, {
  onExcessProperty: "error",
});
export const encodeMailboxRecord = Schema.encodeSync(MailboxRecordJson);
/** Exact canonical bytes reject duplicate JSON keys and other alternate encodings. */
export const decodeMailboxRecord = (input: unknown) =>
  Option.filter(
    decode(input),
    (record) => typeof input === "string" && encodeMailboxRecord(record) === input
  );
const damaged = (t: number) =>
  new LedgerError({ message: `A mailbox entry at t=${t} could not be established.` });

/**
 * Validate every address-scoped fact before returning a position. Rewinds are explicit starts;
 * acknowledgements advance the exact prior position, not merely a greater number. One operation
 * and one mailbox fact per commit make every stored position unambiguous.
 */
export const resolveMailbox = (
  raw: ReadonlyArray<RawMailboxRecord>,
  address: string,
  head: number,
  incarnation: string
) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(head) || head < 0 || incarnation === "") {
      return yield* damaged(head);
    }
    const records: Array<StoredMailboxRecord> = [];
    const operations = new Set<string>();
    let position: number | undefined;
    let unresolved: MailboxUnresolved["reason"] | undefined;
    let previousT = 0;
    for (const entry of [...raw].sort((a, b) => a.t - b.t)) {
      if (!Number.isSafeInteger(entry.t) || entry.t <= previousT || entry.t > head) {
        return yield* damaged(entry.t);
      }
      const decoded = decodeMailboxRecord(entry.json);
      if (
        Option.isNone(decoded) ||
        (decoded.value.kind === "ack" ? "ack" : "start") !== entry.predicate ||
        decoded.value.address !== address ||
        (decoded.value.kind !== "unresolved" && decoded.value.run === "")
      ) {
        return yield* damaged(entry.t);
      }
      const record = decoded.value;
      if (operations.has(record.operation)) return yield* damaged(entry.t);
      operations.add(record.operation);
      if (record.kind === "unresolved") {
        if (position !== undefined || unresolved !== undefined) return yield* damaged(entry.t);
        unresolved = record.reason;
      } else if (record.kind === "start") {
        if (
          record.position >= entry.t ||
          (record.origin === "replay" && record.position !== 0) ||
          (record.origin === "import" && (position !== undefined || unresolved !== undefined)) ||
          ((record.origin === "reconcile" || record.origin === "restart") &&
            unresolved === undefined) ||
          ((record.origin === "join" || record.origin === "replay") && unresolved !== undefined)
        ) {
          return yield* damaged(entry.t);
        }
        position = record.position;
        unresolved = undefined;
      } else {
        if (
          position === undefined ||
          record.from !== position ||
          record.through <= record.from ||
          record.through > record.dataCut.head ||
          record.dataCut.head >= entry.t ||
          record.dataCut.incarnation !== incarnation ||
          (record.mode === "read" && (record.servedCount === 0 || record.carrierBytes === 0)) ||
          (record.mode === "checkpoint" &&
            (record.servedCount !== 0 ||
              record.carrierBytes !== 0 ||
              record.servedDigest !== mailboxServedDigest([])))
        ) {
          return yield* damaged(entry.t);
        }
        position = record.through;
      }
      previousT = entry.t;
      records.push({ record, t: entry.t });
    }
    if (unresolved !== undefined) {
      return { status: "UNRESOLVED", reason: unresolved, records } satisfies MailboxState;
    }
    return position === undefined
      ? ({ status: "ABSENT" } satisfies MailboxState)
      : ({ status: "FOUND", position, records } satisfies MailboxState);
  });
