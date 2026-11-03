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
  /** Pinned query requests that passed through to Fluree. */
  readonly passed: () => number;
  /**
   * Forwards the next update to Fluree and answers it with a 504 once Fluree has responded;
   * resolves with Fluree's status.
   */
  readonly loseNextUpdate: () => Promise<number>;
  readonly stop: () => void;
}

const PINNED = /^\/v1\/fluree\/query\/([^/]+)$/;
const UPDATE = "/v1/fluree/update";

export const boundary = (upstream: string): Boundary => {
  const queued: Array<{ readonly reply: Reply; readonly arrived: (held: Held) => void }> = [];
  const lostUpdates: Array<(status: number) => void> = [];
  let passed = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A held request may be idle for as long as a test keeps it.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const pinned = PINNED.exec(url.pathname);
      const t = Number(/@t:(\d+)$/.exec(decodeURIComponent(pinned?.[1] ?? ""))?.[1] ?? Number.NaN);
      const waiting = pinned === null ? undefined : queued.shift();
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
        const response = waiting.reply(t, ended);
        waiting.arrived({ t, finalised, isFinalised: () => done });
        return response;
      }
      if (pinned !== null) passed += 1;
      const headers = new Headers(request.headers);
      headers.delete("host");
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const lost = url.pathname === UPDATE ? lostUpdates.shift() : undefined;
      const forwarded = fetch(`${upstream}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
        // A lost acknowledgement must still reach Fluree after the client gives up.
        ...(lost === undefined ? { signal: request.signal } : {}),
      });
      if (lost === undefined) return forwarded;
      const response = await forwarded;
      await response.arrayBuffer();
      lost(response.status);
      return new Response(null, { status: 504 });
    },
  });
  return {
    url: server.url.origin,
    next: (reply) => new Promise<Held>((arrived) => queued.push({ reply, arrived })),
    passed: () => passed,
    loseNextUpdate: () => new Promise<number>((forwarded) => lostUpdates.push(forwarded)),
    stop: () => server.stop(true),
  };
};
