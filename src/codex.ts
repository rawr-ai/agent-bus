import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { Clock, Duration, Effect, Option, Schema, type Scope, Stream } from "effect";
import { Bus, type Pending } from "./Bus.ts";
import { machine, type Subscriber } from "./domain.ts";
import { Ledger } from "./Ledger.ts";
import { readEligibility, type Stored } from "./rollout.ts";

export class CodexError extends Schema.TaggedError<CodexError>()("CodexError", {
  method: Schema.String,
  message: Schema.String,
}) {}

const Reply = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Number,
    // Requests from the app-server carry their own ids; they are not replies.
    method: Schema.optionalKey(Schema.Unknown),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  })
);
const decodeReply = Schema.decodeUnknownOption(Reply);

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

type Resolve = (reply: {
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}) => void;

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

  /** Opens the session, with the experimental methods (`thread/queue/*`) unlocked when asked. */
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
      return { request };
    });

  return { receive, closed, initialize };
};

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

/** The Codex daemon's control socket, which the TUI and SSH projects also use. */
const defaultSocket = join(homedir(), ".codex", "app-server-control", "app-server-control.sock");

const NOT_LISTENING = "no Codex daemon is listening on its control socket";

/**
 * Whether anything listens on the daemon's socket: a missing socket, or one a
 * daemon left behind when it stopped, refuses the connection. Only then is
 * starting the daemon the remedy.
 */
const probeDaemon = (socket: string) =>
  Effect.tryPromise({
    try: async () => {
      const probe = await Bun.connect({ unix: socket, socket: { data: () => undefined } });
      probe.end();
    },
    catch: (cause) => {
      const code = field(cause, "code");
      return new CodexError({
        method: "connect",
        message:
          code === "ENOENT" || code === "ECONNREFUSED"
            ? NOT_LISTENING
            : `the control socket refused a connection (${typeof code === "string" ? code : "unknown error"})`,
      });
    },
  });

/**
 * A connection to the Codex daemon: JSON-RPC over a WebSocket at `/rpc` on its
 * Unix socket, as the TUI connects. The scope closes it, which also drops
 * anything it subscribed to.
 */
const connectDaemon = (socket: string, timeout: Duration.Duration) =>
  Effect.gen(function* () {
    yield* probeDaemon(socket);
    // The scope owns the socket from the moment it exists, so a handshake that
    // never completes can be abandoned at the deadline and still be closed.
    const ws = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new WebSocket(`ws+unix://${socket}:/rpc`),
        catch: (cause) => new CodexError({ method: "connect", message: String(cause) }),
      }),
      (ws) => Effect.sync(() => ws.close())
    );
    // Something listens, so a failure here is the daemon's answer, not its absence.
    yield* Effect.callback<void, CodexError>((resume) => {
      const refused = () =>
        resume(
          Effect.fail(
            new CodexError({ method: "connect", message: "the daemon refused the connection" })
          )
        );
      ws.onopen = () => resume(Effect.void);
      ws.onerror = refused;
      ws.onclose = refused;
    }).pipe(timeLimit("connect", timeout));
    const client = rpc((text) => ws.send(text), timeout);
    ws.onmessage = (event) => client.receive(String(event.data));
    ws.onclose = client.closed;
    return yield* client.initialize(false);
  });

/**
 * What a borrow found: the daemon has the thread loaded, freshly or already,
 * or another process holds it, which runs the queue itself unless it is a
 * running `codex exec`.
 */
export type Borrowed = "loaded" | "held";

/** The machine's Codex daemon, asked to load threads so their queued nudges run. */
export interface Daemon {
  readonly borrow: (threadId: string) => Effect.Effect<Borrowed, CodexError>;
}

/** How long the daemon keeps a borrowed thread loaded once it is idle and unsubscribed. */
const RELEASE_SECONDS = 5;
/** A load's deadline, so a wedged daemon can't hold up the other peers. */
const BORROW_TIMEOUT = Duration.seconds(15);
/** The extra time a borrow has when it must start the daemon first. */
const START_TIMEOUT = Duration.seconds(10);
/** The daemon is releasing the thread; it is gone within milliseconds. */
const CLOSING_RETRY = Duration.seconds(1);
/** Unsubscribing only hastens the release, so it isn't waited on long. */
const UNSUBSCRIBE_TIMEOUT = Duration.seconds(2);

