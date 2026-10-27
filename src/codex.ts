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

/** The requests the deliverer makes of a Codex app-server. */
export interface Daemon {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, CodexError>;
}
const Daemon = { of: (daemon: Daemon) => daemon };

/**
 * JSON-RPC over a connection that carries one message per `write`. The
 * transport passes each incoming message to `receive`, and calls `closed` when
 * it ends, which fails every request still waiting.
 */
const rpc = (write: (text: string) => void, timeout: Duration.Duration) => {
  const pending = new Map<number, Resolve>();
  let nextId = 0;
  let ended = false;

  const receive = (text: string) => {
    const reply = decodeReply(text);
    if (Option.isNone(reply) || reply.value.method !== undefined) return;
    const resolve = pending.get(reply.value.id);
    pending.delete(reply.value.id);
    resolve?.(reply.value);
  };
  const closed = () => {
    ended = true;
    for (const resolve of pending.values()) resolve({ error: { message: "connection closed" } });
    pending.clear();
  };

  const request = (method: string, params: unknown) =>
    Effect.callback<unknown, CodexError>((resume) => {
      if (ended) {
        resume(Effect.fail(new CodexError({ method, message: "connection closed" })));
        return;
      }
      const id = ++nextId;
      pending.set(id, (reply) =>
        resume(
          reply.error === undefined
            ? Effect.succeed(reply.result)
            : Effect.fail(new CodexError({ method, message: reply.error.message }))
        )
      );
      try {
        write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (cause) {
        pending.delete(id);
        resume(Effect.fail(new CodexError({ method, message: String(cause) })));
      }
      return Effect.sync(() => pending.delete(id));
    }).pipe(timeLimit(method, timeout));

  /** Opens the session; `experimentalApi` unlocks methods such as `thread/queue/*`. */
  const initialize = (experimentalApi: boolean) =>
    Effect.gen(function* () {
      yield* request("initialize", {
        clientInfo: { name: "agent-bus", title: "agent-bus", version: "0.1.0" },
        capabilities: experimentalApi ? { experimentalApi } : null,
      });
      yield* Effect.try({
        try: () => write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" })),
        catch: (cause) => new CodexError({ method: "initialized", message: String(cause) }),
      });
      return Daemon.of({ request });
    });

  return { receive, closed, initialize };
};

/**
 * A JSON-RPC connection to the local Codex app-server daemon, which speaks
 * WebSocket over its Unix socket. Threads the daemon hosts can be woken with
 * `turn/start`; threads owned by another app-server (the desktop app's
 * embedded one) refuse a second writer.
 */
export const connect = (socketPath: string, timeout: Duration.Duration = REQUEST_TIMEOUT) =>
  Effect.gen(function* () {
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

    const client = rpc((text) => ws.send(text), timeout);
    ws.onmessage = (event) => client.receive(String(event.data));
    ws.onclose = client.closed;
    return yield* client.initialize(false);
  });

/**
 * A Codex app-server of this process's own, on stdio, as `codex queue` starts
 * internally: it needs no daemon and loads no thread unless asked to. The
 * scope ends it, waiting for it to exit, so nothing it was asked to do can
 * land after the scope closes.
 */
const appServer = (codex: string, timeout: Duration.Duration) =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.spawn([codex, "app-server"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
        catch: (cause) => new CodexError({ method: "app-server", message: String(cause) }),
      }),
      (child) =>
        Effect.promise(async () => {
          try {
            child.stdin.end();
          } catch {
            // Already gone.
          }
          // It exits when its input ends; one that doesn't is killed.
          const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(500)]);
          if (exited !== true) child.kill("SIGKILL");
          await child.exited;
        })
    );
    const client = rpc((text) => {
      child.stdin.write(`${text}\n`);
      // A process that has gone can reject the flush later; its requests fail as closed.
      const flushed = child.stdin.flush();
      if (flushed instanceof Promise) flushed.catch(() => undefined);
    }, timeout);
    // One message per line.
    void (async () => {
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of child.stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
          client.receive(buffered.slice(0, end));
          buffered = buffered.slice(end + 1);
        }
      }
    })()
      .catch(() => undefined)
      .finally(client.closed);
    // The end of its stderr says why one that fails to start did.
    let stderr = "";
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-500);
      }
    })().catch(() => undefined);
    return yield* client.initialize(true).pipe(
      Effect.mapError((error) =>
        stderr.trim() === ""
          ? error
          : new CodexError({
              method: error.method,
              message: `${error.message}: ${stderr.trim()}`,
            })
      )
    );
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

/** The first line of a bus nudge, by which the deliverer recognises its own waiting one. */
const nudgeHead = (address: string) => `[agent-bus] New messages for ${JSON.stringify(address)}.`;

/**
 * The turn input that tells a Codex thread it has mail. It carries no text
 * from other sessions (bodies, subjects or sender addresses): a queued item
 * runs as the owner's own input, so their text stays in `bus_read`'s result.
 */
