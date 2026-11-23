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
