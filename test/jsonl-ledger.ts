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
import {
  type Admission,
  type CommandRead,
  type Entry,
  Ledger,
  type MailboxReceiptRead,
  type MailboxWrite,
} from "../src/Ledger.ts";
import {
  decodeMailboxRecord,
  type MailboxAck,
  type MailboxRecord,
  MailboxRecordJson,
  MailboxRecord as MailboxRecordSchema,
  type MailboxStart,
  type RawMailboxRecord,
  resolveMailbox,
} from "../src/mailbox-model.ts";
import { type Pin, QueryGateway } from "../src/Query.ts";

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
const START_MARK = '{"@mailboxStart":';
const ACK_MARK = '{"@mailboxAck":';
const StartLine = Schema.fromJsonString(
  Schema.Struct({ "@mailboxStart": Schema.String, message: Schema.NullOr(Schema.String) })
);
const AckLine = Schema.fromJsonString(Schema.Struct({ "@mailboxAck": Schema.String }));

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
      // Separate files are separate test ledgers; a replacement at the same path is not modelled.
      const instance = `jsonl:${file}`;
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(ledgerError));

      const encode = Schema.encodeEffect(MessageJson);
      const decode = Schema.decodeUnknownEffect(MessageJson);

      const locked = lockFor(file);
      const decodeCommandLine = Schema.decodeUnknownOption(CommandLine);
      const decodeStartLine = Schema.decodeUnknownOption(StartLine, { onExcessProperty: "error" });
      const decodeAckLine = Schema.decodeUnknownOption(AckLine, { onExcessProperty: "error" });
      const encodeRecord = Schema.encodeEffect(MailboxRecordJson);
      const encodeMailbox = (record: MailboxRecord) =>
        Schema.decodeUnknownEffect(MailboxRecordSchema, { onExcessProperty: "error" })(record).pipe(
          Effect.flatMap(encodeRecord)
        );
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

      const readWithin = (from: number, to?: number, strict = false) =>
        Effect.gen(function* () {
          const available = yield* bytesFrom(from);
          const bytes = to === undefined ? available : available.subarray(0, to - from);
          const complete = bytes.lastIndexOf(NEWLINE) + 1;
          const entries: Array<Entry> = [];
          let start = 0;
          while (start < complete) {
            const stop = bytes.indexOf(NEWLINE, start);
            let text = decoder.decode(bytes.subarray(start, stop));
            if (text.startsWith(START_MARK)) {
              const line = decodeStartLine(text);
              if (Option.isNone(line)) return yield* ledgerError("Invalid mailbox start line.");
              text = line.value.message ?? "";
            } else if (text.startsWith(ACK_MARK)) {
              if (Option.isNone(decodeAckLine(text))) {
                return yield* ledgerError("Invalid mailbox acknowledgement line.");
              }
              text = "";
            } else if (text.startsWith(COMMAND_MARK) && strict) {
              if (Option.isNone(decodeCommandLine(text))) {
                return yield* ledgerError("Invalid address command line.");
              }
              text = "";
            }
            if (text.trim() !== "" && !text.startsWith(COMMAND_MARK)) {
              const decoded = yield* Effect.option(decode(text));
              if (Option.isSome(decoded)) {
                entries.push({ message: decoded.value, end: from + stop + 1 });
              } else {
                if (strict)
                  return yield* ledgerError(
                    `A ledger entry at byte ${from + start} could not be decoded.`
                  );
                yield* Effect.logWarning(
                  `Skipping undecodable ledger line at byte ${from + start}`
                );
              }
            }
            start = stop + 1;
          }
          return { entries, next: from + complete };
        });
      const read = Effect.fn("Ledger.read")(function* (from: number) {
        return yield* readWithin(from);
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
            cut: { head, incarnation: instance },
          };
        });

      // Any line past the basis that is a presence for the address, the same id, or
      // unreadable (which `read` would skip) refuses: the guard may refuse too often, never
      // too rarely. A whole command line passes, as Fluree's command nodes are never presences;
      // a damaged one may have been anything, so it refuses.
      const admitAttempt = (message: Message, basis: Pin, start?: MailboxStart) =>
        Effect.gen(function* () {
          if (basis.incarnation !== instance) return yield* ledgerError("The ledger was replaced.");
          let startJson: string | undefined;
          if (start !== undefined) {
            if (
              start.origin === "import" ||
              message.kind !== "presence" ||
              message.presence?.status !== "joined" ||
              start.address !== message.from ||
              start.operation !== message.id ||
              start.run !== (message.presence.rejoinOf ?? message.id) ||
              start.position > basis.head
            ) {
              return yield* ledgerError("Invalid mailbox start.");
            }
            startJson = yield* encodeMailbox(start).pipe(Effect.mapError(ledgerError));
            yield* mailboxLines({ head: start.position, incarnation: basis.incarnation });
            const current = { head: yield* end, incarnation: instance };
            const already = yield* mailboxReceiptAt(start.address, start.operation, current);
            if (already.status !== "ABSENT") {
              return { status: "REFUSED", cut: current } satisfies Admission;
            }
            const prior = (yield* mailboxLines(basis)).filter(
              (row) => row.address === start.address
            );
            const now = (yield* mailboxLines(current)).filter(
              (row) => row.address === start.address
            );
            if (now.some((row) => row.t > basis.head)) {
              return { status: "REFUSED", cut: current } satisfies Admission;
            }
            yield* resolveMailbox(
              [...prior, { predicate: "start", json: startJson, t: basis.head + 1 }],
              start.address,
              basis.head + 1,
              basis.incarnation
            );
          }
          // An id already written, at any position, refuses: an entry is admitted once.
          const { entries: written } = yield* read(0);
          if (written.some((entry) => entry.message.id === message.id)) {
            return {
              status: "REFUSED",
              cut: { head: yield* end, incarnation: instance },
            } satisfies Admission;
          }
          const bytes = yield* bytesFrom(basis.head);
          const complete = bytes.lastIndexOf(NEWLINE) + 1;
          const pending = decoder
            .decode(bytes.subarray(0, complete))
            .split("\n")
            .filter((line) => line.trim() !== "");
          for (let line of pending) {
            if (line.startsWith(COMMAND_MARK) && Option.isSome(decodeCommandLine(line))) continue;
            if (line.startsWith(ACK_MARK)) {
              const wrapped = decodeAckLine(line);
              if (
                Option.isSome(wrapped) &&
                Option.isSome(
                  Option.filter(
                    decodeMailboxRecord(wrapped.value["@mailboxAck"]),
                    (record) => record.kind === "ack"
                  )
                )
              )
                continue;
            } else if (line.startsWith(START_MARK)) {
              const wrapped = decodeStartLine(line);
              if (
                Option.isSome(wrapped) &&
                Option.isSome(
                  Option.filter(
                    decodeMailboxRecord(wrapped.value["@mailboxStart"]),
                    (record) => record.kind === "start"
                  )
                )
              ) {
                if (wrapped.value.message === null) continue;
                line = wrapped.value.message;
              }
            }
            const decoded = yield* Effect.option(decode(line));
            if (
              Option.isNone(decoded) ||
              decoded.value.id === message.id ||
              (decoded.value.kind === "presence" && decoded.value.from === message.from)
            ) {
              return {
                status: "REFUSED",
                cut: { head: yield* end, incarnation: instance },
              } satisfies Admission;
            }
          }
          if (startJson === undefined) yield* write(message);
          else {
            const json = yield* encode(message).pipe(Effect.mapError(ledgerError));
            yield* fs
              .writeFileString(
                file,
                `${JSON.stringify({ "@mailboxStart": startJson, message: json })}\n`,
                { flag: "a" }
              )
              .pipe(Effect.mapError(ledgerError));
          }
          return {
            status: "ADMITTED",
            cut: { head: yield* end, incarnation: instance },
          } satisfies Admission;
        });
      const admit = (message: Message, basis: Pin) =>
        admitAttempt(message, basis).pipe(locked, Effect.withSpan("Ledger.admit"));
      const admitWithStart = (message: Message, start: MailboxStart, basis: Pin) =>
        admitAttempt(message, basis, start).pipe(locked, Effect.withSpan("Ledger.admitWithStart"));

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
      const mailboxLines = (at: Pin) =>
        Effect.gen(function* () {
          if (at.incarnation !== instance || !Number.isSafeInteger(at.head) || at.head < 0) {
            return yield* ledgerError("Invalid mailbox snapshot.");
          }
          const size = yield* end;
          if (at.head > size)
            return yield* ledgerError("The mailbox snapshot is ahead of the ledger.");
          const found = yield* lines(at.head);
          if (at.head !== 0 && found.at(-1)?.end !== at.head) {
            return yield* ledgerError("The mailbox snapshot is not a complete commit.");
          }
          const commits = new Set([0, ...found.map((line) => line.end)]);
          const records: Array<
            RawMailboxRecord & { readonly address: string; readonly operation: string }
          > = [];
          for (const { text, end: t } of found) {
            if (text.startsWith(START_MARK)) {
              const line = decodeStartLine(text);
              const value = Option.flatMap(line, (item) =>
                decodeMailboxRecord(item["@mailboxStart"])
              );
              if (Option.isNone(line) || Option.isNone(value) || value.value.kind !== "start") {
                return yield* ledgerError(`A mailbox entry at t=${t} could not be established.`);
              }
              if (!commits.has(value.value.position)) {
                return yield* ledgerError("A mailbox start does not name a complete commit.");
              }
              if (line.value.message === null) {
                if (value.value.origin !== "import")
                  return yield* ledgerError("A mailbox start lost its presence.");
              } else {
                const message = yield* Effect.option(decode(line.value.message));
                if (
                  value.value.origin === "import" ||
                  Option.isNone(message) ||
                  message.value.kind !== "presence" ||
                  message.value.presence?.status !== "joined" ||
                  message.value.id !== value.value.operation ||
                  message.value.from !== value.value.address ||
                  (message.value.presence.rejoinOf ?? message.value.id) !== value.value.run
                ) {
                  return yield* ledgerError("A mailbox start does not match its presence.");
                }
              }
              records.push({
                predicate: "start",
                json: line.value["@mailboxStart"],
                t,
                address: value.value.address,
                operation: value.value.operation,
              });
            } else if (text.startsWith(ACK_MARK)) {
              const line = decodeAckLine(text);
              const value = Option.flatMap(line, (item) =>
                decodeMailboxRecord(item["@mailboxAck"])
              );
              if (Option.isNone(line) || Option.isNone(value) || value.value.kind !== "ack") {
                return yield* ledgerError(`A mailbox entry at t=${t} could not be established.`);
              }
              if (
                value.value.dataCut.incarnation !== instance ||
                !commits.has(value.value.dataCut.head) ||
                !commits.has(value.value.from) ||
                !commits.has(value.value.through)
              ) {
                return yield* ledgerError(
                  "A mailbox acknowledgement does not name complete commits."
                );
              }
              records.push({
                predicate: "ack",
                json: line.value["@mailboxAck"],
                t,
                address: value.value.address,
                operation: value.value.operation,
              });
            }
          }
          return records;
        });
      const mailboxAt = (address: string, at: Pin) =>
        Effect.flatMap(mailboxLines(at), (records) =>
          resolveMailbox(
            records.filter((record) => record.address === address),
            address,
            at.head,
            at.incarnation
          )
        );
      const readAt = (from: number, at: Pin) =>
        Effect.gen(function* () {
          if (!Number.isSafeInteger(from) || from < 0 || from > at.head) {
            return yield* ledgerError("Invalid entry snapshot.");
          }
          yield* mailboxLines(at);
          yield* mailboxLines({ head: from, incarnation: at.incarnation });
          const slice = yield* readWithin(from, at.head, true);
          if (slice.next !== at.head)
            return yield* ledgerError("The entry snapshot is incomplete.");
          return slice;
        }).pipe(Effect.withSpan("Ledger.readAt"));
      const mailboxReceiptAt = (address: string, operation: string, at: Pin) =>
        Effect.gen(function* () {
          const records = (yield* mailboxLines(at)).filter(
            (record) => record.operation === operation
          );
          const [only] = records;
          if (only === undefined) {
            yield* mailboxAt(address, at);
            return { status: "ABSENT", cut: at } satisfies MailboxReceiptRead;
          }
          if (records.length !== 1)
            return { status: "MALFORMED", cut: at } satisfies MailboxReceiptRead;
          const record = decodeMailboxRecord(only.json);
          if (Option.isNone(record))
            return { status: "MALFORMED", cut: at } satisfies MailboxReceiptRead;
          const state = yield* mailboxAt(record.value.address, at);
          if (
            state.status !== "FOUND" ||
            !state.records.some((item) => item.t === only.t && item.record.operation === operation)
          )
            return { status: "MALFORMED", cut: at } satisfies MailboxReceiptRead;
          return {
            status: "FOUND",
            record: record.value,
            t: only.t,
            cut: at,
          } satisfies MailboxReceiptRead;
        }).pipe(Effect.orElseSucceed((): MailboxReceiptRead => ({ status: "UNAVAILABLE" })));
      const writeMailbox = (record: MailboxRecord, basis: Pin) =>
        Effect.gen(function* () {
          const json = yield* encodeMailbox(record).pipe(Effect.mapError(ledgerError));
          yield* mailboxLines(basis);
          const current = { head: yield* end, incarnation: instance };
          const existing = yield* mailboxReceiptAt(record.address, record.operation, current);
          if (existing.status === "FOUND") {
            const previous = yield* encodeMailbox(existing.record).pipe(
              Effect.mapError(ledgerError)
            );
            return previous === json
              ? ({
                  status: "APPLIED",
                  cut: { head: existing.t, incarnation: instance },
                } satisfies MailboxWrite)
              : ({ status: "IDENTITY_MISMATCH", cut: current } satisfies MailboxWrite);
          }
          if (existing.status !== "ABSENT") return { status: "UNKNOWN" } satisfies MailboxWrite;
          const priorRows = (yield* mailboxLines(basis)).filter(
            (row) => row.address === record.address
          );
          const currentRows = (yield* mailboxLines(current)).filter(
            (row) => row.address === record.address
          );
          const prior = yield* resolveMailbox(
            priorRows,
            record.address,
            basis.head,
            basis.incarnation
          );
          yield* resolveMailbox(currentRows, record.address, current.head, current.incarnation);
          if (currentRows.some((row) => row.t > basis.head)) {
            return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
          }
          if (record.kind === "start") {
            if (
              record.origin !== "import" ||
              record.position > basis.head ||
              prior.status !== "ABSENT"
            ) {
              return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
            }
            yield* mailboxLines({ head: record.position, incarnation: basis.incarnation });
          } else if (
            prior.status !== "FOUND" ||
            record.from !== prior.position ||
            record.dataCut.head > basis.head ||
            record.dataCut.incarnation !== basis.incarnation
          ) {
            return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
          } else {
            yield* mailboxLines(record.dataCut);
            yield* mailboxLines({ head: record.through, incarnation: basis.incarnation });
          }
          yield* resolveMailbox(
            [...priorRows, { predicate: record.kind, json, t: basis.head + 1 }],
            record.address,
            basis.head + 1,
            basis.incarnation
          );
          for (const { text, end: t } of yield* lines(current.head)) {
            if (
              t <= basis.head ||
              text.trim() === "" ||
              text.startsWith(ACK_MARK) ||
              text.startsWith(START_MARK)
            )
              continue;
            if (text.startsWith(COMMAND_MARK) && Option.isSome(decodeCommandLine(text))) continue;
            if (Option.isNone(yield* Effect.option(decode(text)))) {
              return yield* ledgerError(`A ledger entry at t=${t} could not be decoded.`);
            }
          }
          const later = yield* read(basis.head);
          if (
            later.entries.some(
              (entry) => entry.message.kind === "presence" && entry.message.from === record.address
            )
          ) {
            return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
          }
          const line =
            record.kind === "start"
              ? { "@mailboxStart": json, message: null }
              : { "@mailboxAck": json };
          yield* fs
            .writeFileString(file, `${JSON.stringify(line)}\n`, { flag: "a" })
            .pipe(Effect.mapError(ledgerError));
          return {
            status: "APPLIED",
            cut: { head: yield* end, incarnation: instance },
          } satisfies MailboxWrite;
        });
      const importMailbox = (start: MailboxStart, basis: Pin) =>
        writeMailbox(start, basis).pipe(locked, Effect.withSpan("Ledger.importMailbox"));
      const appendMailboxAck = (ack: MailboxAck, basis: Pin) =>
        writeMailbox(ack, basis).pipe(locked, Effect.withSpan("Ledger.appendMailboxAck"));
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
      const cut = Effect.map(end, (head) => ({ head, incarnation: instance }));

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

      // Conditional within this process, under the file's lock, which is as far as the test
      // double needs it to be.
      const appendCommand = (operation: string, json: string) =>
        Effect.gen(function* () {
          const existing = yield* commandLines(Number.MAX_SAFE_INTEGER);
          if (existing.some((line) => line.operation === operation)) return;
          yield* fs
            .writeFileString(
              file,
              `${JSON.stringify({ "@command": operation, command: json })}\n`,
              { flag: "a" }
            )
            .pipe(Effect.mapError(ledgerError));
        }).pipe(locked, Effect.withSpan("Ledger.appendCommand"));

      const decodeCommand = Schema.decodeUnknownOption(AddressCommandJson, {
        onExcessProperty: "error",
      });
      const undecodable = (t: number) =>
        Effect.fail(new LedgerError({ message: `A ledger entry at t=${t} could not be decoded.` }));
      const log = (upTo: number) =>
        Effect.gen(function* () {
          const logged: Array<Logged> = [];
          for (const found of yield* lines(upTo)) {
            const t = found.end;
            let text = found.text;
            if (text.startsWith(START_MARK)) {
              const wrapped = decodeStartLine(text);
              const record = Option.flatMap(wrapped, (line) =>
                decodeMailboxRecord(line["@mailboxStart"])
              );
              if (
                Option.isNone(wrapped) ||
                Option.isNone(record) ||
                record.value.kind !== "start"
              ) {
                return yield* undecodable(t);
              }
              if (wrapped.value.message === null) continue;
              text = wrapped.value.message;
            } else if (text.startsWith(ACK_MARK)) {
              const wrapped = decodeAckLine(text);
              const record = Option.flatMap(wrapped, (line) =>
                decodeMailboxRecord(line["@mailboxAck"])
              );
              if (Option.isNone(record) || record.value.kind !== "ack")
                return yield* undecodable(t);
              continue;
            }
            if (text.startsWith(COMMAND_MARK)) {
              const line = decodeCommandLine(text);
              const command = Option.flatMap(line, (value) => decodeCommand(value.command));
              if (Option.isNone(line) || Option.isNone(command)) return yield* undecodable(t);
              logged.push({
                kind: "command",
                t,
                operation: line.value["@command"],
                command: command.value,
              });
              continue;
            }
            const message = decode(text);
            const decoded = yield* Effect.option(message);
            // A line that can't be read may have been a presence, as Fluree's damaged node is.
            if (Option.isNone(decoded)) return yield* undecodable(t);
            if (decoded.value.kind === "presence") {
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
        instance,
        append,
        readWitness: () =>
          Effect.fail(new LedgerError({ message: "Guarded designations need Fluree." })),
        designate: () =>
          Effect.fail(new LedgerError({ message: "Guarded designations need Fluree." })),
        read,
        readAt,
        end,
        changes,
        presenceAt,
        admit,
        mailboxAt,
        mailboxReceiptAt,
        admitWithStart,
        importMailbox,
        appendMailboxAck,
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