const notListening = (error: CodexError) =>
  error.method === "connect" && error.message === NOT_LISTENING;
const activeWriter = (error: CodexError) => error.message.includes("already has an active writer");
const closing = (error: CodexError) => error.message.includes("is closing");
/** A deadline passed: the daemon, or whatever it waits on, isn't answering. */
const timedOut = (error: CodexError) => error.message.startsWith("no answer within");

/**
 * Starts this machine's Codex daemon, as the TUI does when it finds none:
 * `codex app-server daemon start` runs the managed package, and returns once
 * it is ready, or at once if it is already running.
 */
export const startDaemon = (codex: string, timeout: Duration.Duration = START_TIMEOUT) =>
  Effect.scoped(
    Effect.gen(function* () {
      const method = "app-server daemon start";
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.spawn([codex, "app-server", "daemon", "start"], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "pipe",
            }),
          catch: (cause) => new CodexError({ method, message: String(cause) }),
        }),
        // The daemon runs in a session of its own, so ending this command leaves it running.
        (child) =>
          Effect.promise(async () => {
            if (child.exitCode === null) child.kill("SIGKILL");
            await child.exited;
          })
      );
      const code = yield* Effect.promise(() => child.exited).pipe(timeLimit(method, timeout));
      if (code === 0) return;
      const stderr = yield* Effect.promise(() => new Response(child.stderr).text());
      return yield* new CodexError({
        method,
        message: `exited with ${code}: ${stderr.trim().slice(-300)}`,
      });
    })
  );

/**
 * Borrows threads through the daemon: it asks the daemon to load the thread,
 * which runs whatever waits in its queue, to let it go a few seconds after it
 * goes idle, and then unsubscribes and disconnects. It starts or steers no
 * turn and waits for none. The writer lock decides the rest: a thread another
 * process holds is refused, and that process runs its queue. A daemon that
 * isn't listening is started once, within one deadline for the whole load.
 */
export const daemonBorrower = (options: {
  readonly socket: string;
  readonly start: Effect.Effect<void, CodexError>;
  readonly timeout?: Duration.Duration;
  readonly startTimeout?: Duration.Duration;
}): Daemon => {
  const timeout = options.timeout ?? BORROW_TIMEOUT;
  const deadline = Duration.sum(timeout, options.startTimeout ?? START_TIMEOUT);
  return {
    borrow: (threadId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const resume = Effect.gen(function* () {
            const daemon = yield* connectDaemon(options.socket, timeout);
            yield* daemon.request("thread/resume", {
              threadId,
              excludeTurns: true,
              config: { thread_unload_delay_secs: RELEASE_SECONDS },
            });
            return daemon;
          });
          const attempt = resume.pipe(
            Effect.catchIf(closing, () => Effect.andThen(Effect.sleep(CLOSING_RETRY), resume)),
            timeLimit("thread/resume", timeout)
          );
          const daemon = yield* attempt.pipe(
            Effect.catchIf(notListening, () => Effect.andThen(options.start, attempt)),
            timeLimit("borrow", deadline)
          );
          // Disconnecting would drop the subscription too; this starts the release at once.
          yield* Effect.ignore(
            daemon
              .request("thread/unsubscribe", { threadId })
              .pipe(timeLimit("thread/unsubscribe", UNSUBSCRIBE_TIMEOUT))
          );
          return "loaded" as Borrowed;
        })
      ).pipe(Effect.catchIf(activeWriter, () => Effect.succeed("held" as Borrowed))),
  };
};

/** The first line of a bus nudge, by which the deliverer recognises its own waiting one. */
const nudgeHead = (address: string) => `[agent-bus] New messages for ${JSON.stringify(address)}.`;

/**
 * The turn input that tells a Codex thread it has mail. It carries no text
 * from other sessions (bodies, subjects or sender addresses): a queued item
 * runs as the owner's own input, so their text stays in `bus_read`'s result.
 */
export const formatNudge = (address: string) =>
  `${nudgeHead(address)} You are already joined; don't call bus_join. Read them with the agent-bus bus_read tool, as that address with your $CODEX_THREAD_ID as session, and handle them. If bus_read returns no messages, or says the address isn't joined or belongs to another session, end this turn without replying and without rejoining. If it fails, try once more; if it fails again, say so and end the turn.`;

