import { Effect, Schema } from "effect";
import { LedgerError } from "./domain.ts";
import { messageIri } from "./Ledger.ts";
import type { Pin } from "./Query.ts";

type Query = Readonly<Record<string, unknown>>;
type IO<A> = Effect.Effect<A, LedgerError>;
const invalid = () =>
  new LedgerError({
    message:
      "The ledger ownership fence is missing or inconsistent; no new write can be authorized.",
  });
const eraSubject = "urn:agent-bus:ownership-era";
const string = (value: string) => ({ "@value": value, "@type": "xsd:string" });
export const ownershipEra = { "@id": eraSubject, "bus:presenceEra": string("successor-1") };
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const slotPrefix = (address: string) =>
  `urn:agent-bus:presence-slot:${hash(JSON.stringify(address))}:`;
const slot = (address: string, prior: string | null) =>
  slotPrefix(address) + hash(JSON.stringify(prior));
export const vacantSuccessor = (subject: string) => [
  ownershipEra,
  ["optional", { "@id": subject, "?slotPredicate": "?slotObject" }],
  ["filter", "(not (bound ?slotObject))"],
];
export const successor = (subject: string, operation: string) => ({
  "@id": subject,
  "bus:presenceSuccessor": string(hash(JSON.stringify(operation))),
});
export const predecessor = (subject: string) => ({ "bus:presencePredecessor": string(subject) });
export interface Transition {
  readonly id: string;
  readonly previous: string | null;
  readonly t: number;
}
export interface Ownership {
  readonly prepare: (address: string, basis: Pin) => IO<string>;
  readonly proves: (
    address: string,
    id: string,
    t: number,
    cut: Pin,
    expected?: string
  ) => IO<boolean>;
}
const Rows = Schema.Array(Schema.Tuple([Schema.String, Schema.Int, Schema.Boolean, Schema.String]));
export const makeOwnership = (
  at: (head: number, query: Query) => IO<unknown>,
  history: (from: number, through: number, query: Query) => IO<unknown>,
  transition: (address: string, basis: Pin) => IO<Transition | undefined>
): Ownership => {
  const term = (subject: string, property: string, cut: Pin) =>
    Effect.gen(function* () {
      const rows = yield* at(cut.head, {
        select: ["?value", "?t", "?literal", "?datatype"],
        where: [
          { "@id": subject, [property]: { "@value": "?value", "@t": "?t" } },
          ["bind", "?literal", "(isLiteral ?value)"],
          ["bind", "?datatype", "(datatype ?value)"],
        ],
        limit: 2,
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)), Effect.mapError(invalid));
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        !row[2] ||
        (row[3] !== "xsd:string" && row[3] !== "http://www.w3.org/2001/XMLSchema#string") ||
        row[1] < 1 ||
        row[1] > cut.head
      )
        return yield* invalid();
      return { value: row[0], t: row[1] };
    });
  let originalEra: number | undefined;
  const eraAt = (cut: Pin) =>
    Effect.gen(function* () {
      // The layer is scoped to one incarnation. After establishing the unique original
      // assertion, pin future checks to its exact term and assertion commit.
      if (originalEra !== undefined) {
        const current = yield* term(eraSubject, "bus:presenceEra", cut);
        if (current.value !== "successor-1" || current.t !== originalEra) return yield* invalid();
        return originalEra;
      }
      // A reassertion must not move the cut forward and grandfather a bypassed writer.
      const rows = yield* history(1, cut.head, {
        select: ["?value", "?t", "?asserted", "?datatype"],
        where: [
          {
            "@id": eraSubject,
            "bus:presenceEra": { "@value": "?value", "@t": "?t", "@op": "?asserted" },
          },
          ["bind", "?datatype", "(datatype ?value)"],
        ],
        limit: 2,
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)), Effect.mapError(invalid));
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row[0] !== "successor-1" ||
        row[1] < 1 ||
        row[1] > cut.head ||
        row[2] !== true ||
        (row[3] !== "xsd:string" && row[3] !== "http://www.w3.org/2001/XMLSchema#string")
      )
        return yield* invalid();
      originalEra = row[1];
      return row[1];
    });
  const matchesEdge: Ownership["proves"] = (address, id, t, cut, expected) =>
    Effect.gen(function* () {
      const link = yield* term(messageIri(id), "bus:presencePredecessor", cut);
      if (
        link.t !== t ||
        !link.value.startsWith(slotPrefix(address)) ||
        !/^[0-9a-f]{64}$/.test(link.value.slice(slotPrefix(address).length)) ||
        (expected !== undefined && link.value !== expected)
      )
        return false;
      const edge = yield* term(link.value, "bus:presenceSuccessor", cut);
      return edge.value === hash(JSON.stringify(id)) && edge.t === t;
    });
  return {
    proves: (address, id, t, cut, expected) =>
      Effect.gen(function* () {
        if (t <= (yield* eraAt(cut))) return false;
        return yield* matchesEdge(address, id, t, cut, expected);
      }),
    prepare: (address, basis) =>
      Effect.gen(function* () {
        const era = yield* eraAt(basis);
        const last = yield* transition(address, basis);
        if (last?.t === era) return yield* invalid();
        if (
          last &&
          last.t > era &&
          !(yield* matchesEdge(address, last.id, last.t, basis, slot(address, last.previous)))
        ) {
          return yield* invalid();
        }
        return slot(address, last?.id ?? null);
      }),
  };
};
