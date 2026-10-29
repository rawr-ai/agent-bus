import { Duration } from "effect";

/**
 * Every timeout, retry, delay, schedule and limit of delivery, the Claude
 * wake, `serve` and the MCP and CLI calls, by the name the docs' table of
 * timeouts and schedules gives it. The store's own query and read bounds stay
 * beside the store code (`Fluree.ts`, `sparql.ts`).
 */

// The ledger's change stream (`Fluree.ts`).

/** The tick merged into the change stream: each runs a delivery cycle and a pass of every waiting `bus_wake`. */
export const POLL_INTERVAL = Duration.seconds(15);
/** The pause before reconnecting Fluree's event stream. */
export const RECONNECT_INTERVAL = Duration.seconds(5);

// The MCP layer and the CLI (`mcp.ts`, `serve.ts`, `client.ts`, `claude.ts`).

/** The longest a single wait holds its HTTP request open: one `bus_wake` call, and the longest `bus_wait`. */
export const MAX_WAIT_SECONDS = 50;
/** `bus_history`'s default number of messages. */
export const DEFAULT_HISTORY_LIMIT = 50;
/** The HTTP server's idle timeout, long enough for the longest wait; Bun's default is 10 s. */
export const IDLE_TIMEOUT_SECONDS = MAX_WAIT_SECONDS + 15;
/** The deadline of one CLI call to `serve`. */
export const CALL_TIMEOUT_SECONDS = 30;
/** The Claude wake hook's deadline for one `bus_wake` call. */
export const WAKE_CALL_TIMEOUT_SECONDS = MAX_WAIT_SECONDS + 5;
/** The pause between the hook's failing calls. */
export const WAKE_RETRY = Duration.seconds(5);
/** How long failing calls are retried before the hook gives up until the session's next arming point. */
export const WAKE_FAILING_FOR = Duration.minutes(10);

// Posting and removing a Codex nudge (`codex.ts`).

/** Each request to `serve`'s own app-server. */
export const QUEUE_TIMEOUT = Duration.seconds(2);
/**
 * The deadline for a whole nudge (start, list, add) or removal, which holds the
 * address's lock: an owner's read waits behind it, well inside a CLI call.
 */
export const NUDGE_TIMEOUT = Duration.seconds(6);
/** How long `serve`'s app-server has to exit once its input ends, before it is killed. */
export const APP_SERVER_EXIT_GRACE = Duration.millis(500);
/** The most queue pages one listing reads: more than a queue of a person's own making would fill. */
export const MAX_PAGES = 20;
/** The items each queue page asks for. */
export const QUEUE_PAGE_SIZE = 100;

// Reading a rollout for eligibility (`rollout.ts`).

/** How long reading a rollout may take; it holds up the other peers' turns in the cycle. */
export const READ_TIMEOUT = Duration.seconds(5);
/** The first record holds the base instructions; one longer than this many bytes isn't read. */
export const MAX_FIRST_LINE = 8 * 1024 * 1024;
/** The bytes read at a time, backwards from a rollout's end. */
export const ROLLOUT_CHUNK = 64 * 1024;

// Borrowing a thread through the daemon (`codex.ts`).

/** A load's deadline, so a wedged daemon can't hold up the other peers. */
export const BORROW_TIMEOUT = Duration.seconds(15);
/** The extra time a borrow has when it must start the daemon first. */
export const START_TIMEOUT = Duration.seconds(10);
/** The daemon is releasing the thread; it is gone within milliseconds. */
export const CLOSING_RETRY = Duration.seconds(1);
/** Unsubscribing only hastens the release, so it isn't waited on long. */
export const UNSUBSCRIBE_TIMEOUT = Duration.seconds(2);
/** How long the daemon keeps a borrowed thread loaded once it is idle and unsubscribed. */
export const RELEASE_SECONDS = 5;

// The deliverer's schedules (`codex.ts`).

/** The back-off after a failed attempt: the first delay, doubling with each consecutive failure. */
export const FIRST_RETRY = Duration.seconds(30);
/** The longest back-off. */
export const LAST_RETRY = Duration.minutes(5);
/**
 * How long after an attempt covered some unread mail it is attempted again
 * while that mail stays unread: 5 minutes, then 15, then every hour.
 */
export const RECONCILE = [Duration.minutes(5), Duration.minutes(15), Duration.minutes(60)] as const;
/** After this many reconciles of the same unread mail, the log says the thread isn't reading it. */
export const RECONCILES_BEFORE_WARNING = 3;