/** An item waiting in a thread's queue: Codex's ids for it, which an edit keeps, and its text. */
export interface Queued {
  readonly id: string | undefined;
  readonly clientUserMessageId: string | undefined;
  readonly text: string;
}

/** A thread's queue: whichever app-server has the thread loaded runs its items as turns, in order. */
export interface Queue {
  /** Each item waiting in the thread's queue. */
  readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<Queued>, CodexError>;
  readonly add: (threadId: string, text: string) => Effect.Effect<Queued, CodexError>;
  /**
   * Removes the item with this id, whatever it holds by then; whether one was
   * there. Codex has no delete that checks the content.
   */
  readonly remove: (threadId: string, id: string) => Effect.Effect<boolean, CodexError>;
  /** Where the thread's rollout, its session file, is, from `thread/read`, which loads nothing. */
  readonly rollout: (threadId: string) => Effect.Effect<Stored, CodexError>;
}
const QueuedItems = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeQueued = Schema.decodeUnknownEffect(QueuedItems);

/** A queued item. Items of shapes this doesn't know read as no text, not as an error. */
const queuedItem = (item: unknown): Queued => {
  const id = field(item, "id");
  const clientUserMessageId = field(item, "clientUserMessageId");
  const input = field(item, "input");
  return {
    id: typeof id === "string" ? id : undefined,
    clientUserMessageId: typeof clientUserMessageId === "string" ? clientUserMessageId : undefined,
    text: Array.isArray(input)
      ? input
          .map((part: unknown) => {
            const text = field(part, "text");
            return typeof text === "string" ? text : "";
          })
          .join("\n")
      : "",
  };
};

/**
 * The Codex CLI to reach queues with: the desktop app's own, whose
 * experimental protocol matches the app that runs the items. A machine
 * without the desktop app passes its own CLI with `serve --codex`.
 */
export const defaultCodex =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

/** More pages than a queue of a person's own making would fill. */
const MAX_PAGES = 20;

/** Each app-server request's deadline. */
const QUEUE_TIMEOUT = Duration.seconds(2);

/**
 * The deadline for a whole nudge (start, list, add), which holds the
 * address's lock: an owner's read waits behind it, well inside the CLI's 30 s call.
 */
const NUDGE_TIMEOUT = Duration.seconds(6);

/**
 * Thread queues through an app-server of serve's own (`thread/queue/*`, which
 * the protocol marks experimental). Listing, adding, removing and reading load the
 * thread nowhere. Whichever app-server has the thread loaded (the desktop
 * app's, or the daemon's) runs an item at once when the thread is idle and
 * after the current turn when it is busy; a thread nothing has loaded keeps it
 * until a server loads it.
 */
