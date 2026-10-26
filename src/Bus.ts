import { hostname } from "node:os";
import { Clock, Context, Effect, Layer, Option, Semaphore, Stream } from "effect";
import { Cursors } from "./Cursors.ts";
import {
  type CodexHost,
  isFor,
  type LedgerError,
  Message,
  NotJoined,
  NotOwner,
  Origin,
  Presence,
  type Runtime,
  type Subscriber,
  validSession,
} from "./domain.ts";
import { Ledger, type SearchInput } from "./Ledger.ts";

export interface JoinInput {
  readonly address: string;
  readonly runtime: Runtime;
  /** The joining session's id from its runtime; required, though callers may omit it. */
  readonly session: string | undefined;
  /** The current holder's join id, to replace a session that has ended. */
  readonly takeover?: string | undefined;
  readonly topics?: ReadonlyArray<string> | undefined;
  readonly codexThreadId?: string | undefined;
  readonly codexHost?: CodexHost | undefined;
  readonly note?: string | undefined;
  /** Start from the beginning of the ledger instead of only new messages. */
  readonly replay?: boolean | undefined;
  /** The session's working directory; messages it sends are grouped by its repo and branch. */
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
}

export interface Pending {
  readonly subscriber: Subscriber;
  readonly messages: ReadonlyArray<Message>;
  /** Cursor to acknowledge once these messages are delivered. */
  readonly next: number;
}

export class Bus extends Context.Service<
  Bus,
  {
    /**
     * Claims an address for a session, or reconnects the session that owns it.
     * A different session is refused while the address is held, unless it
     * names the holder's join in `takeover`.
     */
    readonly join: (
      input: JoinInput
    ) => Effect.Effect<
      { readonly address: string; readonly cursor: number },
      LedgerError | NotOwner
    >;
    readonly leave: (
      address: string,
      session: string | undefined
    ) => Effect.Effect<void, LedgerError | NotJoined | NotOwner>;
    readonly publish: (
      input: PublishInput
    ) => Effect.Effect<Message, LedgerError | NotJoined | NotOwner>;
    readonly peers: Effect.Effect<ReadonlyArray<Subscriber>, LedgerError>;
    /**
     * Hands an address's unread messages to `send` and marks them read if it
     * returns true. Joins, leaves and deliveries for one address run one at a
     * time, so a message is delivered once and to the subscriber's current state. This is the Codex deliverer's path, which delivers to whoever owns
     * the address; sessions read through `take` and `wait`.
     */
    readonly deliver: <E>(
      address: string,
      send: (pending: Pending) => Effect.Effect<boolean, E>,
      limit?: number
    ) => Effect.Effect<ReadonlyArray<Message>, LedgerError | NotJoined | E>;
    /** Returns the owner's unread messages and marks them read. */
    readonly take: (
      address: string,
      session: string | undefined,
      limit?: number
    ) => Effect.Effect<ReadonlyArray<Message>, LedgerError | NotJoined | NotOwner>;
    /**
     * Waits until messages arrive, or until the timeout when one is given.
     * Ownership is checked again on every read, so a wait outlived by its
     * session's ownership is refused rather than taking the new owner's messages.
     */
    readonly wait: (
      address: string,
      session: string | undefined,
      timeoutSeconds?: number
    ) => Effect.Effect<ReadonlyArray<Message>, LedgerError | NotJoined | NotOwner>;
    readonly history: (input: SearchInput) => Effect.Effect<ReadonlyArray<Message>, LedgerError>;
  }
>()("agent-bus/Bus") {}