export const formatNudge = (address: string) =>
  `${nudgeHead(address)} Read them with the agent-bus bus_read tool, as that address with your $CODEX_THREAD_ID as session, and handle them. If bus_read returns no messages, or says the address isn't joined or belongs to another session, end this turn without replying and without rejoining. If it fails, try once more; if it fails again, say so and end the turn.`;

/** A thread's queue: whichever app has the thread open runs its items as turns, in order. */
export interface Queue {
  /** The text of each item waiting in the thread's queue. */
  readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<string>, CodexError>;
  readonly add: (threadId: string, text: string) => Effect.Effect<void, CodexError>;
}
const Queue = { of: (queue: Queue) => queue };

const QueuedItems = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const decodeQueued = Schema.decodeUnknownEffect(QueuedItems);

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** A queued item's text. Items of shapes this doesn't know read as no text, not as an error. */
const queuedText = (item: unknown) => {
  const input = field(item, "input");
  if (!Array.isArray(input)) return "";
  return input
    .map((part: unknown) => {
      const text = field(part, "text");
      return typeof text === "string" ? text : "";
    })
    .join("\n");
};

/** The Codex CLI the desktop app ships, whose protocol matches the app that runs the queue. */
const desktopCodex =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

/**
 * The Codex CLI to reach queues with: the desktop app's own, whose
 * experimental protocol matches the app that runs the items. A machine
 * without the desktop app has nothing to run them.
 */
export const defaultCodex = desktopCodex;

/** Each app-server request's deadline. */
const QUEUE_TIMEOUT = Duration.seconds(2);

/**
 * The deadline for a whole nudge (start, list, add), which holds the
 * address's lock: well under the 10 s a `Stop` hook waits to read.
 */
const NUDGE_TIMEOUT = Duration.seconds(6);

/**
 * Thread queues through an app-server of serve's own (`thread/queue/*`, which
 * the protocol marks experimental). Listing and adding load the thread
 * nowhere; the desktop app runs an item in a thread it has open, at once when
 * idle, and a thread nobody has open keeps it until it is opened.
 */
export const appServerQueue = (codex: string, timeout: Duration.Duration = QUEUE_TIMEOUT) =>
  Effect.map(appServer(codex, timeout), (server) =>
    Queue.of({
      list: (threadId) =>
        server.request("thread/queue/list", { threadId, limit: 100 }).pipe(
          Effect.flatMap(decodeQueued),
          Effect.map((queued) => queued.data.map(queuedText)),
          Effect.mapError(
            (cause) => new CodexError({ method: "thread/queue/list", message: cause.message })
          )
        ),
      add: (threadId, text) =>
        server
          .request("thread/queue/add", {
            threadId,
            clientUserMessageId: Bun.randomUUIDv7(),
            input: [{ type: "text", text, text_elements: [] }],
          })
          .pipe(Effect.asVoid),
    })
  );

/** Host names compare without case or domain, which macOS varies (`.local`, `.lan`). */
export const machine = (host: string) => (host.split(".")[0] ?? host).toLowerCase();

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

/** What the deliverer has learned about a peer's current join. */
interface Hold {
  /** The join this applies to; rejoining starts over. */
  readonly joinId: string;
  /**
   * Another app-server refused to let the daemon resume the thread: nudge it
   * through its queue from then on, as for a thread that joined from elsewhere.
   */
  readonly elsewhere: boolean;
  /** The thread takes no direct input (a subagent): never deliver to this join. */
  readonly refused: boolean;
  /** Consecutive transport failures, and when to try again. */
  readonly failures: number;
  readonly until: number;
  /**
   * The unread messages, first to newest, when a bus nudge was last known to be
   * waiting in the thread's queue. Until the owner reads or newer mail arrives,
   * there is no need to look again.
   */
  readonly nudged?: string | undefined;
}

/** What the deliverer knows about each peer, by address. */
export type Holds = Map<string, Hold>;

const otherWriter = (error: CodexError) => error.message.includes("active writer");
const noDirectInput = (error: CodexError) =>
  error.message.includes("direct app-server input is not allowed");

/**
 * Wake each of this machine's Codex peers that has unread messages.
 *
 * A thread that joined from the daemon gets its messages as one turn there
 * (`turn/start` steers it if it is mid-turn), resumed first if the daemon has
 * let it go, and they are marked read once the daemon accepts the turn.
 *
 * Any other thread (the desktop app's, or one the daemon was refused) is never
 * sent to the daemon. It gets a nudge in its queue to read its mail, and the
 * messages stay unread until it does. At most one bus nudge waits in a
 * thread's queue for an address, since a waiting nudge also covers newer mail.
 *
 * Transport failures are retried after a delay that doubles to five minutes.
 */
