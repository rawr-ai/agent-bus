import { randomBytes } from "node:crypto";
import { Clock, Context, Effect, Option } from "effect";
import { QueryCapacity } from "./domain.ts";

/**
 * Ranked search's selections. Fluree scores full text from statistics that a pinned `t` does not
 * fix, so a ranking evaluated again for a later page can reorder and repeat or omit matches. A
 * search therefore evaluates its ranking once per traversal and keeps only what that evaluation
 * decided: which entries matched, in what order, with what score, through which subjects.
 * Everything else is immutable at `t` and re-read for each page. No message body is kept.
 *
 * A selection that serves more than one call is held by the serving process until its absolute
 * expiry, final page included, so any cursor it issued can be passed again for the same page until
 * then; repeating the first request starts a new evaluation. A process restart, expiry or ledger
 * replacement ends it; continuing then means starting a new search.
 */

/** One entry as the ranking selected it. */
export interface Selected {
  /** The commit of the entry's bus:id. */
  readonly t: number;
  readonly id: string;
  /** The best score of its rows in the one evaluation. */
  readonly score: number;
  /** Every typed node that formed the entry, exactly as Fluree returned them. */
  readonly subjects: ReadonlyArray<string>;
}

/** A traversal's ranking: its entries in order, and whether matches ranked below them were cut. */
export interface Selection {
  readonly entries: ReadonlyArray<Selected>;
  readonly truncated: boolean;
}

/** What a retained selection was evaluated for; a cursor must name the same. */
export interface Binding {
  readonly incarnation: string;
  readonly t: number;
  /** The hash of the normalized arguments, without the page size. */
  readonly hash: string;
  /** The page size. */
  readonly size: number;
}

export interface Retained extends Selection, Binding {
  readonly handle: string;
  /** Epoch milliseconds from which the handle is no longer found. */
  readonly expiresAt: number;
}

export interface Policy {
  /** The most entries one selection keeps; matches ranked below them are cut. */
  readonly entries: number;
  /** The most subjects across one selection's entries. */
  readonly subjects: number;
  /** The most descriptor bytes (see `descriptorBytes`) in one selection. */
  readonly bytes: number;
  /** The most descriptor bytes across every selection held at once. */
  readonly totalBytes: number;
  /** The most selections held at once, however small. */
  readonly records: number;
  readonly ttlMillis: number;
}

/**
 * A process's selections: about a quarter of a megabyte each, 32 megabytes and 128 selections in
 * all. A viewer refreshing every 15 seconds and abandoning two traversals each time holds 80 at
 * most, leaving room for others.
 */
export const PROCESS_POLICY: Policy = {
  entries: 1_000,
  subjects: 2_000,
  bytes: 256 * 1024,
  totalBytes: 32 * 1024 * 1024,
  records: 128,
  ttlMillis: 10 * 60 * 1000,
};

/** The most descriptor bytes one call-scoped selection holds, however many entries it asks for. */
const CALL_BYTES = 4 * 1024 * 1024;

/** An accounting of a selection's size: UTF-8 of each id and subject, plus 24 per entry. */
export const descriptorBytes = (entries: ReadonlyArray<Selected>) =>
  entries.reduce(
    (sum, entry) =>
      sum +
      24 +
      Buffer.byteLength(entry.id, "utf8") +
      entry.subjects.reduce((bytes, subject) => bytes + Buffer.byteLength(subject, "utf8"), 0),
    0
  );

/** The length of every handle: 16 random bytes in base64url. */
export const HANDLE_LENGTH = 22;

export class RankedSelections extends Context.Service<
  RankedSelections,
  {
    readonly policy: Policy;
    /**
     * Holds a selection for later pages. Checking room and inserting happen in one step, so
     * concurrent admissions never exceed the total. Refused when there is no room.
     */
    readonly admit: (
      selection: Selection,
      binding: Binding
    ) => Effect.Effect<Retained, QueryCapacity>;
    /** The selection a handle names, while it has not expired. */
    readonly lookup: (handle: string) => Effect.Effect<Option.Option<Retained>>;
  }
>()("agent-bus/RankedSelections") {}

/** Refuses a selection over its own bounds, before any page or cursor is shown. */
export const checkBounds = (policy: Policy, entries: ReadonlyArray<Selected>) => {
  const subjects = entries.reduce((sum, entry) => sum + entry.subjects.length, 0);
  if (
    entries.length > policy.entries ||
    subjects > policy.subjects ||
    descriptorBytes(entries) > policy.bytes
  ) {
    return Effect.fail(
      new QueryCapacity({
        selectionTooLarge: true,
        message: `This search's ranking is larger than one search may hold (${policy.entries} entries, ${policy.subjects} subjects, ${policy.bytes} bytes); narrow the search.`,
      })
    );
  }
  return Effect.void;
};

/** A store of selections under one policy. Expiry is checked when a store is used. */
export const make = (policy: Policy) =>
  Effect.sync(() => {
    const held = new Map<string, Retained>();
    let total = 0;
    const sweep = (now: number) => {
      for (const [handle, record] of held) {
        if (record.expiresAt <= now) {
          held.delete(handle);
          total -= descriptorBytes(record.entries);
        }
      }
    };
    return RankedSelections.of({
      policy,
      admit: (selection, binding) =>
        // Within its own bounds first, so the room check below always has a record to name.
        Effect.andThen(checkBounds(policy, selection.entries), Clock.currentTimeMillis).pipe(
          Effect.flatMap((now) =>
            Effect.suspend(() => {
              sweep(now);
              const bytes = descriptorBytes(selection.entries);
              if (held.size >= policy.records || total + bytes > policy.totalBytes) {
                const earliest = Math.min(...[...held.values()].map((record) => record.expiresAt));
                return Effect.fail(
                  new QueryCapacity({
                    message: `The bus is holding as many ranked searches as it can; this search needs more than one page. Retry after ${new Date(earliest).toISOString()}, or narrow the search.`,
                  })
                );
              }
              const record: Retained = {
                ...selection,
                ...binding,
                handle: randomBytes(16).toString("base64url"),
                expiresAt: now + policy.ttlMillis,
              };
              held.set(record.handle, record);
              total += bytes;
              return Effect.succeed(record);
            })
          )
        ),
      lookup: (handle) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          sweep(now);
          return Option.fromUndefinedOr(held.get(handle));
        }),
    });
  });

/**
 * The most entries one call-scoped selection keeps, however many a call wants: the ranking query
 * asks for one more, so no request can make it larger.
 */
export const CALL_ENTRIES = 10_000;

/**
 * A store for one call that pages a search to `wanted` matches itself (bus_history): it never
 * outlives the call, so it has no expiry or shared total, and its selection may hold `wanted`
 * entries, up to CALL_ENTRIES and within a fixed byte bound.
 */
export const callScoped = (wanted: number) => {
  const entries = Math.min(Math.max(PROCESS_POLICY.entries, wanted), CALL_ENTRIES);
  return make({
    entries,
    subjects: 2 * entries,
    bytes: CALL_BYTES,
    totalBytes: CALL_BYTES,
    records: 1,
    ttlMillis: Number.POSITIVE_INFINITY,
  });
};
