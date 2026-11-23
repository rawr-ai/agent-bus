import { Effect, Schema } from "effect";
import { LedgerError } from "./domain.ts";
import { ownershipEra } from "./FlureePresence.ts";
import type {
  OwnershipActivation,
  OwnershipActivationLookup,
  OwnershipActivationProof,
  OwnershipActivationResult,
} from "./Ledger.ts";
import type { Pin } from "./Query.ts";

type IO<A> = Effect.Effect<A, LedgerError>;
type Query = Readonly<Record<string, unknown>>;
interface ReadStore {
  readonly tip: IO<{ readonly t: number; readonly id: string }>;
  readonly commitAt: (
    t: number
  ) => IO<{ readonly id: string; readonly t: number; readonly parents?: ReadonlyArray<string> }>;
  readonly incarnation: IO<string>;
  readonly at: (t: number, query: Query) => IO<unknown>;
  readonly history: (from: number, through: number, query: Query) => IO<unknown>;
  readonly eraAt: (cut: Pin) => IO<number>;
}
const subject = ownershipEra["@id"];
const property = "bus:ownershipActivation";
const unknown = { status: "UNKNOWN" } as const;
const invalid = () =>
  new LedgerError({ message: "Cannot establish the ownership activation receipt." });
const predicates = (historical: boolean) => ({
  select: "?p",
  where: {
    "@id": subject,
    "?p": { "@value": "?v", ...(historical ? { "@op": "?asserted" } : {}) },
  },
  limit: 3,
});
const Strings = Schema.Array(Schema.String);
const Receipt = Schema.Array(
  Schema.Tuple([Schema.String, Schema.Int, Schema.Boolean, Schema.String])
);

const validLookup = ({ source, operation }: OwnershipActivationLookup) =>
  Number.isSafeInteger(source.head) &&
  source.head >= 1 &&
  source.head < Number.MAX_SAFE_INTEGER &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operation);
const activationRecord = ({ source, operation, commit }: OwnershipActivation) =>
  JSON.stringify([operation, source.incarnation, source.head, commit]);

export const makeOwnershipActivationReader = (store: ReadStore, instance: string) => {
  const inspect = (intent: OwnershipActivation) =>
    Effect.gen(function* () {
      const { source, commit } = intent;
      if ((yield* store.incarnation) !== instance) return unknown;
      const tip = yield* store.tip;
      const cut = { incarnation: instance, head: tip.t };
      const conflict = { status: "CONFLICT", cut } as const;
      if (
        source.incarnation !== instance ||
        source.head > tip.t ||
        (tip.t === source.head && tip.id !== commit)
      )
        return conflict;
      const now = yield* store
        .at(tip.t, predicates(false))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Strings)), Effect.mapError(invalid));
      const history = yield* store
        .history(1, tip.t, predicates(true))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Strings)), Effect.mapError(invalid));
      if (!now.length && !history.length)
        return tip.t === source.head ? ({ status: "VACANT", cut } as const) : conflict;
      const era = yield* store.eraAt(cut);
      if (era === 1 && now.length === 1 && history.length === 1) return conflict;
      if (now.length !== 2 || history.length !== 2) return unknown;
      const rows = yield* store
        .at(tip.t, {
          select: ["?v", "?t", "?literal", "?datatype"],
          where: [
            { "@id": subject, [property]: { "@value": "?v", "@t": "?t" } },
            ["bind", "?literal", "(isLiteral ?v)"],
            ["bind", "?datatype", "(datatype ?v)"],
          ],
          limit: 2,
        })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Receipt)), Effect.mapError(invalid));
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row[1] !== era ||
        !row[2] ||
        (row[3] !== "xsd:string" && row[3] !== "http://www.w3.org/2001/XMLSchema#string")
      )
        return unknown;
      if (row[0] !== activationRecord(intent)) return conflict;
      if (era !== source.head + 1) return unknown;
      const native = yield* store.commitAt(era);
      if (
        !native.id ||
        native.t !== era ||
        native.parents?.length !== 1 ||
        native.parents[0] !== commit
      )
        return unknown;
      return {
        status: "ALREADY_APPLIED",
        cut: { incarnation: instance, head: era },
        commit: native.id,
      } as const;
    }).pipe(
      Effect.flatMap((result) =>
        Effect.map(store.incarnation, (id) => (id === instance ? result : unknown))
      )
    );
  const proofAt = (lookup: OwnershipActivationLookup): IO<OwnershipActivationProof> =>
    Effect.gen(function* () {
      if (
        !validLookup(lookup) ||
        lookup.source.incarnation !== instance ||
        (yield* store.incarnation) !== instance
      )
        return yield* invalid();
      // H=1 has no parent. The receipt needs H's own CID and E's single edge back to it.
      const source = yield* store.commitAt(lookup.source.head);
      if (
        source.t !== lookup.source.head ||
        !source.id ||
        (source.t === 1 && source.id !== instance)
      )
        return yield* invalid();
      const found = yield* inspect({ ...lookup, commit: source.id });
      if (found.status !== "ALREADY_APPLIED") return yield* invalid();
      return { cut: found.cut, commit: found.commit, sourceCommit: source.id };
    });
  return { inspect, proofAt };
};

/** The operator excludes every other writer; Fluree's conditional update guards the era node, not global head. */
export const makeOwnershipActivation =
  (
    inspect: ReturnType<typeof makeOwnershipActivationReader>["inspect"],
    update: (body: Query) => IO<number>
  ) =>
  (intent: OwnershipActivation): IO<OwnershipActivationResult> => {
    if (!validLookup(intent) || !intent.commit) {
      return Effect.fail(new LedgerError({ message: "Invalid ownership activation intent." }));
    }
    return Effect.gen(function* () {
      const before = yield* inspect(intent);
      if (before.status !== "VACANT") return before;
      // One dispatch. Even a successful HTTP response is not a receipt; only re-observe the same intent.
      yield* update({
        where: [
          ["optional", { "@id": subject, "?occupied": "?object" }],
          ["filter", "(not (bound ?object))"],
        ],
        insert: {
          ...ownershipEra,
          [property]: { "@value": activationRecord(intent), "@type": "xsd:string" },
        },
      }).pipe(Effect.ignore);
      const after = yield* inspect(intent);
      if (after.status === "ALREADY_APPLIED") return { ...after, status: "APPLIED" } as const;
      return after.status === "VACANT" ? unknown : after;
    }).pipe(Effect.catch(() => Effect.succeed(unknown)));
  };
