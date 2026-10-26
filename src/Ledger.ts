import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { LedgerError, type Message, MessageJson } from "./domain.ts";

/** A decoded entry and the cursor just past it. */
interface Entry {
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
 * implementation: byte offsets for JSONL, commit `t` for a Fluree ledger.
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

const NEWLINE = 0x0a;
const POLL_INTERVAL = "2 seconds";
const decoder = new TextDecoder();

const ledgerError = (cause: unknown) => new LedgerError({ message: String(cause) });

/**
 * JSONL ledger shared by every process on one machine. Each append is one
 * O_APPEND write of a whole line, so concurrent writers interleave by line,
 * and readers only consume lines that end in a newline.
 */
export const layerJsonl = (file: string) =>
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.dirname(file);
      const name = path.basename(file);
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(ledgerError));

      const encode = Schema.encodeEffect(MessageJson);
      const decode = Schema.decodeUnknownEffect(MessageJson);

      const append = Effect.fn("Ledger.append")(function* (message: Message) {
        const line = yield* encode(message).pipe(Effect.mapError(ledgerError));
        yield* fs
          .writeFileString(file, `${line}\n`, { flag: "a" })
          .pipe(Effect.mapError(ledgerError));
      });

      const bytesFrom = (from: number) =>
        Effect.tryPromise({
          try: async () => {
            const handle = Bun.file(file);
            return (await handle.exists()) ? await handle.slice(from).bytes() : new Uint8Array();
          },
          catch: ledgerError,
        });

      const read = Effect.fn("Ledger.read")(function* (from: number) {
        const bytes = yield* bytesFrom(from);
        const complete = bytes.lastIndexOf(NEWLINE) + 1;
        const entries: Array<Entry> = [];
        let start = 0;
        while (start < complete) {
          const stop = bytes.indexOf(NEWLINE, start);
          const text = decoder.decode(bytes.subarray(start, stop));
          if (text.trim() !== "") {
            const decoded = yield* Effect.option(decode(text));
            if (Option.isSome(decoded)) {
              entries.push({ message: decoded.value, end: from + stop + 1 });
            } else {
              yield* Effect.logWarning(`Skipping undecodable ledger line at byte ${from + start}`);
            }
          }
          start = stop + 1;
        }
        return { entries, next: from + complete };
      });

      const end = Effect.tryPromise({
        try: async () => {
          const handle = Bun.file(file);
          return (await handle.exists()) ? handle.size : 0;
        },
        catch: ledgerError,
      });

      // File events wake readers quickly; the poll covers events the OS drops.
      const watched = fs.watch(dir).pipe(
        Stream.filter((event) => path.basename(event.path) === name),
        Stream.map(() => undefined),
        Stream.catchCause(() => Stream.empty)
      );
      const changes = yield* Stream.share(Stream.merge(watched, Stream.tick(POLL_INTERVAL)), {
        capacity: 1,
        strategy: "sliding",
      });

      const all = Effect.map(read(0), ({ entries }) => entries.map((entry) => entry.message));

      const presence = Effect.map(all, (messages) =>
        messages.filter((message) => message.kind === "presence")
      );

      // Case-insensitive substring match; the Fluree ledger ranks by full-text relevance instead.
      const search = Effect.fn("Ledger.search")(function* (input: SearchInput) {
        const query = input.query?.toLowerCase();
        const matches = (yield* all).filter(
          (message) =>
            message.kind === "message" &&
            (input.participant === undefined ||
              message.from === input.participant ||
              message.to.includes(input.participant)) &&
            (query === undefined ||
              message.body.toLowerCase().includes(query) ||
              (message.subject?.toLowerCase().includes(query) ?? false))
        );
        return matches.slice(-input.limit);
      });

      const select = () =>
        Effect.fail(
          new LedgerError({ message: "SPARQL queries need the Fluree store; this bus uses JSONL." })
        );

      return Ledger.of({ instance: "jsonl", append, read, end, changes, presence, search, select });
    })
  );
