import { type Duration, Effect, Option, Schema } from "effect";
import { LedgerError, type Message, MessageJson } from "./domain.ts";
import type { Admission, MailboxReceiptRead, MailboxWrite } from "./Ledger.ts";
import {
  decodeMailboxRecord,
  encodeMailboxRecord,
  type MailboxAck,
  type MailboxRecord,
  MailboxRecord as MailboxRecordSchema,
  type MailboxStart,
  type MailboxState,
  mailboxIri,
  mailboxReceiptIri,
  type RawMailboxRecord,
  resolveMailbox,
} from "./mailbox-model.ts";
import { storable } from "./message-carrier.ts";
import type { Pin } from "./Query.ts";
import { MAX_ENVELOPE_BYTES } from "./query-contract.ts";

type Query = Readonly<Record<string, unknown>>;
type IO<A> = Effect.Effect<A, LedgerError>;

/** The surrounding Fluree layer owns HTTP, bounds, timeouts and its ledger incarnation. */
export interface MailboxTransport {
  readonly instance: string;
  readonly timeout: Duration.Input;
  readonly head: IO<number>;
  readonly incarnation: IO<string>;
  readonly at: (head: number, body: Query) => IO<unknown>;
  readonly history: (head: number, body: Query) => IO<unknown>;
  readonly update: (body: Query) => IO<number>;
  readonly attemptedMessage: (id: string, head: number) => IO<ReadonlyArray<number>>;
  readonly messageNode: (message: Message, json: string) => Readonly<Record<string, unknown>>;
}

const BUS = "https://rawr.ai/ns/agent-bus#";
const literal = (value: string) => ({ "@value": value, "@type": "xsd:string" });
const iri = (value: string) => ({ "@value": value, "@type": "@id" });
const invalid = () => new LedgerError({ message: "Invalid or incomplete mailbox data." });
const replaced = () =>
  new LedgerError({ message: "The mailbox snapshot is unavailable or the ledger was replaced." });
const HistoryRows = Schema.Array(
  Schema.Tuple([Schema.String, Schema.Int, Schema.Boolean, Schema.Boolean, Schema.String])
);
const PredicateRows = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
const ReceiptRows = Schema.Array(
  Schema.Tuple([
    Schema.String,
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.Int),
    Schema.NullOr(Schema.Boolean),
    Schema.NullOr(Schema.String),
  ])
);
const StartPresenceRows = Schema.Array(
  Schema.Tuple([
    Schema.String,
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.Int),
    Schema.NullOr(Schema.Boolean),
    Schema.NullOr(Schema.String),
  ])
);
const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalid));
const validOperation = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const validAddress = (value: string) => {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
};
const sameType = (value: string | null, kind: MailboxRecord["kind"]) =>
  value === `bus:Mailbox${kind === "start" ? "Start" : "Ack"}` ||
  value === `${BUS}Mailbox${kind === "start" ? "Start" : "Ack"}`;
const stringType = (value: string | null) =>
  value === "xsd:string" || value === "http://www.w3.org/2001/XMLSchema#string";

/**
 * Address-scoped immutable facts and operation witnesses. This layer enforces storage fences;
 * it deliberately does not authorize a holder or prove a claimed served prefix.
 */
