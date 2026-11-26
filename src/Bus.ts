import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import {
  type Activity,
  type ActivityReason,
  ActivityValue,
  type AddressCommand,
  AddressCommandJson,
  type Association,
  Association as AssociationSchema,
  activityAt,
  ambientRoutes,
  canonicalAssociations,
  foldStanding,
  InvalidAssociations,
  InvalidQuery,
  InvalidTopics,
  isFor,
  LedgerError,
  lackingWake,
  latestPresences,
  MAX_ASSOCIATED_ADDRESS_BYTES,
  MAX_ASSOCIATION_BYTES,
  Message,
  type MuteScope,
  NotJoined,
  NotOwner,
  needsScan,
  normalizeMutes,
  Origin,
  Presence,
  PresenceConflict,
  type RecipientStanding,
  type Runtime,
  runOf,
  type Standing,
  type Subscriber,
  topicName,
  validSession,
} from "./domain.ts";
import { type CommandRead, type Entry, Ledger, validEntryId } from "./Ledger.ts";
import {
  canStartVacancy,
  encodeMailboxFact,
  type MailboxAck,
  type MailboxFact,
  type MailboxStart,
  type MailboxState,
  type MailboxUnresolved,
  mailboxInstallationRef,
  mailboxPresenceRef,
  mailboxRunRef,
  mailboxServedDigest,
  mailboxTopicsDigest,
} from "./mailbox-model.ts";
import {
  incompleteMailbox,
  longestPrefix,
  type Prefix,
  readMailboxSlice,
  servedPrefix,
} from "./mailbox-read.ts";
import {
  admitEntry,
  carrierBytes,
  indexable,
  MAX_ORIGIN_CWD_BYTES,
  MAX_STORED_ENTRY_BYTES,
  messageCarrierBytes,
  presenceText,
  READ_ID,
  type ReadReceipt,
  readableEntry,
  readResult,
  servedCarrierBytes,
  unjoinable,
  WAKE_LISTED_BYTES,
} from "./message-carrier.ts";
import { canonicalJson } from "./orientation-model.ts";
import { directoryAt } from "./orientation-read.ts";
import { type Pin, QueryGateway } from "./Query.ts";
import { MAX_ENVELOPE_BYTES } from "./query-contract.ts";
import {
  CheckWakeBindingRequest,
  MAX_WAKE_COVERAGE_IDS,
  MAX_WAKE_OBSERVATION_BYTES,
  ObserveWakeRequest,
  sameWakeBinding,
  type WakeBinding,
  WakeBindingCheck,
  WakeObservation,
  wakeObservationCarrierBytes,
} from "./wake-observation.ts";

export const ORIENTATION_JOIN_TOO_LARGE = "Orientation cannot fit alongside this committed join.";

/** An owner's read of its unread mail; every field after the session is optional. */
export interface ReadInput {
  readonly address: string;
  readonly session: string | undefined;
  /**
   * A lowercase UUIDv7 naming this read: a read that returns mail records its acknowledgement
   * under it, and calling again with it in the same run returns that batch and writes nothing.
   */
  readonly readId?: string | undefined;
  /** Return the unread mail and a receipt for `ack`, and write nothing. */
  readonly peek?: boolean | undefined;
  /** The most messages to return; a commit is never split. */
  readonly limit?: number | undefined;
  /** The most bytes of the complete public result carrier, receipt and nextReadId included. */
  readonly maxResultBytes?: number | undefined;
}

/** A wait for mail: a read that is never a peek, repeated as mail arrives. */
export interface WaitInput extends Omit<ReadInput, "peek"> {
  readonly timeoutSeconds?: number | undefined;
}

/** What a read returns: the batch, its receipt when it has mail, and an id for the next read. */
export interface ReadOutcome {
  readonly messages: ReadonlyArray<Message>;
  readonly receipt?: ReadReceipt;
  readonly nextReadId: string;
}

/** A peek's receipt as its caller hands it back to acknowledge it. */
export interface AckInput {
  readonly address: string;
  readonly session: string | undefined;
  readonly receipt: {
    readonly readId: string;
    readonly from: number;
    readonly through: number;
    readonly basis: { readonly ledger: string; readonly t: number };
    readonly served: { readonly count: number; readonly digest: string };
  };
}

/** What an acknowledgement recorded: the read receipt, and an id for the next read. */
export interface Acked {
  readonly receipt: ReadReceipt;
  readonly nextReadId: string;
}

export interface JoinInput {
  readonly address: string;
  readonly runtime: Runtime;
  /** The joining session's id from its runtime; required, though callers may omit it. */
  readonly session: string | undefined;
  /** The current holder's join id, to replace a session that has ended. */
  readonly takeover?: string | undefined;
  readonly topics?: ReadonlyArray<string> | undefined;
  readonly associations?: ReadonlyArray<Association> | undefined;
  readonly orient?: boolean | undefined;
  readonly codexThreadId?: string | undefined;
  readonly note?: string | undefined;
  /** Start from the beginning of the ledger instead of only new messages. */
  readonly replay?: boolean | undefined;
  /** An explicit owner recovery for an unresolved import, distinct from replay. */
  readonly restartPosition?: boolean | undefined;
  /** The session's working directory; its entries record it, with its repo and branch. */
  readonly cwd: string;
}

export interface PublishInput {
  readonly from: string;
  /** The sending session, which must own `from`. */
  readonly session: string | undefined;
  readonly to: ReadonlyArray<string>;
  readonly body: string;
  readonly subject?: string | undefined;
  readonly replyTo?: string | undefined;
  /**
   * Audience members to wake despite inactivity or mutes, or "all" of those who would otherwise
   * be suppressed, which first returns NOT_SENT with that set and a digest to `confirm`.
   */
  readonly pierce?: ReadonlyArray<string> | "all" | undefined;
  /** The digest of a NOT_SENT pierce of all, to send exactly that set. */
  readonly confirm?: string | undefined;
  /**
   * A lowercase UUIDv7 naming this send and all its retries; it becomes the message's id. The
   * entry stored under it decides a retry: the same send returns the original, replayed.
   */
  readonly operation?: string | undefined;
}

/**
 * Direct recipients whose wake prerequisites the sender's own ownership read showed lacking, at
 * that read's commit `t`, before the send was appended. Recipients can join, leave or renew after
 * it; and its absence never means a wake routes or will arrive.
 */
export interface WakeNotice {
  /** The incarnation and commit of the read, as a query's snapshot names them. */
  readonly ledger: string;
  readonly t: number;
  /** The first of them, in `to` order, whose JSON array fits {@link WAKE_LISTED_BYTES}; possibly none. */
  readonly lacking: ReadonlyArray<{
    readonly address: string;
    readonly standing: RecipientStanding;
  }>;
  /** How many more lacked beyond those listed, when any did. */
  readonly unlisted?: number;
}

/** The longest prefix of `rows` whose JSON array fits the budget, and how many it leaves out. */
const listWithin = <A>(rows: ReadonlyArray<A>, budget: number) => {
  let used = 2; // the brackets
  let listed = 0;
  for (const row of rows) {
    used += Buffer.byteLength(JSON.stringify(row), "utf8") + (listed > 0 ? 1 : 0);
    if (used > budget) break;
    listed += 1;
  }
  return { listed: rows.slice(0, listed), unlisted: rows.length - listed };
};

/** A sent message, with the wake notice its sender's presence observation produced, if any. */
export interface Posted {
  readonly message: Message;
  readonly wake?: WakeNotice;
  /**
   * This call wrote nothing: the message was already stored under its operation. Absent, the
   * message is stored once under that id; it does not say this call was the one that wrote it.
   */
  readonly replayed?: true;
}

/** A pierce of all that was not confirmed: nothing was written. */
export interface NotSent {
  readonly status: "NOT_SENT";
  /** The audience members the message would otherwise not wake, sorted. */
  readonly bypass: ReadonlyArray<string>;
  /** Pass as `confirm`, with the same message, to send it piercing exactly `bypass`. */
  readonly digest: string;
}

/** An owner's change of its address's activity, mutes or both: one written command. */
export interface ActivityInput {
  readonly address: string;
  readonly session: string | undefined;
  /** A UUIDv7 naming this change and all its retries. */
  readonly operation: string;
  readonly activity?: "active" | "inactive" | undefined;
  /** The complete mute set, replacing the current one. */
  readonly mutes?: ReadonlyArray<MuteScope> | undefined;
}

/**
 * What became of an activity command, decided by its own commit: applied, or refused because
 * the address had no joined holder, another holder, or a later run by then. UNKNOWN may have
 * committed: retry only the identical intent with the same operation.
 */
export type ActivityResult =
  | {
      readonly status: "APPLIED";
      readonly operation: string;
      readonly cut: Pin;
      readonly activity: Activity;
      readonly activeSince?: string;
      readonly activityReason?: ActivityReason;
      readonly mutes: ReadonlyArray<MuteScope>;
    }
  | {
      readonly status: "CONFLICT";
      readonly operation: string;
      readonly cut: Pin;
      readonly reason: "not-joined" | "not-holder" | "stale-run";
    }
  | { readonly status: "UNKNOWN"; readonly operation: string }
  | { readonly status: "IDENTITY_MISMATCH"; readonly operation: string };

type PublishError = LedgerError | NotJoined | NotOwner | PresenceConflict | InvalidQuery;

/**
 * A subscriber as it is under its address's lock, and its unread messages that may wake it, with
 * what a wake needs to tell new mail from mail it already rang for: the ids of all the
 * subscriber's unread mail, held back or not, and its read position.
 */
export interface Pending {
  readonly subscriber: Subscriber;
  readonly messages: ReadonlyArray<Message>;
  readonly unread: ReadonlyArray<string>;
  readonly cursor: number;
}

/** What a wake rang for: the eligible mail, while it stays unread, and the read position then. */
export interface Coverage {
  readonly rung: ReadonlyArray<string>;
  readonly cursor: number;
}

/**
 * Whether a wake's eligible mail is news against what an earlier wake of the same join rang for,
 * and the coverage it moves to. News is eligible mail not yet rung for, or a read since: a partial
 * read rings again. Held-back mail becoming eligible rings once; suppression shrinking the
 * eligible set never rings, and mail rung for doesn't ring again when it becomes eligible again.
 * Coverage keeps only unread mail, so it stays bounded by the unread mail.
 */
export const cover = (
  covered: Coverage | undefined,
  { messages, unread, cursor }: Pending
): { readonly news: boolean; readonly coverage: Coverage } => {
  const rung = new Set(covered?.rung);
  const news =
    covered === undefined ||
    covered.cursor !== cursor ||
    messages.some((message) => !rung.has(message.id));
  const still = new Set(unread);
  for (const message of messages) rung.add(message.id);
  return {
    news,
    coverage: { rung: [...rung].filter((id) => still.has(id)), cursor },
  };
};

/** What a session's wake wait found. */
export interface Woken {
  /** The session's addresses with eligible unread mail, including unchanged mail when fresh. */
  readonly addresses: ReadonlyArray<string>;
  /** Whether the session has an address eligible for this installation's Claude wake. */
  readonly owns: boolean;
  /** A newer wait from the same session ended this one. */
  readonly superseded: boolean;
}

