import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { Clock, Context, Duration, Effect, Layer, Option, Schema, Scope, Stream } from "effect";
import { Bus, type Pending } from "./Bus.ts";
import type { CodexHost, Message, Subscriber } from "./domain.ts";
import { Ledger } from "./Ledger.ts";

export const defaultSocket = join(
  homedir(),
  ".codex",
  "app-server-control",
  "app-server-control.sock"
);

export class CodexError extends Schema.TaggedError<CodexError>()("CodexError", {
  method: Schema.String,
  message: Schema.String,
}) {}

const Reply = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Number,
    // Requests from the daemon (approvals) carry their own ids; they are not replies.
    method: Schema.optionalKey(Schema.Unknown),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  })
);
const decodeReply = Schema.decodeUnknownOption(Reply);

const LoadedThreads = Schema.Struct({ data: Schema.Array(Schema.String) });
const decodeLoaded = Schema.decodeUnknownEffect(LoadedThreads);

type Resolve = (reply: {
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}) => void;

/** A daemon that stops answering fails the request instead of stalling every delivery. */
const REQUEST_TIMEOUT = Duration.seconds(30);
const timeLimit =
  (method: string, timeout: Duration.Duration) =>
  <A, R>(effect: Effect.Effect<A, CodexError, R>) =>
    Effect.timeoutOrElse(effect, {
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new CodexError({ method, message: `no answer within ${Duration.format(timeout)}` })
        ),
    });

/** The requests the deliverer makes of a Codex app-server daemon. */
export interface Daemon {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, CodexError>;
}
const Daemon = { of: (daemon: Daemon) => daemon };

/**
 * A JSON-RPC connection to the local Codex app-server daemon, which speaks
 * WebSocket over its Unix socket. Threads the daemon hosts can be woken with
 * `turn/start`; threads owned by another app-server (the desktop app's
 * embedded one) refuse a second writer.
 */
export const connect = (socketPath: string, timeout: Duration.Duration = REQUEST_TIMEOUT) =>
  Effect.gen(function* () {
    const pending = new Map<number, Resolve>();
    let nextId = 0;

    // The scope owns the socket from the moment it exists, so a handshake that
    // never completes can be abandoned at the deadline and still be closed.
    const ws = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(`ws+unix://${socketPath}`)),
      (socket) => Effect.sync(() => socket.close())
    );
    yield* Effect.callback<void, CodexError>((resume) => {
      ws.onopen = () => resume(Effect.void);
      ws.onerror = () =>
        resume(
          Effect.fail(new CodexError({ method: "connect", message: `cannot reach ${socketPath}` }))
        );
    }).pipe(timeLimit("connect", timeout));

    ws.onmessage = (event) => {
      const reply = decodeReply(String(event.data));
      if (Option.isNone(reply) || reply.value.method !== undefined) return;
      const resolve = pending.get(reply.value.id);
      pending.delete(reply.value.id);
      resolve?.(reply.value);
    };
    ws.onclose = () => {
      for (const resolve of pending.values()) resolve({ error: { message: "connection closed" } });
      pending.clear();
    };

    const request = (method: string, params: unknown) =>
      Effect.callback<unknown, CodexError>((resume) => {
        const id = ++nextId;
        pending.set(id, (reply) =>
          resume(
            reply.error === undefined
              ? Effect.succeed(reply.result)
              : Effect.fail(new CodexError({ method, message: reply.error.message }))
          )
        );
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        return Effect.sync(() => pending.delete(id));
      }).pipe(timeLimit(method, timeout));

    yield* request("initialize", {
      clientInfo: { name: "agent-bus", title: "agent-bus", version: "0.1.0" },
      capabilities: null,
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    return Daemon.of({ request });
  });

const describe = (message: Message) =>
  [
    `id: ${message.id}`,
    `from: ${message.from}`,
    `to: ${message.to.join(", ")}`,
    `at: ${message.ts}`,
    ...(message.subject === undefined ? [] : [`subject: ${message.subject}`]),
    ...(message.replyTo === undefined ? [] : [`in reply to: ${message.replyTo}`]),
  ].join(" | ");

