/**
 * A controlled HTTP boundary in front of the throwaway Fluree server: every request passes
 * through unchanged, except pinned query requests (`/v1/fluree/query/{ledger}@t:{t}`) that a
 * test has queued a reply for. A queued reply can stall before headers, stall mid-body, or
 * stream a chosen body in chunks, and the boundary reports when the bus ended that request
 * (the request's signal aborted or the response stream was cancelled). It shows what the bus
 * does with its own request; it says nothing about whether Fluree's computation would stop.
 * It can also lose the acknowledgement of an update: the update reaches Fluree, and the
 * client gets a gateway timeout instead of Fluree's response.
 */

/** A query request the boundary answered, and when the bus let go of it. */
export interface Held {
  /** The commit the request was pinned to. */
  readonly t: number;
  /** Resolves when the bus aborted the request or cancelled the response body. */
  readonly finalised: Promise<void>;
  /** Whether that has happened yet. */
  readonly isFinalised: () => boolean;
}

/** Builds the response to one held request; `ended` marks it finalised. */
export type Reply = (t: number, ended: () => void) => Response | Promise<Response>;

const encoder = new TextEncoder();

/** Never sends headers: the request stays open until the bus aborts it. */
export const stallBeforeHeaders: Reply = () => new Promise<Response>(() => {});

/** Sends headers and the start of a body, then nothing more until the bus cancels it. */
export const stallMidBody: Reply = (_t, ended) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"rows": ['));
      },
      cancel: ended,
    }),
    { headers: { "content-type": "application/json" } }
  );

/**
 * Streams `body` in 64 KiB chunks with no content length (chunked transfer). With `open`, the
 * stream is never closed after the last chunk, so only the reader can end it.
 */
export const chunked =
  (body: string, options: { readonly open?: boolean } = {}): Reply =>
  (_t, ended) => {
    const bytes = encoder.encode(body);
    let offset = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset < bytes.length) {
            controller.enqueue(bytes.slice(offset, offset + 65_536));
            offset += 65_536;
          } else if (options.open !== true) controller.close();
          else return new Promise<void>(() => {});
        },
        cancel: ended,
      }),
      { headers: { "content-type": "application/json" } }
    );
  };

/** What became of an update whose acknowledgement the boundary lost. */
export type Forwarded = { readonly status: number } | { readonly failed: string };

/** A JSON text padded with trailing spaces to exactly `size` UTF-8 bytes. */
export const padded = (value: unknown, size: number) => {
  const text = JSON.stringify(value);
  const pad = size - Buffer.byteLength(text, "utf8");
  if (pad < 0) throw new Error(`The value is already ${-pad} bytes over ${size}`);
  return text + " ".repeat(pad);
};

export interface Boundary {
  /** The boundary's origin, to use as the store's Fluree URL. */
  readonly url: string;
  /** Queues a reply for the next pinned query request; resolves when that request arrives. */
  readonly next: (reply: Reply) => Promise<Held>;
  /** Queues a reply for the next ledger-incarnation pin, after store startup. */
  readonly nextPin: (reply: Reply) => Promise<Held>;
  /** Pinned query requests that passed through to Fluree. */
  readonly passed: () => number;
  /** All queries forwarded, including history ranges on the unqualified query path. */
  readonly queries: () => number;
  /** Update requests seen, including no-op writes and lost answers. */
  readonly updates: () => number;
  readonly creates: () => number;
  /** Forward one create and lose only its acknowledgement. */
  readonly loseNextCreate: () => Promise<Forwarded>;
  /**
   * Forwards the next update to Fluree and answers it with a 504 once forwarding settles;
   * resolves with Fluree's status, or with the failure if the update got no response within
   * the boundary's forward timeout.
   */
  readonly loseNextUpdate: (options?: { readonly disconnect?: boolean }) => Promise<Forwarded>;
  /** Restores contact after a lost answer with disconnect set; returns requests refused meanwhile. */
  readonly reconnect: () => number;
  readonly stop: () => void;
}

const PINNED = /^\/v1\/fluree\/query\/([^/]+)$/;
const INCARNATION = /^\/v1\/fluree\/show\/[^/]+$/;
const UPDATE = "/v1/fluree/update";

