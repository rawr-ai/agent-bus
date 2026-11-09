import { Option, Schema } from "effect";

/** The agent runtime behind an address; it decides how the bus delivers to it. */
export const Runtime = Schema.Literals(["claude", "codex", "human", "other"]);
export type Runtime = typeof Runtime.Type;

/** Stable, case-sensitive names within the orientation directory. */
export const OrientationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
);

/** An address's explicit relationship to a directory and its concerns. */
export const Association = Schema.Struct({
  directory: OrientationId.annotate({ description: "The directory's stable id." }),
  concerns: Schema.Array(OrientationId).annotate({
    description:
      "Explicit concern ids within the directory; an empty list associates only the directory.",
  }),
});
export type Association = typeof Association.Type;
export const MAX_ASSOCIATION_BYTES = 16_384;
export const MAX_ASSOCIATED_ADDRESS_BYTES = 512;

/** Association arrays are sets; a directory can be named more than once. */
export const canonicalAssociations = (entries: ReadonlyArray<Association>): Array<Association> => {
  const groups = new Map<string, Set<string>>();
  for (const entry of entries) {
    const concerns = groups.get(entry.directory) ?? new Set<string>();
    for (const concern of entry.concerns) concerns.add(concern);
    groups.set(entry.directory, concerns);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([directory, concerns]) => ({ directory, concerns: [...concerns].sort() }));
};

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
  /** The installation eligible to wake this join; absent in hostname-routed records. */
  installation: Schema.optionalKey(Schema.String),
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
  /** Absent in legacy presences; the latest presence is never merged with an older one. */
  associations: Schema.optionalKey(Schema.Array(Association)),
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
  /**
   * The recipients a sender confirmed waking despite inactivity or mutes. Never routes: only
   * members of the audience `to` reaches, other than those it names directly. Earlier releases
   * strip it on decode and deliver normally.
   */
  pierce: Schema.optionalKey(Schema.Array(Schema.String)),
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

/**
 * A join or leave refused at its own commit because the address's presence changed after
 * the state it decided on, while that change doesn't itself refuse the call. Nothing was
 * written; calling again decides against the current state.
 */
export class PresenceConflict extends Schema.TaggedError<PresenceConflict>()("PresenceConflict", {
  address: Schema.String,
  message: Schema.String,
}) {}

/**
 * A query or its arguments were refused before or instead of reading the
 * store: a malformed or forbidden query, a stale cursor, a missing record.
 * The message quotes only the caller's own input.
 */
export class InvalidQuery extends Schema.TaggedError<InvalidQuery>()("InvalidQuery", {
  message: Schema.String,
  code: Schema.optionalKey(
    Schema.Literals([
      "RANKING_UNAVAILABLE",
      "EVIDENCE_TOO_LARGE",
      "EVIDENCE_DAMAGED",
      "STALE_LEDGER",
      "NOT_FOUND",
      "WITHHELD",
    ])
  ),
}) {}

/** Safe, machine-readable refusal for the opt-in evidence projection. */
export class SavedQueryRefusal extends Schema.TaggedError<SavedQueryRefusal>()(
  "SavedQueryRefusal",
  {
    code: Schema.Literals([
      "RANKING_UNAVAILABLE",
      "EVIDENCE_TOO_LARGE",
      "EVIDENCE_DAMAGED",
      "STALE_LEDGER",
      "DEADLINE",
      "NOT_FOUND",
      "WITHHELD",
      "INVALID_REQUEST",
      "CAPACITY",
      "SEARCH_TOO_BROAD",
      "UNAVAILABLE",
    ]),
  }
) {}

/**
 * A ranked search could not hold its selection: the bus's retained selections are at capacity,
 * or one selection exceeds its own bounds. Nothing was returned and no cursor was issued.
 */
export class QueryCapacity extends Schema.TaggedError<QueryCapacity>()("QueryCapacity", {
  message: Schema.String,
  selectionTooLarge: Schema.optionalKey(Schema.Literal(true)),
}) {}

/** A join's topic list is malformed; no subscription or cursor was changed. */
export class InvalidTopics extends Schema.TaggedError<InvalidTopics>()("InvalidTopics", {
  message: Schema.String,
}) {}

/** Invalid association input is refused before a join changes a cursor or presence. */
export class InvalidAssociations extends Schema.TaggedError<InvalidAssociations>()(
  "InvalidAssociations",
  { message: Schema.String }
) {}

