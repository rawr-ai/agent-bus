import { Effect } from "effect";
import type { LedgerError } from "./domain.ts";
import type { MailboxCandidate } from "./Ledger.ts";

type IO<A> = Effect.Effect<A, LedgerError>;
type TypeRow = readonly [subject: string, t: number, asserted: boolean];
type RouteRow = readonly [
  subject: string,
  p: string,
  value: unknown,
  t: number,
  asserted: boolean,
  datatype: unknown,
];
type Candidate = {
  subject: string;
  end: number;
  routing?: NonNullable<MailboxCandidate["routing"]>;
};
const SUBJECT_BATCH = 100;

const routeOf = (end: number, rows: ReadonlyArray<RouteRow>) => {
  let id: string | undefined;
  let from: string | undefined;
  const to: Array<string> = [];
  for (const [, p, value, t, asserted, datatype] of rows) {
    if (
      !asserted ||
      t !== end ||
      typeof value !== "string" ||
      (datatype !== "xsd:string" && datatype !== "http://www.w3.org/2001/XMLSchema#string")
    )
      return undefined;
    switch (p) {
      case "bus:id":
      case "https://rawr.ai/ns/agent-bus#id":
        if (id !== undefined) return undefined;
        id = value;
        break;
      case "bus:from":
      case "https://rawr.ai/ns/agent-bus#from":
        if (from !== undefined) return undefined;
        from = value;
        break;
      case "bus:to":
      case "https://rawr.ai/ns/agent-bus#to":
        to.push(value);
        break;
      default:
        return undefined;
    }
  }
  return id !== undefined && from !== undefined ? { id, from, to } : undefined;
};

/** Every type candidate needs its routing history from the start of its window through the
 * final cut. Sparse histories need fewer requests by subject; dense ones by commit window. */
export const scanMailboxCandidates = (
  from: number,
  head: number,
  windowSize: number,
  types: (start: number, stop: number) => IO<ReadonlyArray<TypeRow>>,
  routes: (
    start: number,
    stop: number,
    subjects?: ReadonlyArray<string>
  ) => IO<ReadonlyArray<RouteRow>>,
  overflow: LedgerError,
  invalid: () => LedgerError
) =>
  Effect.gen(function* () {
    const windows = new Map<number, ReadonlyArray<TypeRow>>();
    let batches = 0;
    let first = head + 1;
    for (let start = from + 1; start <= head; start += windowSize) {
      const stop = Math.min(head, start + windowSize - 1);
      const typed = yield* types(start, stop);
      if (typed.length === 0) continue;
      if (typed.some(([, end]) => end < start || end > stop)) return yield* invalid();
      first = Math.min(first, start);
      batches += Math.ceil(new Set(typed.map(([subject]) => subject)).size / SUBJECT_BATCH);
      windows.set(start, typed);
    }
    const sweep = head - from > windowSize && batches >= Math.ceil((head - first + 1) / windowSize);
    const candidates: Array<Candidate> = [];
    const watching = new Map<string, Array<Candidate>>();
    for (let start = first; start <= head; start += windowSize) {
      const stop = sweep ? Math.min(head, start + windowSize - 1) : head;
      const typed = windows.get(start) ?? [];
      const current = new Map<string, Array<RouteRow>>();
      for (const [subject] of typed) current.set(subject, []);
      if (!current.size && !watching.size) continue;
      const collect = (rows: ReadonlyArray<RouteRow>) =>
        Effect.gen(function* () {
          for (const row of rows) {
            const [subject, , , t] = row;
            if (t < start || t > stop) return yield* invalid();
            // Any routing assertion or retraction after an earlier type's window breaks its proof,
            // including removing and restoring the identical value. Do not move damage to this t.
            const earlier = watching.get(subject);
            if (earlier !== undefined) {
              for (const candidate of earlier) delete candidate.routing;
              watching.delete(subject);
            }
            current.get(subject)?.push(row);
          }
        });
      const selective = Effect.gen(function* () {
        const subjects = [...new Set([...watching.keys(), ...current.keys()])];
        for (let offset = 0; offset < subjects.length; offset += SUBJECT_BATCH) {
          yield* collect(
            yield* routes(start, stop, subjects.slice(offset, offset + SUBJECT_BATCH))
          );
        }
      });
      if (!sweep || watching.size + current.size <= SUBJECT_BATCH) {
        yield* selective;
      } else {
        // Dense, long histories need one bounded routing response per window. Unrelated subjects
        // cannot become candidates; if they exhaust this response, use bounded subject batches.
        yield* routes(start, stop).pipe(
          Effect.flatMap(collect),
          Effect.catchIf(
            (error) => error === overflow,
            () => selective
          )
        );
      }
      for (const [subject, end, asserted] of typed) {
        const candidate: Candidate = { subject, end };
        const rows = current.get(subject);
        const routing = asserted && rows !== undefined ? routeOf(end, rows) : undefined;
        if (routing !== undefined) {
          candidate.routing = routing;
          if (sweep) {
            const earlier = watching.get(subject) ?? [];
            earlier.push(candidate);
            watching.set(subject, earlier);
          }
        }
        candidates.push(candidate);
      }
    }
    return candidates;
  });