export const makeFlureeMailbox = (transport: MailboxTransport) => {
  const bounded = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: transport.timeout,
        orElse: () => Effect.fail(new LedgerError({ message: "The mailbox read timed out." })),
      })
    );
  const present = (cut: Pin) =>
    Effect.gen(function* () {
      if (
        cut.incarnation !== transport.instance ||
        !Number.isSafeInteger(cut.head) ||
        cut.head < 0 ||
        (yield* transport.incarnation) !== cut.incarnation ||
        (yield* transport.head) < cut.head
      )
        return yield* replaced();
    });
  const values = (operations: ReadonlyArray<string>) => [
    ["?receipt"],
    operations.map((operation) => [iri(mailboxReceiptIri(operation))]),
  ];
  const receiptFields = (cut: Pin, operations: ReadonlyArray<string>) =>
    transport
      .at(cut.head, {
        select: ["?receipt", "?type", "?json", "?t", "?literal", "?datatype"],
        values: values(operations),
        where: [
          ["optional", { "@id": "?receipt", "@type": "?type" }],
          [
            "optional",
            { "@id": "?receipt", "bus:mailboxRecord": { "@value": "?json", "@t": "?t" } },
          ],
          ["bind", "?literal", "(isLiteral ?json)"],
          ["bind", "?datatype", "(datatype ?json)"],
        ],
      })
      .pipe(Effect.flatMap(decode(ReceiptRows)));
  const receiptPredicates = (cut: Pin, operations: ReadonlyArray<string>) =>
    transport
      .at(cut.head, {
        select: ["?receipt", "?predicate"],
        values: values(operations),
        where: { "@id": "?receipt", "?predicate": "?object" },
      })
      .pipe(Effect.flatMap(decode(PredicateRows)));
  const startPresences = (cut: Pin, operations: ReadonlyArray<string>) =>
    transport
      .at(cut.head, {
        select: ["?message", "?type", "?id", "?from", "?json", "?t", "?literal", "?datatype"],
        values: [
          ["?message"],
          operations.map((operation) => [iri(`urn:agent-bus:message:${operation}`)]),
        ],
        where: [
          ["optional", { "@id": "?message", "@type": "?type" }],
          ["optional", { "@id": "?message", "bus:id": "?id" }],
          ["optional", { "@id": "?message", "bus:from": "?from" }],
          ["optional", { "@id": "?message", "bus:json": { "@value": "?json", "@t": "?t" } }],
          ["bind", "?literal", "(isLiteral ?json)"],
          ["bind", "?datatype", "(datatype ?json)"],
        ],
      })
      .pipe(Effect.flatMap(decode(StartPresenceRows)));

  const recordsAt = (address: string, cut: Pin) =>
    Effect.gen(function* () {
      if (cut.head === 0) return [] as Array<RawMailboxRecord>;
      const records: Array<RawMailboxRecord> = [];
      for (const predicate of ["start", "ack"] as const) {
        const property = predicate === "start" ? "bus:mailboxStart" : "bus:mailboxAck";
        const rows = yield* transport
          .history(cut.head, {
            select: ["?json", "?t", "?op", "?literal", "?datatype"],
            values: [["?mailbox"], [[iri(mailboxIri(address))]]],
            where: [
              { "@id": "?mailbox", [property]: { "@value": "?json", "@t": "?t", "@op": "?op" } },
              ["bind", "?literal", "(isLiteral ?json)"],
              ["bind", "?datatype", "(datatype ?json)"],
            ],
          })
          .pipe(Effect.flatMap(decode(HistoryRows)));
        for (const [json, t, asserted, isLiteral, datatype] of rows) {
          if (!asserted || !isLiteral || !stringType(datatype)) return yield* invalid();
          records.push({ predicate, json, t });
        }
      }
      return records;
    });

  const validateReceipts = (cut: Pin, raw: ReadonlyArray<RawMailboxRecord>, state: MailboxState) =>
    Effect.gen(function* () {
      if (state.status === "ABSENT") return;
      const records = state.records;
      const rawByT = new Map(raw.map((value) => [value.t, value]));
      for (let offset = 0; offset < records.length; offset += 100) {
        const batch = records.slice(offset, offset + 100);
        const operations = batch.map(({ record }) => record.operation);
        const [fields, predicates] = yield* Effect.all([
          receiptFields(cut, operations),
          receiptPredicates(cut, operations),
        ]);
        const starts = batch.filter(
          (event) => event.record.kind === "start" && event.record.origin !== "import"
        );
        const presences =
          starts.length === 0
            ? []
            : yield* startPresences(
                cut,
                starts.map((event) => event.record.operation)
              );
        for (const event of batch) {
          const subject = mailboxReceiptIri(event.record.operation);
          const matches = fields.filter((row) => row[0] === subject);
          const predicatesFor = predicates.filter((row) => row[0] === subject);
          const row = matches[0];
          const data = rawByT.get(event.t);
          if (
            matches.length !== 1 ||
            predicatesFor.length !== 2 ||
            row === undefined ||
            data === undefined ||
            !sameType(row[1], event.record.kind) ||
            row[2] !== data.json ||
            row[3] !== event.t ||
            row[4] !== true ||
            !stringType(row[5])
          )
            return yield* invalid();
          if (event.record.kind === "start" && event.record.origin !== "import") {
            const matches = presences.filter(
              (value) => value[0] === `urn:agent-bus:message:${event.record.operation}`
            );
            const presence = matches[0];
            const message =
              presence?.[4] === null || presence?.[4] === undefined
                ? Option.none()
                : Schema.decodeUnknownOption(MessageJson)(presence[4]);
            if (
              matches.length !== 1 ||
              presence === undefined ||
              (presence[1] !== "bus:Presence" && presence[1] !== `${BUS}Presence`) ||
              presence[2] !== event.record.operation ||
              presence[3] !== event.record.address ||
              presence[5] !== event.t ||
              presence[6] !== true ||
              !stringType(presence[7]) ||
              Option.isNone(message) ||
              message.value.kind !== "presence" ||
              message.value.id !== event.record.operation ||
              message.value.from !== event.record.address ||
              message.value.presence?.status !== "joined" ||
              (message.value.presence.rejoinOf ?? message.value.id) !== event.record.run
            )
              return yield* invalid();
          }
        }
      }
    });

  const mailboxAt = (address: string, cut: Pin) =>
    bounded(
      Effect.gen(function* () {
        yield* present(cut);
        const raw = yield* recordsAt(address, cut);
        const state = yield* resolveMailbox(raw, address, cut.head, cut.incarnation);
        yield* validateReceipts(cut, raw, state);
        yield* present(cut);
        return state;
      })
    );

  const mailboxReceiptAt = (address: string, operation: string, cut: Pin) =>
    Effect.gen(function* () {
      if (!validOperation(operation)) return { status: "UNAVAILABLE" } satisfies MailboxReceiptRead;
      yield* present(cut);
      if (cut.head === 0) return { status: "ABSENT", cut } satisfies MailboxReceiptRead;
      const predicates = yield* receiptPredicates(cut, [operation]);
      if (predicates.length === 0) {
        // An event without its witness is damage, not an absent operation.
        yield* mailboxAt(address, cut);
        yield* present(cut);
        return { status: "ABSENT", cut } satisfies MailboxReceiptRead;
      }
      const fields = yield* receiptFields(cut, [operation]);
      const row = fields[0];
      if (
        predicates.length !== 2 ||
        fields.length !== 1 ||
        row === undefined ||
        row[2] === null ||
        row[3] === null ||
        row[4] !== true ||
        !stringType(row[5])
      ) {
        return { status: "MALFORMED", cut } satisfies MailboxReceiptRead;
      }
      const record = decodeMailboxRecord(row[2]);
      if (
        Option.isNone(record) ||
        record.value.operation !== operation ||
        !sameType(row[1], record.value.kind)
      ) {
        return { status: "MALFORMED", cut } satisfies MailboxReceiptRead;
      }
      const state = yield* mailboxAt(record.value.address, cut);
      const matched =
        state.status === "FOUND" &&
        state.records.some(
          (entry) =>
            entry.t === row[3] &&
            entry.record.operation === operation &&
            encodeMailboxRecord(entry.record) === row[2]
        );
      if (!matched) return { status: "MALFORMED", cut } satisfies MailboxReceiptRead;
      yield* present(cut);
      return { status: "FOUND", record: record.value, t: row[3], cut } satisfies MailboxReceiptRead;
    }).pipe(
      (effect) => bounded(effect),
      Effect.catch(() => Effect.succeed({ status: "UNAVAILABLE" } satisfies MailboxReceiptRead))
    );

  const absence = (subject: string, suffix: string) => [
    ["optional", { "@id": subject, [`?${suffix}Predicate`]: `?${suffix}Object` }],
    ["filter", `(not (bound ?${suffix}Object))`],
  ];
  const guard = (address: string, basis: Pin) => [
    [
      "optional",
      ["values", ["?sender", [address]]],
      {
        "@id": "?presence",
        "@type": "bus:Presence",
        "bus:from": "?sender",
        "bus:json": { "@value": "?presenceJson", "@t": "?presenceT" },
      },
      ["filter", `(> ?presenceT ${basis.head})`],
    ],
    ["filter", "(not (bound ?presenceT))"],
    [
      "optional",
      ["values", ["?mailbox", [iri(mailboxIri(address))]]],
      [
        "union",
        { "@id": "?mailbox", "bus:mailboxStart": { "@value": "?position", "@t": "?positionT" } },
        { "@id": "?mailbox", "bus:mailboxAck": { "@value": "?position", "@t": "?positionT" } },
      ],
      ["filter", `(> ?positionT ${basis.head})`],
    ],
    ["filter", "(not (bound ?positionT))"],
  ];
  const nodes = (record: MailboxRecord, json: string) => [
    {
      "@id": mailboxIri(record.address),
      [record.kind === "start" ? "bus:mailboxStart" : "bus:mailboxAck"]: literal(json),
    },
    {
      "@id": mailboxReceiptIri(record.operation),
      "@type": record.kind === "start" ? "bus:MailboxStart" : "bus:MailboxAck",
      "bus:mailboxRecord": literal(json),
    },
  ];
  const checkInput = (record: MailboxRecord, basis: Pin) =>
    Effect.gen(function* () {
      const checked = yield* Schema.decodeUnknownEffect(MailboxRecordSchema, {
        onExcessProperty: "error",
      })(record).pipe(Effect.mapError(invalid));
      if (!validAddress(checked.address)) {
        return yield* new LedgerError({
          message:
            "Fluree cannot represent an address with an unpaired UTF-16 surrogate; nothing was written.",
        });
      }
      if (!validOperation(checked.operation) || basis.incarnation !== transport.instance) {
        return yield* invalid();
      }
      const json = encodeMailboxRecord(checked);
      const decoded = decodeMailboxRecord(json);
      if (Option.isNone(decoded) || Buffer.byteLength(json, "utf8") > MAX_ENVELOPE_BYTES)
        return yield* invalid();
      return json;
    });
  const latest = Effect.gen(function* () {
    const incarnation = yield* transport.incarnation;
    const head = yield* transport.head;
    return { head, incarnation } satisfies Pin;
  });

  const writeMailbox = (record: MailboxAck | MailboxStart, basis: Pin) =>
    Effect.gen(function* () {
      const json = yield* checkInput(record, basis);
      yield* present(basis);
      const current = yield* latest;
      if (current.incarnation !== basis.incarnation) return yield* replaced();
      const existing = yield* mailboxReceiptAt(record.address, record.operation, current);
      if (existing.status === "FOUND") {
        return encodeMailboxRecord(existing.record) === json
          ? ({
              status: "APPLIED",
              cut: { head: existing.t, incarnation: current.incarnation },
            } satisfies MailboxWrite)
          : ({ status: "IDENTITY_MISMATCH", cut: current } satisfies MailboxWrite);
      }
      if (existing.status !== "ABSENT") return { status: "UNKNOWN" } satisfies MailboxWrite;
      const prior = yield* mailboxAt(record.address, basis);
      const now = yield* mailboxAt(record.address, current);
      if (now.status === "FOUND" && now.records.some((entry) => entry.t > basis.head)) {
        return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
      }
      if (record.kind === "start") {
        if (
          record.origin !== "import" ||
          record.position > basis.head ||
          prior.status !== "ABSENT"
        ) {
          return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
        }
      } else if (
        prior.status !== "FOUND" ||
        record.from !== prior.position ||
        record.dataCut.head > basis.head ||
        record.dataCut.incarnation !== basis.incarnation
      ) {
        return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
      }
      const raw = yield* recordsAt(record.address, basis);
      yield* resolveMailbox(
        [...raw, { predicate: record.kind, json, t: basis.head + 1 }],
        record.address,
        basis.head + 1,
        basis.incarnation
      );
      const response = yield* Effect.option(
        transport.update({
          where: [
            ...guard(record.address, basis),
            ...absence(mailboxReceiptIri(record.operation), "receipt"),
          ],
          insert: nodes(record, json),
        })
      );
      if (Option.isNone(response)) return { status: "UNKNOWN" } satisfies MailboxWrite;
      return yield* Effect.gen(function* () {
        const cut = { head: response.value, incarnation: basis.incarnation };
        const saved = yield* mailboxReceiptAt(record.address, record.operation, cut);
        if (saved.status === "FOUND") {
          return encodeMailboxRecord(saved.record) === json
            ? ({
                status: "APPLIED",
                cut: { head: saved.t, incarnation: basis.incarnation },
              } satisfies MailboxWrite)
            : ({ status: "IDENTITY_MISMATCH", cut } satisfies MailboxWrite);
        }
        if (saved.status === "ABSENT") return { status: "CONFLICT", cut } satisfies MailboxWrite;
        return { status: "UNKNOWN" } satisfies MailboxWrite;
      }).pipe(Effect.catch(() => Effect.succeed({ status: "UNKNOWN" } satisfies MailboxWrite)));
    }).pipe(
      Effect.timeoutOrElse({
        duration: transport.timeout,
        orElse: () => Effect.succeed({ status: "UNKNOWN" } satisfies MailboxWrite),
      })
    );

  const admitWithStart = (message: Message, start: MailboxStart, basis: Pin) =>
    Effect.gen(function* () {
      if (
        start.origin === "import" ||
        message.kind !== "presence" ||
        message.presence?.status !== "joined" ||
        message.from !== start.address ||
        message.id !== start.operation ||
        (message.presence.rejoinOf ?? message.id) !== start.run ||
        start.position > basis.head
      )
        return yield* invalid();
      yield* storable(message);
      const json = yield* checkInput(start, basis);
      const messageJson = yield* Schema.encodeEffect(MessageJson)(message).pipe(
        Effect.mapError(invalid)
      );
      yield* mailboxAt(start.address, basis);
      const current = yield* latest;
      if (current.incarnation !== basis.incarnation) return yield* replaced();
      const now = yield* mailboxAt(start.address, current);
      if (now.status === "FOUND" && now.records.some((entry) => entry.t > basis.head)) {
        return { status: "REFUSED", cut: current } satisfies Admission;
      }
      const raw = yield* recordsAt(start.address, basis);
      yield* resolveMailbox(
        [...raw, { predicate: "start", json, t: basis.head + 1 }],
        start.address,
        basis.head + 1,
        basis.incarnation
      );
      yield* present(basis);
      const response = yield* Effect.option(
        transport.update({
          where: [
            ...guard(start.address, basis),
            ...absence(mailboxReceiptIri(start.operation), "receipt"),
            ...absence(`urn:agent-bus:message:${message.id}`, "message"),
          ],
          insert: [transport.messageNode(message, messageJson), ...nodes(start, json)],
        })
      );
      if (Option.isNone(response)) return { status: "UNKNOWN" } satisfies Admission;
      return yield* Effect.gen(function* () {
        const cut = { head: response.value, incarnation: basis.incarnation };
        const receipt = yield* mailboxReceiptAt(start.address, start.operation, cut);
        const commits = yield* transport.attemptedMessage(message.id, cut.head);
        const presences = yield* startPresences(cut, [message.id]);
        if ((yield* transport.incarnation) !== cut.incarnation) {
          return { status: "UNKNOWN" } satisfies Admission;
        }
        const stored = presences.length === 1 ? presences[0] : undefined;
        if (
          receipt.status === "FOUND" &&
          encodeMailboxRecord(receipt.record) === json &&
          commits.length === 1 &&
          commits[0] === receipt.t &&
          receipt.t > basis.head &&
          stored?.[4] === messageJson
        ) {
          return {
            status: "ADMITTED",
            cut: { head: receipt.t, incarnation: cut.incarnation },
          } satisfies Admission;
        }
        if (
          receipt.status === "FOUND" &&
          commits.length === 1 &&
          commits[0] === receipt.t &&
          stored !== undefined &&
          stored[4] !== messageJson
        )
          return { status: "REFUSED", cut } satisfies Admission;
        if (receipt.status === "ABSENT" && commits.length === 0)
          return { status: "REFUSED", cut } satisfies Admission;
        return { status: "UNKNOWN" } satisfies Admission;
      }).pipe(Effect.catch(() => Effect.succeed({ status: "UNKNOWN" } satisfies Admission)));
    }).pipe(
      Effect.timeoutOrElse({
        duration: transport.timeout,
        orElse: () => Effect.succeed({ status: "UNKNOWN" } satisfies Admission),
      })
    );

  return {
    mailboxAt,
    mailboxReceiptAt,
    admitWithStart,
    importMailbox: (start: MailboxStart, basis: Pin) => writeMailbox(start, basis),
    appendMailboxAck: (ack: MailboxAck, basis: Pin) => writeMailbox(ack, basis),
  };
};
