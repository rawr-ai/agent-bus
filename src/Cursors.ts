import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { LedgerError } from "./domain.ts";

/**
 * Each subscriber's read position, written only by the bus process on the
 * machine the subscriber joined from.
 */
export class Cursors extends Context.Service<
  Cursors,
  {
    readonly get: (address: string) => Effect.Effect<Option.Option<number>, LedgerError>;
    readonly set: (address: string, cursor: number) => Effect.Effect<void, LedgerError>;
    /** Removes the address's cursor, restoring its absence; absent already is fine. */
    readonly clear: (address: string) => Effect.Effect<void, LedgerError>;
  }
>()("agent-bus/Cursors") {}

export const CursorPosition = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
);
export const CursorJson = Schema.fromJsonString(
  Schema.Struct({ address: Schema.String, cursor: CursorPosition })
);
export const cursorText = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** UTF-16LE preserves every JS code unit, including unpaired surrogates. */
export const cursorFileName = (address: string) =>
  `${Bun.CryptoHasher.hash("sha256", Buffer.from(address, "utf16le"), "hex")}.json`;

// File and schema errors can embed local paths and stored values.
const ledgerError = () => new LedgerError({ message: "The cursor could not be read or written." });

/** One witnessed file per exact address, published atomically on each write. */
export const layerFiles = (dir: string) =>
  Layer.effect(
    Cursors,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(ledgerError));

      const fileFor = (address: string) => path.join(dir, cursorFileName(address));
      const decode = Schema.decodeUnknownEffect(CursorJson);
      const encode = Schema.encodeEffect(CursorJson);

      const get = Effect.fn("Cursors.get")(function* (address: string) {
        const file = fileFor(address);
        const info = yield* fs
          .lstat(file)
          .pipe(
            Effect.catch((error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed(undefined)
                : Effect.fail(ledgerError())
            )
          );
        if (info === undefined) return Option.none<number>();
        if (info.type !== "File") return yield* ledgerError();
        const bytes = yield* fs.readFile(file).pipe(Effect.mapError(ledgerError));
        const text = yield* Effect.try({
          try: () => cursorText(bytes),
          catch: ledgerError,
        });
        const record = yield* decode(text).pipe(Effect.mapError(ledgerError));
        if (record.address !== address) return yield* ledgerError();
        return Option.some(record.cursor);
      });

      const set = Effect.fn("Cursors.set")(function* (address: string, cursor: number) {
        const file = fileFor(address);
        const temp = `${file}.${Bun.randomUUIDv7()}.tmp`;
        const previous = yield* get(address);
        const text = yield* encode({ address, cursor }).pipe(Effect.mapError(ledgerError));
        // A newly occupied hash must never overwrite a different address's file.
        yield* fs
          .writeFileString(temp, text, { flag: "wx", mode: 0o600 })
          .pipe(
            Effect.andThen(Option.isNone(previous) ? fs.link(temp, file) : fs.rename(temp, file)),
            Effect.mapError(ledgerError),
            Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore))
          );
      });

      const clear = Effect.fn("Cursors.clear")(function* (address: string) {
        if (Option.isSome(yield* get(address))) {
          yield* fs.remove(fileFor(address), { force: true }).pipe(Effect.mapError(ledgerError));
        }
      });

      return Cursors.of({ get, set, clear });
    })
  );
