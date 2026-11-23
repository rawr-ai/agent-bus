import { Effect, Schema } from "effect";
import { LedgerError } from "./domain.ts";
import { ownershipEra } from "./FlureePresence.ts";
import type { OwnershipActivation, OwnershipActivationResult } from "./Ledger.ts";
import type { Pin } from "./Query.ts";

type IO<A> = Effect.Effect<A, LedgerError>;
type Query = Readonly<Record<string, unknown>>;
interface Store {
  readonly tip: IO<{ readonly t: number; readonly id: string }>;
  readonly commitAt: (
    t: number
  ) => IO<{ readonly id: string; readonly t: number; readonly parents: readonly [string] }>;
  readonly incarnation: IO<string>;
  readonly at: (t: number, query: Query) => IO<unknown>;
  readonly history: (from: number, through: number, query: Query) => IO<unknown>;
  readonly eraAt: (cut: Pin) => IO<number>;
  readonly update: (body: Query) => IO<number>;
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

/** The operator excludes every other writer; Fluree's conditional update guards the era node, not global head. */
export const makeOwnershipActivation =
  (store: Store, instance: string) =>
  (intent: OwnershipActivation): IO<OwnershipActivationResult> => {
    const { source, commit, operation } = intent;
    if (
      !Number.isSafeInteger(source.head) ||
      source.head < 1 ||
      source.head >= Number.MAX_SAFE_INTEGER ||
      !commit ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operation)
    ) {
      return Effect.fail(new LedgerError({ message: "Invalid ownership activation intent." }));
    }
    const record = JSON.stringify([operation, source.incarnation, source.head, commit]);
    const inspect = Effect.gen(function* () {
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
      if (row[0] !== record) return conflict;
      if (era !== source.head + 1) return unknown;
      const native = yield* store.commitAt(era);
      if (!native.id || native.t !== era || native.parents[0] !== commit) return unknown;
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
    return Effect.gen(function* () {
      const before = yield* inspect;
      if (before.status !== "VACANT") return before;
      // One dispatch. Even a successful HTTP response is not a receipt; only re-observe the same intent.
      yield* store
        .update({
          where: [
            ["optional", { "@id": subject, "?occupied": "?object" }],
            ["filter", "(not (bound ?object))"],
          ],
          insert: { ...ownershipEra, [property]: { "@value": record, "@type": "xsd:string" } },
        })
        .pipe(Effect.ignore);
      const after = yield* inspect;
      if (after.status === "ALREADY_APPLIED") return { ...after, status: "APPLIED" } as const;
      return after.status === "VACANT" ? unknown : after;
    }).pipe(Effect.catch(() => Effect.succeed(unknown)));
  };