/** The turn input a Codex session sees when bus messages arrive. */
export const formatDelivery = (address: string, messages: ReadonlyArray<Message>) => {
  const count = messages.length === 1 ? "1 new message" : `${messages.length} new messages`;
  const blocks = messages.map((message) => `${describe(message)}\n\n${message.body}`);
  const first = messages[0];
  const replyHint =
    first === undefined
      ? ""
      : `\n\nReply with the agent-bus bus_publish tool: from "${address}", to ["${first.from}"], replyTo "${first.id}".`;
  return `[agent-bus] ${count} for ${address}\n\n${blocks.join("\n\n---\n\n")}${replyHint}`;
};

/** Host names compare without case or domain, which macOS varies (`.local`, `.lan`). */
const machine = (host: string) => (host.split(".")[0] ?? host).toLowerCase();

export const localHost = hostname();

/**
 * The Codex peers one machine's deliverer wakes: those with a thread id that
 * joined from that machine, since a thread can only be woken by the daemon that
 * hosts it. One deliverer per machine keeps one cursor writer per address.
 */
export const deliveryTargets = (peers: ReadonlyArray<Subscriber>, host: string) =>
  peers.filter(
    (peer) =>
      peer.presence.runtime === "codex" &&
      peer.presence.codexThreadId !== undefined &&
      peer.host !== undefined &&
      machine(peer.host) === machine(host)
  );

const loadedThreads = (daemon: Daemon) =>
  daemon.request("thread/loaded/list", {}).pipe(
    Effect.flatMap(decodeLoaded),
    Effect.map((loaded) => loaded.data),
    Effect.mapError(
      (cause) => new CodexError({ method: "thread/loaded/list", message: String(cause) })
    )
  );

/** How long classifying a joining thread may hold up its join. */
const CLASSIFY_TIMEOUT = Duration.seconds(5);

/**
 * Classifies a joining Codex thread by where it runs. A Codex session joins
 * mid-turn, so its thread is loaded in whichever app-server runs it: if that is
 * this machine's daemon, the bus may later resume it there.
 */
export class ThreadHosts extends Context.Service<
  ThreadHosts,
  { readonly classify: (threadId: string) => Effect.Effect<CodexHost> }
>()("agent-bus/ThreadHosts") {}

export const threadHostsLayer = (socketPath: string) =>
  Layer.succeed(ThreadHosts)({
    classify: (threadId) =>
      Effect.scoped(Effect.flatMap(connect(socketPath, CLASSIFY_TIMEOUT), loadedThreads)).pipe(
        Effect.map((loaded): CodexHost => (loaded.includes(threadId) ? "daemon" : "other")),
        // An unreachable daemon can't be running the thread.
        Effect.orElseSucceed((): CodexHost => "other")
      ),
  });

const FIRST_RETRY = Duration.seconds(30);
const LAST_RETRY = Duration.minutes(5);

/** What the deliverer has learned about a peer's current join that keeps it from waking the peer. */
interface Hold {
  /** The join this applies to; rejoining starts over. */
  readonly joinId: string;
  /**
   * The thread runs in another app-server: deliver only while the daemon has
   * it loaded, never by resuming it, which would take it from its owner.
   */
  readonly elsewhere: boolean;
  /** The thread takes no direct input (a subagent): never deliver to this join. */
  readonly refused: boolean;
  /** Consecutive transport failures, and when to try again. */
  readonly failures: number;
  readonly until: number;
}

/** Peers the deliverer is holding back, by address. */
export type Holds = Map<string, Hold>;

const otherWriter = (error: CodexError) => error.message.includes("active writer");
const noDirectInput = (error: CodexError) =>
  error.message.includes("direct app-server input is not allowed");

/**
 * Deliver each of this machine's Codex peers its unread messages as one turn
 * per thread. If the thread is mid-turn, `turn/start` steers it instead.
 * Messages are only marked read once the daemon accepts the turn.
 *
 * A thread the daemon hasn't loaded is resumed only if it ran on the daemon
 * when it joined; otherwise its messages wait, unread, until the daemon has it
 * loaded (the owner opened it there) or the peer rejoins from the daemon.
 * Transport failures are retried after a delay that doubles to five minutes.
 */
