// The boundary's lost acknowledgement, against a stand-in upstream: the update reaches the
// upstream, the client gets a 504, and the outcome settles whether or not the upstream answers.
import { afterEach, expect, test } from "bun:test";
import { boundary } from "./fluree-boundary.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const UPDATE = "/v1/fluree/update?ledger=boundary-test%3Amain";

const post = (origin: string) =>
  fetch(`${origin}${UPDATE}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ insert: [] }),
  });

test("a lost acknowledgement forwards the update and reports the upstream's status", async () => {
  const received: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push(`${new URL(request.url).pathname} ${await request.text()}`);
      return Response.json({ t: 1 });
    },
  });
  stops.push(() => upstream.stop(true));
  const relay = boundary(upstream.url.origin);
  stops.push(relay.stop);

  const forwarded = relay.loseNextUpdate();
  const response = await post(relay.url);

  expect(response.status).toBe(504);
  expect(await forwarded).toEqual({ status: 200 });
  expect(received).toEqual([`/v1/fluree/update ${JSON.stringify({ insert: [] })}`]);
  // Only the next update is lost; the one after passes through.
  expect((await post(relay.url)).status).toBe(200);
});

test("a lost acknowledgement settles when the update gets no response", async () => {
  // A port that was just released refuses the connection.
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const origin = closed.url.origin;
  closed.stop(true);
  const relay = boundary(origin);
  stops.push(relay.stop);

  const forwarded = relay.loseNextUpdate();
  const response = await post(relay.url);

  expect(response.status).toBe(504);
  const outcome = await forwarded;
  expect("failed" in outcome && outcome.failed.length > 0).toBe(true);
});

test("a lost acknowledgement settles when the upstream accepts the update and never answers", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  stops.push(() => upstream.stop(true));
  const relay = boundary(upstream.url.origin, { forwardTimeoutMs: 100 });
  stops.push(relay.stop);

  const forwarded = relay.loseNextUpdate();
  const response = await post(relay.url);

  expect(response.status).toBe(504);
  const outcome = await forwarded;
  expect("failed" in outcome && outcome.failed.length > 0).toBe(true);
});
