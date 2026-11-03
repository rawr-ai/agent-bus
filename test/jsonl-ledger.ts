import { Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { LedgerError, type Message, MessageJson } from "../src/domain.ts";
import { type Entry, Ledger } from "../src/Ledger.ts";
import { QueryGateway } from "../src/Query.ts";

const NEWLINE = 0x0a;
const POLL_INTERVAL = "2 seconds";
const decoder = new TextDecoder();

const ledgerError = (cause: unknown) => new LedgerError({ message: String(cause) });

/**
 * The tests' ledger: one JSONL file, read from a byte offset. Production uses
 * Fluree only, and queries need it: this store refuses them. Each append is
 * one O_APPEND write of a whole line, and readers only consume lines that end
 * in a newline.
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

      return Ledger.of({
        instance: "jsonl",
        append,
        readWitness: () =>
          Effect.fail(new LedgerError({ message: "Guarded designations need Fluree." })),
        designate: () =>
          Effect.fail(new LedgerError({ message: "Guarded designations need Fluree." })),
        read,
        end,
        changes,
        presence,
      });
    })
  ).pipe(
    // No query engine: every query refuses, as the design keeps JSONL to delivery.
    Layer.merge(QueryGateway.layerUnavailable)
  );
