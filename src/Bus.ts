import { hostname } from "node:os";
import { Clock, Context, Effect, Layer, Option, Semaphore, Stream } from "effect";
import { Cursors } from "./Cursors.ts";
import {
  type CodexHost,
  isFor,
  type LedgerError,
  Message,
  NotJoined,
  Origin,
  Presence,
  type Runtime,
  type Subscriber,
} from "./domain.ts";
import { Ledger, type SearchInput } from "./Ledger.ts";

export interface JoinInput {
  readonly address: string;
  readonly runtime: Runtime;
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
    readonly join: (
      input: JoinInput
    ) => Effect.Effect<{ readonly address: string; readonly cursor: number }, LedgerError>;
    readonly leave: (address: string) => Effect.Effect<void, LedgerError>;
    readonly publish: (input: PublishInput) => Effect.Effect<Message, LedgerError>;
    readonly peers: Effect.Effect<ReadonlyArray<Subscriber>, LedgerError>;
    /**
     * Hands an address's unread messages to `send` and marks them read if it
     * returns true. Joins, leaves and deliveries to one address run one at a
     * time, so a message is delivered once and to the subscriber's current state.
     */
    readonly deliver: <E>(
      address: string,
      send: (pending: Pending) => Effect.Effect<boolean, E>,
      limit?: number
    ) => Effect.Effect<ReadonlyArray<Message>, LedgerError | NotJoined | E>;
    readonly take: (
      address: string,
      limit?: number
    ) => Effect.Effect<ReadonlyArray<Message>, LedgerError | NotJoined>;
    /** Waits until messages arrive, or until the timeout when one is given. */
    readonly wait: (
      address: string,
      timeoutSeconds?: number
    ) => Effect.Effect<ReadonlyArray<Message>, LedgerError | NotJoined>;
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

export const layer = Layer.effect(
  Bus,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const cursors = yield* Cursors;

    const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

    const peers = Effect.gen(function* () {
      const latest = new Map<string, Subscriber>();
      for (const message of yield* ledger.presence) {
        if (message.presence === undefined) continue;
        latest.set(message.from, {
          address: message.from,
          presence: message.presence,
          joinId: message.id,
          host: message.origin?.host,
          cwd: message.origin?.cwd,
        });
      }
      return Array.from(latest.values()).filter((peer) => peer.presence.status === "joined");
    }).pipe(Effect.withSpan("Bus.peers"));

    const peer = (address: string) =>
      Effect.map(peers, (all) => all.find((subscriber) => subscriber.address === address));

    const locks = new Map<string, Semaphore.Semaphore>();
    const exclusive = (address: string) => {
      let lock = locks.get(address);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(address, lock);
      }
      return Semaphore.withPermit(lock);
    };

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
        const presence = new Presence({
          runtime: input.runtime,
          status: "joined",
          topics: [...(input.topics ?? [])],
          ...optional("codexThreadId", input.codexThreadId),
          ...optional("codexHost", input.codexHost),
          ...optional("note", input.note),
        });
        // Rejoining keeps unread messages; a new subscriber starts at the present.
        // The cursor is set before the announcement, so no reply to it is skipped.
        const existing = yield* cursors.get(input.address);
        const cursor = input.replay
          ? 0
          : Option.isSome(existing)
            ? existing.value
            : yield* ledger.end;
        yield* cursors.set(input.address, cursor);
        yield* announce(input.address, presence, input.cwd);
        return { address: input.address, cursor };
      }).pipe(exclusive(input.address), Effect.withSpan("Bus.join"));

    const leave = (address: string) =>
      Effect.gen(function* () {
        const current = yield* peer(address);
        const presence = new Presence({
          runtime: current?.presence.runtime ?? "other",
          status: "left",
          topics: [],
        });
        yield* announce(address, presence, current?.cwd);
      }).pipe(exclusive(address), Effect.withSpan("Bus.leave"));

    const publish = Effect.fn("Bus.publish")(function* (input: PublishInput) {
      const sender = yield* peer(input.from);
      const message = new Message({
        id: Bun.randomUUIDv7(),
        ts: yield* now,
        from: input.from,
        to: [...input.to],
        kind: "message",
        body: input.body,
        ...optional("subject", input.subject),
        ...optional("replyTo", input.replyTo),
        origin: yield* originFor(sender?.cwd),
      });
      yield* ledger.append(message);
      return message;
    });

    const pending = Effect.fn("Bus.pending")(function* (address: string, limit?: number) {
      const notJoined = new NotJoined({
        address,
        message: `${address} has not joined the bus; join first.`,
      });
      const subscriber = yield* peer(address);
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
    });

    const ack = (address: string, cursor: number) => cursors.set(address, cursor);

    const deliver = <E>(
      address: string,
      send: (pending: Pending) => Effect.Effect<boolean, E>,
      limit?: number
    ) =>
      Effect.gen(function* () {
        const batch = yield* pending(address, limit);
        // A batch with nothing for this subscriber still moves its cursor past what was read.
        const sent = batch.messages.length === 0 ? false : yield* send(batch);
        if (batch.messages.length === 0 || sent) yield* ack(address, batch.next);
        return sent ? batch.messages : [];
      }).pipe(exclusive(address), Effect.withSpan("Bus.deliver"));

    const take = (address: string, limit?: number) =>
      deliver(address, () => Effect.succeed(true), limit);
    const wait = Effect.fn("Bus.wait")(function* (address: string, timeoutSeconds?: number) {
      const ready = yield* take(address);
      if (ready.length > 0) return ready;
      const arrival = ledger.changes.pipe(
        Stream.mapEffect(() => take(address)),
        Stream.filter((messages) => messages.length > 0),
        Stream.runHead
      );
      const arrived =
        timeoutSeconds === undefined
          ? yield* arrival
          : Option.flatten(yield* Effect.timeoutOption(arrival, `${timeoutSeconds} seconds`));
      return Option.getOrElse(arrived, (): ReadonlyArray<Message> => []);
    });

    const history = (input: SearchInput) => ledger.search(input);

    return Bus.of({ join, leave, publish, peers, deliver, take, wait, history });
  })
);