/** A case-sensitive topic name, accepting one optional # marker and outer whitespace. */
export const topicName = (input: string): string | undefined => {
  const name = input.trim().replace(/^#/, "").trim();
  return name === "" || name.startsWith("#") ? undefined : name;
};

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

/** Whether a `#topic` recipient names one of the subscriber's topics. */
const subscribes = (subscriber: Subscriber, recipient: string) =>
  recipient.startsWith("#") &&
  subscriber.presence.topics.some(
    // Keep literal legacy matching, and accept its valid #prefixed subscriptions too.
    (topic) => topic === recipient.slice(1) || topicName(topic) === recipient.slice(1)
  );

/** Whether a message should be delivered to a subscriber. Senders never receive their own. */
export const isFor = (message: Message, subscriber: Subscriber): boolean =>
  message.kind === "message" &&
  message.from !== subscriber.address &&
  message.to.some(
    (recipient) =>
      recipient === "*" || recipient === subscriber.address || subscribes(subscriber, recipient)
  );

/** The ambient routes by which a message reaches a subscriber: `*` and its matching #topics. */
export const ambientRoutes = (message: Message, subscriber: Subscriber): Array<string> =>
  message.to.filter((recipient) => recipient === "*" || subscribes(subscriber, recipient));

/**
 * Each address's latest presence, joined or left, folded from presence
 * entries oldest first. Joins and leaves from before addresses had owners
 * (no session) are ignored. Delivery folds the presences at head; the query
 * catalogue folds the ones visible at its snapshot, with the same rule.
 */
export const latestPresences = (entries: Iterable<Message>): Map<string, Subscriber> => {
  const latest = new Map<string, Subscriber>();
  for (const message of entries) {
    if (message.presence?.session === undefined) continue;
    latest.set(message.from, {
      address: message.from,
      presence: message.presence,
      joinId: message.id,
      since: message.ts,
      host: message.origin?.host,
      cwd: message.origin?.cwd,
    });
  }
  return latest;
};

/** The run a join belongs to: the first join of a run of ordinary rejoins by one session. */
export const runOf = (subscriber: Subscriber) => subscriber.presence.rejoinOf ?? subscriber.joinId;

// ---- Reachable inactivity ----------------------------------------------------------------------

/**
 * A scope an address mutes: programme `*` mail, one topic, or the concern topics of a
 * directory, or of one of its concerns, as registered when each message commits.
 */
export const MuteScope = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("programme") }),
  Schema.Struct({ scope: Schema.Literal("topic"), topic: Schema.String }),
  Schema.Struct({ scope: Schema.Literal("directory"), directory: OrientationId }),
  Schema.Struct({
    scope: Schema.Literal("concern"),
    directory: OrientationId,
    concern: OrientationId,
  }),
]);
export type MuteScope = typeof MuteScope.Type;

const muteKey = (mute: MuteScope) => {
  switch (mute.scope) {
    case "programme":
      return JSON.stringify([mute.scope]);
    case "topic":
      return JSON.stringify([mute.scope, mute.topic]);
    case "directory":
      return JSON.stringify([mute.scope, mute.directory]);
    case "concern":
      return JSON.stringify([mute.scope, mute.directory, mute.concern]);
  }
};

const decodeMutes = Schema.decodeUnknownOption(Schema.Array(MuteScope), {
  onExcessProperty: "error",
});

/**
 * A mute set in its one stored form: topics named as topicName names them, duplicates merged,
 * in a fixed order. Undefined for anything that is not a set of known scopes.
 */
export const normalizeMutes = (input: unknown): Array<MuteScope> | undefined => {
  const decoded = decodeMutes(input);
  if (Option.isNone(decoded)) return undefined;
  const unique = new Map<string, MuteScope>();
  for (const mute of decoded.value) {
    let normal: MuteScope;
    switch (mute.scope) {
      case "programme":
        normal = { scope: "programme" };
        break;
      case "topic": {
        const topic = topicName(mute.topic);
        if (topic === undefined) return undefined;
        normal = { scope: "topic", topic };
        break;
      }
      case "directory":
        normal = { scope: "directory", directory: mute.directory };
        break;
      case "concern":
        normal = { scope: "concern", directory: mute.directory, concern: mute.concern };
        break;
    }
    unique.set(muteKey(normal), normal);
  }
  return [...unique.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, mute]) => mute);
};

export const ActivityValue = Schema.Literals(["active", "inactive"]);

/**
 * An owner's command, stored as its own node beside messages: `run` is the holder's run when
 * the call was validated, and `ts` when it was written. The frame's representation has no `ts`,
 * so a command without one still decodes; it only leaves `activeSince` unstated. Legacy readers
 * never see it.
 */
export const AddressCommand = Schema.Struct({
  address: Schema.String,
  runtime: Runtime,
  session: Schema.String,
  run: Schema.String,
  ts: Schema.optionalKey(Schema.String),
  activity: Schema.optionalKey(ActivityValue),
  mutes: Schema.optionalKey(Schema.Array(MuteScope)),
});
export type AddressCommand = typeof AddressCommand.Type;
export const AddressCommandJson = Schema.fromJsonString(AddressCommand);

/** A presence entry or a command node at its commit. */
export type Logged =
  | { readonly kind: "presence"; readonly t: number; readonly message: Message }
  | {
      readonly kind: "command";
      readonly t: number;
      readonly operation: string;
      readonly command: AddressCommand;
    };

export type Verdict =
  | { readonly status: "APPLIED" }
  | { readonly status: "CONFLICT"; readonly reason: "not-joined" | "not-holder" | "stale-run" };

/** Where activity was last set: by a reset (active) or an accepted command. */
export interface Anchor {
  readonly value: typeof ActivityValue.Type;
  readonly t: number;
  /** When it was set, or "" when nothing recorded that. */
  readonly ts: string;
}

