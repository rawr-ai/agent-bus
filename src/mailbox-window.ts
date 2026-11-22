import { Effect, Schema } from "effect";
import type { LocatedPresence } from "./activity-read.ts";
import { LedgerError, type Message } from "./domain.ts";
import { type LocatedSlice, messageIri } from "./Ledger.ts";

type IO<A> = Effect.Effect<A, LedgerError>;
type Body = Record<string, unknown>;
const Rows = Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.Int]));
const Slots = Schema.Array(Schema.Tuple([Schema.String, Schema.Int]));
const where = [{ "@id": "?m", "bus:json": { "@value": "?json", "@t": "?t", "@op": true } }];
const select = ["?m", "?json", "?t"];
const invalid = () =>
  new LedgerError({ message: "The mailbox carrier inventory is inconsistent." });
const key = (subject: string, t: number) => JSON.stringify([subject, t]);

/** Every asserted carrier in a history window, including nonmail and damaged candidates. */
export const mailboxWindow = (
  start: number,
  stop: number,
  history: (body: Body) => IO<unknown>,
  overflow: LedgerError,
  presences: (subjects: ReadonlyArray<string>) => IO<ReadonlyArray<LocatedPresence>>,
  decodeMessage: (text: string, t: number) => IO<Message>
) => {
  const rows = (body: Body) =>
    history(body).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
      Effect.catchTag("SchemaError", () => Effect.fail(invalid()))
    );
  const decoded = (raw: typeof Rows.Type) =>
    Effect.forEach(raw, ([subject, json, end]) =>
      end < start || end > stop
        ? Effect.fail(invalid())
        : Effect.map(decodeMessage(json, end), (message) => ({ subject, end, message }))
    );
  return rows({ select, where }).pipe(
    Effect.flatMap(decoded),
    Effect.catchIf(
      (error) => error === overflow,
      () =>
        Effect.gen(function* () {
          // A non-distinct inventory retains multiplicity. A validated snapshot presence whose
          // *JSON assertion* has this exact subject and t can replace only the single such flake:
          // it is the very value decoded by the presence read, not a re-encoding of that value.
          const inventory = yield* history({ select: ["?m", "?t"], where }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Slots)),
            Effect.catchTag("SchemaError", () => Effect.fail(invalid()))
          );
          const slots = new Map<string, { subject: string; end: number; count: number }>();
          for (const [subject, end] of inventory) {
            if (end < start || end > stop) return yield* invalid();
            const k = key(subject, end);
            const slot = slots.get(k);
            if (slot === undefined) slots.set(k, { subject, end, count: 1 });
            else slot.count++;
          }
          if (slots.size === 0) return yield* invalid();
          const proof = yield* presences([...new Set(inventory.map(([subject]) => subject))]);
          const entries: Array<LocatedSlice["entries"][number]> = [];
          for (const { subject, entryT, message } of proof) {
            if (
              entryT === null ||
              message.kind !== "presence" ||
              message.presence === undefined ||
              subject !== messageIri(message.id)
            )
              continue;
            const k = key(subject, entryT);
            if (slots.get(k)?.count !== 1) continue;
            entries.push({ subject, end: entryT, message });
            slots.delete(k);
          }
          if (entries.length === 0) return yield* overflow;
          if (slots.size === 0) return entries;
          // One bounded response for all unproved rows, including duplicates. Do not turn the
          // budget into unlimited pages of arbitrary mail. Reconcile it against the inventory.
          const remainder = yield* rows({
            select,
            values: [
              ["?m", "?wantedT"],
              [...slots.values()].map(({ subject, end }) => [
                { "@value": subject, "@type": "@id" },
                end,
              ]),
            ],
            where: [...where, ["filter", "(= ?t ?wantedT)"]],
          });
          for (const [subject, , end] of remainder) {
            const k = key(subject, end);
            const slot = slots.get(k);
            if (slot === undefined) return yield* invalid();
            if (--slot.count === 0) slots.delete(k);
          }
          if (slots.size !== 0) return yield* invalid();
          for (const entry of yield* decoded(remainder)) entries.push(entry);
          return entries;
        })
    )
  );
};
