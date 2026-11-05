import { Effect, FileSystem, Layer, Option, Path, Schema, Semaphore, Stream } from "effect";
import {
  AddressCommandJson,
  type DirectScan,
  LedgerError,
  type Logged,
  type Message,
  MessageJson,
  qualifies,
} from "../src/domain.ts";
import { type Admission, type CommandRead, type Entry, Ledger } from "../src/Ledger.ts";
import { QueryGateway } from "../src/Query.ts";

const NEWLINE = 0x0a;
const POLL_INTERVAL = "2 seconds";
const decoder = new TextDecoder();

const ledgerError = (cause: unknown) => new LedgerError({ message: String(cause) });

/** One write lock per file, shared by every layer in the process, as one Fluree is. */
const locks = new Map<string, Semaphore.Semaphore>();
const lockFor = (file: string) => {
  let lock = locks.get(file);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(file, lock);
  }
  return Semaphore.withPermit(lock);
};

/**
 * Address commands share the file, so an unchanged end proves nothing was written. Their lines
 * are never a Message: reads pass over them, as Fluree's message reads never see command nodes.
 */
const COMMAND_MARK = '{"@command":';
const CommandLine = Schema.fromJsonString(
  Schema.Struct({ "@command": Schema.String, command: Schema.String })
);

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

      const locked = lockFor(file);
      const write = (message: Message) =>
        Effect.gen(function* () {
          const line = yield* encode(message).pipe(Effect.mapError(ledgerError));
          yield* fs
            .writeFileString(file, `${line}\n`, { flag: "a" })
            .pipe(Effect.mapError(ledgerError));
        });
      const append = (message: Message) =>
        write(message).pipe(locked, Effect.withSpan("Ledger.append"));

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
          if (text.trim() !== "" && !text.startsWith(COMMAND_MARK)) {
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

      const presenceAt = (at?: number) =>
        Effect.gen(function* () {
          const head = at ?? (yield* end);
          const { entries } = yield* read(0);
          return {
            entries: entries
              .filter((entry) => entry.end <= head && entry.message.kind === "presence")
              .map((entry) => entry.message),
            cut: { head, incarnation: "jsonl" },
          };
        });

      // Any line past the basis that is a presence for the address, the same id, or
      // unreadable (which `read` would skip) refuses: the guard may refuse too often, never
      // too rarely.
      const admit = (presence: Message, basis: { readonly head: number }) =>
        Effect.gen(function* () {
          // An id already written, at any position, refuses: an entry is admitted once.
          const { entries: written } = yield* read(0);
          if (written.some((entry) => entry.message.id === presence.id)) {
            return {
              status: "REFUSED",
              cut: { head: yield* end, incarnation: "jsonl" },
            } satisfies Admission;
          }
          const bytes = yield* bytesFrom(basis.head);
          const complete = bytes.lastIndexOf(NEWLINE) + 1;
          const lines = decoder
            .decode(bytes.subarray(0, complete))
            .split("\n")
            .filter((line) => line.trim() !== "");
          for (const line of lines) {
            const decoded = yield* Effect.option(decode(line));
            if (
              Option.isNone(decoded) ||
              decoded.value.id === presence.id ||
              (decoded.value.kind === "presence" && decoded.value.from === presence.from)
            ) {
              return {
                status: "REFUSED",
                cut: { head: yield* end, incarnation: "jsonl" },
              } satisfies Admission;
            }
          }
          yield* write(presence);
          return {
            status: "ADMITTED",
            cut: { head: yield* end, incarnation: "jsonl" },
          } satisfies Admission;
        }).pipe(locked, Effect.withSpan("Ledger.admit"));

      /** Every complete line up to `upTo`, with the offset just past it. */
      const lines = (upTo: number) =>
        Effect.map(bytesFrom(0), (bytes) => {
          const complete = Math.min(bytes.lastIndexOf(NEWLINE) + 1, upTo);
          const found: Array<{ readonly text: string; readonly end: number }> = [];
          let start = 0;
          while (start < complete) {
            const stop = bytes.indexOf(NEWLINE, start);
            if (stop + 1 > complete) break;
            found.push({ text: decoder.decode(bytes.subarray(start, stop)), end: stop + 1 });
            start = stop + 1;
          }
          return found;
        });
      const decodeCommandLine = Schema.decodeUnknownOption(CommandLine);
      const commandLines = (upTo: number) =>
        Effect.map(lines(upTo), (found) =>
          found.flatMap(({ text, end }) => {
            if (!text.startsWith(COMMAND_MARK)) return [];
            const line = decodeCommandLine(text);
            return Option.isSome(line)
              ? [{ operation: line.value["@command"], json: line.value.command, end }]
              : [];
          })
        );
      const cut = Effect.map(end, (head) => ({ head, incarnation: "jsonl" }));

      const readCommand = (operation: string) =>
        Effect.gen(function* () {
          const at = yield* cut;
          const found = (yield* commandLines(at.head)).filter(
            (line) => line.operation === operation
          );
          const [only] = found;
          if (only === undefined) return { status: "ABSENT", cut: at } satisfies CommandRead;
          if (found.length > 1) return { status: "MALFORMED", cut: at } satisfies CommandRead;
          return { status: "FOUND", json: only.json, t: only.end, cut: at } satisfies CommandRead;
        }).pipe(Effect.orElseSucceed((): CommandRead => ({ status: "UNAVAILABLE" })));

      // Conditional within this process, which is as far as the test double needs it to be.
      const appendCommand = Effect.fn("Ledger.appendCommand")(function* (
        operation: string,
        json: string
      ) {
        const existing = yield* commandLines(Number.MAX_SAFE_INTEGER);
        if (existing.some((line) => line.operation === operation)) return;
        yield* fs
          .writeFileString(file, `${JSON.stringify({ "@command": operation, command: json })}\n`, {
            flag: "a",
          })
          .pipe(Effect.mapError(ledgerError));
      });

      const decodeCommand = Schema.decodeUnknownOption(AddressCommandJson, {
        onExcessProperty: "error",
      });
      const log = (upTo: number) =>
        Effect.gen(function* () {
          const logged: Array<Logged> = [];
          for (const { text, end: t } of yield* lines(upTo)) {
            if (text.startsWith(COMMAND_MARK)) {
              const line = decodeCommandLine(text);
              const command = Option.flatMap(line, (value) => decodeCommand(value.command));
              logged.push(
                Option.isSome(line) && Option.isSome(command)
                  ? {
                      kind: "command",
                      t,
                      operation: line.value["@command"],
                      command: command.value,
                    }
                  : { kind: "damaged", t }
              );
              continue;
            }
            const message = decode(text);
            const decoded = yield* Effect.option(message);
            if (Option.isSome(decoded) && decoded.value.kind === "presence") {
              logged.push({ kind: "presence", t, message: decoded.value });
            }
          }
          return logged;
        });

      const direct = (address: string, after: number, upTo: number) =>
        Effect.map(read(after), ({ entries }): DirectScan => {
          for (const entry of entries) {
            if (entry.end > upTo) break;
            if (qualifies(entry.message, address)) {
              return {
                found: { ts: entry.message.ts, t: entry.end },
                damaged: false,
                complete: true,
              };
            }
          }
          return { damaged: false, complete: true };
        });

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
        presenceAt,
        admit,
        appendCommand,
        readCommand,
        log,
        direct,
      });
    })
  ).pipe(
    // No query engine: every query refuses, as the design keeps JSONL to delivery.
    Layer.merge(QueryGateway.layerUnavailable)
  );