/** An address's state folded from its presences and commands in commit order. */
export interface Standing {
  /** The latest session-bearing presence, joined or left, as latestPresences reads it. */
  readonly holder: Subscriber | undefined;
  readonly anchor: Anchor;
  readonly mutes: ReadonlyArray<MuteScope>;
  /** Each command's verdict at its own commit, by operation. */
  readonly verdicts: ReadonlyMap<string, Verdict>;
}

/**
 * Folds one address's presences and commands, oldest first (docs/frames/reachable-inactivity.md,
 * "The fold"). A leave, a join while absent or left, a takeover or another session's join
 * resets it: active, no mutes, anchored at that presence. A rejoin keeps its run; a replay
 * starts a new one; neither changes activity or mutes. A command applies only from the
 * joined holder's own runtime, session and run, and never changes the holder or its run.
 */
export const foldStanding = (address: string, log: Iterable<Logged>): Standing => {
  let holder: Subscriber | undefined;
  let anchor: Anchor = { value: "active", t: 0, ts: "" };
  let mutes: ReadonlyArray<MuteScope> = [];
  const verdicts = new Map<string, Verdict>();
  for (const entry of log) {
    switch (entry.kind) {
      case "presence": {
        const { message } = entry;
        const presence = message.presence;
        if (message.from !== address || presence?.session === undefined) break;
        const continues =
          holder?.presence.status === "joined" &&
          presence.status === "joined" &&
          holder.presence.session === presence.session &&
          presence.takeover === undefined;
        if (!continues) {
          anchor = { value: "active", t: entry.t, ts: message.ts };
          mutes = [];
        }
        holder = {
          address,
          presence,
          joinId: message.id,
          since: message.ts,
          host: message.origin?.host,
          cwd: message.origin?.cwd,
        };
        break;
      }
      case "command": {
        const { command } = entry;
        if (command.address !== address) break;
        const verdict: Verdict =
          holder === undefined || holder.presence.status !== "joined"
            ? { status: "CONFLICT", reason: "not-joined" }
            : holder.presence.runtime !== command.runtime ||
                holder.presence.session !== command.session
              ? { status: "CONFLICT", reason: "not-holder" }
              : runOf(holder) !== command.run
                ? { status: "CONFLICT", reason: "stale-run" }
                : { status: "APPLIED" };
        if (!verdicts.has(entry.operation)) verdicts.set(entry.operation, verdict);
        if (verdict.status !== "APPLIED") break;
        if (command.activity !== undefined) {
          anchor = { value: command.activity, t: entry.t, ts: command.ts ?? "" };
        }
        if (command.mutes !== undefined) mutes = command.mutes;
        break;
      }
    }
  }
  return { holder, anchor, mutes, verdicts };
};

/** A direct message that reactivates its addressee: from someone else, naming it literally. */
export const qualifies = (message: Message, address: string) =>
  message.kind === "message" && message.from !== address && message.to.includes(address);

/**
 * The direct candidates committed after an anchor: the first qualifying message, and whether
 * any candidate could not be decoded or the scan stopped short of the cut.
 */
export interface DirectScan {
  readonly found?: { readonly ts: string; readonly t: number } | undefined;
  readonly damaged: boolean;
  readonly complete: boolean;
}

export type Activity = "active" | "inactive" | "unknown";

/**
 * Why activity is unknown: an unreadable direct candidate after the inactive anchor, or a
 * candidate scan that hit its cap or never completed. An unreadable presence or command fails
 * the read instead, since no standing can be established past it.
 */
export const ACTIVITY_REASONS = ["damaged-mail", "incomplete-scan"] as const;
export type ActivityReason = (typeof ACTIVITY_REASONS)[number];

/** Activity at a cut; a reason accompanies unknown, and only unknown. */
export type ActivityAt =
  | { readonly activity: "active"; readonly activeSince?: string }
  | { readonly activity: "inactive" }
  | { readonly activity: "unknown"; readonly activityReason: ActivityReason };

/** Whether activity at a cut depends on direct mail after the anchor. */
export const needsScan = (standing: Standing) => standing.anchor.value === "inactive";

/**
 * Activity at a cut ("Activity at a cut"): the anchor, then the first qualifying direct message
 * after it; a damaged candidate or an incomplete scan is unknown.
 */
export const activityAt = (standing: Standing, scan: DirectScan | undefined): ActivityAt => {
  if (standing.anchor.value === "active") {
    return standing.anchor.ts === ""
      ? { activity: "active" }
      : { activity: "active", activeSince: standing.anchor.ts };
  }
  if (scan?.found !== undefined) return { activity: "active", activeSince: scan.found.ts };
  // Damage found is the more specific reason, so it wins over a capped scan.
  if (scan?.damaged === true) return { activity: "unknown", activityReason: "damaged-mail" };
  if (scan === undefined || !scan.complete) {
    return { activity: "unknown", activityReason: "incomplete-scan" };
  }
  return { activity: "inactive" };
};