export const deliverOnce = Effect.fn("Codex.deliverOnce")(function* (
  open: Effect.Effect<Daemon, CodexError, Scope.Scope>,
  openQueue: Effect.Effect<Queue, CodexError, Scope.Scope>,
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
      // Connect once, and only when a daemon thread has messages.
      const scope = yield* Scope.Scope;
      const daemon = yield* Effect.cached(Effect.provideService(open, Scope.Scope, scope));
      for (const peer of ready) {
        // The bus hands over the subscriber as it is now, under the address's lock;
        // what happens belongs to that subscriber, which may have rejoined since `peer` was read.
        let attempted: Subscriber = peer;
        let nudged: string | undefined;
        let added = false;
        let refusedResume = false;
        const current = () => {
          const hold = holds.get(peer.address);
          return hold?.joinId === attempted.joinId ? hold : undefined;
        };
        const nudge = (address: string, threadId: string, messages: ReadonlyArray<Message>) =>
          Effect.gen(function* () {
            const unread = `${messages[0]?.id}..${messages.at(-1)?.id}`;
            if (messages.length === 0 || current()?.nudged === unread) return false;
            // The app-server is ended before the lock is released, so an add can't land later.
            yield* Effect.scoped(
              Effect.gen(function* () {
                const queue = yield* openQueue;
                const waiting = (yield* queue.list(threadId)).some((text) =>
                  text.startsWith(nudgeHead(address))
                );
                if (!waiting) {
                  yield* queue.add(threadId, formatNudge(address));
                  added = true;
                }
              })
            ).pipe(timeLimit("queue nudge", NUDGE_TIMEOUT));
            nudged = unread;
            // The thread reads its own mail, so nothing is marked read here.
            return false;
          });
        const send = ({ subscriber, messages }: Pending) =>
          Effect.gen(function* () {
            attempted = subscriber;
            const threadId = subscriber.presence.codexThreadId;
            if (threadId === undefined || deliveryTargets([subscriber], host).length === 0) {
              return false;
            }
            if (subscriber.presence.codexHost !== "daemon" || current()?.elsewhere) {
              return yield* nudge(subscriber.address, threadId, messages);
            }
            return yield* Effect.gen(function* () {
              const connection = yield* daemon;
              if (!(yield* loadedThreads(connection)).includes(threadId)) {
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
            }).pipe(
              // Another app-server has the thread, so the daemon must not take it.
              Effect.catchIf(otherWriter, () => {
                refusedResume = true;
                return nudge(subscriber.address, threadId, messages);
              })
            );
          });
        const delivered = yield* Effect.result(bus.deliver(peer.address, send));
        const hold = (change: Partial<Hold>) => {
          const previous = current();
          holds.set(peer.address, {
            joinId: attempted.joinId,
            elsewhere: refusedResume || (previous?.elsewhere ?? false),
            refused: previous?.refused ?? false,
            failures: 0,
            until: 0,
            nudged: previous?.nudged,
            ...change,
          });
        };
        if (refusedResume && current()?.elsewhere !== true) {
          yield* Effect.logInfo(
            `Nudging ${peer.address} through its Codex queue from now on: another Codex app-server, such as the desktop app's, runs its thread.`
          );
        }

        if (delivered._tag === "Success") {
          if (nudged !== undefined) {
            hold({ nudged });
            if (added) yield* Effect.logInfo(`Queued a nudge for ${peer.address} to read its mail`);
            continue;
          }
          if (refusedResume) hold({});
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
        // Codex names the thread in some errors; logs name the address instead.
        const threadId = attempted.presence.codexThreadId;
        const reason =
          threadId === undefined ? error.message : error.message.replaceAll(threadId, "<thread>");
        if (noDirectInput(error)) {
          hold({ refused: true });
          yield* Effect.logWarning(
            `Not waking ${peer.address}: its Codex thread takes no direct input (${reason}). Its messages stay unread for bus_read until it rejoins.`
          );
          continue;
        }
        const failures = (current()?.failures ?? 0) + 1;
        const delay = Duration.min(Duration.times(FIRST_RETRY, 2 ** (failures - 1)), LAST_RETRY);
        // The delay runs from the failure, which may have taken a request timeout to arrive.
        const failedAt = yield* Clock.currentTimeMillis;
        hold({ failures, until: failedAt + Duration.toMillis(delay) });
        yield* Effect.logWarning(
          `Could not wake ${peer.address}: ${error.method}: ${reason}. Next attempt in ${Duration.format(delay)}.`
        );
      }
    })
  );
});

/** Long-running deliverer: delivers now, then whenever the ledger changes. */
export const runDeliverer = (socketPath: string, codex: string, host: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const holds: Holds = new Map();
    const attempt = deliverOnce(connect(socketPath), appServerQueue(codex), host, holds).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Delivery cycle failed", cause))
    );
    yield* attempt;
    yield* ledger.changes.pipe(
      Stream.mapEffect(() => attempt),
      Stream.runDrain
    );
  });
