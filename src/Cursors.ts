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
  }
>()("agent-bus/Cursors") {}

const CursorJson = Schema.fromJsonString(Schema.Struct({ cursor: Schema.Number }));

const ledgerError = (cause: unknown) => new LedgerError({ message: String(cause) });

/** One JSON file per address, replaced atomically on each write. */
export const layerFiles = (dir: string) =>
  Layer.effect(
    Cursors,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(ledgerError));

      const fileFor = (address: string) => path.join(dir, `${encodeURIComponent(address)}.json`);
      const decode = Schema.decodeUnknownEffect(CursorJson);
      const encode = Schema.encodeEffect(CursorJson);

      const get = Effect.fn("Cursors.get")(function* (address: string) {
        const file = fileFor(address);
        const exists = yield* fs.exists(file).pipe(Effect.mapError(ledgerError));
        if (!exists) return Option.none<number>();
        const text = yield* fs.readFileString(file).pipe(Effect.mapError(ledgerError));
        const { cursor } = yield* decode(text).pipe(Effect.mapError(ledgerError));
        return Option.some(cursor);
      });

      const set = Effect.fn("Cursors.set")(function* (address: string, cursor: number) {
        const file = fileFor(address);
        const temp = `${file}.${Bun.randomUUIDv7()}.tmp`;
        const text = yield* encode({ cursor }).pipe(Effect.mapError(ledgerError));
        yield* fs.writeFileString(temp, text).pipe(Effect.mapError(ledgerError));
        yield* fs.rename(temp, file).pipe(Effect.mapError(ledgerError));
      });

      return Cursors.of({ get, set });
    })
  );
