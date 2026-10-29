import { Schema } from "effect";

/** The agent runtime behind an address; it decides how the bus delivers to it. */
export const Runtime = Schema.Literals(["claude", "codex", "human", "other"]);
export type Runtime = typeof Runtime.Type;

/** Where an entry was written from. `repo` and `branch` are optional metadata for queries. */
export class Origin extends Schema.Class<Origin>("Origin")({
  host: Schema.String.annotate({ description: "The machine it was written on." }),
  cwd: Schema.optionalKey(
    Schema.String.annotate({ description: "The writer's working directory." })
  ),
  repo: Schema.optionalKey(
    Schema.String.annotate({ description: "The Git repository at cwd, by its top-level path." })
  ),
  branch: Schema.optionalKey(
    Schema.String.annotate({ description: "The branch checked out there." })
  ),
}) {}

/**
 * A subscriber's announcement. The latest presence per address is that peer's
 * state, and its owner is the session that may use the address: `runtime` and
 * `session`, the runtime's own id for it (a Codex thread id, a Claude Code
 * session id). Presences written before addresses had owners have no session.
 */
export class Presence extends Schema.Class<Presence>("Presence")({
  runtime: Runtime,
  status: Schema.Literals(["joined", "left"]),
  topics: Schema.Array(Schema.String),
  session: Schema.optionalKey(Schema.String),
  /** The join this one took over from a different session. */
  takeover: Schema.optionalKey(Schema.String),
  /**
   * The first join of the run this one continues: the same session joining
   * again while joined, without replay. Delivery carries its wake state over
   * such a rejoin.
   */
  rejoinOf: Schema.optionalKey(Schema.String),
  codexThreadId: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
}) {}

/**
 * One ledger entry. Recipients in `to` are addresses, `#topic` for topic
 * subscribers, or `*` for every peer.
 */
export class Message extends Schema.Class<Message>("Message")({
  id: Schema.String.annotate({ description: "The message's id, which replies name in replyTo." }),
  ts: Schema.String.annotate({ description: "When it was sent (ISO 8601)." }),
  from: Schema.String.annotate({ description: "The sender's address." }),
  to: Schema.Array(Schema.String).annotate({
    description: "Its recipients: addresses, #topic or *.",
  }),
  kind: Schema.Literals(["message", "presence"]).annotate({
    description: "message, or presence for a join or leave announcement.",
  }),
  subject: Schema.optionalKey(Schema.String.annotate({ description: "Its subject line." })),
  body: Schema.String.annotate({ description: "The message text." }),
  replyTo: Schema.optionalKey(
    Schema.String.annotate({ description: "The id of the message it answers." })
  ),
  origin: Schema.optionalKey(Origin),
  presence: Schema.optionalKey(Presence),
}) {}

export const MessageJson = Schema.fromJsonString(Message);

export class LedgerError extends Schema.TaggedError<LedgerError>()("LedgerError", {
  message: Schema.String,
}) {}

export class NotJoined extends Schema.TaggedError<NotJoined>()("NotJoined", {
  address: Schema.String,
  message: Schema.String,
}) {}

/**
 * A usable session id: present, not blank, and not a configuration
 * placeholder that was never expanded (`${CLAUDE_CODE_SESSION_ID}`, `$VAR`).
 */
export const validSession = (session: string | undefined): session is string =>
  session !== undefined &&
  session.trim() !== "" &&
  !session.includes("${") &&
  !session.startsWith("$");

/** The bus refused a call that isn't from the address's owner; nothing changed. */
export class NotOwner extends Schema.TaggedError<NotOwner>()("NotOwner", {
  address: Schema.String,
  message: Schema.String,
}) {}

export interface Subscriber {
  readonly address: string;
  readonly presence: Presence;
  /** Id of the presence entry that made this the peer's current state. */
  readonly joinId: string;
  /** When that presence was written. */
  readonly since?: string | undefined;
  /** The machine the peer joined from; only that machine's bus delivers to it. */
  readonly host?: string | undefined;
  /** The peer's working directory, which locates the messages it sends. */
  readonly cwd?: string | undefined;
}

/** Whether a message should be delivered to a subscriber. Senders never receive their own. */
export const isFor = (message: Message, subscriber: Subscriber): boolean =>
  message.kind === "message" &&
  message.from !== subscriber.address &&
  message.to.some(
    (recipient) =>
      recipient === "*" ||
      recipient === subscriber.address ||
      (recipient.startsWith("#") && subscriber.presence.topics.includes(recipient.slice(1)))
  );

/** Host names compare without case or domain, which macOS varies (`.local`, `.lan`). */
export const machine = (host: string) => (host.split(".")[0] ?? host).toLowerCase();