interface DeliveryOptions<E> {
  readonly accepts?: (subscriber: Subscriber) => boolean;
  readonly idle?: (subscriber: Subscriber) => Effect.Effect<void, E>;
}

interface MailboxBasis {
  readonly subscriber: Subscriber;
  readonly cut: Pin;
  readonly position: number;
  readonly positionOperation: string;
}

interface MailboxPlan {
  readonly through: number;
  readonly messages: ReadonlyArray<Message>;
}

export class Bus extends Context.Service<
  Bus,
  {
    /**
     * Claims an address for a session, or reconnects the session that owns it.
     * A different session is refused while the address is held, unless it
     * names the holder's join in `takeover`. `hooked` says this machine's bus
     * has seen the session's wake hook, which wakes it when mail arrives.
     */
    readonly join: (input: JoinInput) => Effect.Effect<
      {
        readonly address: string;
        readonly topics: ReadonlyArray<string>;
        readonly associations: ReadonlyArray<Association>;
        readonly cursor: number;
        readonly hooked?: true;
        /** A fresh read id for the first keyed read. */
        readonly nextReadId: string;
      },
      LedgerError | NotOwner | PresenceConflict | InvalidTopics | InvalidAssociations | InvalidQuery
    >;
    readonly leave: (
      address: string,
      session: string | undefined
    ) => Effect.Effect<void, LedgerError | NotJoined | NotOwner | PresenceConflict | InvalidQuery>;
    /** A pierce of "all" without its confirming digest returns NOT_SENT and writes nothing. */
    readonly publish: {
      (
        input: PublishInput & { readonly pierce?: ReadonlyArray<string> | undefined }
      ): Effect.Effect<Posted, PublishError>;
      (input: PublishInput): Effect.Effect<Posted | NotSent, PublishError>;
    };
    /**
     * Sets the owner's activity, mutes or both by writing one command, never a no-op. A
     * recorded operation returns its original receipt without writing.
     */
    readonly activity: (
      input: ActivityInput
    ) => Effect.Effect<ActivityResult, LedgerError | NotJoined | NotOwner | InvalidQuery>;
    /** Runs a publisher operation under the same ownership lock as ordinary sends. */
    readonly withOwner: <A, E>(
      address: string,
      session: string | undefined,
      action: (owner: Subscriber) => Effect.Effect<A, E>
    ) => Effect.Effect<A, E | LedgerError | NotJoined | NotOwner>;
    readonly peers: Effect.Effect<ReadonlyArray<Subscriber>, LedgerError>;
    readonly localPeers: Effect.Effect<ReadonlyArray<Subscriber>, LedgerError>;
    /** Checks captured native authority without consulting mail, cursor or wake eligibility. */
    readonly checkWakeBinding: (
      input: CheckWakeBindingRequest
    ) => Effect.Effect<WakeBindingCheck, LedgerError | NotJoined | NotOwner | InvalidQuery>;
    /** Pure ownership-checked wake evidence; the caller alone retains or commits coverage. */
    readonly observeWake: (
      input: ObserveWakeRequest
    ) => Effect.Effect<WakeObservation, LedgerError | NotJoined | NotOwner | InvalidQuery>;
    /**
     * Hands an address's unread messages to `nudge`, and marks none of them
     * read: only the owner's read does. With nothing for the subscriber, it
     * remembers the empty scan in this process without acknowledging it. Joins,
     * leaves, reads and nudges for one address run one at a time, so a nudge
     * acts on the subscriber's current state. Nonlocal joins and joins `accepts`
     * rejects do not access a cursor or invoke a callback. Returns what `nudge` returns, or
     * undefined when it had nothing to act on, in which case `idle`, if given,
     * runs for the subscriber, still under the lock. Unread mail the wake law
     * suppresses (inactivity, mutes) is handed over only alongside mail that
     * wakes; with none that wakes, it returns undefined without `idle`, and
     * nothing is passed over. This is the native deliverers' path; sessions
     * read through `take` and `wait`, unfiltered.
     */
    readonly deliver: <A, E, E2 = never>(
      address: string,
      nudge: (pending: Pending) => Effect.Effect<A, E>,
      options?: DeliveryOptions<E2>
    ) => Effect.Effect<A | undefined, LedgerError | NotJoined | E | E2>;
    /**
     * Returns the owner's unread messages and marks them read, or with `peek` writes nothing.
     * A recorded `readId` of the same run returns its batch again and writes nothing.
     */
    readonly read: (
      input: ReadInput
    ) => Effect.Effect<ReadOutcome, LedgerError | NotJoined | NotOwner | InvalidQuery>;
    /** An un-keyed read's messages alone. */
    readonly take: (
      address: string,
      session: string | undefined,
      limit?: number
    ) => Effect.Effect<ReadonlyArray<Message>, LedgerError | NotJoined | NotOwner | InvalidQuery>;
    /**
     * Waits until messages arrive, or until the timeout when one is given.
     * Ownership and the read id are checked again on every read, so a wait outlived by its
     * session's ownership is refused rather than taking the new owner's messages.
     */
    readonly wait: (
      input: WaitInput
    ) => Effect.Effect<ReadOutcome, LedgerError | NotJoined | NotOwner | InvalidQuery>;
    /** Acknowledges exactly what a peek served, if nothing has changed since it read. */
    readonly ack: (
      input: AckInput
    ) => Effect.Effect<Acked, LedgerError | NotJoined | NotOwner | InvalidQuery>;
    /**
     * Waits until an address `session` owns has unread mail, first to newest,
     * other than what it was last woken for, or the timeout, and returns those
     * addresses. It marks nothing read and, like `deliver`, passes over what
     * isn't the subscriber's mail. A newer wait from the same session ends this
     * one. This is the path of the hook that wakes Claude sessions.
     */
    readonly wake: (
      session: string | undefined,
      timeoutSeconds: number,
      /** A compact hook may ring unchanged unread mail; that hook exits after one response. */
      fresh?: boolean
    ) => Effect.Effect<Woken, LedgerError | NotOwner>;
  }
>()("agent-bus/Bus") {}

/** How long `git` may take; it runs under the address's lock. */
const GIT_TIMEOUT = Duration.seconds(2);

/**
 * Runs git in a directory, or returns undefined when it is not a repo, no
 * longer exists, or takes longer than GIT_TIMEOUT.
 */
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise(async (signal) => {
    const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", signal });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const text = out.trim();
    return code === 0 && text !== "" ? text : undefined;
  }).pipe(
    Effect.timeout(GIT_TIMEOUT),
    Effect.orElseSucceed(() => undefined)
  );

/**
 * Where an entry was written: this machine, and the session's directory with
 * its repo and branch. They are optional metadata for queries: a branch can't
 * be recovered once its worktree or branch is gone.
 */
export const originFor = Effect.fn("Bus.originFor")(function* (
  cwd: string | undefined,
  hostOf = hostname
) {
  if (cwd === undefined) return new Origin({ host: hostOf() });
  const repo = yield* git(cwd, ["rev-parse", "--show-toplevel"]);
  const branch = repo === undefined ? undefined : yield* git(cwd, ["branch", "--show-current"]);
  return new Origin({
    host: hostOf(),
    cwd,
    ...(repo === undefined ? {} : { repo }),
    ...(branch === undefined ? {} : { branch }),
  });
});

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : { [key]: value };

/** Canonicalize the declared set without resolving it or implying a subscription. */
const associationsOf = (value: ReadonlyArray<Association>) =>
  Schema.decodeUnknownEffect(Schema.Array(AssociationSchema))(value).pipe(
    Effect.mapError(
      () =>
        new InvalidAssociations({
          message:
            "Each association must name a directory and concern ids using letters, digits, '.', '_' or '-'. Nothing was changed.",
        })
    ),
    Effect.flatMap((entries) => {
      const associations = canonicalAssociations(entries);
      return Buffer.byteLength(JSON.stringify(associations), "utf8") <= MAX_ASSOCIATION_BYTES
        ? Effect.succeed(associations)
        : Effect.fail(
            new InvalidAssociations({
              message: `Associations exceed ${MAX_ASSOCIATION_BYTES} UTF-8 bytes. Nothing was changed.`,
            })
          );
    })
  );

const sessionHelp =
  "Pass your runtime's own session id as `session`: $CODEX_THREAD_ID in Codex, $CLAUDE_CODE_SESSION_ID in Claude Code, or a stable id of your own for other clients.";

/** What an address's owner was last woken for: its join, and the mail that wake covered. */
export interface Mark {
  readonly joinId: string;
  readonly coverage: Coverage;
}

/** An address's mark as a wake read it under the address's lock, and the mark it would move to. */
export interface Moved {
  readonly address: string;
  readonly previous: Mark | undefined;
  readonly mark: Mark;
  /** Whether the mail is news against `previous` (see `cover`). */
  readonly news: boolean;
}

/**
 * Moves the marks a wake read, in one step, and returns their addresses. It
 * skips a mark another wake has moved since it was read (the new owner's,
 * after a takeover), and, unless fresh, one already at the unread mail read.
 * Each move is added to `moved`, so a result that is never returned can be undone.
 */
export const commitMarks = (
  woken: Map<string, Mark>,
  found: ReadonlyArray<Moved>,
  moved: Array<Moved>,
  fresh = false
): Array<string> => {
  const addresses: Array<string> = [];
  for (const read of found) {
    const { address, previous, mark } = read;
    if (woken.get(address) !== previous) continue;
    if (!fresh && !read.news) continue;
    moved.push(read);
    woken.set(address, mark);
    addresses.push(address);
  }
  return addresses;
};

/** Puts back the marks a wake moved but didn't return, unless another wake has moved them since. */
export const restoreMarks = (
  woken: Map<string, Mark>,
  moved: ReadonlyArray<Moved>,
  returned: ReadonlyArray<string>
) => {
  for (const { address, previous, mark } of moved) {
    if (returned.includes(address) || woken.get(address) !== mark) continue;
    if (previous === undefined) woken.delete(address);
    else woken.set(address, previous);
  }
};

/** What this machine's bus has seen of an address's owner, for telling a live holder from a dead one. */
interface Seen {
  last?: string;
  waits: number;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isActivityValue = Schema.is(ActivityValue);
const decodeCommand = Schema.decodeUnknownOption(AddressCommandJson, {
  onExcessProperty: "error",
});

/** A command's retry identity: what the caller asked for, never its runtime, run or time. */
const intentOf = (command: {
  readonly address: string;
  readonly session: string | undefined;
  readonly activity?: string | undefined;
  readonly mutes?: ReadonlyArray<MuteScope> | undefined;
}) =>
  canonicalJson({
    address: command.address,
    session: command.session,
    activity: command.activity,
    mutes: command.mutes,
  });

/**
 * A send's retry identity: what the caller asked for, with the pierce set it resolved to, never
 * its id, time or origin. A NOT_SENT digest hashes exactly this.
 */
const sendIntentOf = (
  draft: Pick<Message, "from" | "to" | "subject" | "body" | "kind" | "replyTo">,
  bypass: ReadonlyArray<string>
) =>
  canonicalJson({
    from: draft.from,
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    kind: draft.kind,
    replyTo: draft.replyTo,
    bypass,
  });

const digestOf = (draft: Parameters<typeof sendIntentOf>[0], bypass: ReadonlyArray<string>) =>
  createHash("sha256").update(sendIntentOf(draft, bypass)).digest("hex");

/** A named pierce as it is stored: once each, without the direct recipients, sorted. */
const namedPierce = (pierce: ReadonlyArray<string>, to: ReadonlyArray<string>) =>
  [...new Set(pierce)].filter((address) => !to.includes(address)).sort();

/** Concern topics by directory id at one commit; undefined where the designation is unreadable. */
type Concerns = Map<
  string,
  ReadonlyArray<{ readonly id: string; readonly topic: string }> | undefined
>;

const make = (installation: string, hostOf: () => string, storedEntryBytes: number) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const gateway = yield* QueryGateway;