export const deliverOnce = Effect.fn("Codex.deliverOnce")(function* (
  open: Effect.Effect<Daemon, CodexError, Scope.Scope>,
  host: string,
  holds: Holds
) {
  const bus = yield* Bus;
  const now = yield* Clock.currentTimeMillis;
  const ready = deliveryTargets(yield* bus.peers, host).filter((peer) => {
    const hold = holds.get(peer.address);
    return (
      hold === undefined || hold.joinId !== peer.joinId || (!hold.refused && hold.until <= now)
    );
  });
  if (ready.length === 0) return;

  yield* Effect.scoped(
    Effect.gen(function* () {
      // Connect once, and only when some peer has messages.
      const scope = yield* Scope.Scope;
      const daemon = yield* Effect.cached(Effect.provideService(open, Scope.Scope, scope));
      for (const peer of ready) {
        // The bus hands over the subscriber as it is now, under the address's lock;
        // what happens belongs to that subscriber, which may have rejoined since `peer` was read.
        let attempted: Subscriber = peer;
        let waiting = false;
        const current = () => {
          const hold = holds.get(peer.address);
          return hold?.joinId === attempted.joinId ? hold : undefined;
        };
        const send = ({ subscriber, messages }: Pending) =>
          Effect.gen(function* () {
            attempted = subscriber;
            const threadId = subscriber.presence.codexThreadId;
            if (threadId === undefined || deliveryTargets([subscriber], host).length === 0) {
              return false;
            }
            const connection = yield* daemon;
            if (!(yield* loadedThreads(connection)).includes(threadId)) {
              if (subscriber.presence.codexHost !== "daemon" || current()?.elsewhere) {
                waiting = true;
                return false;
              }
              yield* connection.request("thread/resume", { threadId });
            }
            yield* connection.request("turn/start", {
              threadId,
              input: [
                {
                  type: "text",
                  text: formatDelivery(subscriber.address, messages),
                  text_elements: [],
                },
              ],
            });
            // serve can't answer approvals, and must not keep the thread loaded.
            yield* connection.request("thread/unsubscribe", { threadId }).pipe(Effect.ignore);
            return true;
          });
        const delivered = yield* Effect.result(bus.deliver(peer.address, send));
        const threadId = attempted.presence.codexThreadId;
        const hold = (change: Partial<Hold>) => {
          const previous = current();
          holds.set(peer.address, {
            joinId: attempted.joinId,
            elsewhere: previous?.elsewhere ?? false,
            refused: previous?.refused ?? false,
            failures: 0,
            until: 0,
            ...change,
          });
          return previous;
        };

        if (delivered._tag === "Success") {
          if (waiting) {
            if (current()?.elsewhere !== true) {
              hold({ elsewhere: true });
              yield* Effect.logInfo(
                `Holding messages for ${peer.address}: Codex thread ${threadId} isn't running on this machine's daemon. They wait until it is opened there, or the peer rejoins from a daemon session.`
              );
            }
            continue;
          }
          if (delivered.success.length === 0) continue;
          holds.delete(peer.address);
          yield* Effect.logInfo(`Delivered ${delivered.success.length} to ${peer.address}`);
          continue;
        }
        const error = delivered.failure;
        if (error._tag !== "CodexError") {
          yield* Effect.logWarning(`Could not deliver to ${peer.address}: ${error.message}`);
          continue;
        }
        if (noDirectInput(error)) {
          hold({ refused: true });
          yield* Effect.logWarning(
            `Not waking ${peer.address}: Codex thread ${threadId} takes no direct input (${error.message}). Its messages stay unread for bus_read.`
          );
          continue;
        }
        if (otherWriter(error)) {
          if (current()?.elsewhere !== true) {
            hold({ elsewhere: true });
            yield* Effect.logInfo(
              `Holding messages for ${peer.address}: another Codex app-server, such as the desktop app's, runs thread ${threadId}. They wait until it is opened on this machine's daemon.`
            );
          }
          continue;
        }
        const failures = (current()?.failures ?? 0) + 1;
        const delay = Duration.min(Duration.times(FIRST_RETRY, 2 ** (failures - 1)), LAST_RETRY);
        // The delay runs from the failure, which may have taken a request timeout to arrive.
        const failedAt = yield* Clock.currentTimeMillis;
        hold({ failures, until: failedAt + Duration.toMillis(delay) });
        yield* Effect.logWarning(
          `Could not wake ${peer.address} (Codex thread ${threadId}): ${error.message}. Next attempt in ${Duration.format(delay)}.`
        );
      }
    })
  );
});

/** Long-running deliverer: delivers now, then whenever the ledger changes. */
export const runDeliverer = (socketPath: string, host: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const holds: Holds = new Map();
    const attempt = deliverOnce(connect(socketPath), host, holds).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Delivery cycle failed", cause))
    );
    yield* attempt;
    yield* ledger.changes.pipe(
      Stream.mapEffect(() => attempt),
      Stream.runDrain
    );
  });
