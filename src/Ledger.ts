import { Context, type Effect, type Stream } from "effect";
import type { LedgerError, Message } from "./domain.ts";

/** A decoded entry and the cursor just past it. */
export interface Entry {
  readonly message: Message;
  readonly end: number;
}

export interface Slice {
  readonly entries: ReadonlyArray<Entry>;
  /** Cursor past every complete entry read, including ones that failed to decode. */
  readonly next: number;
}

export interface SearchInput {
  readonly query?: string | undefined;
  readonly participant?: string | undefined;
  readonly limit: number;
}

/**
 * Append-only message storage. Cursors are opaque positions owned by the
 * implementation: commit `t` for the Fluree ledger, byte offsets for the
 * tests' JSONL ledger.
 * `changes` is only a wake-up signal, shared by every reader in the process;
 * reading from a cursor is the authority.
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
    readonly read: (from: number) => Effect.Effect<Slice, LedgerError>;
    readonly end: Effect.Effect<number, LedgerError>;
    readonly changes: Stream.Stream<void>;
    /** Every presence entry, oldest first; the latest per address is that peer's state. */
    readonly presence: Effect.Effect<ReadonlyArray<Message>, LedgerError>;
    /** Messages matching the search, newest last. */
    readonly search: (input: SearchInput) => Effect.Effect<ReadonlyArray<Message>, LedgerError>;
    /** Runs a read-only SPARQL SELECT over the ledger at commit `t`, or the head. */
    readonly select: (query: string, t?: number) => Effect.Effect<unknown, LedgerError>;
  }
>()("agent-bus/Ledger") {}
