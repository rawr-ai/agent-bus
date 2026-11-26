import { Effect, Schema } from "effect";
import { InvalidQuery, type Message, MessageJson } from "./domain.ts";

/**
 * The most bytes one new message's full v1 public carrier may take: every creator of a message
 * entry (publish, directory and bulletin notices) checks it before its single write, so any one
 * commit fits a reader whose result budget is at least this plus {@link READ_METADATA_BYTES} (a
 * peek's receipt also names its ledger and served digest). Stored entries are never re-checked.
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

/** Every field an inbox reader needs to understand and reply to the complete message. */
const inboxMessage = (message: Message) => ({
  id: message.id,
  ts: message.ts,
  from: message.from,
  to: message.to,
  kind: message.kind,
  body: message.body,
  ...(message.subject === undefined ? {} : { subject: message.subject }),
  ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
});

/** Historical public projection used by write admission and persisted v1 acknowledgement evidence. */
export const publicMessages = (messages: ReadonlyArray<Message>) => ({
  messages: messages.map((message) => ({
    ...inboxMessage(message),
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

/**
 * Exact JSON bytes of a duplicated public MCP result, excluding the JSON-RPC envelope: the
 * structured content once as itself and once as escaped text, both counted. Key order does not
 * change the count.
 */
export const carrierBytes = (structuredContent: object) =>
  Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    }),
    "utf8"
  );

/** Exact JSON bytes of a carrier of messages alone: the single-message bound every writer checks. */
export const messageCarrierBytes = (messages: ReadonlyArray<Message>) =>
  carrierBytes(publicMessages(messages));

/** A read id: a lowercase UUIDv7, always 36 ASCII characters. */
export const READ_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Stands in for any read id when a size is measured; every read id has its length. */
const SIZING_ID = "00000000-0000-7000-8000-000000000000";

/** What a read or peek acknowledged, or would. A peek's receipt adds what `bus_ack` checks. */
export interface ReadReceipt {
  readonly readId: string;
  readonly from: number;
  readonly through: number;
  readonly replayed: boolean;
  /** Peek only: the ledger incarnation and commit the peek read at. */
  readonly basis?: { readonly ledger: string; readonly t: number };
  /** Peek only: how many messages it served and the digest of their ordered ids. */
  readonly served?: { readonly count: number; readonly digest: string };
}

const readMetadata = (receipt: ReadReceipt | undefined, nextReadId: string) => ({
  ...(receipt === undefined
    ? {}
    : {
        receipt: {
          readId: receipt.readId,
          from: receipt.from,
          through: receipt.through,
          replayed: receipt.replayed,
          ...(receipt.basis === undefined
            ? {}
            : { basis: { ledger: receipt.basis.ledger, t: receipt.basis.t } }),
          ...(receipt.served === undefined
            ? {}
            : { served: { count: receipt.served.count, digest: receipt.served.digest } }),
        },
      }),
  nextReadId,
});

/** Use the full v1 shape for durable evidence and for conservative, cross-version byte admission. */
export const readResult = (
  messages: ReadonlyArray<Message>,
  receipt: ReadReceipt | undefined,
  nextReadId: string
) => ({ ...publicMessages(messages), ...readMetadata(receipt, nextReadId) });

/** Origin belongs in history and exact-message lookup, not repeated on each ordinary inbox row. */
export const inboxResult = (
  messages: ReadonlyArray<Message>,
  receipt: ReadReceipt | undefined,
  nextReadId: string
) => ({ messages: messages.map(inboxMessage), ...readMetadata(receipt, nextReadId) });

/**
 * The bytes an acknowledgement records as its carrier: the read-shaped public result of exactly
 * that batch, with a receipt saying `replayed: false` and a 36-character `nextReadId`. A read
 * budgets that size and a replay two bytes less (`true`, in each copy), so a batch that fitted
 * fits again even with the old projection. A peek's receipt is larger, but `bus_ack` records
 * this same canonical size. It is compared on replay and never used to compute a position.
 */
export const servedCarrierBytes = (
  messages: ReadonlyArray<Message>,
  from: number,
  through: number
) =>
  carrierBytes(
    readResult(messages, { readId: SIZING_ID, from, through, replayed: false }, SIZING_ID)
  );

/** The smallest complete read result: no mail, only `nextReadId`. The read limits' minimum. */
export const EMPTY_READ_RESULT_BYTES = carrierBytes(readResult([], undefined, SIZING_ID));

/** The most a read receipt and `nextReadId` add to a carrier of messages, at the widest positions. */
export const READ_METADATA_BYTES =
  carrierBytes(
    readResult(
      [],
      {
        readId: SIZING_ID,
        from: Number.MAX_SAFE_INTEGER,
        through: Number.MAX_SAFE_INTEGER,
        replayed: false,
      },
      SIZING_ID
    )
  ) - messageCarrierBytes([]);

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
          message: `This message is too large: including origin, text and structured copies and their JSON escaping, it takes ${bytes} bytes, over the ${MAX_ENTRY_CARRIER_BYTES}-byte limit. Nothing was sent or written. Keep the message short and link to large content (a file path, URL or commit) instead.`,
        })
      );
};
