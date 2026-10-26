import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { runDeliverer } from "./codex.ts";
import * as Mcp from "./mcp.ts";

/**
 * Rejects requests whose Host is not this loopback server, so a web page that
 * rebinds a domain to 127.0.0.1 cannot reach the bus. Browser Origins are
 * already rejected by the MCP endpoint.
 */
const localOnly = HttpRouter.middleware(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    const port = address._tag === "UnixPathAddress" ? undefined : address.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return hosts.has(request.headers.host ?? "")
          ? yield* httpEffect
          : HttpServerResponse.empty({ status: 403 });
      });
  }),
  { global: true }
);

const health = HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"));

/** The bus's MCP endpoint at `/mcp` and `/health`, on loopback. */
export const layerHttp = (options: { readonly port: number; readonly version: string }) =>
  HttpRouter.serve(Layer.mergeAll(Mcp.layerHttp(options.version), health, localOnly), {
    disableLogger: true,
  }).pipe(
    Layer.provide(
      BunHttpServer.layer({
        hostname: "127.0.0.1",
        port: options.port,
        // Long enough for the longest bus_wait; Bun's default closes idle requests after 10 s.
        idleTimeout: Mcp.MAX_WAIT_SECONDS + 15,
      })
    )
  );

/**
 * The machine's one bus process: the MCP endpoint for every session on this
 * machine, and the deliverer that wakes this machine's Codex peers. Both use
 * the Bus provided around this layer, so they share cursors and locks.
 */
export const layer = (options: {
  readonly port: number;
  readonly version: string;
  readonly codexSocket: string;
  readonly host: string;
}) =>
  Layer.mergeAll(
    layerHttp(options),
    Layer.effectDiscard(Effect.forkScoped(runDeliverer(options.codexSocket, options.host)))
  );