    const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

    /** Each address's latest presence, joined or left. */
    const latest = Effect.map(ledger.presenceAt(), (read) => latestPresences(read.entries));

    const peers = Effect.map(latest, (all) =>
      Array.from(all.values()).filter((peer) => peer.presence.status === "joined")
    ).pipe(Effect.withSpan("Bus.peers"));

    const local = (peer: Subscriber) => peer.presence.installation === installation;
    const localPeers = Effect.map(peers, (all) => all.filter(local));

    const lockFor = (locks: Map<string, Semaphore.Semaphore>) => (address: string) => {
      let lock = locks.get(address);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(address, lock);
      }
      return Semaphore.withPermit(lock);
    };
    /** Serializes reads, deliveries and anything that moves an address's cursor. */
    const exclusive = lockFor(new Map());
    /**
     * Serializes changes of ownership with sends, so a session that loses an
     * address can't send after it, without sends waiting on a slow delivery.
     * Taken before `exclusive` whenever both are held.
     */
    const claiming = lockFor(new Map());

    /** Sessions whose wake hook has called this bus since it started. */
    const hooked = new Set<string>();

    const seenBy = new Map<string, Seen>();
    const seenOf = (address: string) => {
      let seen = seenBy.get(address);
      if (seen === undefined) {
        seen = { waits: 0 };
        seenBy.set(address, seen);
      }
      return seen;
    };
    const touch = (address: string) =>
      Effect.map(now, (ts) => {
        seenOf(address).last = ts;
      });

    /** Why a session that doesn't own an address can't join it, and what to do instead. */
    const heldBy = (holder: Subscriber) => {
      const { presence } = holder;
      const seen = seenOf(holder.address);
      const facts = [
        `runtime ${presence.runtime}`,
        ...(holder.host === undefined ? [] : [`on ${holder.host}`]),
        ...(holder.since === undefined ? [] : [`joined ${holder.since}`]),
        ...(presence.note === undefined ? [] : [`note "${presence.note}"`]),
        `last call ${seen.last ?? "not seen by this machine's bus since it started"}`,
        seen.waits > 0 ? "a wait open now" : "no wait open on this machine",
      ];
      return new NotOwner({
        address: holder.address,
        message: `${holder.address} is held by another session (${facts.join("; ")}). An address is one session's inbox: join one specific to this session instead. Only if that session has ended and the human says to replace it, take it over with bus_takeover, holder "${holder.joinId}" (agent-bus join --takeover from a shell).`,
      });
    };

    /** A call from a session that doesn't own the address, refused before it changes anything. */
    const notOwner = (holder: Subscriber) =>
      new NotOwner({
        address: holder.address,
        message: `${holder.address} belongs to another session; nothing was changed. If you joined it earlier, it has since been taken over or your session id changed (after /clear or a fork): join an address specific to this session.`,
      });

    const noSession = (address: string) => new NotOwner({ address, message: sessionHelp });

    /** The address's current subscriber, when `session` owns it. */
    const ownedIn = (
      all: ReadonlyMap<string, Subscriber>,
      address: string,
      session: string | undefined
    ) =>
      Effect.gen(function* () {
        if (!validSession(session)) return yield* noSession(address);
        const subscriber = all.get(address);
        if (subscriber === undefined || subscriber.presence.status !== "joined") {
          return yield* new NotJoined({
            address,
            message: `${address} has not joined the bus; join first.`,
          });
        }
        if (subscriber.presence.session !== session) return yield* notOwner(subscriber);
        return subscriber;
      });
    const owned = Effect.fn("Bus.owned")(function* (address: string, session: string | undefined) {
      const subscriber = yield* ownedIn(yield* latest, address, session);
      yield* touch(address);
      return subscriber;
    });

    /**
     * Legacy leave exception: a holder can let go even if its generated searchable body
     * exceeds today's limit. The exact address stays in the sender and stored entry.
     */
    const presenceBody = (address: string, status: Presence["status"]) => {
      const body = presenceText(address, status);
      return status === "left" && !indexable(body) ? "An address too long to index left" : body;
    };

    const presenceMessage = (address: string, presence: Presence, cwd: string | undefined) =>
      Effect.gen(function* () {
        return new Message({
          id: Bun.randomUUIDv7(),
          ts: yield* now,
          from: address,
          to: ["*"],
          kind: "presence",
          body: presenceBody(address, presence.status),
          origin: yield* originFor(cwd, hostOf),
          presence,
        });
      });

    const conflict = (address: string) =>
      new PresenceConflict({
        address,
        message: `${address} changed while this call was deciding, so nothing was written. Call again: the bus will decide against the address's current state.`,
      });

    const unconfirmed = (operation: "join" | "leave", address: string) =>
      new LedgerError({
        message: `The bus could not confirm whether this ${operation} of ${address} was recorded. It may have committed. When connected, check bus_owned_addresses for your session and bus_peers for the address's current topics. If the intended state is already in effect, do not repeat the change. These checks show current state, not what the earlier request did.`,
      });

    const invalidReadId = () =>
      new InvalidQuery({
        message:
          "readId must be a lowercase UUIDv7, such as a result's nextReadId. Nothing was changed.",
      });

    const unresolvedMailbox = (reason: MailboxUnresolved["reason"]) =>
      new LedgerError({
        message: `This mailbox position is unresolved (${reason}); ask the operator to reconcile the import. Do not rejoin or replay. Nothing was changed.`,
      });

    /**
     * What a join would write against one presence state, or the refusal it gets. Pure: it
     * reads and writes nothing, so a refused write can be re-decided without writing.
     */
    const decideJoin = (input: JoinInput, session: string, all: ReadonlyMap<string, Subscriber>) =>
      Effect.gen(function* () {
        const last = all.get(input.address);
        const mine =
          last !== undefined &&
          last.presence.session === session &&
          last.presence.runtime === input.runtime;
        let takeover: string | undefined;
        if (last?.presence.status === "joined" && !mine) {
          if (input.takeover !== last.joinId) return yield* heldBy(last);
          takeover = last.joinId;
        }
        const renews =
          last !== undefined &&
          mine &&
          last.presence.status === "joined" &&
          input.replay !== true &&
          input.restartPosition !== true;
        // A rejoin that names no topics keeps its subscriptions; only the caller changes them.
        const requestedTopics =
          input.topics ??
          (last !== undefined && mine && last.presence.status === "joined"
            ? last.presence.topics
            : []);
        const associations = yield* associationsOf(
          input.associations ??
            (last !== undefined && mine && last.presence.status === "joined"
              ? (last.presence.associations ?? [])
              : [])
        );
        if (
          associations.length > 0 &&
          Buffer.byteLength(input.address, "utf8") > MAX_ASSOCIATED_ADDRESS_BYTES
        ) {
          return yield* new InvalidAssociations({
            message: `An associated address cannot exceed ${MAX_ASSOCIATED_ADDRESS_BYTES} UTF-8 bytes. Nothing was changed.`,
          });
        }
        const topics = new Set<string>();
        for (const requested of requestedTopics) {
          const topic = topicName(requested);
          if (topic === undefined && input.topics !== undefined) {
            return yield* new InvalidTopics({
              message:
                'Each topic must have a non-empty name with at most one leading #. Pass topics such as ["reviews"]; use [] only to clear subscriptions. Nothing was changed.',
            });
          }
          // An omitted list must not make an older, malformed subscription block a rejoin.
          topics.add(topic ?? requested);
        }
        // The presence this join (or a later leave) writes is full-text indexed; checked here,
        // in the pure decision, so a refusal writes nothing.
        const unindexable = unjoinable(input.address);
        if (unindexable !== undefined) return yield* new InvalidQuery({ message: unindexable });
        if (Buffer.byteLength(input.cwd, "utf8") > MAX_ORIGIN_CWD_BYTES) {
          return yield* new InvalidQuery({
            message: `The working directory cannot exceed ${MAX_ORIGIN_CWD_BYTES} UTF-8 bytes, since every message sent from the address records it. Join from a shorter path. Nothing was changed.`,
          });
        }
        if (input.orient === true) {
          const smallestResult = {
            address: input.address,
            topics: [...topics],
            associations,
            cursor: Number.MAX_SAFE_INTEGER,
            hooked: true,
            nextReadId: Bun.randomUUIDv7(),
            orientation: {
              status: "UNAVAILABLE",
              reason: "INADMISSIBLE",
              section: "result",
              message: ORIENTATION_JOIN_TOO_LARGE,
              recovery: { tool: "bus_orient", input: { cwd: input.cwd } },
            },
          };
          if (Buffer.byteLength(JSON.stringify(smallestResult), "utf8") > MAX_ENVELOPE_BYTES) {
            return yield* new InvalidQuery({
              message:
                "The join echo is too large to include an orientation status. Shorten the join fields, or join without orientation. Nothing was changed.",
            });
          }
        }
        const presence = new Presence({
          runtime: input.runtime,
          status: "joined",
          topics: [...topics],
          associations,
          session,
          installation,
          ...optional("takeover", takeover),
          ...optional("rejoinOf", renews ? (last.presence.rejoinOf ?? last.joinId) : undefined),
          ...optional("codexThreadId", input.codexThreadId),
          ...optional("note", input.note),
        });
        return { presence, mine, takeover };
      });

    const join = (input: JoinInput) =>
      Effect.gen(function* () {
        const session = input.session;
        if (!validSession(session)) return yield* noSession(input.address);
        // A Codex thread is woken at its own thread id, so it can't name another.
        if (
          input.runtime === "codex" &&
          input.codexThreadId !== undefined &&
          input.codexThreadId !== session
        ) {
          return yield* new NotOwner({
            address: input.address,
            message: "codexThreadId must be your own thread id, the same as session.",
          });
        }
        const read = yield* ledger.presenceAt();
        const holdings = latestPresences(read.entries);
        const last = holdings.get(input.address);
        const { presence, mine, takeover } = yield* decideJoin(input, session, holdings);
        const previous = yield* ledger.mailboxAt(input.address, read.cut);
        const restart = input.restartPosition === true;
        const classified = previous.status === "UNRESOLVED" ? previous.current.record : undefined;
        const vacant =
          last?.presence.status === "left" &&
          classified?.kind === "unresolved" &&
          !restart &&
          classified.vacant?.presenceRef === mailboxPresenceRef(last.joinId) &&
          (input.replay !== true || classified.vacant.noFiles) &&
          canStartVacancy(previous, input.runtime, session);
        if (
          previous.status === "UNRESOLVED" &&
          !vacant &&
          (!restart || !mine || input.replay === true)
        ) {
          return yield* unresolvedMailbox(previous.reason);
        }
        if (restart && previous.status !== "UNRESOLVED") {
          return yield* new InvalidQuery({
            message:
              "A restart at the present requires an unresolved mailbox position; nothing was changed.",
          });
        }
        const message = yield* presenceMessage(input.address, presence, input.cwd);
        const imported = previous.status === "FOUND" ? previous.current.record : undefined;
        const elsewhere =
          last?.presence.status === "left" &&
          imported?.kind === "start" &&
          imported.legacySource?.presenceRef === mailboxPresenceRef(last.joinId) &&
          imported.legacySource.installationRef !== mailboxInstallationRef(installation);
        // Never copy an inherited position: an old holder may acknowledge mail after our
        // decision and before the takeover commits. A fresh start and its presence are atomic.
        const start: MailboxStart | undefined =
          vacant ||
          elsewhere ||
          restart ||
          input.replay === true ||
          previous.status === "ABSENT" ||
          (!mine && takeover === undefined)
            ? {
                version: 1,
                kind: "start",
                operation: message.id,
                address: input.address,
                run: presence.rejoinOf ?? message.id,
                origin:
                  vacant && input.replay !== true
                    ? "vacancy"
                    : restart
                      ? "restart"
                      : input.replay === true
                        ? "replay"
                        : "join",
                position: input.replay === true ? 0 : read.cut.head,
              }
            : undefined;
        const admission = yield* start === undefined
          ? ledger.admit(message, read.cut)
          : ledger.admitWithStart(message, start, read.cut);
        if (admission.status === "UNKNOWN") return yield* unconfirmed("join", input.address);
        if (admission.status === "REFUSED") {
          const now = yield* ledger.presenceAt(admission.cut.head);
          yield* decideJoin(input, session, latestPresences(now.entries));
          return yield* conflict(input.address);
        }
        // Report the position at admission, including an old holder's last acknowledged
        // read if it committed between a takeover decision and the guarded join.
        const cursor = yield* start === undefined
          ? ledger.mailboxAt(input.address, admission.cut).pipe(
              Effect.map((state) => (state.status === "FOUND" ? state.position : undefined)),
              Effect.orElseSucceed(() => undefined)
            )
          : Effect.succeed(start.position);
        if (cursor === undefined)
          return yield* new LedgerError({
            message:
              "The join was recorded, but its mailbox position could not be established; call again as its holder.",
          });
        yield* touch(input.address);
        return {
          address: input.address,
          topics: presence.topics,
          associations: presence.associations ?? [],
          cursor,
          ...(input.runtime === "claude" && hooked.has(session) ? { hooked: true as const } : {}),
          nextReadId: Bun.randomUUIDv7(),
        };
      }).pipe(exclusive(input.address), claiming(input.address), Effect.withSpan("Bus.join"));

    const leave = (address: string, session: string | undefined) =>
      Effect.gen(function* () {
        const read = yield* ledger.presenceAt();
        const current = yield* ownedIn(latestPresences(read.entries), address, session);
        const presence = new Presence({
          runtime: current.presence.runtime,
          status: "left",
          topics: [],
          ...optional("associations", current.presence.associations),
          ...optional("session", current.presence.session),
        });
        const message = yield* presenceMessage(address, presence, current.cwd);
        const admission = yield* ledger.admit(message, read.cut);
        if (admission.status === "UNKNOWN") return yield* unconfirmed("leave", address);
        if (admission.status === "REFUSED") {
          const now = yield* ledger.presenceAt(admission.cut.head);
          yield* ownedIn(latestPresences(now.entries), address, session);
          return yield* conflict(address);
        }
        yield* touch(address);
      }).pipe(exclusive(address), claiming(address), Effect.withSpan("Bus.leave"));

    /** An address's standing and activity at commit `t`, from the one indexed basis. */
    const standingAt = (address: string, t: number) =>
      Effect.gen(function* () {
        const standing = foldStanding(address, yield* ledger.log(t));
        const scan = needsScan(standing)
          ? yield* ledger.direct(address, standing.anchor.t, t)
          : undefined;
        return { standing, ...activityAt(standing, scan) };
      });

    /** A directory's concerns at commit `t`, read once per pass; unreadable is undefined. */
    const concernsAt = (concerns: Concerns, directory: string, t: number) =>
      Effect.gen(function* () {
        const key = JSON.stringify([t, directory]);
        if (concerns.has(key)) return concerns.get(key);
        const resolved = yield* directoryAt(gateway, t, directory).pipe(
          Effect.map((found) => found?.value.directory.concerns ?? []),
          Effect.orElseSucceed(() => undefined)
        );
        concerns.set(key, resolved);
        return resolved;
      });

    /**
     * Whether any ambient route escapes the mutes, with directory and concern mutes resolved at
     * commit `t`. A designation that can't be read covers nothing: muting errs toward contact.
     */
    const uncovered = (
      mutes: ReadonlyArray<MuteScope>,
      routes: ReadonlyArray<string>,
      t: number,
      concerns: Concerns
    ) =>
      Effect.gen(function* () {
        for (const route of routes) {
          if (route === "*") {
            if (!mutes.some((mute) => mute.scope === "programme")) return true;
            continue;
          }
          const topic = route.slice(1);
          if (mutes.some((mute) => mute.scope === "topic" && mute.topic === topic)) continue;
          let covered = false;
          for (const mute of mutes) {
            if (mute.scope !== "directory" && mute.scope !== "concern") continue;
            const registered = yield* concernsAt(concerns, mute.directory, t);
            covered =
              registered?.some(
                (concern) =>
                  (mute.scope === "directory" || concern.id === mute.concern) &&
                  topicName(concern.topic) === topic
              ) ?? false;
            if (covered) break;
          }
          if (!covered) return true;
        }
        return false;
      });

    /**
     * Whether ambient mail would leave a peer asleep: inactive, or every route muted at `t`. A
     * standing that can't be read fails the call: no bypass set is fabricated without it.
     */
    const suppressed = (peer: Subscriber, message: Message, t: number, concerns: Concerns) =>
      Effect.gen(function* () {
        const { standing, activity } = yield* standingAt(peer.address, t);
        if (activity === "inactive") return true;
        if (standing.mutes.length === 0) return false;
        return !(yield* uncovered(standing.mutes, ambientRoutes(message, peer), t, concerns));
      });

    /**
     * The wake law (docs/frames/reachable-inactivity.md): direct mail always wakes, and
     * reactivates by being direct mail after the anchor; a pierce wakes without reactivating;
     * otherwise mail wakes an active or unknown address through an unmuted ambient route.
     * Activity is read at the slice's cut, only when some mail is ambient. Direct and pierced
     * mail needs no standing, so a standing that can't be read leaves only that mail eligible;
     * with none, the pass fails, as an unreadable entry does. Either way the ambient mail stays
     * unread until the ledger can be read again.
     */
    const eligibleOf = (subscriber: Subscriber, entries: ReadonlyArray<Entry>, cut: number) =>
      Effect.gen(function* () {
        const { address } = subscriber;
        const reaches = (message: Message) =>
          message.to.includes(address) || (message.pierce ?? []).includes(address);
        const all = entries.map((entry) => entry.message);
        const direct = all.filter(reaches);
        if (direct.length === all.length) return all;
        const read =
          direct.length === 0
            ? Option.some(yield* standingAt(address, cut))
            : yield* Effect.option(standingAt(address, cut));
        if (Option.isNone(read)) return direct;
        const { standing, activity } = read.value;
        const concerns: Concerns = new Map();
        const eligible: Array<Message> = [];
        for (const { message, end } of entries) {
          if (
            reaches(message) ||
            (activity !== "inactive" &&
              (standing.mutes.length === 0 ||
                (yield* uncovered(
                  standing.mutes,
                  ambientRoutes(message, subscriber),
                  end,
                  concerns
                ))))
          ) {
            eligible.push(message);
          }
        }
        return eligible;
      });

    /**
     * Ownership and the wake notice come from one presence read under the sender's claiming
     * lock. The ledger admits the send only if the sender's presence has not changed since
     * that read, including on another machine. The wake notice still describes the earlier cut.
     */
    function publish(
      input: PublishInput & { readonly pierce?: ReadonlyArray<string> | undefined }
    ): Effect.Effect<Posted, PublishError>;
    function publish(input: PublishInput): Effect.Effect<Posted | NotSent, PublishError>;
    function publish(input: PublishInput): Effect.Effect<Posted | NotSent, PublishError> {
      return Effect.gen(function* () {
        const { operation } = input;
        if (operation !== undefined && !validEntryId(operation)) {
          return yield* new InvalidQuery({
            message:
              "operation must be a lowercase UUIDv7, the same for every retry of this send. Nothing was sent.",
          });
        }
        /**
         * Ownership, required on every attempt. A retry's refusal says nothing of an earlier
         * attempt under the operation, which may have committed; nor does it reveal one.
         */
        const owns = (presences: ReadonlyMap<string, Subscriber>) =>
          ownedIn(presences, input.from, input.session).pipe(
            Effect.mapError((error) => {
              if (operation === undefined || !validSession(input.session)) return error;
              const fields = {
                address: input.from,
                message: `${input.from} is not held by this session, so the bus cannot answer for operation ${operation}: an earlier attempt under it may have committed. Read whether it did from history before sending this message again.`,
              };
              return error._tag === "NotJoined" ? new NotJoined(fields) : new NotOwner(fields);
            })
          );
        const read = yield* ledger.presenceAt();
        const all = latestPresences(read.entries);
        const sender = yield* owns(all);
        yield* touch(input.from);
        const lacking = lackingWake(all, input.from, input.to);
        const { listed, unlisted } = listWithin(lacking, WAKE_LISTED_BYTES);
        const wake: WakeNotice | undefined =
          lacking.length === 0
            ? undefined
            : {
                ledger: read.cut.incarnation,
                t: read.cut.head,
                lacking: listed,
                ...(unlisted > 0 ? { unlisted } : {}),
              };
        const posted = (message: Message, replayed: boolean): Posted => ({
          message,
          ...(wake === undefined ? {} : { wake }),
          ...(replayed ? { replayed: true as const } : {}),
        });
        const draft = new Message({
          id: operation ?? Bun.randomUUIDv7(),
          ts: yield* now,
          from: input.from,
          to: [...input.to],
          kind: "message",
          body: input.body,
          ...optional("subject", input.subject),
          ...optional("replyTo", input.replyTo),
          origin: yield* originFor(sender.cwd, hostOf),
        });
        const mismatch = (id: string) =>
          new InvalidQuery({
            code: "IDENTITY_MISMATCH",
            message: `operation ${id} already names another entry than this send: another sender, audience, subject, body, replyTo or pierce. Nothing was written; use a new operation for a new message.`,
          });
        const unconfirmed = (id: string) =>
          new LedgerError({
            message: `The bus could not confirm whether this message was sent: it may have committed as ${id}. Retry the identical call with operation ${id}: it returns the message if it was stored and sends it once if not.`,
          });
        /**
         * Whether a stored entry is this send: the same sender, `to` exactly as given (order and
         * duplicates included, as the digest hashes it), subject, body, replyTo and pierce set.
         * A named pierce compares as it is stored. A pierce of all is the stored set this call's
         * `confirm` names, so a retry is decided by what was sent, not by the set now; without
         * `confirm` it is not the confirmed send.
         */
        const isThisSend = (stored: Message) => {
          if (stored.kind !== "message" || stored.from !== input.from) return false;
          const bypass = stored.pierce ?? [];
          const intent = sendIntentOf(stored, bypass);
          if (input.pierce === "all") {
            return (
              sendIntentOf(draft, bypass) === intent && input.confirm === digestOf(stored, bypass)
            );
          }
          const named = input.pierce === undefined ? [] : namedPierce(input.pierce, draft.to);
          return sendIntentOf(draft, named) === intent;
        };
        const store = Effect.fn("Bus.publish.store")(function* (message: Message) {
          // Only a new send reaches here. Its entry as stored, pierce set included, must fit
          // the point read that settles its retries, with or without an operation: one sent
          // without is retried under the id an unconfirmed error names.
          yield* readableEntry(message, storedEntryBytes);
          const admission = yield* ledger.admit(message, read.cut);
          if (admission.status === "REFUSED") {
            // The write is definitively refused even if the reason cannot be read back.
            const state = yield* Effect.option(ledger.presenceAt(admission.cut.head));
            if (Option.isSome(state)) {
              yield* owns(latestPresences(state.value.entries));
            }
          }
          if (operation === undefined) {
            if (admission.status === "UNKNOWN") return yield* unconfirmed(message.id);
            if (admission.status === "REFUSED") return yield* conflict(input.from);
            return posted(message, false);
          }
          // The entry stored under the operation decides every outcome: an earlier or racing
          // attempt's entry refuses this insert, or answers it as a no-op at its own commit.
          const settled = yield* ledger.readEntry(message.id);
          if (settled.status === "FOUND") {
            if (!isThisSend(settled.message)) return yield* mismatch(message.id);
            // `replayed` is reported only where it is certain this call wrote nothing: the insert
            // was refused, or the stored entry carries another attempt's time or origin. Its
            // absence never says which attempt wrote the entry: an admission or an unknown
            // outcome can be another attempt's identical entry, read at its commit, and two
            // attempts with one time and origin can't be told apart.
            const wroteNothing =
              admission.status === "REFUSED" ||
              settled.message.ts !== message.ts ||
              canonicalJson(settled.message.origin) !== canonicalJson(message.origin);
            return posted(settled.message, wroteNothing);
          }
          if (settled.status === "ABSENT" && admission.status === "REFUSED") {
            return yield* conflict(input.from);
          }
          return yield* unconfirmed(message.id);
        });
        // A send already stored under the operation is returned before anything outside its
        // intent is checked: its carrier was admitted when it was stored, and this attempt's
        // origin, which the carrier counts and the intent ignores, may since have grown. Nor is
        // its pierce set resolved again, and nothing is written.
        if (operation !== undefined) {
          const recorded = yield* ledger.readEntry(operation);
          if (recorded.status === "FOUND") {
            if (!isThisSend(recorded.message)) return yield* mismatch(operation);
            return posted(recorded.message, true);
          }
          if (recorded.status !== "ABSENT") {
            return yield* new LedgerError({
              message: `The entry under operation ${operation} could not be read, so nothing was sent. Retry the identical call with the same operation.`,
            });
          }
        }
        // Only a new send is admitted. The optional pierce set changes routing, not the public
        // read carrier.
        yield* admitEntry(draft);
        if (input.pierce === undefined) return yield* store(draft);
        const audience = (yield* peers).filter((peer) => isFor(draft, peer));
        let pierce: Array<string>;
        if (input.pierce === "all") {
          const head = yield* ledger.end;
          const concerns: Concerns = new Map();
          pierce = [];
          for (const peer of audience) {
            if (draft.to.includes(peer.address)) continue;
            if (yield* suppressed(peer, draft, head, concerns)) pierce.push(peer.address);
          }
          pierce.sort();
          const digest = digestOf(draft, pierce);
          if (input.confirm !== digest) {
            return { status: "NOT_SENT", bypass: pierce, digest } satisfies NotSent;
          }
        } else {
          const outside = input.pierce.find(
            (address) => !audience.some((peer) => peer.address === address)
          );
          if (outside !== undefined) {
            return yield* new InvalidQuery({
              message: `${outside} is not in this message's audience: pierce names only joined peers it already reaches. Nothing was sent.`,
            });
          }
          pierce = namedPierce(input.pierce, draft.to);
        }
        return yield* store(pierce.length === 0 ? draft : new Message({ ...draft, pierce }));
      }).pipe(claiming(input.from), Effect.withSpan("Bus.publish"));
    }

    /** The receipt a recorded command earns at its own commit; any failure to read it is UNKNOWN. */
    const receiptOf = (
      found: Extract<CommandRead, { readonly status: "FOUND" }>,
      address: string,
      operation: string,
      intent: string
    ) =>
      Effect.gen(function* () {
        const unknown: ActivityResult = { status: "UNKNOWN", operation };
        const stored = decodeCommand(found.json);
        if (Option.isNone(stored)) return unknown;
        if (intentOf(stored.value) !== intent) {
          return { status: "IDENTITY_MISMATCH", operation } satisfies ActivityResult;
        }
        const standing: Standing = foldStanding(address, yield* ledger.log(found.t));
        const verdict = standing.verdicts.get(operation);
        const cut = { head: found.t, incarnation: found.cut.incarnation };
        if (verdict === undefined) return unknown;
        if (verdict.status === "CONFLICT") {
          return {
            status: "CONFLICT",
            operation,
            cut,
            reason: verdict.reason,
          } satisfies ActivityResult;
        }
        const scan = needsScan(standing)
          ? yield* ledger.direct(address, standing.anchor.t, found.t)
          : undefined;
        return {
          status: "APPLIED",
          operation,
          cut,
          ...activityAt(standing, scan),
          mutes: [...standing.mutes],
        } satisfies ActivityResult;
      }).pipe(Effect.orElseSucceed((): ActivityResult => ({ status: "UNKNOWN", operation })));

    const activity = (input: ActivityInput) =>
      Effect.gen(function* () {
        const refuse = (problem: string) =>
          new InvalidQuery({ message: `${problem} Nothing was written.` });
        if (typeof input.operation !== "string" || !UUID_V7.test(input.operation)) {
          return yield* refuse("operation must be a UUIDv7, the same for every retry.");
        }
        const operation = input.operation.toLowerCase();
        if (input.activity === undefined && input.mutes === undefined) {
          return yield* refuse("Give activity, mutes or both.");
        }
        if (input.activity !== undefined && !isActivityValue(input.activity)) {
          return yield* refuse('activity must be "active" or "inactive".');
        }
        const mutes = input.mutes === undefined ? undefined : normalizeMutes(input.mutes);
        if (input.mutes !== undefined && mutes === undefined) {
          return yield* refuse(
            "Each mute is {scope: programme}, {scope: topic, topic}, {scope: directory, directory} or {scope: concern, directory, concern}, with no other fields."
          );
        }
        // A call that can never own the address is refused before anything is read.
        if (!validSession(input.session)) return yield* noSession(input.address);
        const intent = intentOf({ ...input, mutes });
        const unknown: ActivityResult = { status: "UNKNOWN", operation };

        const recorded = yield* ledger.readCommand(operation);
        if (recorded.status === "FOUND") {
          return yield* receiptOf(recorded, input.address, operation, intent);
        }
        if (recorded.status !== "ABSENT") return unknown;
        // Ownership at the cut where the operation was absent: a refusal here wrote nothing, and
        // says nothing of any other attempt with the same operation. A log that can't be read
        // fails the call before anything is written.
        const at = recorded.cut.head;
        const { holder } = foldStanding(input.address, yield* ledger.log(at));
        if (holder === undefined || holder.presence.status !== "joined") {
          return yield* new NotJoined({
            address: input.address,
            message: `${input.address} has not joined the bus; this call wrote nothing (operation ${operation} was absent at t=${at}).`,
          });
        }
        if (holder.presence.session !== input.session) {
          return yield* new NotOwner({
            address: input.address,
            message: `${input.address} belongs to another session; this call wrote nothing (operation ${operation} was absent at t=${at}).`,
          });
        }
        yield* touch(input.address);
        const command: AddressCommand = {
          address: input.address,
          runtime: holder.presence.runtime,
          session: input.session,
          run: runOf(holder),
          ts: yield* now,
          ...optional("activity", input.activity),
          ...optional("mutes", mutes),
        };
        // A lost response may still have committed: only reading the node back decides.
        yield* Effect.ignore(ledger.appendCommand(operation, JSON.stringify(command)));
        const written = yield* ledger.readCommand(operation);
        return written.status === "FOUND"
          ? yield* receiptOf(written, input.address, operation, intent)
          : unknown;
      }).pipe(claiming(input.address), Effect.withSpan("Bus.activity"));

    const withOwner = <A, E>(
      address: string,
      session: string | undefined,
      action: (owner: Subscriber) => Effect.Effect<A, E>
    ) =>
      owned(address, session).pipe(
        Effect.flatMap(action),
        claiming(address),
        Effect.withSpan("Bus.withOwner")
      );

    const unprovedSource = () =>
      new LedgerError({
        message:
          "The original mailbox import does not establish this holding's read source. Nothing was served or changed. Ask the operator to reconcile the retained evidence; do not rejoin or replay.",
      });

    /** Only an intact initial import can identify the source, including a confirmed nonlocal one. */
    const legacyReadOnSource = (
      subscriber: Subscriber,
      cut: Pin,
      state: Extract<MailboxState, { status: "FOUND" }>
    ) =>
      Effect.gen(function* () {
        if (
          subscriber.presence.installation !== undefined ||
          subscriber.presence.status !== "joined"
        )
          return false;
        let first = state.current;
        if (first.t !== state.initialT) {
          const original = yield* ledger.mailboxAt(subscriber.address, {
            ...cut,
            head: state.initialT,
          });
          if (original.status !== "FOUND" || original.current.t !== state.initialT)
            return yield* unprovedSource();
          const intact = yield* ledger.mailboxReceiptAt(
            subscriber.address,
            original.current.record.operation,
            cut
          );
          if (intact.status === "UNAVAILABLE")
            return yield* new LedgerError({
              message:
                "The original mailbox import receipt could not be read. This call served and changed nothing. Retry the same call once when the store is available, keeping the same readId or acknowledgement receipt. Do not rejoin.",
            });
          if (
            intact.status !== "FOUND" ||
            intact.t !== state.initialT ||
            encodeMailboxFact(intact.record) !== encodeMailboxFact(original.current.record)
          )
            return yield* unprovedSource();
          first = intact;
        }
        const { record } = first;
        // An ordinary start is not a missing import; it never carried a manual-read grant.
        if (record.kind === "start" && record.origin !== "import") return false;
        if (
          record.kind !== "start" ||
          record.previous !== null ||
          record.legacySource?.cut.incarnation !== cut.incarnation ||
          record.legacySource.presenceRef !== mailboxPresenceRef(subscriber.joinId) ||
          record.runRef !== mailboxRunRef(runOf(subscriber)) ||
          (state.current.t !== state.initialT &&
            (state.current.record.kind !== "ack" ||
              state.current.record.runRef !== record.runRef ||
              state.current.record.subscription.presenceRef !== record.legacySource.presenceRef))
        )
          return yield* unprovedSource();
        return record.legacySource.installationRef === mailboxInstallationRef(installation);
      });

    const mailboxBasis = (subscriber: Subscriber, cut: Pin, manual = false) =>
      Effect.gen(function* () {
        const address = subscriber.address;
        const notLocal = () =>
          new NotJoined({
            address,
            message: "This holding did not join from this installation; nothing was changed.",
          });
        if (!local(subscriber) && (!manual || subscriber.presence.installation !== undefined))
          return yield* notLocal();
        const state = yield* ledger.mailboxAt(address, cut);
        if (state.status === "UNRESOLVED") return yield* unresolvedMailbox(state.reason);
        if (state.status !== "FOUND") {
          if (!local(subscriber)) return yield* unprovedSource();
          return yield* new NotJoined({
            address,
            message: "This holding has no ledger position; nothing was changed.",
          });
        }
        if (!local(subscriber) && !(yield* legacyReadOnSource(subscriber, cut, state)))
          return yield* notLocal();
        return {
          subscriber,
          cut,
          position: state.position,
          positionOperation: state.current.record.operation,
        } satisfies MailboxBasis;
      });

    const hints = new Map<string, { readonly basis: string; readonly through: number }>();
    const hintBasis = ({ subscriber, cut, positionOperation }: MailboxBasis) =>
      JSON.stringify([
        cut.incarnation,
        positionOperation,
        runOf(subscriber),
        subscriber.presence.topics,
      ]);

    /** Shared pinned proof; only a successful empty pass may choose to retain its progress. */
    const pending = (basis: MailboxBasis) =>
      Effect.gen(function* () {
        const { subscriber, cut, position } = basis;
        const hint = hints.get(subscriber.address);
        let from = position;
        if (hint !== undefined) {
          if (
            hint.basis === hintBasis(basis) &&
            hint.through >= position &&
            hint.through <= cut.head
          ) {
            from = hint.through;
          } else {
            hints.delete(subscriber.address);
          }
        }
        return yield* readMailboxSlice(ledger, from, cut, subscriber);
      }).pipe(Effect.withSpan("Bus.pending"));

    const rememberEmpty = (basis: MailboxBasis) =>
      Effect.sync(() => {
        if (basis.cut.head > basis.position) {
          hints.set(basis.subscriber.address, { basis: hintBasis(basis), through: basis.cut.head });
        }
      });

    const wholeRead = (basis: MailboxBasis) =>
      pending(basis).pipe(
        Effect.flatMap(({ entries, damage }) =>
          damage === undefined ? Effect.succeed(entries) : Effect.fail(incompleteMailbox(damage))
        )
      );

    /**
     * The comparators for a receipt's identity witnesses, its run and its served subscription:
     * the one place that reads how a receipt records them.
     */
    type RecordedAck = Extract<MailboxFact, { kind: "ack" }>;
    const sameRun = (record: RecordedAck, subscriber: Subscriber) =>
      record.runRef === mailboxRunRef(runOf(subscriber));
    const servedUnder = (record: RecordedAck, subscriber: Subscriber) =>
      record.subscription.presenceRef === mailboxPresenceRef(subscriber.joinId) &&
      record.subscription.topicsDigest === mailboxTopicsDigest(subscriber.presence.topics);

    /** Writes one guarded acknowledgement of exactly `messages`; the caller settles the status. */
    const acknowledge = (
      { subscriber, cut, position }: MailboxBasis,
      { through, messages }: MailboxPlan,
      operation: string
    ) => {
      const address = subscriber.address;
      const record: MailboxAck = {
        version: 1,
        kind: "ack",
        operation,
        address,
        mode: "read",
        run: runOf(subscriber),
        from: position,
        through,
        dataCut: cut,
        subscription: {
          presenceId: subscriber.joinId,
          topicsDigest: mailboxTopicsDigest(subscriber.presence.topics),
        },
        servedCount: messages.length,
        servedDigest: mailboxServedDigest(messages.map(({ id }) => id)),
        carrierBytes: servedCarrierBytes(messages, position, through),
      };
      return Effect.map(ledger.appendMailboxAck(record, cut), (saved) => {
        if (saved.status === "APPLIED") hints.delete(address);
        return saved.status;
      });
    };

    const unestablished = () =>
      new LedgerError({
        message:
          "The read recorded under this readId could not be established; nothing was served or changed.",
      });

    /**
     * The read recorded under `readId` for `current`'s run, or undefined when none is. Anything
     * else recorded under it, another address's, a position that served no batch or an earlier
     * run's, is refused; a receipt the mailbox never referenced is not a recorded read.
     */
    const recordedRead = (current: Subscriber, readId: string, cut: Pin) =>
      Effect.gen(function* () {
        const found = yield* ledger.mailboxReceiptAt(current.address, readId, cut);
        if (found.status === "ABSENT") return undefined;
        if (found.status === "ADDRESS_MISMATCH") {
          return yield* new InvalidQuery({
            message:
              "This readId is recorded for another address, so this address cannot use it. Read with a new readId, such as your latest nextReadId. Nothing was changed.",
          });
        }
        if (found.status !== "FOUND") return yield* unestablished();
        const { record } = found;
        if (record.kind !== "ack" || record.mode !== "read") {
          return yield* new InvalidQuery({
            message:
              "This readId names a mailbox position that served no batch, so it can be neither replayed nor acknowledged. Read with a new readId. Nothing was changed.",
          });
        }
        if (!sameRun(record, current)) {
          return yield* new InvalidQuery({
            message:
              "This readId was recorded in an earlier run of this holding (a leave and rejoin, a replay or a takeover since), so it can be neither replayed nor acknowledged. Read with your latest nextReadId, or without one. Nothing was changed.",
          });
        }
        // The position at the receipt's commit matters, not which later reads moved the pointer.
        const original = yield* ledger.mailboxAt(current.address, {
          incarnation: cut.incarnation,
          head: found.t,
        });
        if (
          record.dataCut.incarnation !== cut.incarnation ||
          original.status !== "FOUND" ||
          original.current.t !== found.t ||
          original.current.record.operation !== readId
        ) {
          return yield* unestablished();
        }
        return record;
      });

    /** The joined subscriber in force for the address at a receipt's own cut, as it recorded it. */
    const servedSubscriber = (address: string, record: RecordedAck) =>
      Effect.gen(function* () {
        const read = yield* ledger.presenceAt(record.dataCut.head);
        const subscriber = latestPresences(read.entries).get(address);
        if (
          read.cut.incarnation !== record.dataCut.incarnation ||
          read.cut.head !== record.dataCut.head ||
          subscriber?.presence.status !== "joined" ||
          !servedUnder(record, subscriber)
        ) {
          return yield* unestablished();
        }
        return subscriber;
      });

    /**
     * Serves a recorded batch again, whole, writing nothing: reconstructed at its original cut
     * under the subscription it was served with, never from the scan hint, and matched exactly.
     */
    const replay = (record: RecordedAck, input: ReadInput, nextReadId: string) =>
      Effect.gen(function* () {
        const historical = yield* servedSubscriber(input.address, record);
        const { entries } = yield* servedPrefix(
          ledger,
          record.from,
          record.through,
          record.dataCut,
          historical
        );
        const messages = entries.map(({ message }) => message);
        if (
          messages.length !== record.servedCount ||
          mailboxServedDigest(messages.map(({ id }) => id)) !== record.servedDigest ||
          servedCarrierBytes(messages, record.from, record.through) !== record.carrierBytes
        ) {
          return yield* unestablished();
        }
        const receipt: ReadReceipt = {
          readId: record.operation,
          from: record.from,
          through: record.through,
          replayed: true,
        };
        const bytes = carrierBytes(readResult(messages, receipt, nextReadId));
        if (
          (input.limit !== undefined && messages.length > input.limit) ||
          (input.maxResultBytes !== undefined && bytes > input.maxResultBytes)
        ) {
          return yield* new InvalidQuery({
            message: `The batch recorded under this readId needs ${bytes} result bytes and a limit of at least ${messages.length}; repeat the read with the same readId and limits that fit. Nothing was changed.`,
          });
        }
        return { messages, receipt, nextReadId } satisfies ReadOutcome;
      });

    /** A receipt can settle the earlier write only for a still-authorized caller at its lookup cut. */
    const settledRead = (basis: MailboxBasis, session: string | undefined, readId: string) =>
      Effect.gen(function* () {
        const { entries, cut } = yield* ledger.presenceAt();
        if (cut.incarnation !== basis.cut.incarnation || cut.head < basis.cut.head)
          return undefined;
        const prior = basis.subscriber;
        const current = yield* ownedIn(latestPresences(entries), prior.address, session);
        if (current.presence.runtime !== prior.presence.runtime || runOf(current) !== runOf(prior))
          return undefined;
        if (!local(current)) yield* mailboxBasis(current, cut, true);
        return yield* recordedRead(current, readId, cut);
      }).pipe(Effect.option, Effect.map(Option.getOrUndefined));

    const wakeHolding = (address: string, session: string | undefined, at?: number) =>
      Effect.gen(function* () {
        const read = yield* ledger.presenceAt(at);
        const subscriber = yield* ownedIn(latestPresences(read.entries), address, session);
        if (!local(subscriber)) {
          return yield* new InvalidQuery({
            message: "This holding did not join from this installation; nothing was changed.",
          });
        }
        const binding: WakeBinding = {
          address,
          session: subscriber.presence.session ?? "",
          runtime: subscriber.presence.runtime,
          installation: subscriber.presence.installation ?? "",
          incarnation: read.cut.incarnation,
          run: runOf(subscriber),
        };
        return { subscriber, binding, cut: read.cut };
      });

    const currentWakeHolding = (
      address: string,
      session: string | undefined,
      previous: { readonly subscriber: Subscriber; readonly cut: Pin }
    ) =>
      Effect.gen(function* () {
        const current = yield* wakeHolding(address, session);
        if (
          current.cut.incarnation !== previous.cut.incarnation ||
          current.subscriber.joinId !== previous.subscriber.joinId
        ) {
          return yield* new InvalidQuery({
            message:
              "The holding or ledger changed during observation; retry without advancing coverage.",
          });
        }
        return current;
      });

    const checkWakeBinding = Effect.fn("Bus.checkWakeBinding")(function* (
      input: CheckWakeBindingRequest
    ) {
      const checked = yield* Schema.decodeUnknownEffect(CheckWakeBindingRequest, {
        onExcessProperty: "error",
      })(input).pipe(
        Effect.mapError(
          () =>
            new InvalidQuery({
              message: "Invalid wake binding check arguments; nothing was changed.",
            })
        )
      );
      if (Buffer.byteLength(JSON.stringify(checked), "utf8") > MAX_WAKE_OBSERVATION_BYTES) {
        return yield* new InvalidQuery({
          message:
            "Wake binding check arguments exceed the complete input budget; nothing was changed.",
        });
      }
      if (!validSession(checked.session)) return yield* noSession(checked.address);
      return yield* Effect.gen(function* () {
        const first = yield* wakeHolding(checked.address, checked.session);
        if (!sameWakeBinding(checked.expectedBinding, first.binding)) {
          return yield* new InvalidQuery({
            message:
              "The wake binding is stale; obtain fresh authority for the current holding. Nothing was changed.",
          });
        }
        const current = yield* currentWakeHolding(checked.address, checked.session, first);
        const result = { binding: current.binding, observationCut: current.cut };
        if (wakeObservationCarrierBytes(result) > MAX_WAKE_OBSERVATION_BYTES) {
          return yield* new InvalidQuery({
            message:
              "The complete wake binding result exceeds this observer's capacity; nothing was changed.",
          });
        }
        return yield* Schema.decodeUnknownEffect(WakeBindingCheck)(result).pipe(
          Effect.mapError(
            () =>
              new LedgerError({
                message: "The complete wake binding evidence could not be validated.",
              })
          )
        );
      }).pipe(exclusive(checked.address));
    });

    const observeOnce = (input: ObserveWakeRequest, bind?: (binding: WakeBinding) => void) =>
      Effect.gen(function* () {
        const { address, session, expectedBinding, previousCoverage } = input;
        const refuse = (message: string) => new InvalidQuery({ message });
        const first = yield* wakeHolding(address, session);
        const { subscriber, binding, cut } = first;
        for (const expected of [expectedBinding, previousCoverage?.binding]) {
          if (expected !== undefined && !sameWakeBinding(expected, binding)) {
            return yield* refuse(
              "The wake binding is stale; obtain fresh authority for the current holding. Nothing was changed."
            );
          }
        }
        // Retain this wait's first authorized holding even if its initial slice times out.
        bind?.(binding);
        const basis = yield* mailboxBasis(subscriber, cut);
        const cursor = basis.position;
        if (previousCoverage !== undefined && previousCoverage.cursor > cursor) {
          return yield* refuse(
            "Wake coverage is ahead of this holding's read position; nothing was changed."
          );
        }
        const entries = yield* wholeRead(basis);
        const messages = yield* eligibleOf(subscriber, entries, cut.head);
        const ready = messages.length > 0;
        let latestEligibleAt: { readonly millis: number; readonly tail: string } | undefined;
        for (const message of messages) {
          // Native messages are ISO timestamps. Refuse damaged primary evidence instead
          // of manufacturing an occurrence time from the observer's clock.
          const parts =
            /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d+))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
              message.ts
            );
          const year = Number(parts?.[1]);
          const month = Number(parts?.[2]);
          const day = Number(parts?.[3]);
          const calendar = new Date(0);
          calendar.setUTCFullYear(year, month - 1, day);
          const timestamp = parts === null ? Number.NaN : Date.parse(message.ts);
          if (
            !Number.isFinite(timestamp) ||
            calendar.getUTCFullYear() !== year ||
            calendar.getUTCMonth() !== month - 1 ||
            calendar.getUTCDate() !== day
          ) {
            return yield* new LedgerError({ message: "An eligible message timestamp is invalid." });
          }
          const tail = (parts?.[4] ?? "").slice(3).replace(/0+$/, "");
          const tailLength = Math.max(tail.length, latestEligibleAt?.tail.length ?? 0);
          if (
            latestEligibleAt === undefined ||
            timestamp > latestEligibleAt.millis ||
            (timestamp === latestEligibleAt.millis &&
              tail.padEnd(tailLength, "0") > latestEligibleAt.tail.padEnd(tailLength, "0"))
          )
            latestEligibleAt = { millis: timestamp, tail };
        }
        const covered = cover(previousCoverage, {
          subscriber,
          cursor,
          unread: entries.map((entry) => entry.message.id),
          messages,
        });
        const nextCoverage = ready ? { binding, ...covered.coverage } : previousCoverage;
        const result: WakeObservation = {
          binding,
          observationCut: cut,
          ready,
          news: ready && covered.news,
          ...(latestEligibleAt === undefined
            ? {}
            : {
                latestEligibleAt: new Date(latestEligibleAt.millis)
                  .toISOString()
                  .replace(/Z$/, `${latestEligibleAt.tail}Z`),
              }),
          ...(nextCoverage === undefined ? {} : { nextCoverage }),
        };
        if (
          (nextCoverage?.rung.length ?? 0) > MAX_WAKE_COVERAGE_IDS ||
          wakeObservationCarrierBytes(result) > (input.maxResultBytes ?? MAX_WAKE_OBSERVATION_BYTES)
        ) {
          return yield* refuse(
            "Complete wake coverage exceeds this observer's capacity; no partial evidence was returned and nothing was changed. Read mail or reduce backlog before retrying."
          );
        }
        // A remote writer does not share our lock. Fence changes observed before return admission.
        yield* currentWakeHolding(address, session, first);
        const observation = yield* Schema.decodeUnknownEffect(WakeObservation)(result).pipe(
          Effect.mapError(
            () => new LedgerError({ message: "The complete wake evidence could not be validated." })
          )
        );
        if (entries.length === 0) yield* rememberEmpty(basis);
        return observation;
      }).pipe(exclusive(input.address), Effect.withSpan("Bus.observeWake.snapshot"));

    const observeWake = Effect.fn("Bus.observeWake")(function* (input: ObserveWakeRequest) {
      const checked = yield* Schema.decodeUnknownEffect(ObserveWakeRequest, {
        onExcessProperty: "error",
      })(input).pipe(
        Effect.mapError(
          () =>
            new InvalidQuery({
              message: "Invalid wake observation arguments; nothing was changed.",
            })
        )
      );
      if (Buffer.byteLength(JSON.stringify(checked), "utf8") > MAX_WAKE_OBSERVATION_BYTES) {
        return yield* new InvalidQuery({
          message:
            "Wake observation arguments exceed the complete input budget; nothing was changed.",
        });
      }
      if (!validSession(checked.session)) return yield* noSession(checked.address);
      if (
        checked.previousCoverage !== undefined &&
        new Set(checked.previousCoverage.rung).size !== checked.previousCoverage.rung.length
      ) {
        return yield* new InvalidQuery({
          message: "Wake coverage ids must be unique; nothing was changed.",
        });
      }
      const timeoutSeconds = checked.timeoutSeconds ?? 0;
      if (timeoutSeconds === 0) return yield* observeOnce(checked);
      let binding = checked.expectedBinding;
      // Subscribe alongside the first look. Each wait keeps its initial run, never rebinds.
      const watch = Stream.merge(Stream.succeed(undefined), ledger.changes).pipe(
        Stream.mapEffect(() =>
          observeOnce(
            { ...checked, ...(binding === undefined ? {} : { expectedBinding: binding }) },
            (found) => {
              binding = found;
            }
          )
        ),
        Stream.filter((found) => found.ready && found.news),
        Stream.runHead
      );
      const found = Option.flatten(yield* Effect.timeoutOption(watch, `${timeoutSeconds} seconds`));
      return Option.isSome(found)
        ? found.value
        : yield* observeOnce({
            ...checked,
            ...(binding === undefined ? {} : { expectedBinding: binding }),
          });
    });

    const deliver = <A, E, E2 = never>(
      address: string,
      nudge: (pending: Pending) => Effect.Effect<A, E>,
      { accepts, idle }: DeliveryOptions<E2> = {}
    ) =>
      Effect.gen(function* () {
        // Discovery is not authority: membership, position and mail are all read at this cut.
        const { entries: presence, cut } = yield* ledger.presenceAt();
        const subscriber = latestPresences(presence).get(address);
        if (
          subscriber?.presence.status !== "joined" ||
          !local(subscriber) ||
          accepts?.(subscriber) === false
        ) {
          return undefined;
        }
        const basis = yield* mailboxBasis(subscriber, cut);
        const entries = yield* wholeRead(basis);
        if (entries.length > 0) {
          const eligible = yield* eligibleOf(subscriber, entries, cut.head);
          if (eligible.length > 0) {
            return yield* nudge({
              subscriber,
              messages: eligible,
              unread: entries.map((entry) => entry.message.id),
              cursor: basis.position,
            });
          }
          // Suppressed: nothing wakes it, and its unread mail stays unread and unacknowledged.
          return undefined;
        }
        yield* rememberEmpty(basis);
        if (idle !== undefined) yield* idle(subscriber);
        return undefined;
      }).pipe(exclusive(address), Effect.withSpan("Bus.deliver"));

    /** The owner's read: ownership, the read id and the position are decided under the lock. */
    const readOnce = (input: ReadInput) =>
      Effect.gen(function* () {
        const { address, session, readId, limit, maxResultBytes } = input;
        if (!validSession(session)) return yield* noSession(address);
        if (readId !== undefined && !READ_ID.test(readId)) return yield* invalidReadId();
        const { entries: presence, cut } = yield* ledger.presenceAt();
        const subscriber = yield* ownedIn(latestPresences(presence), address, session);
        const basis = yield* mailboxBasis(subscriber, cut, true);
        yield* touch(address);
        const nextReadId = Bun.randomUUIDv7();
        if (readId !== undefined) {
          const recorded = yield* recordedRead(subscriber, readId, cut);
          if (recorded !== undefined) return yield* replay(recorded, input, nextReadId);
        }
        const { entries, damage } = yield* pending(basis);
        if (entries.length === 0) {
          if (damage !== undefined) return yield* incompleteMailbox(damage);
          yield* rememberEmpty(basis);
          return { messages: [], nextReadId } satisfies ReadOutcome;
        }
        // A caller's id names the acknowledgement; the bus mints one only when none is given.
        const operation = readId ?? Bun.randomUUIDv7();
        const messagesOf = (prefix: Prefix) =>
          entries.slice(0, prefix.count).map(({ message }) => message);
        const receiptOf = (prefix: Prefix): ReadReceipt => {
          const served = {
            readId: operation,
            from: basis.position,
            through: prefix.through,
            replayed: false,
          };
          return input.peek !== true
            ? served
            : {
                ...served,
                basis: { ledger: cut.incarnation, t: cut.head },
                served: {
                  count: prefix.count,
                  digest: mailboxServedDigest(messagesOf(prefix).map(({ id }) => id)),
                },
              };
        };
        const bytesOf = (prefix: Prefix) =>
          carrierBytes(readResult(messagesOf(prefix), receiptOf(prefix), nextReadId));
        const { chosen, first } = longestPrefix(
          entries,
          cut.head,
          limit,
          (prefix) => maxResultBytes === undefined || bytesOf(prefix) <= maxResultBytes
        );
        // A Fluree cursor names a commit, not a row. Never consume only part of one commit.
        if (chosen === undefined)
          return yield* new InvalidQuery({
            message: `The oldest unread messages cannot fit this read's limits without splitting a commit; the cursor was not advanced. Their first commit needs ${bytesOf(first)} result bytes and a limit of at least ${first.count}. Use a reader with larger limits.`,
          });
        if (chosen.exhausted && damage !== undefined) return yield* incompleteMailbox(damage);
        const messages = messagesOf(chosen);
        const receipt = receiptOf(chosen);
        if (input.peek === true) return { messages, receipt, nextReadId } satisfies ReadOutcome;
        const status = yield* acknowledge(basis, { through: chosen.through, messages }, operation);
        if (status === "APPLIED") return { messages, receipt, nextReadId } satisfies ReadOutcome;
        // The stored receipt decides: this read's own uncertain commit, or a racing call's.
        const stored = yield* settledRead(basis, session, operation);
        if (stored !== undefined) {
          if (
            stored.from === basis.position &&
            stored.through === chosen.through &&
            stored.dataCut.head === cut.head &&
            stored.servedDigest === mailboxServedDigest(messages.map(({ id }) => id))
          )
            return { messages, receipt, nextReadId } satisfies ReadOutcome;
          if (readId !== undefined) return yield* replay(stored, input, nextReadId);
        }
        switch (status) {
          case "CONFLICT":
            return yield* new LedgerError({
              message:
                "The holding or mailbox position changed during this read; nothing was acknowledged. Read again from its current position.",
            });
          case "IDENTITY_MISMATCH":
            return yield* new LedgerError({
              message: "This mailbox operation names a different recorded acknowledgement.",
            });
          case "UNKNOWN":
            return yield* new LedgerError({
              message: `The bus could not confirm this acknowledgement; it may have committed. Repeat the read with readId "${operation}": it returns this batch if it was recorded, or reads afresh if not.`,
            });
        }
      });

    const read = (input: ReadInput) =>
      readOnce(input).pipe(exclusive(input.address), Effect.withSpan("Bus.read"));

    const take = (address: string, session: string | undefined, limit?: number) =>
      Effect.map(read({ address, session, limit }), ({ messages }) => messages);

    const waitFor = Effect.fn("Bus.wait")(function* (input: WaitInput) {
      // Each pass is a whole read, so a read id recorded meanwhile is replayed, not reused.
      const once = read({
        address: input.address,
        session: input.session,
        readId: input.readId,
        limit: input.limit,
        maxResultBytes: input.maxResultBytes,
      });
      const ready = yield* once;
      if (ready.messages.length > 0) return ready;
      const arrival = ledger.changes.pipe(
        Stream.mapEffect(() => once),
        Stream.filter((outcome) => outcome.messages.length > 0),
        Stream.runHead
      );
      const arrived =
        input.timeoutSeconds === undefined
          ? yield* arrival
          : Option.flatten(yield* Effect.timeoutOption(arrival, `${input.timeoutSeconds} seconds`));
      return Option.getOrElse(arrived, () => ready);
    });
    // Open waits are counted so a refused join can say whether the holder is listening.
    const wait = (input: WaitInput) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          seenOf(input.address).waits += 1;
        }),
        () => waitFor(input),
        () =>
          Effect.sync(() => {
            seenOf(input.address).waits -= 1;
          })
      );

    /**
     * Acknowledges exactly what a peek served. The receipt is checked, not trusted: the batch
     * is reconstructed at the peek's own cut, and the write is fenced on that cut, so any
     * presence or position written since the peek refuses it.
     */
    const ackOnce = (input: AckInput) =>
      Effect.gen(function* () {
        const { address, session, receipt } = input;
        if (!validSession(session)) return yield* noSession(address);
        if (!READ_ID.test(receipt.readId)) return yield* invalidReadId();
        const changed = () =>
          new InvalidQuery({
            message:
              "The holding, subscription or mailbox position changed since this peek; nothing was acknowledged. Peek again.",
          });
        const mismatched = () =>
          new InvalidQuery({
            message:
              "This receipt does not match the mail its peek served; nothing was acknowledged. Peek again.",
          });
        const { entries: presence, cut } = yield* ledger.presenceAt();
        const subscriber = yield* ownedIn(latestPresences(presence), address, session);
        const current = yield* mailboxBasis(subscriber, cut, true);
        yield* touch(address);
        const nextReadId = Bun.randomUUIDv7();
        const done = (replayed: boolean): Acked => ({
          receipt: {
            readId: receipt.readId,
            from: receipt.from,
            through: receipt.through,
            replayed,
          },
          nextReadId,
        });
        const records = (record: RecordedAck) =>
          record.from === receipt.from &&
          record.through === receipt.through &&
          record.dataCut.head === receipt.basis.t &&
          record.servedCount === receipt.served.count &&
          record.servedDigest === receipt.served.digest;
        if (receipt.basis.ledger !== cut.incarnation) {
          return yield* new InvalidQuery({
            message:
              "This receipt was read from a replaced ledger; nothing was acknowledged. Peek again.",
          });
        }
        const recorded = yield* recordedRead(subscriber, receipt.readId, cut);
        if (recorded !== undefined) {
          if (records(recorded)) return done(true);
          return yield* new InvalidQuery({
            message:
              "This readId already records a different batch; nothing was acknowledged. Peek again.",
          });
        }
        const peekCut: Pin = { incarnation: cut.incarnation, head: receipt.basis.t };
        if (
          !Number.isSafeInteger(peekCut.head) ||
          peekCut.head < 0 ||
          peekCut.head > cut.head ||
          current.position !== receipt.from
        )
          return yield* changed();
        const then = yield* ledger.presenceAt(peekCut.head);
        const peeked = latestPresences(then.entries).get(address);
        if (
          then.cut.head !== peekCut.head ||
          peeked?.presence.status !== "joined" ||
          peeked.joinId !== subscriber.joinId
        )
          return yield* changed();
        const basis = yield* mailboxBasis(peeked, peekCut, true);
        if (basis.position !== receipt.from) return yield* changed();
        const { entries, boundary } = yield* servedPrefix(
          ledger,
          receipt.from,
          receipt.through,
          peekCut,
          peeked
        );
        const messages = entries.map(({ message }) => message);
        if (
          !boundary ||
          messages.length === 0 ||
          messages.length !== receipt.served.count ||
          mailboxServedDigest(messages.map(({ id }) => id)) !== receipt.served.digest
        )
          return yield* mismatched();
        const status = yield* acknowledge(
          basis,
          { through: receipt.through, messages },
          receipt.readId
        );
        if (status === "APPLIED") return done(false);
        const stored = yield* settledRead(current, session, receipt.readId);
        if (stored !== undefined && records(stored)) return done(status !== "UNKNOWN");
        if (status === "UNKNOWN") {
          return yield* new LedgerError({
            message:
              "The bus could not confirm this acknowledgement; it may have committed. Repeat bus_ack with the same receipt.",
          });
        }
        return yield* changed();
      });

    const ack = (input: AckInput) =>
      ackOnce(input).pipe(exclusive(input.address), Effect.withSpan("Bus.ack"));

    /** Per address, the join and the unread mail (first to newest) its owner was last woken for. */
    const woken = new Map<string, Mark>();
    /** Each session's current wake wait; a newer one ends it. */
    const wakers = new Map<string, Deferred.Deferred<void>>();

    const settled = (found: Woken) => found.addresses.length > 0 || !found.owns || found.superseded;
    const timedOut: Woken = { addresses: [], owns: true, superseded: false };
    const superseded: Woken = { addresses: [], owns: true, superseded: true };

    /**
     * The session's addresses, joined from this machine as Claude, whose unread
     * mail isn't what they were last woken for. New mail, or a partial read,
     * changes it; a fresh compact hook can also ring for unchanged unread mail.
     * The reads, under each address's lock, can be interrupted, and an address
     * whose read fails is skipped for this pass, keeping its mark. The marks then
     * move in one step, only while this is still the session's wait. Each
     * address it covers counts as an open wait (`counted`), as a `bus_wait`
     * does, so a refused join can tell a live holder from a dead one.
     */
    const wakeable = (
      session: string,
      mine: Deferred.Deferred<void>,
      moved: Array<Moved>,
      counted: Set<string>,
      fresh: boolean
    ) =>
      Effect.gen(function* () {
        const eligible = (peer: Subscriber) =>
          peer.presence.runtime === "claude" && peer.presence.session === session;
        const owned = (yield* localPeers).filter(eligible);
        const found: Array<Moved> = [];
        for (const peer of owned) {
          yield* touch(peer.address);
          if (!counted.has(peer.address)) {
            counted.add(peer.address);
            seenOf(peer.address).waits += 1;
          }
          const unread = yield* deliver(
            peer.address,
            (found) => {
              const { subscriber } = found;
              // The mark as it was under the lock: if it has moved by the commit (another
              // owner's wake, after a takeover), this reading is stale and is dropped.
              const previous = woken.get(subscriber.address);
              const { news, coverage } = cover(
                previous?.joinId === subscriber.joinId ? previous.coverage : undefined,
                found
              );
              return Effect.succeed({
                address: subscriber.address,
                previous,
                mark: { joinId: subscriber.joinId, coverage },
                news,
              });
            },
            { accepts: eligible }
          ).pipe(
            // A join without an established mailbox, or a failing read,
            // leaves this address for a later pass rather than holding up the others.
            Effect.catchTags({
              NotJoined: (error) => Effect.as(skipped(peer.address, error), undefined),
              LedgerError: (error) => Effect.as(skipped(peer.address, error), undefined),
            })
          );
          if (unread !== undefined) found.push(unread);
        }
        return yield* Effect.sync(
          (): Woken =>
            wakers.get(session) === mine
              ? {
                  addresses: commitMarks(woken, found, moved, fresh),
                  owns: owned.length > 0,
                  superseded: false,
                }
              : superseded
        );
      });

    const skipped = (address: string, error: { readonly message: string }) =>
      Effect.logWarning(`Not waking ${address} this pass: ${error.message}`);

    const wake = (session: string | undefined, timeoutSeconds: number, fresh = false) =>
      Effect.gen(function* () {
        if (!validSession(session)) {
          return yield* new NotOwner({ address: "", message: sessionHelp });
        }
        hooked.add(session);
        const mine = yield* Deferred.make<void>();
        const moved: Array<Moved> = [];
        const counted = new Set<string>();
        // A first look now, and one per change after; the changes are subscribed
        // alongside the first look, so mail landing during it isn't left to the poll.
        const watch = Stream.merge(Stream.succeed(undefined), ledger.changes).pipe(
          Stream.mapEffect(() => wakeable(session, mine, moved, counted, fresh)),
          Stream.filter(settled),
          Stream.runHead,
          Effect.map(Option.getOrElse(() => timedOut))
        );
        return yield* Effect.acquireUseRelease(
          Effect.suspend(() => {
            const previous = wakers.get(session);
            wakers.set(session, mine);
            return previous === undefined ? Effect.void : Deferred.succeed(previous, undefined);
          }),
          () =>
            Effect.raceFirst(watch, Effect.as(Deferred.await(mine), superseded)).pipe(
              Effect.timeoutOption(`${timeoutSeconds} seconds`),
              Effect.map(Option.getOrElse(() => timedOut))
            ),
          (_, exit) =>
            Effect.sync(() => {
              if (wakers.get(session) === mine) wakers.delete(session);
              for (const address of counted) seenOf(address).waits -= 1;
              // A mark moves only with the result that names it: undo those whose result was lost.
              restoreMarks(woken, moved, Exit.isSuccess(exit) ? exit.value.addresses : []);
            })
        );
      }).pipe(Effect.withSpan("Bus.wake"));

    return Bus.of({
      join,
      leave,
      publish,
      activity,
      withOwner,
      peers,
      localPeers,
      checkWakeBinding,
      observeWake,
      deliver,
      read,
      take,
      wait,
      ack,
      wake,
    });
  });

/**
 * `storedEntryBytes` is the stored-entry budget a new send is sized against; only tests lower it,
 * to reach the bound without a 32 MiB fixture.
 */
export const layer = (
  installation: string,
  hostOf = hostname,
  storedEntryBytes = MAX_STORED_ENTRY_BYTES
) => Layer.effect(Bus, make(installation, hostOf, storedEntryBytes));
