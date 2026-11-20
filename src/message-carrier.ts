import { Effect, Schema } from "effect";
import { InvalidQuery, type Message, MessageJson } from "./domain.ts";

/**
 * The most bytes one new message's public read carrier may take: every creator of a message
 * entry (publish, directory and bulletin notices) checks it before its single write, so any one
 * commit fits a reader whose result budget is at least this. Stored entries are never re-checked.
 */
export const MAX_ENTRY_CARRIER_BYTES = 1_048_576;

/** The largest JSON array of listed wake-notice rows. A publish receipt must fit after the write. */
export const WAKE_LISTED_BYTES = 4096;

/** The longest joined working directory, which every later entry from the address records. */
export const MAX_ORIGIN_CWD_BYTES = 4096;

/**
 * The most UTF-8 bytes one full-text-indexed value may hold: a message's body or subject, or a
 * presence's generated body. Fluree 4.2.4 writes each term's byte length and each value's
 * distinct-term count as unchecked 16-bit numbers (fluree-db-binary-index/src/arena/fulltext.rs
 * :267, :276), and either past 65,535 corrupts the index. Lowercasing grows text at most 1.5
 * times, so a value of 32,768 bytes indexes as at most 49,152: no term can reach 65,536 bytes,
 * and it holds at most about 24,576 tokens; stopwords only delete and stemming never lengthens a
 * long term.
 */
export const MAX_INDEXED_FIELD_BYTES = 32_768;

/** Whether one full-text-indexed value fits; the single test every caller and the store share. */
export const indexable = (text: string | undefined) =>
  text === undefined || Buffer.byteLength(text, "utf8") <= MAX_INDEXED_FIELD_BYTES;

/** A presence's generated searchable body. */
export const presenceText = (address: string, status: "joined" | "left") => `${address} ${status}`;

/**
 * Why an address can't be joined, renewed or taken over, or undefined when it can: every join and
 * leave records it in a searchable presence body, `<address> joined` or `<address> left`.
 */
export const unjoinable = (address: string) =>
  indexable(presenceText(address, "joined")) && indexable(presenceText(address, "left"))
    ? undefined
    : `This address takes ${Buffer.byteLength(address, "utf8")} UTF-8 bytes, so the presence every join and leave records for it would be over the ${MAX_INDEXED_FIELD_BYTES}-byte limit for searchable text. Nothing was changed. Join under a shorter address.`;

/**
 * The ledger's own check before it sends an entry: callers refuse first, so this is reached only
 * by a caller that skipped them. A definite refusal; nothing was sent.
 */
export const storable = (message: Message) =>
  indexable(message.body) && indexable(message.subject)
    ? Effect.void
    : Effect.fail(
        new InvalidQuery({
          message: `This entry's body or subject is over the ${MAX_INDEXED_FIELD_BYTES}-byte limit for searchable text, so the ledger did not send it. Nothing was sent or written.`,
        })
      );

/**
 * The most bytes the ledger's point read of one entry reads (Fluree's whole-entry JSON-LD
 * bound). A retried send is settled by that read, so an entry it can't read back can't be
 * retried: every new send is sized against it before its write.
 */
export const ENTRY_READ_BYTES = 32 * 1024 * 1024;

/** Room in that read for all but the stored encoding: the row's brackets, its commit t, framing. */
const ENTRY_READ_ROW_BYTES = 1024;

/** The most bytes one stored encoding may take in the point read's response. */
export const MAX_STORED_ENTRY_BYTES = ENTRY_READ_BYTES - ENTRY_READ_ROW_BYTES;

const encodeEntry = Schema.encodeSync(MessageJson);

/**
 * The bytes an entry's stored encoding takes in a read response: the whole entry as stored,
 * pierce set included, written as a JSON string, with every non-ASCII UTF-16 unit counted as a
 * six-byte `\uXXXX` escape, the most any JSON writer spends on it.
 */
export const storedReadBytes = (message: Message) => {
  const quoted = JSON.stringify(encodeEntry(message));
  let bytes = 0;
  for (let index = 0; index < quoted.length; index++) {
    bytes += quoted.charCodeAt(index) < 0x80 ? 1 : 6;
  }
  return bytes;
};

/**
 * A new send's check before its first write, after its pierce set is resolved: the entry as
 * stored must fit the point read that settles its retries, or nothing is written.
 */
export const readableEntry = (message: Message, limit = MAX_STORED_ENTRY_BYTES) => {
  const bytes = storedReadBytes(message);
  return bytes <= limit
    ? Effect.void
    : Effect.fail(
        new InvalidQuery({
          message: `This message's stored entry, with its pierce set, would take ${bytes} bytes to read back, over the ${limit}-byte limit. Nothing was sent or written. Pierce fewer recipients, or shorten the message and its audience.`,
        })
      );
};

/** The explicit public projection reads return: never presence, pierce or other internals. */
export const publicMessages = (messages: ReadonlyArray<Message>) => ({
  messages: messages.map((message) => ({
    id: message.id,
    ts: message.ts,
    from: message.from,
    to: message.to,
    kind: message.kind,
    body: message.body,
    ...(message.subject === undefined ? {} : { subject: message.subject }),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    ...(message.origin === undefined
      ? {}
      : {
          origin: {
            host: message.origin.host,
            ...(message.origin.cwd === undefined ? {} : { cwd: message.origin.cwd }),
            ...(message.origin.repo === undefined ? {} : { repo: message.origin.repo }),
            ...(message.origin.branch === undefined ? {} : { branch: message.origin.branch }),
          },
        }),
  })),
});

/** Exact JSON bytes of the duplicated public MCP result, excluding the JSON-RPC envelope. */
export const messageCarrierBytes = (messages: ReadonlyArray<Message>) => {
  const structuredContent = publicMessages(messages);
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    }),
    "utf8"
  );
};

/**
 * Refuses, before anything is written, a new message whose read carrier exceeds its bound or
 * whose body or subject is over the searchable-text bound.
 */
export const admitEntry = (message: Message) => {
  for (const [field, text] of [
    ["body", message.body],
    ["subject", message.subject],
  ] as const) {
    if (!indexable(text)) {
      return Effect.fail(
        new InvalidQuery({
          message: `This message's ${field} takes ${Buffer.byteLength(text ?? "", "utf8")} UTF-8 bytes, over the ${MAX_INDEXED_FIELD_BYTES}-byte limit for searchable text. Nothing was sent or written. Keep it shorter and link to longer content (a file path, URL or commit).`,
        })
      );
    }
  }
  const bytes = messageCarrierBytes([message]);
  return bytes <= MAX_ENTRY_CARRIER_BYTES
    ? Effect.void
    : Effect.fail(
        new InvalidQuery({
          message: `This message is too large: as a reader receives it, with both its text and structured copies and their JSON escaping, it takes ${bytes} bytes, over the ${MAX_ENTRY_CARRIER_BYTES}-byte limit. Nothing was sent or written. Keep the message short and link to large content (a file path, URL or commit) instead.`,
        })
      );
};
