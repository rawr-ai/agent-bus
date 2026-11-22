import { type Duration, Effect, Option, Schema } from "effect";
import { LedgerError, type Message, MessageJson } from "./domain.ts";
import { type Ownership, predecessor, successor, vacantSuccessor } from "./FlureePresence.ts";
import type { Admission, MailboxReceiptRead, MailboxWrite } from "./Ledger.ts";
import {
  decodeMailboxFact,
  encodeMailboxFact,
  type MailboxAck,
  type MailboxFact,
  type MailboxRecord,
  MailboxRecord as MailboxRecordSchema,
  type MailboxStart,
  type MailboxState,
  type MailboxUnresolved,
  mailboxFactOf,
  mailboxIntentMatches,
  mailboxIri,
  mailboxReceiptIri,
  validMailboxFactAt,
} from "./mailbox-model.ts";
import { storable } from "./message-carrier.ts";
import type { Pin } from "./Query.ts";

type Query = Readonly<Record<string, unknown>>;
type IO<A> = Effect.Effect<A, LedgerError>;

/** The surrounding Fluree layer owns HTTP, bounds, timeouts and its ledger incarnation. */
export interface MailboxTransport {
  readonly ownership: Ownership;
  readonly instance: string;
  readonly timeout: Duration.Input;
  readonly head: IO<number>;
  readonly incarnation: IO<string>;
  readonly at: (head: number, body: Query) => IO<unknown>;
  /** History of one subject and predicate, bounded by a pinned inclusive commit range. */
  readonly history: (from: number, through: number, body: Query) => IO<unknown>;
  readonly update: (body: Query) => IO<number>;
  readonly messageNode: (message: Message, json: string) => Readonly<Record<string, unknown>>;
}

const BUS = "https://rawr.ai/ns/agent-bus#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const marker = "v1";
const literal = (value: string) => ({ "@value": value, "@type": "xsd:string" });
const iri = (value: string) => ({ "@value": value, "@type": "@id" });
const invalid = () => new LedgerError({ message: "Invalid or incomplete mailbox data." });
const replaced = () =>
  new LedgerError({ message: "The mailbox snapshot is unavailable or the ledger was replaced." });
const maybeString = Schema.NullOr(Schema.String);
const maybeInt = Schema.NullOr(Schema.Int);
const maybeBoolean = Schema.NullOr(Schema.Boolean);
const HeadRows = Schema.Array(
  Schema.Tuple([
    maybeString,
    maybeInt,
    maybeString,
    maybeInt,
    maybeBoolean,
    maybeString,
    maybeBoolean,
    maybeString,
  ])
);
const ReceiptRows = Schema.Array(
  Schema.Tuple([
    maybeString,
    Schema.Unknown,
    maybeString,
    maybeString,
    maybeInt,
    maybeBoolean,
    maybeString,
    maybeInt,
    maybeBoolean,
  ])
);
const EntryRows = Schema.Array(
  Schema.Tuple([
    maybeString,
    maybeString,
    maybeString,
    maybeString,
    maybeInt,
    maybeBoolean,
    maybeString,
    maybeBoolean,
    maybeString,
    maybeBoolean,
    maybeString,
    maybeBoolean,
  ])
);
const KnownRows = Schema.Array(
  Schema.Tuple([
    maybeString,
    maybeString,
    maybeString,
    maybeInt,
    maybeBoolean,
    maybeString,
    maybeBoolean,
    maybeInt,
    maybeInt,
    maybeInt,
    maybeBoolean,
    maybeString,
    maybeBoolean,
    maybeString,
    maybeBoolean,
  ])
);
const AssertionRows = Schema.Array(Schema.Tuple([Schema.String, Schema.Int, Schema.Boolean]));
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
const recordType = (kind: MailboxFact["kind"]) =>
  kind === "start" ? "Start" : kind === "ack" ? "Ack" : "Unresolved";
const sameType = (value: string | null, kind: MailboxFact["kind"]) =>
  value === `bus:Mailbox${recordType(kind)}` || value === `${BUS}Mailbox${recordType(kind)}`;
const stringType = (value: string | null) => value === "xsd:string" || value === `${XSD}string`;
const messageType = (value: string | null, kind: Message["kind"]) =>
  value === `bus:${kind === "presence" ? "Presence" : "Message"}` ||
  value === `${BUS}${kind === "presence" ? "Presence" : "Message"}`;

