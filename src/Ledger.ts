import { Context, type Effect, type Stream } from "effect";
import type { DirectScan, InvalidQuery, LedgerError, Logged, Message } from "./domain.ts";
import type {
  MailboxAck,
  MailboxRecord,
  MailboxStart,
  MailboxState,
  MailboxUnresolved,
} from "./mailbox-model.ts";
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
export const COMMAND_PREFIX = "urn:agent-bus:command:";
export const commandIri = (operation: string) => `${COMMAND_PREFIX}${operation}`;

/** One operation's command node, read at one cut. */
export type CommandRead =
  | { readonly status: "FOUND"; readonly json: string; readonly t: number; readonly cut: Pin }
  | { readonly status: "ABSENT"; readonly cut: Pin }
  | { readonly status: "MALFORMED"; readonly cut: Pin }
  | { readonly status: "UNAVAILABLE" };

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
 * A guarded entry write, confirmed by reading the attempted entry at its commit.
 * REFUSED wrote nothing. UNKNOWN may have committed.
 */
export type Admission =
  | { readonly status: "ADMITTED"; readonly cut: Pin }
  | { readonly status: "REFUSED"; readonly cut: Pin }
  | { readonly status: "UNKNOWN" };

/** A raw operation witness at the caller's pinned cut; address mismatch never returns its payload. */
export type MailboxReceiptRead =
  | {
      readonly status: "FOUND";
      readonly record: MailboxRecord;
      readonly t: number;
      readonly cut: Pin;
    }
  | { readonly status: "ABSENT"; readonly cut: Pin }
  | { readonly status: "ADDRESS_MISMATCH"; readonly cut: Pin }
  | { readonly status: "MALFORMED"; readonly cut: Pin }
  | { readonly status: "UNAVAILABLE" };

/** APPLIED proves only the stored record, not that a holding or a served prefix was valid. */
export type MailboxWrite =
  | { readonly status: "APPLIED"; readonly cut: Pin }
  | { readonly status: "CONFLICT"; readonly cut: Pin }
  | { readonly status: "IDENTITY_MISMATCH"; readonly cut: Pin }
  | { readonly status: "UNKNOWN" };

export interface Slice {
  readonly entries: ReadonlyArray<Entry>;
  /** Cursor past every complete, decoded entry read. A failed read returns no slice. */
  readonly next: number;
}

/** The independently enumerated subject of an asserted or retracted message type. */
export interface MailboxCandidate {
  readonly subject: string;
  readonly end: number;
  /** Absent when the type was retracted or its routing projection cannot be established. */
  readonly routing?: {
    readonly id: string;
    readonly from: string;
    readonly to: ReadonlyArray<string>;
  };
}

export interface LocatedSlice extends Slice {
  readonly entries: ReadonlyArray<Entry & { readonly subject: string }>;
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
    /**
     * Unconditional append for fixture entries; address operations use guarded writes.
     * Fluree refuses over-limit indexed text before dispatch in append, admit and designate.
     */
    readonly append: (message: Message) => Effect.Effect<void, LedgerError | InvalidQuery>;
    readonly readWitness: (operation: string) => Effect.Effect<WitnessRead, LedgerError>;
    readonly designate: (
      designation: Designation
    ) => Effect.Effect<DesignationResult, LedgerError | InvalidQuery>;
    readonly read: (from: number) => Effect.Effect<Slice, LedgerError>;
    /**
     * Encoded entry assertions in (from, cut.head], at one incarnation and commit. This does not
     * discover a damaged entry with no encoding, or prove audience and served-prefix completeness.
     */
    readonly readAt: (from: number, cut: Pin) => Effect.Effect<LocatedSlice, LedgerError>;
    /**
     * Enumerate candidates in (from, cut.head] without requiring their id, routing or carrier.
     * In Fluree the type history establishes membership independently of the encoded slice.
     */
    readonly mailboxCandidatesAt: (
      from: number,
      cut: Pin
    ) => Effect.Effect<ReadonlyArray<MailboxCandidate>, LedgerError>;
    readonly end: Effect.Effect<number, LedgerError>;
    readonly changes: Stream.Stream<void>;
    /**
     * Every presence entry at commit `at` (the head when omitted), oldest first; the latest
     * per address is that peer's state. Damage fails the read.
     */
    readonly presenceAt: (at?: number) => Effect.Effect<PresenceRead, LedgerError>;
    /**
     * Appends an entry only if no presence for its sender was written after `basis`, the cut
     * its ownership decision read. One attempt with a fresh id, never resent: a resent id
     * is never stored twice, but its status may report the original admission.
     */
    readonly admit: (
      entry: Message,
      basis: Pin
    ) => Effect.Effect<Admission, LedgerError | InvalidQuery>;
    /**
     * All start and acknowledgement assertions for this address at one cut, with their
     * operation witnesses and starting presences checked. This is an address-scoped history
     * scan, not a constant-time lookup; damage, deadline or response-budget exhaustion fails
     * instead of returning an older or partial position. Its cost is not yet qualified.
     */
    readonly mailboxAt: (address: string, cut: Pin) => Effect.Effect<MailboxState, LedgerError>;
    /** A raw immutable receipt at the supplied cut. This is not an authorization check. */
    readonly mailboxReceiptAt: (
      address: string,
      operation: string,
      cut: Pin
    ) => Effect.Effect<MailboxReceiptRead, LedgerError>;
    /**
     * Admit a presence and its initial or replay start in the same transaction, fenced against
     * later presence and position facts. Exact retries may recover an older successful commit;
     * that historical outcome is not a current ownership grant. The caller decides whether the
     * original start was lawful and must authorize any new operation against current state.
     */
    readonly admitWithStart: (
      entry: Message,
      start: MailboxStart,
      basis: Pin
    ) => Effect.Effect<Admission, LedgerError | InvalidQuery>;
    /** Record an import that could not establish a position, only while truly absent. */
    readonly classifyMailboxImport: (
      unresolved: MailboxUnresolved,
      basis: Pin
    ) => Effect.Effect<MailboxWrite, LedgerError>;
    /** Import into an absent mailbox, or explicitly reconcile an unresolved one. */
    readonly importMailbox: (
      start: MailboxStart,
      basis: Pin
    ) => Effect.Effect<MailboxWrite, LedgerError>;
    /**
     * Fenced storage only. The caller must prove the holder, run, membership, prefix and carrier
     * at the same basis before writing, and must authorize receipt access separately.
     */
    readonly appendMailboxAck: (
      ack: MailboxAck,
      basis: Pin
    ) => Effect.Effect<MailboxWrite, LedgerError>;
    /**
     * Writes an address command as its own node, `commandIri(operation)`, only if that node
     * holds no command yet. A failure says nothing about whether it committed: read it back.
     */
    readonly appendCommand: (operation: string, json: string) => Effect.Effect<void, LedgerError>;
    /** The operation's command at one pinned cut; any failure to read it is UNAVAILABLE. */
    readonly readCommand: (operation: string) => Effect.Effect<CommandRead>;
    /** Every presence entry and command node committed at or before `t`, oldest first. */
    readonly log: (t: number) => Effect.Effect<ReadonlyArray<Logged>, LedgerError>;
    /**
     * The direct candidates for `address` committed in (after, upTo]: entries whose recipients
     * name it, decoded, until the first that qualifies.
     */
    readonly direct: (
      address: string,
      after: number,
      upTo: number
    ) => Effect.Effect<DirectScan, LedgerError>;
  }
>()("agent-bus/Ledger") {}
