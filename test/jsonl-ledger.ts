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
  type EntryRead,
  Ledger,
  type MailboxReceiptRead,
  type MailboxWrite,
  messageIri,
} from "../src/Ledger.ts";
import {
  decodeMailboxFact,
  encodeMailboxFact,
  type MailboxAck,
  type MailboxRecord,
  MailboxRecord as MailboxRecordSchema,
  type MailboxStart,
  type MailboxState,
  type MailboxUnresolved,
  mailboxFactOf,
  mailboxIntentMatches,
  mailboxIri,
  mailboxRunRef,
  type StoredMailboxRecord,
  validMailboxFactAt,
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

/** The double can scan its file to validate the whole predecessor chain at a byte cut. */
const resolveMailbox = (
  records: ReadonlyArray<StoredMailboxRecord>,
  mailbox: string,
  head: number,
  incarnation: string
) =>
  Effect.gen(function* () {
    let current: StoredMailboxRecord | undefined;
    let position: number | undefined;
    let unresolved: MailboxUnresolved["reason"] | undefined;
    let previousT = 0;
    const operations = new Set<string>();
    for (const item of records) {
      const { record, t } = item;
      if (
        !Number.isSafeInteger(t) ||
        t <= previousT ||
        t > head ||
        operations.has(record.operation)
      ) {
        return yield* ledgerError(`A mailbox entry at t=${t} could not be established.`);
      }
      previousT = t;
      operations.add(record.operation);
      if (record.mailbox !== mailbox) continue;
      if (
        !validMailboxFactAt(record, t, incarnation) ||
        record.previous !== (current?.record.operation ?? null) ||
        (record.kind !== "unresolved" && record.runRef === mailboxRunRef(""))
      ) {
        return yield* ledgerError(`A mailbox entry at t=${t} could not be established.`);
      }
      if (record.kind === "unresolved") {
        if (current !== undefined)
          return yield* ledgerError(`A mailbox entry at t=${t} could not be established.`);
        unresolved = record.reason;
      } else if (record.kind === "start") {
        if (
          (record.origin === "import" && current !== undefined) ||
          ((record.origin === "reconcile" || record.origin === "restart") &&
            unresolved === undefined) ||
          ((record.origin === "join" || record.origin === "replay") && unresolved !== undefined) ||
          (record.origin === "restart" && record.position < (current?.t ?? 0))
        ) {
          return yield* ledgerError(`A mailbox entry at t=${t} could not be established.`);
        }
        position = record.position;
        unresolved = undefined;
      } else {
        if (position === undefined || record.from !== position)
          return yield* ledgerError(`A mailbox entry at t=${t} could not be established.`);
        position = record.through;
      }
      current = item;
    }
    if (current === undefined) return { status: "ABSENT" } satisfies MailboxState;
    if (unresolved !== undefined) {
      return { status: "UNRESOLVED", reason: unresolved, current } satisfies MailboxState;
    }
    if (position === undefined) return yield* ledgerError("A mailbox position is missing.");
    return { status: "FOUND", position, current } satisfies MailboxState;
  });

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
      const decodeCommandLine = Schema.decodeUnknownOption(CommandLine, {
        onExcessProperty: "error",
      });
      const startLine = Schema.decodeUnknownOption(StartLine, { onExcessProperty: "error" });
      const ackLine = Schema.decodeUnknownOption(AckLine, { onExcessProperty: "error" });
      const decodeStartLine = (text: string) =>
        Option.filter(
          startLine(text),
          (line) =>
            JSON.stringify({ "@mailboxStart": line["@mailboxStart"], message: line.message }) ===
            text
        );
      const decodeAckLine = (text: string) =>
        Option.filter(
          ackLine(text),
          (line) => JSON.stringify({ "@mailboxAck": line["@mailboxAck"] }) === text
        );
      const validateMailbox = Schema.decodeUnknownEffect(MailboxRecordSchema, {
        onExcessProperty: "error",
      });
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
            } else if (text.startsWith(COMMAND_MARK)) {
              // An address command is standing evidence, never mail.
              text = "";
            }
            if (text.trim() !== "") {
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
          if (start !== undefined) {
            yield* snapshotLines(basis);
            if (Option.isNone(yield* Effect.option(mailboxLines(basis)))) {
              return { status: "UNKNOWN" } satisfies Admission;
            }
          }
          let startJson: string | undefined;
          if (start !== undefined) {
            if (
              start.origin === "import" ||
              start.origin === "reconcile" ||
              message.kind !== "presence" ||
              message.presence?.status !== "joined" ||
              start.address !== message.from ||
              start.operation !== message.id ||
              start.run !== (message.presence.rejoinOf ?? message.id)
            ) {
              return yield* ledgerError("Invalid mailbox start.");
            }
            yield* validateMailbox(start).pipe(Effect.mapError(ledgerError));
            const messageJson = yield* encode(message).pipe(Effect.mapError(ledgerError));
            const current = { head: yield* end, incarnation: instance };
            const already = yield* mailboxReceiptAt(start.address, start.operation, current);
            if (already.status === "ADDRESS_MISMATCH") {
              return { status: "REFUSED", cut: current } satisfies Admission;
            }
            if (already.status === "MALFORMED" || already.status === "UNAVAILABLE") {
              return { status: "UNKNOWN" } satisfies Admission;
            }
            const complete = yield* Effect.option(readWithin(0, current.head, true));
            if (Option.isNone(complete)) return { status: "UNKNOWN" } satisfies Admission;
            const entries = complete.value.entries.filter(
              (entry) => entry.message.id === message.id
            );
            if (already.status === "FOUND") {
              if (!mailboxIntentMatches(start, already.record))
                return { status: "REFUSED", cut: current } satisfies Admission;
              const entry = entries.length === 1 ? entries[0] : undefined;
              if (entry === undefined || entry.end !== already.t) {
                return { status: "UNKNOWN" } satisfies Admission;
              }
              const savedMessage = yield* encode(entry.message).pipe(Effect.mapError(ledgerError));
              const original = (yield* lines(already.t)).at(-1);
              const wrapped =
                original === undefined ? Option.none() : decodeStartLine(original.text);
              if (
                original?.end !== already.t ||
                Option.isNone(wrapped) ||
                wrapped.value.message !== savedMessage
              ) {
                return { status: "UNKNOWN" } satisfies Admission;
              }
              return wrapped.value.message === messageJson
                ? ({
                    status: "ADMITTED",
                    cut: { head: already.t, incarnation: instance },
                  } satisfies Admission)
                : ({ status: "REFUSED", cut: current } satisfies Admission);
            }
            if (entries.length > 1) return { status: "UNKNOWN" } satisfies Admission;
            if (entries.length === 1)
              return { status: "REFUSED", cut: current } satisfies Admission;
            if (start.position > basis.head) return yield* ledgerError("Invalid mailbox start.");
            yield* mailboxLines({ head: start.position, incarnation: basis.incarnation });
            const mailbox = mailboxIri(start.address);
            const prior = yield* mailboxLines(basis);
            const now = yield* mailboxLines(current);
            const priorState = yield* resolveMailbox(prior, mailbox, basis.head, instance);
            yield* resolveMailbox(now, mailbox, current.head, instance);
            if (now.some((row) => row.t > basis.head && row.record.mailbox === mailbox)) {
              return { status: "REFUSED", cut: current } satisfies Admission;
            }
            if (
              (start.origin === "restart" &&
                (priorState.status !== "UNRESOLVED" || start.position !== basis.head)) ||
              (start.origin !== "restart" && priorState.status === "UNRESOLVED")
            ) {
              return { status: "REFUSED", cut: current } satisfies Admission;
            }
            const fact = mailboxFactOf(
              start,
              priorState.status === "ABSENT" ? null : priorState.current.record.operation
            );
            startJson = encodeMailboxFact(fact);
            yield* resolveMailbox(
              [...prior, { record: fact, t: basis.head + 1 }],
              mailbox,
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
                    decodeMailboxFact(wrapped.value["@mailboxAck"]),
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
                    decodeMailboxFact(wrapped.value["@mailboxStart"]),
                    (record) => record.kind === "start" || record.kind === "unresolved"
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
      const snapshotLines = (at: Pin) =>
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
          return found;
        });
      const mailboxLines = (at: Pin) =>
        Effect.gen(function* () {
          const found = yield* snapshotLines(at);
          const commits = new Set([0, ...found.map((line) => line.end)]);
          const records: Array<StoredMailboxRecord> = [];
          for (const { text, end: t } of found) {
            if (text.startsWith(START_MARK)) {
              const line = decodeStartLine(text);
              const value = Option.flatMap(line, (item) =>
                decodeMailboxFact(item["@mailboxStart"])
              );
              if (
                Option.isNone(line) ||
                Option.isNone(value) ||
                (value.value.kind !== "start" && value.value.kind !== "unresolved") ||
                !validMailboxFactAt(value.value, t, instance)
              ) {
                return yield* ledgerError(`A mailbox entry at t=${t} could not be established.`);
              }
              if (value.value.kind === "unresolved") {
                if (line.value.message !== null)
                  return yield* ledgerError("An unresolved import cannot contain a presence.");
              } else if (!commits.has(value.value.position)) {
                return yield* ledgerError("A mailbox start does not name a complete commit.");
              } else if (line.value.message === null) {
                if (value.value.origin !== "import" && value.value.origin !== "reconcile")
                  return yield* ledgerError("A mailbox start lost its presence.");
              } else {
                const message = yield* Effect.option(decode(line.value.message));
                if (
                  value.value.origin === "import" ||
                  value.value.origin === "reconcile" ||
                  Option.isNone(message) ||
                  message.value.kind !== "presence" ||
                  message.value.presence?.status !== "joined" ||
                  message.value.id !== value.value.operation ||
                  mailboxIri(message.value.from) !== value.value.mailbox ||
                  mailboxRunRef(message.value.presence.rejoinOf ?? message.value.id) !==
                    value.value.runRef
                ) {
                  return yield* ledgerError("A mailbox start does not match its presence.");
                }
                const canonical = yield* encode(message.value).pipe(Effect.mapError(ledgerError));
                if (canonical !== line.value.message) {
                  return yield* ledgerError("A mailbox start's presence is not canonical.");
                }
              }
              records.push({ record: value.value, t });
            } else if (text.startsWith(ACK_MARK)) {
              const line = decodeAckLine(text);
              const value = Option.flatMap(line, (item) => decodeMailboxFact(item["@mailboxAck"]));
              if (
                Option.isNone(line) ||
                Option.isNone(value) ||
                value.value.kind !== "ack" ||
                !validMailboxFactAt(value.value, t, instance)
              ) {
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
              records.push({ record: value.value, t });
            }
          }
          return records;
        });
      const mailboxAt = (address: string, at: Pin) =>
        Effect.flatMap(mailboxLines(at), (records) =>
          resolveMailbox(records, mailboxIri(address), at.head, at.incarnation)
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
          return {
            ...slice,
            entries: slice.entries.map((entry) => ({
              ...entry,
              subject: messageIri(entry.message.id),
            })),
          };
        }).pipe(Effect.withSpan("Ledger.readAt"));
      const mailboxCandidatesAt = (from: number, at: Pin) =>
        Effect.gen(function* () {
          if (!Number.isSafeInteger(from) || from < 0 || from > at.head) {
            return yield* ledgerError("Invalid entry snapshot.");
          }
          yield* mailboxLines(at);
          yield* mailboxLines({ head: from, incarnation: at.incarnation });
          const slice = yield* readWithin(from, at.head, true);
          return slice.entries.flatMap(({ message, end }) =>
            message.kind === "message"
              ? [
                  {
                    subject: messageIri(message.id),
                    end,
                    routing: { id: message.id, from: message.from, to: [...new Set(message.to)] },
                  },
                ]
              : []
          );
        }).pipe(Effect.withSpan("Ledger.mailboxCandidatesAt"));
      const mailboxReceiptAt = (address: string, operation: string, at: Pin) =>
        Effect.gen(function* () {
          const all = yield* mailboxLines(at);
          const records = all.filter((item) => item.record.operation === operation);
          const [only] = records;
          if (only === undefined) {
            yield* resolveMailbox(all, mailboxIri(address), at.head, at.incarnation);
            return { status: "ABSENT", cut: at } satisfies MailboxReceiptRead;
          }
          if (records.length !== 1)
            return { status: "MALFORMED", cut: at } satisfies MailboxReceiptRead;
          const state = yield* resolveMailbox(all, only.record.mailbox, at.head, at.incarnation);
          if (state.status === "ABSENT")
            return { status: "MALFORMED", cut: at } satisfies MailboxReceiptRead;
          if (only.record.mailbox !== mailboxIri(address)) {
            return { status: "ADDRESS_MISMATCH", cut: at } satisfies MailboxReceiptRead;
          }
          return {
            status: "FOUND",
            record: only.record,
            t: only.t,
            cut: at,
          } satisfies MailboxReceiptRead;
        }).pipe(Effect.orElseSucceed((): MailboxReceiptRead => ({ status: "UNAVAILABLE" })));
      const writeMailbox = (record: MailboxRecord, basis: Pin) =>
        Effect.gen(function* () {
          yield* validateMailbox(record).pipe(Effect.mapError(ledgerError));
          yield* snapshotLines(basis);
          if (Option.isNone(yield* Effect.option(mailboxLines(basis)))) {
            return { status: "UNKNOWN" } satisfies MailboxWrite;
          }
          const current = { head: yield* end, incarnation: instance };
          const existing = yield* mailboxReceiptAt(record.address, record.operation, current);
          if (existing.status === "FOUND") {
            return mailboxIntentMatches(record, existing.record)
              ? ({
                  status: "APPLIED",
                  cut: { head: existing.t, incarnation: instance },
                } satisfies MailboxWrite)
              : ({ status: "IDENTITY_MISMATCH", cut: current } satisfies MailboxWrite);
          }
          if (existing.status === "ADDRESS_MISMATCH")
            return { status: "IDENTITY_MISMATCH", cut: current } satisfies MailboxWrite;
          if (existing.status !== "ABSENT") return { status: "UNKNOWN" } satisfies MailboxWrite;
          const mailbox = mailboxIri(record.address);
          const priorRows = yield* mailboxLines(basis);
          const currentRows = yield* mailboxLines(current);
          const prior = yield* resolveMailbox(priorRows, mailbox, basis.head, basis.incarnation);
          yield* resolveMailbox(currentRows, mailbox, current.head, current.incarnation);
          if (currentRows.some((row) => row.t > basis.head && row.record.mailbox === mailbox)) {
            return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
          }
          if (record.kind === "unresolved") {
            if (prior.status !== "ABSENT")
              return { status: "CONFLICT", cut: current } satisfies MailboxWrite;
          } else if (record.kind === "start") {
            if (
              (record.origin !== "import" && record.origin !== "reconcile") ||
              record.position > basis.head ||
              (record.origin === "import" && prior.status !== "ABSENT") ||
              (record.origin === "reconcile" && prior.status !== "UNRESOLVED")
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
          const fact = mailboxFactOf(
            record,
            prior.status === "ABSENT" ? null : prior.current.record.operation
          );
          const json = encodeMailboxFact(fact);
          yield* resolveMailbox(
            [...priorRows, { record: fact, t: basis.head + 1 }],
            mailbox,
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
            record.kind === "ack"
              ? { "@mailboxAck": json }
              : { "@mailboxStart": json, message: null };
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
      const classifyMailboxImport = (unresolved: MailboxUnresolved, basis: Pin) =>
        writeMailbox(unresolved, basis).pipe(
          locked,
          Effect.withSpan("Ledger.classifyMailboxImport")
        );
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
                decodeMailboxFact(line["@mailboxStart"])
              );
              if (
                Option.isNone(wrapped) ||
                Option.isNone(record) ||
                (record.value.kind !== "start" && record.value.kind !== "unresolved")
              ) {
                return yield* undecodable(t);
              }
              if (wrapped.value.message === null) continue;
              text = wrapped.value.message;
            } else if (text.startsWith(ACK_MARK)) {
              const wrapped = decodeAckLine(text);
              const record = Option.flatMap(wrapped, (line) =>
                decodeMailboxFact(line["@mailboxAck"])
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

      // As Fluree's point read: a line naming the id that does not decode to exactly one entry
      // with that id is MALFORMED, never ABSENT.
      const readEntry = (id: string) =>
        Effect.gen(function* () {
          const at = yield* cut;
          const found: Array<{ readonly message: Message; readonly t: number }> = [];
          let damaged = false;
          for (const { text, end: t } of yield* lines(at.head)) {
            if (text.trim() === "" || text.startsWith(COMMAND_MARK) || text.startsWith(ACK_MARK))
              continue;
            let carrier = text;
            if (text.startsWith(START_MARK)) {
              const wrapped = decodeStartLine(text);
              if (Option.isNone(wrapped)) {
                if (text.includes(id)) damaged = true;
                continue;
              }
              if (wrapped.value.message === null) continue;
              carrier = wrapped.value.message;
            }
            const decoded = yield* Effect.option(decode(carrier));
            if (Option.isSome(decoded)) {
              if (decoded.value.id === id) found.push({ message: decoded.value, t });
            } else if (carrier.includes(id)) {
              damaged = true;
            }
          }
          const [only] = found;
          if (only === undefined && !damaged)
            return { status: "ABSENT", cut: at } satisfies EntryRead;
          if (only === undefined || damaged || found.length > 1) {
            return { status: "MALFORMED", cut: at } satisfies EntryRead;
          }
          return { status: "FOUND", message: only.message, t: only.t, cut: at } satisfies EntryRead;
        }).pipe(Effect.orElseSucceed((): EntryRead => ({ status: "UNAVAILABLE" })));

      return Ledger.of({
        instance,
        append,
        readWitness: () =>
          Effect.fail(new LedgerError({ message: "Guarded designations need Fluree." })),
        designate: () =>
          Effect.fail(new LedgerError({ message: "Guarded designations need Fluree." })),
        read,
        readAt,
        mailboxCandidatesAt,
        end,
        changes,
        presenceAt,
        ownershipEraAt: () => ledgerError("A JSONL fixture has no Fluree ownership era."),
        activateOwnershipEra: () => ledgerError("A JSONL fixture has no Fluree ownership era."),
        admit,
        mailboxAt,
        mailboxReceiptAt,
        admitWithStart,
        classifyMailboxImport,
        importMailbox,
        appendMailboxAck,
        appendCommand,
        readCommand,
        log,
        direct,
        readEntry,
      });
    })
  ).pipe(
    // No query engine: every query refuses, as the design keeps JSONL to delivery.
    Layer.merge(QueryGateway.layerUnavailable)
  );