export const appServerQueue = (codex: string, timeout: Duration.Duration = QUEUE_TIMEOUT) =>
  Effect.map(
    appServer(codex, timeout),
    (server): Queue => ({
      // Every page, so a waiting nudge further down is still found.
      list: (threadId) =>
        Effect.gen(function* () {
          const items: Array<Queued> = [];
          const seen = new Set<string>();
          let cursor: string | null = null;
          do {
            if (seen.size >= MAX_PAGES || (cursor !== null && seen.has(cursor))) {
              return yield* new CodexError({
                method: "thread/queue/list",
                message: `the listing didn't end after ${seen.size + 1} pages`,
              });
            }
            if (cursor !== null) seen.add(cursor);
            const page: typeof QueuedItems.Type = yield* server
              .request("thread/queue/list", { threadId, limit: 100, cursor })
              .pipe(Effect.flatMap(decodeQueued));
            items.push(...page.data.map(queuedItem));
            cursor = page.nextCursor ?? null;
          } while (cursor !== null);
          return items;
        }).pipe(
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
          .pipe(Effect.map((added) => queuedItem(field(added, "queuedSubmission")))),
      remove: (threadId, id) =>
        server
          .request("thread/queue/delete", { threadId, queuedSubmissionId: id })
          .pipe(Effect.map((answer) => field(answer, "deleted") === true)),
      rollout: (threadId) =>
        server.request("thread/read", { threadId }).pipe(
          Effect.map((read): Stored => {
            const thread = field(read, "thread");
            const path = field(thread, "path");
            return {
              path: typeof path === "string" ? path : undefined,
              historyMode: field(thread, "historyMode"),
            };
          })
        ),
    })
  );

export const localHost = hostname();

/**
 * The Codex peers one machine's deliverer wakes: those with a thread id that
 * joined from that machine, whose queues are in that machine's `~/.codex`.
 * One deliverer per machine keeps one cursor writer per address.
 */
export const deliveryTargets = (peers: ReadonlyArray<Subscriber>, host: string) =>
  peers.filter(
    (peer) =>
      peer.presence.runtime === "codex" &&
      peer.presence.codexThreadId !== undefined &&
      peer.host !== undefined &&
      machine(peer.host) === machine(host)
  );

const FIRST_RETRY = Duration.seconds(30);
const LAST_RETRY = Duration.minutes(5);

/**
 * How long after an attempt covered some unread mail it is attempted again
 * while that mail stays unread: 5 minutes, then 15, then every hour.
 */
const RECONCILE = [Duration.minutes(5), Duration.minutes(15), Duration.minutes(60)] as const;
const reconcileDelay = (reconciles: number) =>
  RECONCILE[Math.min(reconciles, RECONCILE.length - 1)] ?? Duration.minutes(60);
/** After this many reconciles of the same unread mail, the log says the thread isn't reading it. */
const RECONCILES_BEFORE_WARNING = 3;

/** Unread mail an attempt covered, and when. */
interface Covered {
  /** The unread messages, first to newest. */
  readonly unread: string;
  readonly at: number;
  /** The attempts since the first, on the reconcile schedule. */
  readonly reconciles: number;
}

/** A nudge of ours as Codex queued it: the only item the deliverer ever removes. */
interface Posted {
  readonly id: string;
  readonly clientUserMessageId: string;
  readonly text: string;
}

const postedOf = ({ id, clientUserMessageId, text }: Queued): Posted | undefined =>
  id === undefined || clientUserMessageId === undefined
    ? undefined
    : { id, clientUserMessageId, text };

/** What the deliverer has learned about a peer's thread. */
interface Hold {
  /** The join this applies to. */
  readonly joinId: string;
  /**
   * The first join of its run: an ordinary rejoin by the same session
   * continues the run, and carries over what is known about the thread; a
   * replay, a leave or a takeover starts a new one.
   */
  readonly run: string;
  /** The thread takes no direct input (a subagent): never nudge this join. */
  readonly refused: boolean;
  /** Consecutive failures, and when to try again. */
  readonly failures: number;
  readonly until: number;
  /**
   * The unread mail the last attempt covered: a bus nudge waits in the
   * thread's queue, and the daemon has loaded the thread, or another process
   * holds it, or the thread can't be borrowed. That mail is attempted again
   * only on the reconcile schedule, until the owner reads or newer mail arrives.
   */
  readonly covered?: Covered | undefined;
  /** Why the log last said this thread can't be borrowed; a different reason is said again. */
  readonly warned?: string | undefined;
  /**
   * The nudge this deliverer last added, as Codex answered the add, kept apart
   * from `covered`: an add that landed is known even if the borrow afterwards
   * failed. Once the mail is read, it is removed if it still waits unchanged.
   * One found waiting isn't recorded, since the owner can queue our text too.
   */
  readonly posted?: Posted | undefined;
}

const runOf = (subscriber: Subscriber) => subscriber.presence.rejoinOf ?? subscriber.joinId;

/** Whether a hold still applies to this subscriber: the same join, or an ordinary rejoin of it. */
const carries = (hold: Hold, subscriber: Subscriber) => hold.run === runOf(subscriber);

/** What the deliverer knows about each peer, by address. */
export type Holds = Map<string, Hold>;

const noDirectInput = (error: CodexError) =>
  error.message.includes("direct app-server input is not allowed");

/**
 * Wake each of this machine's Codex peers that has unread messages, in two
 * acts. Under the address's lock, it posts one fixed nudge to the thread's
 * queue, unless one of ours already waits, and finds the thread's rollout.
 * Then, if the rollout says the thread may be borrowed, it asks the daemon to
 * load the thread, so that whichever process has it runs the nudge as a turn.
 * The messages stay unread until the thread reads them. One waiting nudge also
 * covers newer mail. Once a borrow times out, the cycle's other borrows fail
 * at once, so a wedged daemon costs one deadline, not one per peer.
 *
 * Mail that stays unread is attempted again on the reconcile schedule, which
 * re-posts a nudge that has gone and borrows again. Failures are retried after
 * a delay that doubles to five minutes. What it knows about a thread carries
 * over an ordinary rejoin, so a woken thread that rejoins before reading isn't
 * nudged again.
 *
 * Once the mail is read, as by a read inside a running turn, it removes our
 * nudge if it still waits with the ids Codex gave it and our exact text, so
 * it doesn't run as an empty turn. Removal is best effort: it is tried once.
 */
export const deliverOnce = Effect.fn("Codex.deliverOnce")(function* (
  openQueue: Effect.Effect<Queue, CodexError, Scope.Scope>,
  daemon: Daemon,
  host: string,
  holds: Holds
) {
  const bus = yield* Bus;
  const now = yield* Clock.currentTimeMillis;
  let stalled: CodexError | undefined;
  const targets = deliveryTargets(yield* bus.peers, host);
  // An ordinary rejoin keeps what was learned, but a subagent refusal and failures belong to the join.
  for (const peer of targets) {
    const hold = holds.get(peer.address);
    if (hold !== undefined && hold.joinId !== peer.joinId && carries(hold, peer)) {
      holds.set(peer.address, {
        ...hold,
        joinId: peer.joinId,
        refused: false,
        failures: 0,
        until: 0,
      });
    }
  }
  // Back-off holds off posting, not removing a nudge whose mail has been read.
  const ready = targets.filter((peer) => {
    const hold = holds.get(peer.address);
    return (
      hold === undefined ||
      hold.joinId !== peer.joinId ||
      (!hold.refused && (hold.until <= now || hold.posted !== undefined))
    );
  });

  for (const peer of ready) {
    // The bus hands over the subscriber as it is now, under the address's lock;
    // what happens belongs to that subscriber, which may have rejoined since `peer` was read.
    let attempted: Subscriber = peer;
    const current = () => {
      const hold = holds.get(peer.address);
      return hold !== undefined && carries(hold, attempted) ? hold : undefined;
    };
    /** Changes what is known about the attempted subscriber's thread, keeping the rest. */
    const update = (change: Partial<Hold>) => {
      const known = current();
      holds.set(peer.address, {
        joinId: attempted.joinId,
        run: runOf(attempted),
        // A subagent refusal and the back-off belong to the join.
        refused: known?.joinId === attempted.joinId && known.refused,
        failures: known?.joinId === attempted.joinId ? known.failures : 0,
        until: known?.joinId === attempted.joinId ? known.until : 0,
        covered: known?.covered,
        warned: known?.warned,
        posted: known?.posted,
        ...change,
      });
    };
    const hold = (change: Partial<Hold>) => update({ failures: 0, until: 0, ...change });
    const post = ({ subscriber, messages }: Pending) =>
      Effect.gen(function* () {
        attempted = subscriber;
        const threadId = subscriber.presence.codexThreadId;
        const unread = `${messages[0]?.id}..${messages.at(-1)?.id}`;
        if (threadId === undefined || deliveryTargets([subscriber], host).length === 0) {
          return undefined;
        }
        if ((current()?.until ?? 0) > now) return undefined;
        const covered = current()?.covered;
        const again = covered?.unread === unread;
        if (again && now < covered.at + Duration.toMillis(reconcileDelay(covered.reconciles))) {
          return undefined;
        }
        // The app-server is ended before the lock is released, so an add can't land later.
        const queued = yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* openQueue;
            const ours = formatNudge(subscriber.address);
            // Any nudge of ours covers the mail, but only one this deliverer added is ever removed:
            // the owner can queue our text too.
            const waiting = (yield* queue.list(threadId)).some(({ text }) =>
              text.startsWith(nudgeHead(subscriber.address))
            );
            if (!waiting) update({ posted: postedOf(yield* queue.add(threadId, ours)) });
            return { added: !waiting, stored: yield* queue.rollout(threadId) };
          })
        ).pipe(timeLimit("queue nudge", NUDGE_TIMEOUT));
        return { threadId, unread, reconciles: again ? covered.reconciles + 1 : 0, ...queued };
      });
    // Reading the rollout and the borrow run outside the lock: the owner's read needn't wait on them.
    // With the mail read, our nudge would run as an empty turn: remove it if it still waits unchanged.
    const retract = (subscriber: Subscriber) =>
      Effect.gen(function* () {
        attempted = subscriber;
        const posted = current()?.posted;
        const threadId = subscriber.presence.codexThreadId;
        if (posted === undefined || threadId === undefined) return;
        update({ posted: undefined });
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* openQueue;
            const item = (yield* queue.list(threadId)).find(({ id }) => id === posted.id);
            if (item === undefined) return "it had already run";
            if (
              item.clientUserMessageId !== posted.clientUserMessageId ||
              item.text !== posted.text
            ) {
              return "it was edited, so it was left";
            }
            return (yield* queue.remove(threadId, posted.id)) ? "removed it" : "it had already run";
          })
        ).pipe(timeLimit("remove nudge", NUDGE_TIMEOUT), Effect.result);
        yield* Effect.logDebug(
          outcome._tag === "Success"
            ? `${peer.address} read its mail while our nudge waited: ${outcome.success}`
            : `Could not remove ${peer.address}'s nudge: ${outcome.failure.method}: ${outcome.failure.message.replaceAll(threadId, "<thread>")}`
        );
      });
    const waking = Effect.gen(function* () {
      const posted = yield* bus.deliver(peer.address, post, retract);
      if (posted === undefined) return undefined;
      const eligibility = yield* readEligibility(posted.threadId, posted.stored);
      if (!eligibility.eligible) return { ...posted, eligibility, borrowed: undefined };
      if (stalled !== undefined) {
        return yield* new CodexError({
          method: "borrow",
          message: `not tried, since an earlier borrow this cycle got ${stalled.message}`,
        });
      }
      const borrowed = yield* daemon.borrow(posted.threadId).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (timedOut(error)) stalled = error;
          })
        )
      );
      return { ...posted, eligibility, borrowed };
    });
    const outcome = yield* Effect.result(waking);

    if (outcome._tag === "Success") {
      const woken = outcome.success;
      if (woken === undefined) continue;
      const at = yield* Clock.currentTimeMillis;
      const ineligible = woken.eligibility.eligible ? undefined : woken.eligibility.reason;
      const warned = ineligible !== undefined && current()?.warned === ineligible;
      hold({
        covered: { unread: woken.unread, at, reconciles: woken.reconciles },
        warned: ineligible,
      });
      const posted = woken.added ? "queued a nudge" : "a nudge was already waiting";
      const doing = woken.reconciles > 0 ? "Still waking" : "Waking";
      if (ineligible !== undefined) {
        if (!warned) {
          yield* Effect.logWarning(
            `Not borrowing ${peer.address}'s Codex thread: ${ineligible.replaceAll(woken.threadId, "<thread>")}. Its nudge runs wherever the thread is next loaded.`
          );
        }
        if (woken.added) {
          yield* Effect.logInfo(`${doing} ${peer.address}: queued a nudge`);
        }
      } else if (woken.borrowed === "loaded") {
        yield* Effect.logInfo(
          `${doing} ${peer.address}: ${posted}, and the Codex daemon loaded its thread to run it`
        );
      } else {
        yield* Effect.logInfo(
          `${doing} ${peer.address}: ${posted}; another Codex process holds its thread`
        );
      }
      if (woken.reconciles === RECONCILES_BEFORE_WARNING) {
        yield* Effect.logWarning(
          ineligible === undefined
            ? `${peer.address} hasn't read its mail after ${woken.reconciles} attempts to wake it since the first; trying hourly until it does.`
            : `${peer.address} hasn't read its mail after ${woken.reconciles} checks that its nudge still waits; its thread can't be borrowed (${ineligible.replaceAll(woken.threadId, "<thread>")}), so the nudge runs only when the thread is next loaded. Checking hourly.`
        );
      }
      continue;
    }
    const error = outcome.failure;
    if (error._tag !== "CodexError") {
      yield* Effect.logWarning(`Could not nudge ${peer.address}: ${error.message}`);
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
});

/** Long-running deliverer: wakes now, then whenever the ledger changes, and on its 15 s tick. */
export const runDeliverer = (codex: string, host: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const holds: Holds = new Map();
    const daemon = daemonBorrower({ socket: defaultSocket, start: startDaemon(codex) });
    const attempt = deliverOnce(appServerQueue(codex), daemon, host, holds).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Delivery cycle failed", cause))
    );
    yield* attempt;
    yield* ledger.changes.pipe(
      Stream.mapEffect(() => attempt),
      Stream.runDrain
    );
  });
