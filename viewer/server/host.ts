import { RPCHandler } from "@orpc/server/fetch";
import { ManagedRuntime } from "effect";
import { MAX_CONCURRENT_READS, OPERATION_TIMEOUT_MILLIS, readerLayer } from "./reader.ts";
import { createRouter, type ViewerRuntime } from "./router.ts";

export const MAX_REQUEST_BYTES = 4096;
export interface ViewerAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}
export type ViewerAssets = ReadonlyMap<string, ViewerAsset>;

const error = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

const secure = (response: Response) => {
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
  return response;
};

/** A single guarded request path serves both exact assets and the two RPC leaves. */
export const createViewer = (options: {
  readonly port: number;
  readonly busPort: number;
  readonly assets: ViewerAssets;
  readonly timeoutMillis?: number;
  readonly runtime?: ViewerRuntime;
}) => {
  const runtime = options.runtime ?? ManagedRuntime.make(readerLayer(options));
  const handler = new RPCHandler(createRouter(runtime));
  const active = new Set<AbortController>();
  let closing = false;
  let closed: Promise<void> | undefined;
  let boundPort = options.port;

  const fetchRequest = async (request: Request): Promise<Response> => {
    if (closing) return error(503, "Viewer unavailable");
    const url = new URL(request.url);
    const authority = `127.0.0.1:${boundPort}`;
    if (
      url.protocol !== "http:" ||
      request.headers.get("host") !== authority ||
      url.host !== authority
    ) {
      return error(403, "Request refused");
    }
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== `http://${authority}`) return error(403, "Request refused");
    if (url.search !== "") return error(404, "Not Found");
    const rpc = url.pathname === "/rpc/history" || url.pathname === "/rpc/peers";
    if (!rpc) {
      const asset = options.assets.get(url.pathname);
      if (asset === undefined) return error(404, "Not Found");
      if (request.method !== "GET" && request.method !== "HEAD")
        return error(405, "Method refused");
      return new Response(request.method === "HEAD" ? null : new Uint8Array(asset.body), {
        headers: { "content-type": asset.contentType, "cache-control": "no-store" },
      });
    }
    if (request.method !== "POST") return error(405, "Method refused");
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      return error(415, "JSON required");
    }
    const declaredLength = request.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)
    ) {
      return error(413, "Request too large");
    }
    if (active.size >= MAX_CONCURRENT_READS) return error(503, "Viewer busy");
    const controller = new AbortController();
    let bodyReader = request.body?.getReader();
    let timedOut = false;
    const cancelBody = () => {
      void bodyReader?.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancelBody, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMillis ?? OPERATION_TIMEOUT_MILLIS);
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) controller.abort();
    active.add(controller);
    try {
      const parts: Uint8Array[] = [];
      let bytes = 0;
      if (bodyReader !== undefined) {
        try {
          while (true) {
            if (controller.signal.aborted) return error(timedOut ? 504 : 499, "Request ended");
            const chunk = await bodyReader.read();
            if (controller.signal.aborted) return error(timedOut ? 504 : 499, "Request ended");
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_REQUEST_BYTES) {
              await bodyReader.cancel();
              return error(413, "Request too large");
            }
            parts.push(chunk.value);
          }
        } finally {
          bodyReader.releaseLock();
          bodyReader = undefined;
        }
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const part of parts) {
        body.set(part, offset);
        offset += part.byteLength;
      }
      const forwarded = new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      const result = await handler.handle(forwarded, { prefix: "/rpc" });
      if (timedOut) return error(504, "Observation timed out");
      const response = result.response ?? error(404, "Not Found");
      response.headers.set("cache-control", "no-store");
      return response;
    } catch {
      return error(
        timedOut ? 504 : controller.signal.aborted ? 499 : 500,
        "Observation unavailable"
      );
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancelBody);
      active.delete(controller);
      request.signal.removeEventListener("abort", abort);
    }
  };

  const fetch = async (request: Request) => secure(await fetchRequest(request));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    development: false,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    fetch,
    error: () => secure(error(500, "Viewer unavailable")),
  });
  boundPort = server.port ?? options.port;
  return {
    url: server.url,
    fetch,
    close: () => {
      if (closed !== undefined) return closed;
      closing = true;
      for (const controller of active) controller.abort();
      closed = (async () => {
        await server.stop(true);
        await runtime.dispose();
      })();
      return closed;
    },
  };
};
