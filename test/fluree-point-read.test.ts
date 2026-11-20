// The point read a retried send settles by, at its HTTP boundary: an in-process stub stands in for
// Fluree's endpoints (no child process), so an early refusal can carry a slow body and the test
// can see whether the read closes the connection or keeps draining it after it has answered.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";

const CHUNKS = 40;
const CHUNK_INTERVAL_MS = 50;

/** When the refused query's body stream was cancelled, and how many chunks it had sent. */
const body = { cancelledAt: undefined as number | undefined, sent: 0, finished: false };

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/fluree/show/")) {
      return Response.json({ id: "fixture-incarnation" });
    }
    if (url.pathname.startsWith("/v1/fluree/info/")) return Response.json({ ledger: { t: 7 } });
    if (url.pathname.startsWith("/v1/fluree/query/")) {
      // An early refusal whose body keeps coming for two seconds unless the reader closes it.
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => {
            if (body.sent >= CHUNKS) {
              clearInterval(timer);
              body.finished = true;
              controller.close();
              return;
            }
            body.sent++;
            controller.enqueue(new TextEncoder().encode(`${"x".repeat(1024)}\n`));
          }, CHUNK_INTERVAL_MS);
        },
        cancel() {
          clearInterval(timer);
          body.cancelledAt = performance.now();
        },
      });
      return new Response(stream, { status: 503 });
    }
    return new Response(null, { status: 404 });
  },
});

const runtime = ManagedRuntime.make(
  layerFluree(
    { url: server.url.origin, ledger: "fixture/ledger", token: "fixture-token" },
    { existingOnly: true }
  ).pipe(Layer.provide(FetchHttpClient.layer))
);

afterAll(async () => {
  await runtime.dispose();
  server.stop(true);
});

test("a refused point read is unavailable and closes its connection instead of draining it", async () => {
  const result = await runtime.runPromise(
    Effect.flatMap(Ledger, (ledger) => ledger.readEntry(Bun.randomUUIDv7()))
  );
  const answeredAt = performance.now();
  expect(result.status).toBe("UNAVAILABLE");
  // Give a draining read time to show itself: several more chunks would be sent by now.
  await Bun.sleep(CHUNK_INTERVAL_MS * 6);
  expect(body.finished).toBe(false);
  expect(body.cancelledAt).toBeDefined();
  expect((body.cancelledAt ?? Number.POSITIVE_INFINITY) - answeredAt).toBeLessThan(
    CHUNK_INTERVAL_MS * 4
  );
  expect(body.sent).toBeLessThan(CHUNKS / 2);
});