type ReceiptNode =
  | { readonly status: "ABSENT" }
  | { readonly status: "MALFORMED" }
  | { readonly status: "FOUND"; readonly record: MailboxFact; readonly t: number };
interface Head {
  readonly state: MailboxState;
  readonly markerT: number | null;
  readonly pointerT: number | null;
  readonly operation: string | null;
}

/**
 * One marker and one current reference per address, with immutable operation receipts.
 * This layer enforces storage fences; it does not authorize a holder or prove a served prefix.
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
  const predicatesAt = (subject: string, cut: Pin) =>
    transport
      .at(cut.head, {
        select: "?predicate",
        values: [["?subject"], [[iri(subject)]]],
        where: { "@id": "?subject", "?predicate": "?object" },
      })
      .pipe(Effect.flatMap(decode(Schema.Array(Schema.String))));

  /** Snapshot IRI metadata can be zero. The original assertion must still be effective at cut. */
  const effectiveType = (subject: string, type: string, t: number, through: number) =>
    transport
      .history(t, through, {
        "@context": { bus: BUS, xsd: XSD, rdf: RDF },
        select: ["?type", "?t", "?asserted"],
        values: [["?subject"], [[iri(subject)]]],
        where: [
          { "@id": "?subject", "rdf:type": { "@value": "?type", "@t": "?t", "@op": "?asserted" } },
        ],
        limit: 2,
      })
      .pipe(
        Effect.flatMap(decode(AssertionRows)),
        Effect.map(
          (rows) =>
            rows.length === 1 &&
            rows[0]?.[0] === type &&
            rows[0]?.[1] === t &&
            rows[0]?.[2] === true
        )
      );

  /** Complete point read of an unknown entry, used only to classify a differing intent. */
  const entryAttempt = (operation: string, cut: Pin) =>
    bounded(
      Effect.gen(function* () {
        yield* present(cut);
        const subject = `urn:agent-bus:message:${operation}`;
        const predicates = yield* predicatesAt(subject, cut);
        if (predicates.length === 0) {
          yield* present(cut);
          return { status: "ABSENT" } as const;
        }
        const rows = yield* transport
          .at(cut.head, {
            select: [
              "?type",
              "?id",
              "?from",
              "?json",
              "?t",
              "?literal",
              "?datatype",
              "?idLiteral",
              "?idDatatype",
              "?fromLiteral",
              "?fromDatatype",
              "?typeIri",
            ],
            values: [["?message"], [[iri(subject)]]],
            where: [
              ["optional", { "@id": "?message", "@type": "?type" }],
              ["optional", { "@id": "?message", "bus:id": "?id" }],
              ["optional", { "@id": "?message", "bus:from": "?from" }],
              ["optional", { "@id": "?message", "bus:json": { "@value": "?json", "@t": "?t" } }],
              ["bind", "?literal", "(isLiteral ?json)"],
              ["bind", "?datatype", "(datatype ?json)"],
              ["bind", "?idLiteral", "(isLiteral ?id)"],
              ["bind", "?idDatatype", "(datatype ?id)"],
              ["bind", "?fromLiteral", "(isLiteral ?from)"],
              ["bind", "?fromDatatype", "(datatype ?from)"],
              ["bind", "?typeIri", "(isIRI ?type)"],
            ],
          })
          .pipe(Effect.flatMap(decode(EntryRows)));
        const row = rows.length === 1 ? rows[0] : undefined;
        const message =
          row?.[3] == null
            ? Option.none()
            : Schema.decodeUnknownOption(MessageJson, { onExcessProperty: "error" })(row[3]);
        if (
          row === undefined ||
          row[1] !== operation ||
          row[4] === null ||
          row[4] < 1 ||
          row[4] > cut.head ||
          row[5] !== true ||
          !stringType(row[6]) ||
          row[7] !== true ||
          !stringType(row[8]) ||
          row[9] !== true ||
          !stringType(row[10]) ||
          row[11] !== true ||
          Option.isNone(message) ||
          message.value.id !== operation ||
          message.value.from !== row[2] ||
          (message.value.kind === "presence" && message.value.presence === undefined) ||
          !messageType(row[0], message.value.kind)
        )
          return { status: "MALFORMED" } as const;
        yield* present(cut);
        return {
          status: "FOUND",
          json: Schema.encodeSync(MessageJson)(message.value),
          t: row[4],
        } as const;
      })
    );

  /** Compare a known canonical presence without returning its potentially unbounded JSON. */
  const knownEntry = (
    message: Message,
    json: string,
    cut: Pin,
    expected?: { slot: string; after: number }
  ) =>
    bounded(
      Effect.gen(function* () {
        yield* present(cut);
        const subject = `urn:agent-bus:message:${message.id}`;
        const rows = yield* transport
          .at(cut.head, {
            "@context": { bus: BUS, xsd: XSD, rdf: RDF },
            select: [
              "?id",
              "?type",
              "?from",
              "?t",
              "?literal",
              "?datatype",
              "?matches",
              "?typeT",
              "?idT",
              "?fromT",
              "?idLiteral",
              "?idDatatype",
              "?fromLiteral",
              "?fromDatatype",
              "?typeIri",
            ],
            values: [["?message", "?expected"], [[iri(subject), literal(json)]]],
            where: [
              [
                "optional",
                { "@id": "?message", "rdf:type": { "@value": "?type", "@t": "?typeT" } },
              ],
              ["optional", { "@id": "?message", "bus:id": { "@value": "?id", "@t": "?idT" } }],
              [
                "optional",
                { "@id": "?message", "bus:from": { "@value": "?from", "@t": "?fromT" } },
              ],
              ["optional", { "@id": "?message", "bus:json": { "@value": "?stored", "@t": "?t" } }],
              ["bind", "?literal", "(isLiteral ?stored)"],
              ["bind", "?datatype", "(datatype ?stored)"],
              ["bind", "?matches", "(= ?stored ?expected)"],
              ["bind", "?idLiteral", "(isLiteral ?id)"],
              ["bind", "?idDatatype", "(datatype ?id)"],
              ["bind", "?fromLiteral", "(isLiteral ?from)"],
              ["bind", "?fromDatatype", "(datatype ?from)"],
              ["bind", "?typeIri", "(isIRI ?type)"],
            ],
          })
          .pipe(Effect.flatMap(decode(KnownRows)));
        const row = rows.length === 1 ? rows[0] : undefined;
        if (row === undefined) return { status: "MALFORMED" } as const;
        if (row[0] === null && row[1] === null && row[2] === null && row[3] === null) {
          const predicates = yield* predicatesAt(subject, cut);
          yield* present(cut);
          return predicates.length === 0
            ? ({ status: "ABSENT" } as const)
            : ({ status: "MALFORMED" } as const);
        }
        if (
          row[0] !== message.id ||
          row[1] === null ||
          row[2] === null ||
          row[3] === null ||
          row[3] < 1 ||
          row[3] > cut.head ||
          row[4] !== true ||
          !stringType(row[5]) ||
          row[6] === null ||
          (row[7] !== null && row[7] !== 0 && row[7] !== row[3]) ||
          row[8] !== row[3] ||
          row[9] !== row[3] ||
          row[10] !== true ||
          !stringType(row[11]) ||
          row[12] !== true ||
          !stringType(row[13]) ||
          row[14] !== true
        )
          return { status: "MALFORMED" } as const;
        if (row[7] === null || row[7] === 0) {
          if (!(yield* effectiveType(subject, row[1], row[3], cut.head)))
            return { status: "MALFORMED" } as const;
        }
        if (row[6]) {
          if (row[2] !== message.from || !messageType(row[1], message.kind)) {
            return { status: "MALFORMED" } as const;
          }
          if (
            message.kind === "presence" &&
            !(yield* transport.ownership.proves(
              message.from,
              message.id,
              row[3],
              cut,
              expected && row[3] > expected.after ? expected.slot : undefined
            ))
          ) {
            return { status: "MALFORMED" } as const;
          }
          yield* present(cut);
          return { status: "SAME", t: row[3] } as const;
        }
        const other = yield* Effect.option(entryAttempt(message.id, cut));
        if (Option.isNone(other) || other.value.status !== "FOUND" || other.value.t !== row[3]) {
          return { status: "MALFORMED" } as const;
        }
        yield* present(cut);
        return { status: "DIFFERENT", t: row[3] } as const;
      })
    );

  /** All predicates on one operation node, so extra values cannot be hidden by a selector. */
  const receiptNode = (operation: string, cut: Pin) =>
    Effect.gen(function* () {
      const rows = yield* transport
        .at(cut.head, {
          "@context": { bus: BUS, xsd: XSD, rdf: RDF },
          select: [
            "?predicate",
            "?object",
            "?type",
            "?json",
            "?t",
            "?literal",
            "?datatype",
            "?typeT",
            "?typeIri",
          ],
          values: [["?receipt"], [[iri(mailboxReceiptIri(operation))]]],
          where: [
            ["optional", { "@id": "?receipt", "?predicate": "?object" }],
            ["optional", { "@id": "?receipt", "rdf:type": { "@value": "?type", "@t": "?typeT" } }],
            [
              "optional",
              { "@id": "?receipt", "bus:mailboxRecord": { "@value": "?json", "@t": "?t" } },
            ],
            ["bind", "?literal", "(isLiteral ?json)"],
            ["bind", "?datatype", "(datatype ?json)"],
            ["bind", "?typeIri", "(isIRI ?type)"],
          ],
        })
        .pipe(Effect.flatMap(decode(ReceiptRows)));
      const first = rows[0];
      if (rows.length === 1 && first?.[0] === null)
        return { status: "ABSENT" } satisfies ReceiptNode;
      if (
        rows.length !== 2 ||
        first === undefined ||
        first[3] === null ||
        first[4] === null ||
        first[5] !== true ||
        !stringType(first[6]) ||
        first[8] !== true ||
        rows.some(
          (row) =>
            row[2] !== first[2] || row[3] !== first[3] || row[4] !== first[4] || row[7] !== first[7]
        )
      )
        return { status: "MALFORMED" } satisfies ReceiptNode;
      const record = decodeMailboxFact(first[3]);
      if (
        Option.isNone(record) ||
        record.value.operation !== operation ||
        !sameType(first[2], record.value.kind) ||
        first[4] > cut.head ||
        !validMailboxFactAt(record.value, first[4], cut.incarnation)
      )
        return { status: "MALFORMED" } satisfies ReceiptNode;
      if (
        first[2] === null ||
        (first[7] !== null && first[7] !== 0 && first[7] !== first[4]) ||
        ((first[7] === null || first[7] === 0) &&
          !(yield* effectiveType(mailboxReceiptIri(operation), first[2], first[4], cut.head)))
      )
        return { status: "MALFORMED" } satisfies ReceiptNode;
      return { status: "FOUND", record: record.value, t: first[4] } satisfies ReceiptNode;
    });

  /** The marker, single pointer and named receipt, at one immutable cut. */
  const headAt = (key: string, cut: Pin) =>
    Effect.gen(function* () {
      const absent: Head = {
        state: { status: "ABSENT" },
        markerT: null,
        pointerT: null,
        operation: null,
      };
      if (cut.head === 0) return absent;
      const rows = yield* transport
        .at(cut.head, {
          select: [
            "?marker",
            "?markerT",
            "?head",
            "?headT",
            "?markerLiteral",
            "?markerDatatype",
            "?headLiteral",
            "?headDatatype",
          ],
          values: [["?mailbox"], [[iri(key)]]],
          where: [
            [
              "optional",
              { "@id": "?mailbox", "bus:mailboxMarker": { "@value": "?marker", "@t": "?markerT" } },
            ],
            [
              "optional",
              { "@id": "?mailbox", "bus:mailboxHead": { "@value": "?head", "@t": "?headT" } },
            ],
            ["bind", "?markerLiteral", "(isLiteral ?marker)"],
            ["bind", "?markerDatatype", "(datatype ?marker)"],
            ["bind", "?headLiteral", "(isLiteral ?head)"],
            ["bind", "?headDatatype", "(datatype ?head)"],
          ],
        })
        .pipe(Effect.flatMap(decode(HeadRows)));
      const row = rows.length === 1 ? rows[0] : undefined;
      if (row === undefined) return yield* invalid();
      if (row[0] === null && row[2] === null) {
        if ((yield* predicatesAt(key, cut)).length !== 0) return yield* invalid();
        return absent;
      }
      if (
        row[0] !== marker ||
        row[1] === null ||
        row[1] < 1 ||
        row[2] === null ||
        row[3] === null ||
        row[3] < row[1] ||
        row[3] > cut.head ||
        row[4] !== true ||
        !stringType(row[5]) ||
        row[6] !== true ||
        !stringType(row[7])
      )
        return yield* invalid();
      const prefix = "urn:agent-bus:mailbox-receipt:";
      const operation = row[2].startsWith(prefix) ? row[2].slice(prefix.length) : "";
      if (!validOperation(operation)) return yield* invalid();
      const receipt = yield* receiptNode(operation, cut);
      if (
        receipt.status !== "FOUND" ||
        receipt.t !== row[3] ||
        receipt.record.mailbox !== key ||
        (receipt.record.previous === null) !== (row[1] === row[3])
      )
        return yield* invalid();
      const current = { record: receipt.record, t: receipt.t };
      const state: MailboxState =
        receipt.record.kind === "unresolved"
          ? { status: "UNRESOLVED", reason: receipt.record.reason, current }
          : {
              status: "FOUND",
              position:
                receipt.record.kind === "start" ? receipt.record.position : receipt.record.through,
              current,
            };
      return { state, markerT: row[1], pointerT: row[3], operation } satisfies Head;
    });

  const mailboxAt = (address: string, cut: Pin) =>
    bounded(
      Effect.gen(function* () {
        yield* present(cut);
        const head = yield* headAt(mailboxIri(address), cut);
        yield* present(cut);
        return head.state;
      })
    );

  const mailboxReceiptAt = (address: string, operation: string, cut: Pin) =>
    bounded(
      Effect.gen(function* () {
        if (!validOperation(operation))
          return { status: "UNAVAILABLE" } satisfies MailboxReceiptRead;
        yield* present(cut);
        if (cut.head === 0) return { status: "ABSENT", cut } satisfies MailboxReceiptRead;
        const receipt = yield* receiptNode(operation, cut);
        if (receipt.status === "MALFORMED")
          return { status: "MALFORMED", cut } satisfies MailboxReceiptRead;
        if (receipt.status === "ABSENT") {
          yield* headAt(mailboxIri(address), cut);
          yield* present(cut);
          return { status: "ABSENT", cut } satisfies MailboxReceiptRead;
        }
        const original = yield* headAt(receipt.record.mailbox, {
          head: receipt.t,
          incarnation: cut.incarnation,
        });
        if (original.operation !== operation || original.pointerT !== receipt.t) {
          return { status: "MALFORMED", cut } satisfies MailboxReceiptRead;
        }
        yield* present(cut);
        if (receipt.record.mailbox !== mailboxIri(address)) {
          return { status: "ADDRESS_MISMATCH", cut } satisfies MailboxReceiptRead;
        }
        return {
          status: "FOUND",
          record: receipt.record,
          t: receipt.t,
          cut,
        } satisfies MailboxReceiptRead;
      })
    ).pipe(
      Effect.catch(() => Effect.succeed({ status: "UNAVAILABLE" } satisfies MailboxReceiptRead))
    );

  const absence = (subject: string, suffix: string) => [
    ["optional", { "@id": subject, [`?${suffix}Predicate`]: `?${suffix}Object` }],
    ["filter", `(not (bound ?${suffix}Object))`],
  ];
  const guard = (address: string, slot: string, prior: Head) => {
    const key = mailboxIri(address);
    const current =
      prior.operation === null
        ? [
            ["optional", { "@id": "?mailbox", "?mailboxPredicate": "?mailboxObject" }],
            ["filter", "(not (bound ?mailboxObject))"],
          ]
        : [
            ["values", ["?fence", [1]]],
            // Keep both assertion times in one independent scan. Indexed transaction joins
            // can otherwise lose the metadata binding of the second matched pattern.
            [
              "minus",
              { "@id": key, "?mailboxProperty": { "@value": "?observed", "@t": "?assertionT" } },
              [
                "filter",
                `(or (and (= ?observed ${JSON.stringify(marker)}) (or (not (bound ?assertionT)) (!= ?assertionT ${prior.markerT}))) (and (= ?observed ${JSON.stringify(mailboxReceiptIri(prior.operation))}) (or (not (bound ?assertionT)) (!= ?assertionT ${prior.pointerT}))))`,
              ],
              ["bind", "?fence", "1"],
            ],
            ["values", ["?expectedMarker", [literal(marker)]]],
            ["values", ["?expectedHead", [literal(mailboxReceiptIri(prior.operation))]]],
            {
              "@id": "?mailbox",
              "bus:mailboxMarker": "?marker",
              "bus:mailboxHead": "?head",
            },
            ["filter", "(and (sameTerm ?marker ?expectedMarker) (sameTerm ?head ?expectedHead))"],
            [
              "optional",
              { "@id": "?mailbox", "bus:mailboxMarker": "?otherMarker" },
              ["filter", "(not (sameTerm ?otherMarker ?expectedMarker))"],
            ],
            ["filter", "(not (bound ?otherMarker))"],
            [
              "optional",
              { "@id": "?mailbox", "bus:mailboxHead": "?otherHead" },
              ["filter", "(not (sameTerm ?otherHead ?expectedHead))"],
            ],
            ["filter", "(not (bound ?otherHead))"],
          ];
    return [["values", ["?mailbox", [iri(key)]]], ...current, ...vacantSuccessor(slot)];
  };
  const update = (
    record: MailboxRecord,
    prior: Head,
    slot: string,
    extra: ReadonlyArray<unknown> = []
  ) => {
    const key = mailboxIri(record.address);
    const receipt = mailboxReceiptIri(record.operation);
    const fact = mailboxFactOf(record, prior.operation);
    return {
      where: [...guard(record.address, slot, prior), ...absence(receipt, "receipt"), ...extra],
      ...(prior.operation === null
        ? {}
        : {
            delete: { "@id": key, "bus:mailboxHead": literal(mailboxReceiptIri(prior.operation)) },
          }),
      insert: [
        {
          "@id": key,
          ...(prior.operation === null ? { "bus:mailboxMarker": literal(marker) } : {}),
          "bus:mailboxHead": literal(receipt),
        },
        {
          "@id": receipt,
          "@type": `bus:Mailbox${recordType(fact.kind)}`,
          "bus:mailboxRecord": literal(encodeMailboxFact(fact)),
        },
      ],
    };
  };
  const checkInput = (record: MailboxRecord, basis: Pin) =>
    Effect.gen(function* () {
      const checked = yield* Schema.decodeUnknownEffect(MailboxRecordSchema, {
        onExcessProperty: "error",
      })(record).pipe(Effect.mapError(invalid));
      if (!validAddress(checked.address))
        return yield* new LedgerError({
          message:
            "Fluree cannot represent an address with an unpaired UTF-16 surrogate; nothing was written.",
        });
      if (
        !validOperation(checked.operation) ||
        basis.incarnation !== transport.instance ||
        (checked.kind !== "unresolved" && checked.run === "")
      )
        return yield* invalid();
      return checked;
    });
  const latest = Effect.gen(function* () {
    const incarnation = yield* transport.incarnation;
    const head = yield* transport.head;
    return { head, incarnation } satisfies Pin;
  });
  const sameHead = (a: Head, b: Head) =>
    a.operation === b.operation && a.markerT === b.markerT && a.pointerT === b.pointerT;

  const writeMailbox = (input: MailboxAck | MailboxStart | MailboxUnresolved, basis: Pin) =>
    Effect.gen(function* () {
      const record = yield* checkInput(input, basis);
      yield* present(basis);
      const current = yield* latest;
      if (current.incarnation !== basis.incarnation) return yield* replaced();
      const existing = yield* mailboxReceiptAt(record.address, record.operation, current);
      if (existing.status === "FOUND")
        return mailboxIntentMatches(record, existing.record)
          ? ({
              status: "APPLIED",
              cut: { head: existing.t, incarnation: current.incarnation },
            } satisfies MailboxWrite)
          : ({ status: "IDENTITY_MISMATCH", cut: current } satisfies MailboxWrite);
      if (existing.status === "ADDRESS_MISMATCH")
        return { status: "IDENTITY_MISMATCH", cut: current } satisfies MailboxWrite;
      if (existing.status !== "ABSENT") return { status: "UNKNOWN" } satisfies MailboxWrite;
      const key = mailboxIri(record.address);
      const prior = yield* headAt(key, basis);
      const now = yield* headAt(key, current);
      if (!sameHead(prior, now)) return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
      if (record.kind === "unresolved") {
        if (prior.state.status !== "ABSENT")
          return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
      } else if (record.kind === "start") {
        if (
          (record.origin !== "import" && record.origin !== "reconcile") ||
          record.position > basis.head ||
          (record.origin === "import" && prior.state.status !== "ABSENT") ||
          (record.origin === "reconcile" && prior.state.status !== "UNRESOLVED")
        )
          return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
      } else if (
        prior.state.status !== "FOUND" ||
        record.from !== prior.state.position ||
        record.dataCut.head > basis.head ||
        record.dataCut.incarnation !== basis.incarnation
      )
        return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
      const fact = mailboxFactOf(record, prior.operation);
      if (!validMailboxFactAt(fact, basis.head + 1, basis.incarnation)) return yield* invalid();
      const slot = yield* transport.ownership.prepare(record.address, basis);
      if (
        current.head !== basis.head &&
        (yield* transport.ownership.prepare(record.address, current)) !== slot
      )
        return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
      const response = yield* Effect.option(transport.update(update(record, prior, slot)));
      return yield* Effect.gen(function* () {
        const answered =
          Option.isSome(response) && response.value >= current.head && response.value > 0;
        const cut = answered
          ? { head: response.value, incarnation: basis.incarnation }
          : yield* latest;
        if (cut.incarnation !== basis.incarnation)
          return { status: "UNKNOWN" } satisfies MailboxWrite;
        const saved = yield* mailboxReceiptAt(record.address, record.operation, cut);
        if (saved.status === "FOUND")
          return mailboxIntentMatches(record, saved.record)
            ? ({
                status: "APPLIED",
                cut: { head: saved.t, incarnation: cut.incarnation },
              } satisfies MailboxWrite)
            : ({ status: "IDENTITY_MISMATCH", cut } satisfies MailboxWrite);
        if (saved.status === "ADDRESS_MISMATCH")
          return { status: "IDENTITY_MISMATCH", cut } satisfies MailboxWrite;
        if (saved.status === "ABSENT" && answered)
          return { status: "CONFLICT", cut } satisfies MailboxWrite;
        return { status: "UNKNOWN" } satisfies MailboxWrite;
      }).pipe(Effect.catch(() => Effect.succeed({ status: "UNKNOWN" } satisfies MailboxWrite)));
    }).pipe(
      Effect.timeoutOrElse({
        duration: transport.timeout,
        orElse: () => Effect.succeed({ status: "UNKNOWN" } satisfies MailboxWrite),
      })
    );

  const admitWithStart = (message: Message, input: MailboxStart, basis: Pin) =>
    Effect.gen(function* () {
      if (
        input.origin === "import" ||
        input.origin === "reconcile" ||
        message.kind !== "presence" ||
        message.presence?.status !== "joined" ||
        message.from !== input.address ||
        message.id !== input.operation ||
        (message.presence.rejoinOf ?? message.id) !== input.run
      )
        return yield* invalid();
      yield* storable(message);
      const start = yield* checkInput(input, basis);
      if (start.kind !== "start") return yield* invalid();
      const messageJson = yield* Schema.encodeEffect(MessageJson)(message).pipe(
        Effect.mapError(invalid)
      );
      yield* present(basis);
      const current = yield* latest;
      if (current.incarnation !== basis.incarnation) return yield* replaced();
      const existing = yield* mailboxReceiptAt(start.address, start.operation, current);
      if (existing.status === "ADDRESS_MISMATCH")
        return { status: "REFUSED", cut: current } satisfies Admission;
      if (existing.status === "MALFORMED" || existing.status === "UNAVAILABLE")
        return { status: "UNKNOWN" } satisfies Admission;
      if (existing.status === "FOUND" && !mailboxIntentMatches(start, existing.record))
        return { status: "REFUSED", cut: current } satisfies Admission;
      // A retry can follow later holdings. Its old presence is evidence of the original
      // operation, never of present authority. Use its own basis when proving the old slot.
      const expected =
        existing.status === "FOUND" && existing.t > basis.head
          ? { slot: yield* transport.ownership.prepare(message.from, basis), after: basis.head }
          : undefined;
      const attempted = yield* Effect.option(knownEntry(message, messageJson, current, expected));
      if (Option.isNone(attempted)) return { status: "UNKNOWN" } satisfies Admission;
      const attempt = attempted.value;
      if (existing.status === "FOUND") {
        if (attempt.status === "DIFFERENT" && attempt.t === existing.t)
          return { status: "REFUSED", cut: current } satisfies Admission;
        if (attempt.status !== "SAME" || attempt.t !== existing.t)
          return { status: "UNKNOWN" } satisfies Admission;
        return {
          status: "ADMITTED",
          cut: { head: existing.t, incarnation: current.incarnation },
        } satisfies Admission;
      }
      if (attempt.status === "MALFORMED") return { status: "UNKNOWN" } satisfies Admission;
      if (attempt.status !== "ABSENT")
        return { status: "REFUSED", cut: current } satisfies Admission;
      if (start.position > basis.head) return yield* invalid();
      const key = mailboxIri(start.address);
      const prior = yield* headAt(key, basis);
      if (
        (start.origin === "restart" &&
          (prior.state.status !== "UNRESOLVED" || start.position !== basis.head)) ||
        (start.origin !== "restart" && prior.state.status === "UNRESOLVED")
      )
        return { status: "REFUSED", cut: basis } satisfies Admission;
      const now = yield* headAt(key, current);
      if (!sameHead(prior, now)) return { status: "REFUSED", cut: current } satisfies Admission;
      const fact = mailboxFactOf(start, prior.operation);
      if (!validMailboxFactAt(fact, basis.head + 1, basis.incarnation)) return yield* invalid();
      yield* present(basis);
      const slot = yield* transport.ownership.prepare(message.from, basis);
      if (
        current.head !== basis.head &&
        (yield* transport.ownership.prepare(message.from, current)) !== slot
      )
        return { status: "REFUSED", cut: current } satisfies Admission;
      const transaction = update(
        start,
        prior,
        slot,
        absence(`urn:agent-bus:message:${message.id}`, "message")
      );
      const response = yield* Effect.option(
        transport.update({
          ...transaction,
          insert: [
            { ...transport.messageNode(message, messageJson), ...predecessor(slot) },
            successor(slot, message.id),
            ...transaction.insert,
          ],
        })
      );
      return yield* Effect.gen(function* () {
        const answered =
          Option.isSome(response) && response.value >= current.head && response.value > 0;
        const cut = answered
          ? { head: response.value, incarnation: basis.incarnation }
          : yield* latest;
        if (cut.incarnation !== basis.incarnation) return { status: "UNKNOWN" } satisfies Admission;
        const receipt = yield* mailboxReceiptAt(start.address, start.operation, cut);
        const stored = yield* knownEntry(message, messageJson, cut, { slot, after: basis.head });
        if ((yield* transport.incarnation) !== cut.incarnation)
          return { status: "UNKNOWN" } satisfies Admission;
        if (receipt.status === "ADDRESS_MISMATCH")
          return { status: "REFUSED", cut } satisfies Admission;
        if (receipt.status === "FOUND" && !mailboxIntentMatches(start, receipt.record))
          return { status: "REFUSED", cut } satisfies Admission;
        if (receipt.status === "FOUND" && stored.status === "DIFFERENT" && stored.t === receipt.t)
          return { status: "REFUSED", cut } satisfies Admission;
        if (receipt.status === "FOUND" && stored.status === "SAME" && stored.t === receipt.t)
          return {
            status: "ADMITTED",
            cut: { head: receipt.t, incarnation: cut.incarnation },
          } satisfies Admission;
        if (
          receipt.status === "ABSENT" &&
          (stored.status === "SAME" ||
            stored.status === "DIFFERENT" ||
            (stored.status === "ABSENT" && answered))
        )
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
    knownEntry,
    admitWithStart,
    classifyMailboxImport: (unresolved: MailboxUnresolved, basis: Pin) =>
      writeMailbox(unresolved, basis),
    importMailbox: (start: MailboxStart, basis: Pin) => writeMailbox(start, basis),
    appendMailboxAck: (ack: MailboxAck, basis: Pin) => writeMailbox(ack, basis),
  };
};
