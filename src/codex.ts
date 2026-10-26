import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { Clock, Duration, Effect, Option, Schema, Scope, Stream } from "effect";
import { Bus, type Pending } from "./Bus.ts";
import type { Message, Subscriber } from "./domain.ts";
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
      if (Option.isNone(reply)) return;
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

const ensureLoaded = Effect.fn("Codex.ensureLoaded")(function* (daemon: Daemon, threadId: string) {
  const loaded = yield* daemon.request("thread/loaded/list", {}).pipe(
    Effect.flatMap(decodeLoaded),
    Effect.mapError(
      (cause) => new CodexError({ method: "thread/loaded/list", message: String(cause) })
    )
  );
  if (!loaded.data.includes(threadId)) {
    yield* daemon.request("thread/resume", { threadId });
  }
});

const FIRST_RETRY = Duration.seconds(30);
const LAST_RETRY = Duration.minutes(30);

/** A Codex peer that could not be woken, and when to try again. */
interface Refusal {
  /** The join the failures belong to; rejoining starts over. */
  readonly joinId: string;
  readonly failures: number;
  readonly until: number;
}

/** Peers waiting out a failed delivery, by address. */
export type Refusals = Map<string, Refusal>;

const explain = (error: CodexError) =>
  error.message.includes("active writer")
    ? `${error.message} (the thread is open in another Codex app-server, such as the desktop app's)`
    : error.message;

/**
 * Deliver each of this machine's Codex peers its unread messages as one turn
 * per thread. If the thread is mid-turn, `turn/start` steers it instead.
 * Messages are only marked read once the daemon accepts the turn, so failed
 * deliveries retry, after a delay that doubles with each failure.
 */
export const deliverOnce = Effect.fn("Codex.deliverOnce")(function* (
  open: Effect.Effect<Daemon, CodexError, Scope.Scope>,
  host: string,
  refusals: Refusals
) {
  const bus = yield* Bus;
  const now = yield* Clock.currentTimeMillis;
  const ready = deliveryTargets(yield* bus.peers, host).filter((peer) => {
    const refusal = refusals.get(peer.address);
    return refusal === undefined || refusal.joinId !== peer.joinId || refusal.until <= now;
  });
  if (ready.length === 0) return;

  yield* Effect.scoped(
    Effect.gen(function* () {
      // Connect once, and only when some peer has messages.
      const scope = yield* Scope.Scope;
      const daemon = yield* Effect.cached(Effect.provideService(open, Scope.Scope, scope));
      for (const peer of ready) {
        // The bus hands over the subscriber as it is now, under the address's lock;
        // a failure belongs to that subscriber, which may have rejoined since `peer` was read.
        let attempted: Subscriber = peer;
        const send = ({ subscriber, messages }: Pending) =>
          Effect.gen(function* () {
            attempted = subscriber;
            const threadId = subscriber.presence.codexThreadId;
            if (threadId === undefined || deliveryTargets([subscriber], host).length === 0) {
              return false;
            }
            const connection = yield* daemon;
            yield* ensureLoaded(connection, threadId);
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
            return true;
          });
        const delivered = yield* Effect.result(bus.deliver(peer.address, send));
        if (delivered._tag === "Success") {
          if (delivered.success.length === 0) continue;
          refusals.delete(peer.address);
          yield* Effect.logInfo(`Delivered ${delivered.success.length} to ${peer.address}`);
          continue;
        }
        const error = delivered.failure;
        if (error._tag !== "CodexError") {
          yield* Effect.logWarning(`Could not deliver to ${peer.address}: ${error.message}`);
          continue;
        }
        const previous = refusals.get(peer.address);
        const failures = previous?.joinId === attempted.joinId ? previous.failures + 1 : 1;
        const delay = Duration.min(Duration.times(FIRST_RETRY, 2 ** (failures - 1)), LAST_RETRY);
        // The delay runs from the failure, which may have taken a request timeout to arrive.
        const failedAt = yield* Clock.currentTimeMillis;
        refusals.set(peer.address, {
          joinId: attempted.joinId,
          failures,
          until: failedAt + Duration.toMillis(delay),
        });
        yield* Effect.logWarning(
          `Could not wake ${peer.address} (Codex thread ${attempted.presence.codexThreadId}): ${explain(error)}. Next attempt in ${Duration.format(delay)}.`
        );
      }
    })
  );
});

/** Long-running deliverer: delivers now, then whenever the ledger changes. */
export const runDeliverer = (socketPath: string, host: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const refusals: Refusals = new Map();
    const attempt = deliverOnce(connect(socketPath), host, refusals).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Delivery cycle failed", cause))
    );
    yield* attempt;
    yield* ledger.changes.pipe(
      Stream.mapEffect(() => attempt),
      Stream.runDrain
    );
  });