export const boundary = (
  upstream: string,
  options: {
    readonly forwardTimeoutMs?: number;
    /** Hold a prepared transaction after its body arrives, before Fluree can evaluate it. */
    readonly beforeUpdate?: () => Promise<void>;
    /** A test-only return budget, independent of what fits in a query or an update request. */
    readonly queryResponseBytes?: () => number;
  } = {}
): Boundary => {
  type Pending = { readonly reply: Reply; readonly arrived: (held: Held) => void };
  const queued: Pending[] = [];
  const pins: Pending[] = [];
  const lostUpdates: Array<(forwarded: Forwarded) => void> = [];
  const lostCreates: Array<(forwarded: Forwarded) => void> = [];
  let disconnected = false;
  let refused = 0;
  let passed = 0;
  let queries = 0;
  let updates = 0;
  let creates = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A held request may be idle for as long as a test keeps it.
    idleTimeout: 0,
    async fetch(request) {
      if (disconnected) {
        refused++;
        return new Response(null, { status: 503 });
      }
      const url = new URL(request.url);
      const pinned = PINNED.exec(url.pathname);
      const t = Number(/@t:(\d+)$/.exec(decodeURIComponent(pinned?.[1] ?? ""))?.[1] ?? Number.NaN);
      const pin = INCARNATION.test(url.pathname) && url.searchParams.get("commit") === "t:1";
      const waiting = pin ? pins.shift() : pinned === null ? undefined : queued.shift();
      if (waiting !== undefined) {
        let done = false;
        let ended = () => {};
        const finalised = new Promise<void>((resolve) => {
          ended = () => {
            done = true;
            resolve();
          };
        });
        request.signal.addEventListener("abort", ended);
        const commit = pin ? 1 : t;
        const response = waiting.reply(commit, ended);
        waiting.arrived({ t: commit, finalised, isFinalised: () => done });
        return response;
      }
      if (pinned !== null) passed += 1;
      if (pinned !== null || url.pathname === "/v1/fluree/query") queries += 1;
      const headers = new Headers(request.headers);
      headers.delete("host");
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const forward = (signal: AbortSignal) =>
        fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
          signal,
        });
      if (url.pathname === UPDATE) {
        updates += 1;
        await options.beforeUpdate?.();
      }
      const create = url.pathname === "/v1/fluree/create";
      if (create) creates++;
      const lost = create
        ? lostCreates.shift()
        : url.pathname === UPDATE
          ? lostUpdates.shift()
          : undefined;
      if (lost === undefined) {
        const response = await forward(request.signal);
        const budget = options.queryResponseBytes;
        if (budget === undefined || (pinned === null && url.pathname !== "/v1/fluree/query"))
          return response;
        const payload = await response.arrayBuffer();
        return payload.byteLength > budget()
          ? new Response(null, { status: 502 })
          : new Response(payload, {
              status: response.status,
              headers: { "content-type": "application/json" },
            });
      }
      // The update still goes to Fluree after the client gives up, and its outcome settles
      // whether or not Fluree answers, so the test waiting on it can always finish.
      try {
        const response = await forward(AbortSignal.timeout(options.forwardTimeoutMs ?? 30_000));
        await response.arrayBuffer();
        lost({ status: response.status });
      } catch (error) {
        lost({ failed: error instanceof Error ? error.message : String(error) });
      }
      return new Response(null, { status: 504 });
    },
  });
  return {
    url: server.url.origin,
    next: (reply) => new Promise<Held>((arrived) => queued.push({ reply, arrived })),
    nextPin: (reply) => new Promise<Held>((arrived) => pins.push({ reply, arrived })),
    passed: () => passed,
    queries: () => queries,
    updates: () => updates,
    creates: () => creates,
    loseNextCreate: () => new Promise<Forwarded>((resolve) => lostCreates.push(resolve)),
    loseNextUpdate: (options) =>
      new Promise<Forwarded>((settled) =>
        lostUpdates.push((result) => {
          if (options?.disconnect) {
            refused = 0;
            disconnected = true;
          }
          settled(result);
        })
      ),
    reconnect: () => {
      disconnected = false;
      return refused;
    },
    stop: () => server.stop(true),
  };
};
