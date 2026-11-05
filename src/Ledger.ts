import { Context, type Effect, type Stream } from "effect";
import type { LedgerError, Message } from "./domain.ts";
import type { Pin } from "./Query.ts";

/** Server-selected namespaces: callers cannot name an arbitrary ledger subject. */
export type DesignationScope =
  | { readonly kind: "directory"; readonly directory: string }
  | { readonly kind: "programme" }
  | { readonly kind: "concern"; readonly directory: string; readonly concern: string };

export const scopeIri = (scope: DesignationScope): string => {
  switch (scope.kind) {
    case "directory":
      return `urn:agent-bus:orientation:directory:${encodeURIComponent(scope.directory)}`;
    case "programme":
      return "urn:agent-bus:orientation:programme";
    case "concern":
      return `urn:agent-bus:orientation:concern:${encodeURIComponent(scope.directory)}:${encodeURIComponent(scope.concern)}`;
  }
};

export const revisionIri = (operation: string) => `urn:agent-bus:revision:${operation}`;
export const witnessIri = (operation: string) => `urn:agent-bus:witness:${operation}`;
export const messageIri = (id: string) => `urn:agent-bus:message:${id}`;

export interface Designation {
  readonly scope: DesignationScope;
  readonly expected: string | null;
  /** Lowercase UUIDv7, unique across every scope. */
  readonly operation: string;
  /** Already-canonicalized semantic intent, including the publisher address. */
  readonly intent: string;
  /** Complete encoded immutable record, understood by the caller. */
  readonly record: string;
  readonly notification: Message;
  /** A concern write may also fence the containing directory's current revision. */
  readonly directoryRevision?: string;
}

export type WitnessRead =
  | {
      readonly status: "FOUND";
      readonly intent: string;
      readonly revision: string;
      readonly notification: Message;
      readonly cut: Pin;
    }
  | { readonly status: "ABSENT"; readonly cut: Pin }
  | { readonly status: "MALFORMED"; readonly cut: Pin }
  | { readonly status: "UNAVAILABLE" };

export type DesignationResult =
  | {
      readonly status: "APPLIED";
      readonly revision: string;
      readonly notification: Message;
      readonly cut: Pin;
    }
  | { readonly status: "IDENTITY_MISMATCH"; readonly cut: Pin }
  | { readonly status: "CONFLICT"; readonly current: string | null; readonly cut: Pin }
  | { readonly status: "UNKNOWN" };

/** A decoded entry and the cursor just past it. */
export interface Entry {
  readonly message: Message;
  readonly end: number;
}

/** Every presence entry at one cut, oldest first. */
export interface PresenceRead {
  readonly entries: ReadonlyArray<Message>;
  readonly cut: Pin;
}

/**
 * A guarded presence write, decided at its own commit by reading the attempted entry there.
 * REFUSED wrote nothing: another presence for the address committed after the basis.
 * UNKNOWN may have committed.
 */
export type Admission =
  | { readonly status: "ADMITTED"; readonly cut: Pin }
  | { readonly status: "REFUSED"; readonly cut: Pin }
  | { readonly status: "UNKNOWN" };

export interface Slice {
  readonly entries: ReadonlyArray<Entry>;
  /** Cursor past every complete, decoded entry read. A failed read returns no slice. */
  readonly next: number;
}

/**
 * Append-only message storage. Cursors are opaque positions owned by the
 * implementation: commit `t` for the Fluree ledger, byte offsets for the
 * tests' JSONL ledger.
 * `changes` is only a wake-up signal, shared by every reader in the process;
 * reading from a cursor is the authority. Queries over the store go through
 * the separate, read-only `QueryGateway`.
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    /**
     * Identifies this ledger's history. Cursors are kept per instance, so a
     * replaced ledger starts subscribers over instead of skipping messages.
     */
    readonly instance: string;
    readonly append: (message: Message) => Effect.Effect<void, LedgerError>;
    readonly readWitness: (operation: string) => Effect.Effect<WitnessRead, LedgerError>;
    readonly designate: (designation: Designation) => Effect.Effect<DesignationResult, LedgerError>;
    readonly read: (from: number) => Effect.Effect<Slice, LedgerError>;
    readonly end: Effect.Effect<number, LedgerError>;
    readonly changes: Stream.Stream<void>;
    /**
     * Every presence entry at commit `at` (the head when omitted), oldest first; the latest
     * per address is that peer's state. Damage fails the read.
     */
    readonly presenceAt: (at?: number) => Effect.Effect<PresenceRead, LedgerError>;
    /**
     * Appends `presence` only if no presence for its address was written after `basis`, the
     * cut its decision read. One attempt, never resent.
     */
    readonly admit: (presence: Message, basis: Pin) => Effect.Effect<Admission, LedgerError>;
  }
>()("agent-bus/Ledger") {}
