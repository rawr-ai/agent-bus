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
import { Cursors } from "./Cursors.ts";
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
  type Runtime,
  runOf,
  type Standing,
  type Subscriber,
  topicName,
  validSession,
} from "./domain.ts";
import { type CommandRead, type Entry, Ledger } from "./Ledger.ts";
import { canonicalJson } from "./orientation-model.ts";
import { directoryAt } from "./orientation-read.ts";
import { type Pin, QueryGateway } from "./Query.ts";

export const ORIENTATION_JOIN_TOO_LARGE = "Orientation cannot fit alongside this committed join.";

/** Selects a whole prefix before the read cursor advances, while the address is locked. */
export type ReadAdmission = (messages: ReadonlyArray<Message>) => number;

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

type PublishError = LedgerError | NotJoined | NotOwner | InvalidQuery;

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
      },
      LedgerError | NotOwner | PresenceConflict | InvalidTopics | InvalidAssociations | InvalidQuery
    >;
    readonly leave: (
      address: string,
      session: string | undefined
    ) => Effect.Effect<void, LedgerError | NotJoined | NotOwner | PresenceConflict>;
    /** A pierce of "all" without its confirming digest returns NOT_SENT and writes nothing. */
    readonly publish: {
      (
        input: PublishInput & { readonly pierce?: ReadonlyArray<string> | undefined }
      ): Effect.Effect<Message, PublishError>;
      (input: PublishInput): Effect.Effect<Message | NotSent, PublishError>;
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
    /**
     * Hands an address's unread messages to `nudge`, and marks none of them
     * read: only the owner's read does. With nothing for the subscriber, it
     * passes over what isn't its mail, as the owner's read would. Joins,
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
    /** Returns the owner's unread messages and marks them read. */
    readonly take: (
      address: string,
      session: string | undefined,
      limit?: number,
      admit?: ReadAdmission
    ) => Effect.Effect<ReadonlyArray<Message>, LedgerError | NotJoined | NotOwner | InvalidQuery>;
    /**
     * Waits until messages arrive, or until the timeout when one is given.
     * Ownership is checked again on every read, so a wait outlived by its
     * session's ownership is refused rather than taking the new owner's messages.
     */
    readonly wait: (
      address: string,
      session: string | undefined,
      timeoutSeconds?: number,
      admit?: ReadAdmission
    ) => Effect.Effect<ReadonlyArray<Message>, LedgerError | NotJoined | NotOwner | InvalidQuery>;
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

/** Concern topics by directory id at one commit; undefined where the designation is unreadable. */
type Concerns = Map<
  string,
  ReadonlyArray<{ readonly id: string; readonly topic: string }> | undefined
>;

const make = (installation: string, hostOf: () => string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const cursors = yield* Cursors;
    const gateway = yield* QueryGateway;

    const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

    /** Each address's latest presence, joined or left. */
    const latest = Effect.map(ledger.presenceAt(), (read) => latestPresences(read.entries));

    const peers = Effect.map(latest, (all) =>
      Array.from(all.values()).filter((peer) => peer.presence.status === "joined")
    ).pipe(Effect.withSpan("Bus.peers"));

    const local = (peer: Subscriber) => peer.presence.installation === installation;
    const localPeers = Effect.map(peers, (all) => all.filter(local));

    const peer = (address: string) =>
      Effect.map(peers, (all) => all.find((subscriber) => subscriber.address === address));

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

    const presenceMessage = (address: string, presence: Presence, cwd: string | undefined) =>
      Effect.gen(function* () {
        return new Message({
          id: Bun.randomUUIDv7(),
          ts: yield* now,
          from: address,
          to: ["*"],
          kind: "presence",
          body: `${address} ${presence.status}`,
          origin: yield* originFor(cwd, hostOf),
          presence,
        });
      });

    /** Puts an address's cursor back exactly as it was, including its absence. */
    const restore = (address: string, previous: Option.Option<number>) =>
      Option.isSome(previous) ? cursors.set(address, previous.value) : cursors.clear(address);

    const conflict = (address: string) =>
      new PresenceConflict({
        address,
        message: `${address} changed while this call was deciding, so nothing was written. Call again: the bus will decide against the address's current state.`,
      });

    const unconfirmed = (operation: "join" | "leave", address: string) =>
      new LedgerError({
        message: `The bus could not confirm whether this ${operation} of ${address} was recorded: it may or may not have committed, and nothing was undone. Calling it again is safe, since the bus decides against the address's current state, but that result doesn't show what this attempt did.`,
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
          last !== undefined && mine && last.presence.status === "joined" && input.replay !== true;
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
        if (input.orient === true) {
          const smallestResult = {
            address: input.address,
            topics: [...topics],
            associations,
            cursor: Number.MAX_SAFE_INTEGER,
            hooked: true,
            orientation: {
              status: "UNAVAILABLE",
              reason: "INADMISSIBLE",
              section: "result",
              message: ORIENTATION_JOIN_TOO_LARGE,
              recovery: { tool: "bus_orient", input: { cwd: input.cwd } },
            },
          };
          if (Buffer.byteLength(JSON.stringify(smallestResult), "utf8") > 65_536) {
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
        const { presence, mine, takeover } = yield* decideJoin(
          input,
          session,
          latestPresences(read.entries)
        );
        // The owner rejoining, or a takeover, keeps unread messages; a new owner starts at
        // the cut its decision read, so a left address's mail isn't handed to another session.
        // The cursor is set before the write, so no reply to it is skipped, and only when it
        // changes, so a refusal has nothing else to undo.
        const previous = yield* cursors.get(input.address);
        const cursor = input.replay
          ? 0
          : Option.isSome(previous) && (mine || takeover !== undefined)
            ? previous.value
            : read.cut.head;
        const staged = Option.isNone(previous) || previous.value !== cursor;
        const unstage = staged ? restore(input.address, previous) : Effect.void;
        // Staging, the message and the restoration after a definite refusal can't be cut
        // short by cancellation, so a cancelled call never leaves a refused join's cursor
        // staged. Only the admission itself stays interruptible: cancelled there, its outcome
        // is unknown, and the cursor is kept.
        const admission = yield* Effect.uninterruptibleMask((interruptible) =>
          Effect.gen(function* () {
            if (staged) yield* cursors.set(input.address, cursor);
            const message = yield* presenceMessage(input.address, presence, input.cwd).pipe(
              Effect.tapError(() => unstage)
            );
            const admission = yield* interruptible(ledger.admit(message, read.cut)).pipe(
              Effect.tapError(() => unstage)
            );
            if (admission.status === "REFUSED") yield* unstage;
            return admission;
          })
        );
        // A possibly admitted join keeps its cursor: undoing it could skip the owner's mail.
        if (admission.status === "UNKNOWN") return yield* unconfirmed("join", input.address);
        if (admission.status === "REFUSED") {
          const now = yield* ledger.presenceAt(admission.cut.head);
          yield* decideJoin(input, session, latestPresences(now.entries));
          return yield* conflict(input.address);
        }
        yield* touch(input.address);
        return {
          address: input.address,
          topics: presence.topics,
          associations: presence.associations ?? [],
          cursor,
          ...(input.runtime === "claude" && hooked.has(session) ? { hooked: true as const } : {}),
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

    const digestOf = (draft: Message, bypass: ReadonlyArray<string>) =>
      createHash("sha256")
        .update(
          canonicalJson({
            from: draft.from,
            to: draft.to,
            subject: draft.subject,
            body: draft.body,
            kind: draft.kind,
            replyTo: draft.replyTo,
            bypass,
          })
        )
        .digest("hex");

    function publish(
      input: PublishInput & { readonly pierce?: ReadonlyArray<string> | undefined }
    ): Effect.Effect<Message, PublishError>;
    function publish(input: PublishInput): Effect.Effect<Message | NotSent, PublishError>;
    function publish(input: PublishInput): Effect.Effect<Message | NotSent, PublishError> {
      return Effect.gen(function* () {
        const sender = yield* owned(input.from, input.session);
        const draft = new Message({
          id: Bun.randomUUIDv7(),
          ts: yield* now,
          from: input.from,
          to: [...input.to],
          kind: "message",
          body: input.body,
          ...optional("subject", input.subject),
          ...optional("replyTo", input.replyTo),
          origin: yield* originFor(sender.cwd, hostOf),
        });
        if (input.pierce === undefined) {
          yield* ledger.append(draft);
          return draft;
        }
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
          pierce = [...new Set(input.pierce)]
            .filter((address) => !draft.to.includes(address))
            .sort();
        }
        const message = pierce.length === 0 ? draft : new Message({ ...draft, pierce });
        yield* ledger.append(message);
        return message;
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

    /** The unread messages of the subscriber `reader` resolves, as it is under the lock. */
    const pending = <R>(
      address: string,
      reader: Effect.Effect<Subscriber | undefined, R>,
      limit?: number
    ) =>
      Effect.gen(function* () {
        const notJoined = new NotJoined({
          address,
          message: `${address} has not joined the bus; join first.`,
        });
        const subscriber = yield* reader;
        if (subscriber === undefined) return yield* notJoined;
        const cursor = yield* cursors.get(address);
        if (Option.isNone(cursor)) return yield* notJoined;

        const slice = yield* ledger.read(cursor.value);
        const entries: Array<Entry> = [];
        const batch = (next: number) => ({
          subscriber,
          entries,
          messages: entries.map((entry) => entry.message),
          from: cursor.value,
          next,
        });
        for (const entry of slice.entries) {
          if (!isFor(entry.message, subscriber)) continue;
          entries.push(entry);
          if (limit !== undefined && entries.length >= limit) return batch(entry.end);
        }
        return batch(slice.next);
      }).pipe(Effect.withSpan("Bus.pending"));

    const ack = (address: string, cursor: number) => cursors.set(address, cursor);

    const deliver = <A, E, E2 = never>(
      address: string,
      nudge: (pending: Pending) => Effect.Effect<A, E>,
      { accepts, idle }: DeliveryOptions<E2> = {}
    ) =>
      Effect.gen(function* () {
        // The join may have changed since discovery. Check before even an empty scan can ack.
        const subscriber = yield* peer(address);
        if (subscriber === undefined || !local(subscriber) || accepts?.(subscriber) === false) {
          return undefined;
        }
        const { entries, from, next } = yield* pending(address, Effect.succeed(subscriber));
        if (entries.length > 0) {
          const eligible = yield* eligibleOf(subscriber, entries, next);
          if (eligible.length > 0) {
            return yield* nudge({
              subscriber,
              messages: eligible,
              unread: entries.map((entry) => entry.message.id),
              cursor: from,
            });
          }
          // Suppressed: nothing wakes it, and its unread mail stays unread and unacknowledged.
          return undefined;
        }
        // With nothing for this subscriber, pass over what was read, as its own read would,
        // so later passes don't read it again.
        yield* ack(address, next);
        if (idle !== undefined) yield* idle(subscriber);
        return undefined;
      }).pipe(exclusive(address), Effect.withSpan("Bus.deliver"));

    /** The owner's read: its reader checks ownership under the lock, just before the cursor moves. */
    const take = (
      address: string,
      session: string | undefined,
      limit?: number,
      admit?: ReadAdmission
    ) =>
      Effect.gen(function* () {
        const batch = yield* pending(address, owned(address, session));
        const offered = batch.messages.slice(0, limit);
        let count = admit === undefined ? offered.length : admit(offered);
        if (!Number.isInteger(count) || count < 0 || count > offered.length)
          return yield* Effect.die(new Error("The read admission returned an invalid prefix."));
        // A Fluree cursor names a commit, not a row. Never consume only part of one commit.
        while (
          count > 0 &&
          count < batch.entries.length &&
          batch.entries[count - 1]?.end === batch.entries[count]?.end
        )
          count--;
        if (count === 0 && batch.messages.length > 0)
          return yield* new InvalidQuery({
            message:
              "The oldest unread messages cannot fit this read's limits without splitting a commit; the cursor was not advanced. Use a reader with larger limits.",
          });
        const next =
          count === batch.messages.length && (limit === undefined || count < limit)
            ? batch.next
            : batch.entries[count - 1]?.end;
        if (next === undefined)
          return yield* Effect.die(new Error("The read prefix has no cursor."));
        yield* ack(address, next);
        return batch.messages.slice(0, count);
      }).pipe(exclusive(address), Effect.withSpan("Bus.take"));

    const waitFor = Effect.fn("Bus.wait")(function* (
      address: string,
      session: string | undefined,
      timeoutSeconds?: number,
      admit?: ReadAdmission
    ) {
      const ready = yield* take(address, session, undefined, admit);
      if (ready.length > 0) return ready;
      const arrival = ledger.changes.pipe(
        Stream.mapEffect(() => take(address, session, undefined, admit)),
        Stream.filter((messages) => messages.length > 0),
        Stream.runHead
      );
      const arrived =
        timeoutSeconds === undefined
          ? yield* arrival
          : Option.flatten(yield* Effect.timeoutOption(arrival, `${timeoutSeconds} seconds`));
      return Option.getOrElse(arrived, (): ReadonlyArray<Message> => []);
    });
    // Open waits are counted so a refused join can say whether the holder is listening.
    const wait = (
      address: string,
      session: string | undefined,
      timeoutSeconds?: number,
      admit?: ReadAdmission
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          seenOf(address).waits += 1;
        }),
        () => waitFor(address, session, timeoutSeconds, admit),
        () =>
          Effect.sync(() => {
            seenOf(address).waits -= 1;
          })
      );

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
            // A join from this machine without a cursor (a replaced ledger, say), or a failing read,
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
      deliver,
      take,
      wait,
      wake,
    });
  });

export const layer = (installation: string, hostOf = hostname) =>
  Layer.effect(Bus, make(installation, hostOf));
