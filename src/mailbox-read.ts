import { Effect } from "effect";
import { isFor, LedgerError, type Subscriber } from "./domain.ts";
import {
  type Entry,
  type Ledger,
  type LocatedSlice,
  type MailboxCandidate,
  messageIri,
} from "./Ledger.ts";
import type { Pin } from "./Query.ts";

export const incompleteMailbox = (t: number) =>
  new LedgerError({
    message: `The complete mailbox group at t=${t} could not be established; nothing was acknowledged.`,
  });

interface Group {
  readonly entries: Array<LocatedSlice["entries"][number]>;
  readonly candidates: Array<MailboxCandidate>;
}

const sameAudience = (expected: ReadonlyArray<string>, actual: ReadonlyArray<string>) => {
  const peers = new Set(expected);
  return peers.size === actual.length && actual.every((recipient) => peers.delete(recipient));
};

/**
 * Neither a valid carrier nor a typed subject is proof by itself. Reconcile the entire commit
 * before exposing any row in it; a later group cannot repair, or be offered past, a damaged one.
 */
const reconcile = (
  raw: LocatedSlice,
  typed: ReadonlyArray<MailboxCandidate>,
  subscriber: Subscriber
) => {
  const groups = new Map<number, Group>();
  const groupAt = (end: number) => {
    const group = groups.get(end) ?? { entries: [], candidates: [] };
    groups.set(end, group);
    return group;
  };
  for (const candidate of typed) groupAt(candidate.end).candidates.push(candidate);
  for (const entry of raw.entries) {
    // Ordinary presence carriers share the encoding predicate but are not message candidates.
    if (
      entry.message.kind === "message" ||
      groups.get(entry.end)?.candidates.some(({ subject }) => subject === entry.subject)
    )
      groupAt(entry.end).entries.push(entry);
  }
  const witnessed = new Set<string>();
  const entries: Array<Entry> = [];
  for (const [end, { entries: encoded, candidates }] of [...groups].sort(([a], [b]) => a - b)) {
    const expected = new Map(candidates.map((candidate) => [candidate.subject, candidate]));
    if (expected.size !== candidates.length || expected.size !== encoded.length)
      return { entries, damage: end };
    for (const { message, subject } of encoded) {
      const candidate = expected.get(subject);
      const routing = candidate?.routing;
      if (
        routing === undefined ||
        message.kind !== "message" ||
        witnessed.has(subject) ||
        subject !== messageIri(message.id) ||
        routing.id !== message.id ||
        routing.from !== message.from ||
        !sameAudience(message.to, routing.to)
      ) {
        return { entries, damage: end };
      }
      expected.delete(subject);
      witnessed.add(subject);
    }
    for (const entry of encoded) {
      if (isFor(entry.message, subscriber)) entries.push({ message: entry.message, end });
    }
  }
  return { entries, damage: undefined };
};

/** An ordered, fully witnessed prefix at the same snapshot as authorization and membership. */
export const readMailboxSlice = (
  ledger: Ledger["Service"],
  from: number,
  cut: Pin,
  subscriber: Subscriber
) =>
  Effect.gen(function* () {
    const [raw, typed] = yield* Effect.all(
      [ledger.readAt(from, cut), ledger.mailboxCandidatesAt(from, cut)],
      { concurrency: 2 }
    );
    if (
      raw.next !== cut.head ||
      raw.entries.some(({ end }) => !Number.isSafeInteger(end) || end <= from || end > cut.head) ||
      typed.some(({ end }) => !Number.isSafeInteger(end) || end <= from || end > cut.head)
    )
      return yield* incompleteMailbox(cut.head);
    return reconcile(raw, typed, subscriber);
  });

/** The lengths of every whole-commit prefix of an ordered slice, shortest first. */
const groupEnds = (entries: ReadonlyArray<Entry>) => {
  const counts: Array<number> = [];
  for (let count = 1; count <= entries.length; count++) {
    if (count === entries.length || entries[count - 1]?.end !== entries[count]?.end)
      counts.push(count);
  }
  return counts;
};

/** A whole-commit prefix of unread mail and the position just past it. */
export interface Prefix {
  readonly count: number;
  readonly through: number;
  /** It serves everything readable at its cut, so it may pass over the rest to the head. */
  readonly exhausted: boolean;
}

const prefixOf = (
  entries: ReadonlyArray<Entry>,
  count: number,
  head: number,
  limit: number | undefined
): Prefix => {
  const exhausted = count === entries.length && (limit === undefined || count < limit);
  return { count, through: exhausted ? head : (entries[count - 1]?.end ?? head), exhausted };
};

/**
 * The longest whole-commit prefix within `limit` that `fits`, which must be monotone in the
 * prefix; `first` is the shortest, for a refusal to name what it needs.
 */
export const longestPrefix = (
  entries: ReadonlyArray<Entry>,
  head: number,
  limit: number | undefined,
  fits: (prefix: Prefix) => boolean
) => {
  const ends = groupEnds(entries);
  const first = prefixOf(entries, ends[0] ?? 0, head, undefined);
  const allowed = ends.filter((count) => limit === undefined || count <= limit);
  let low = 0;
  let high = allowed.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const count = allowed[middle - 1];
    if (count !== undefined && fits(prefixOf(entries, count, head, limit))) low = middle;
    else high = middle - 1;
  }
  const chosen = allowed[low - 1];
  return {
    chosen: chosen === undefined ? undefined : prefixOf(entries, chosen, head, limit),
    first,
  };
};

/**
 * Reconstructs a recorded batch: the subscriber's mail in (from, through], reconciled as whole
 * commit groups at the recorded cut. Damage at or before `through` refuses; damage after it
 * cannot undo a prefix already proved. `boundary` says whether `through` is a position a read
 * could have recorded there: the cut's head, or the end of a served commit.
 */
export const servedPrefix = (
  ledger: Ledger["Service"],
  from: number,
  through: number,
  cut: Pin,
  subscriber: Subscriber
) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(through) || through <= from || through > cut.head)
      return { entries: [], boundary: false };
    const { entries, damage } = yield* readMailboxSlice(ledger, from, cut, subscriber);
    if (damage !== undefined && damage <= through) return yield* incompleteMailbox(damage);
    const served = entries.filter(({ end }) => end <= through);
    return {
      entries: served,
      boundary: through === cut.head || served.at(-1)?.end === through,
    };
  });