/** Runs git in a directory, or returns undefined when it is not a repo or no longer exists. */
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise(async () => {
    const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const text = out.trim();
    return code === 0 && text !== "" ? text : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Where an entry was written: this machine, and the sender's directory with its
 * repo and branch, which commit windows group messages by.
 */
const originFor = Effect.fn("Bus.originFor")(function* (cwd: string | undefined) {
  if (cwd === undefined) return new Origin({ host: hostname() });
  const repo = yield* git(cwd, ["rev-parse", "--show-toplevel"]);
  const branch = repo === undefined ? undefined : yield* git(cwd, ["branch", "--show-current"]);
  return new Origin({
    host: hostname(),
    cwd,
    ...(repo === undefined ? {} : { repo }),
    ...(branch === undefined ? {} : { branch }),
  });
});

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : { [key]: value };

const sessionHelp =
  "Pass your runtime's own session id as `session`: $CODEX_THREAD_ID in Codex, $CLAUDE_CODE_SESSION_ID in Claude Code, or a stable id of your own for other clients.";

/** What this machine's bus has seen of an address's owner, for telling a live holder from a dead one. */
interface Activity {
  last?: string;
  waits: number;
}

export const layer = Layer.effect(
  Bus,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const cursors = yield* Cursors;

    const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

    /** Each address's latest presence, joined or left. */
    const latest = Effect.gen(function* () {
      const latest = new Map<string, Subscriber>();
      for (const message of yield* ledger.presence) {
        if (message.presence === undefined) continue;
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
    });

    const peers = Effect.map(latest, (all) =>
      Array.from(all.values()).filter((peer) => peer.presence.status === "joined")
    ).pipe(Effect.withSpan("Bus.peers"));

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

    const activity = new Map<string, Activity>();
    const activityOf = (address: string) => {
      let seen = activity.get(address);
      if (seen === undefined) {
        seen = { waits: 0 };
        activity.set(address, seen);
      }
      return seen;
    };
    const touch = (address: string) =>
      Effect.map(now, (ts) => {
        activityOf(address).last = ts;
      });

    /**
     * Whether `session` owns the presence. A presence from before owners is
     * owned by the Codex thread it names, so that thread keeps its inbox.
     */
    const owns = (presence: Presence, session: string) =>
      presence.session === undefined
        ? presence.runtime === "codex" && presence.codexThreadId === session
        : presence.session === session;

    /** What a session told about a presence from before owners should do. */
    const legacyHelp = (holder: Subscriber) =>
      `${holder.address} joined before addresses had owners. If this session joined it, reclaim it by rejoining with bus_join, your session id and takeover "${holder.joinId}"; otherwise join an address specific to this session.`;

    /** Why a session that doesn't own an address can't join it, and what to do instead. */
    const heldBy = (holder: Subscriber) => {
      const { presence } = holder;
      const seen = activityOf(holder.address);
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
        message:
          presence.session === undefined
            ? `${legacyHelp(holder)} (${facts.join("; ")})`
            : `${holder.address} is held by another session (${facts.join("; ")}). An address is one session's inbox: join one specific to this session instead. Only if that session has ended and the human says to replace it, rejoin with takeover "${holder.joinId}".`,
      });
    };

    /** A call from a session that doesn't own the address, refused before it changes anything. */
    const notOwner = (holder: Subscriber) =>
      new NotOwner({
        address: holder.address,
        message:
          holder.presence.session === undefined
            ? `${legacyHelp(holder)} Nothing was changed.`
            : `${holder.address} belongs to another session; nothing was changed. If you joined it earlier, it has since been taken over or your session id changed (after /clear or a fork): join an address specific to this session.`,
      });

    const noSession = (address: string) => new NotOwner({ address, message: sessionHelp });

    /** The address's current subscriber, when `session` owns it. */
    const owned = Effect.fn("Bus.owned")(function* (address: string, session: string | undefined) {
      if (!validSession(session)) return yield* noSession(address);
      const subscriber = yield* peer(address);
      if (subscriber === undefined) {
        return yield* new NotJoined({
          address,
          message: `${address} has not joined the bus; join first.`,
        });
      }
      if (!owns(subscriber.presence, session)) return yield* notOwner(subscriber);
      yield* touch(address);
      return subscriber;
    });

    const announce = Effect.fn("Bus.announce")(function* (
      address: string,
      presence: Presence,
      cwd: string | undefined
    ) {
      const message = new Message({
        id: Bun.randomUUIDv7(),
        ts: yield* now,
        from: address,
        to: ["*"],
        kind: "presence",
        body: `${address} ${presence.status}`,
        origin: yield* originFor(cwd),
        presence,
      });
      yield* ledger.append(message);
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
        const last = (yield* latest).get(input.address);
        const mine =
          last !== undefined &&
          owns(last.presence, session) &&
          last.presence.runtime === input.runtime;
        let takeover: string | undefined;
        if (last?.presence.status === "joined" && !mine) {
          if (input.takeover !== last.joinId) return yield* heldBy(last);
          takeover = last.joinId;
        }
        const presence = new Presence({
          runtime: input.runtime,
          status: "joined",
          topics: [...(input.topics ?? [])],
          session,
          ...optional("takeover", takeover),
          ...optional("codexThreadId", input.codexThreadId),
          ...optional("codexHost", input.codexHost),
          ...optional("note", input.note),
        });
        // The owner rejoining, or a takeover, keeps unread messages; a new owner
        // starts at the present, so a left address's mail isn't handed to another
        // session. The cursor is set before the announcement, so no reply to it
        // is skipped.
        const existing = yield* cursors.get(input.address);
        const cursor = input.replay
          ? 0
          : Option.isSome(existing) && (mine || takeover !== undefined)
            ? existing.value
            : yield* ledger.end;
        yield* cursors.set(input.address, cursor);
        yield* announce(input.address, presence, input.cwd);
        yield* touch(input.address);
        return { address: input.address, cursor };
      }).pipe(exclusive(input.address), claiming(input.address), Effect.withSpan("Bus.join"));

    const leave = (address: string, session: string | undefined) =>
      Effect.gen(function* () {
        const current = yield* owned(address, session);
        const presence = new Presence({
          runtime: current.presence.runtime,
          status: "left",
          topics: [],
          ...optional("session", current.presence.session),
        });
        yield* announce(address, presence, current.cwd);
      }).pipe(exclusive(address), claiming(address), Effect.withSpan("Bus.leave"));

    const publish = (input: PublishInput) =>
      Effect.gen(function* () {
        const sender = yield* owned(input.from, input.session);
        const message = new Message({
          id: Bun.randomUUIDv7(),
          ts: yield* now,
          from: input.from,
          to: [...input.to],
          kind: "message",
          body: input.body,
          ...optional("subject", input.subject),
          ...optional("replyTo", input.replyTo),
          origin: yield* originFor(sender.cwd),
        });
        yield* ledger.append(message);
        return message;
      }).pipe(claiming(input.from), Effect.withSpan("Bus.publish"));

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
        const messages: Array<Message> = [];
        for (const { message, end } of slice.entries) {
          if (!isFor(message, subscriber)) continue;
          messages.push(message);
          if (limit !== undefined && messages.length >= limit) {
            return { subscriber, messages, next: end };
          }
        }
        return { subscriber, messages, next: slice.next };
      }).pipe(Effect.withSpan("Bus.pending"));

    const ack = (address: string, cursor: number) => cursors.set(address, cursor);

    /**
     * Reads `reader`'s messages under the address's lock. A session's reader
     * checks ownership there on every attempt, just before the cursor moves.
     */
    const deliverAs = <R, E>(
      address: string,
      reader: Effect.Effect<Subscriber | undefined, R>,
      send: (pending: Pending) => Effect.Effect<boolean, E>,
      limit?: number
    ) =>
      Effect.gen(function* () {
        const batch = yield* pending(address, reader, limit);
        // A batch with nothing for this subscriber still moves its cursor past what was read.
        const sent = batch.messages.length === 0 ? false : yield* send(batch);
        if (batch.messages.length === 0 || sent) yield* ack(address, batch.next);
        return sent ? batch.messages : [];
      }).pipe(exclusive(address), Effect.withSpan("Bus.deliver"));

    const deliver = <E>(
      address: string,
      send: (pending: Pending) => Effect.Effect<boolean, E>,
      limit?: number
    ) => deliverAs(address, peer(address), send, limit);

    const take = (address: string, session: string | undefined, limit?: number) =>
      deliverAs(address, owned(address, session), () => Effect.succeed(true), limit);

    const waitFor = Effect.fn("Bus.wait")(function* (
      address: string,
      session: string | undefined,
      timeoutSeconds?: number
    ) {
      const ready = yield* take(address, session);
      if (ready.length > 0) return ready;
      const arrival = ledger.changes.pipe(
        Stream.mapEffect(() => take(address, session)),
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
    const wait = (address: string, session: string | undefined, timeoutSeconds?: number) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          activityOf(address).waits += 1;
        }),
        () => waitFor(address, session, timeoutSeconds),
        () =>
          Effect.sync(() => {
            activityOf(address).waits -= 1;
          })
      );

    const history = (input: SearchInput) => ledger.search(input);

    return Bus.of({ join, leave, publish, peers, deliver, take, wait, history });
  })
);
