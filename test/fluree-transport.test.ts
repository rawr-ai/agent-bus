import { expect, test } from "bun:test";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { createFlureeLedgerOnce, layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { QueryGateway } from "../src/Query.ts";

const ledger = "transport:main";
const path = `/v1/fluree/show/${encodeURIComponent(ledger)}`;
const callerInit = { redirect: "follow" as const, headers: { "x-caller-init": "preserved" } };

test.each([300, 302, 307, 308])(
  "existing-only open refuses HTTP %i without following or decoding it",
  async (status) => {
    const destinationRequests: Array<string> = [];
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        destinationRequests.push(request.url);
        return Response.json({ id: "wrong-incarnation" });
      },
    });
    const requests: Array<string> = [];
    let headerPreserved = false;
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        headerPreserved = request.headers.get("x-caller-init") === "preserved";
        return new Response(JSON.stringify({ id: "redirect-body-is-not-a-commit" }), {
          status,
          headers: { location: destination.url.href, "content-type": "application/json" },
        });
      },
    });
    let bound = false;
    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Ledger;
            bound = true;
          }).pipe(
            Effect.provide(layerFluree({ url: source.url.origin, ledger }, { existingOnly: true })),
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.RequestInit, callerInit)
          )
        )
      ).rejects.toMatchObject({
        _tag: "LedgerError",
        message: `Fluree request failed (HTTP ${status}).`,
      });
      expect(bound).toBe(false);
      expect(requests).toEqual([path]);
      expect(destinationRequests).toEqual([]);
      expect(headerPreserved).toBe(true);
      if (status === 302) {
        // The provider must not change the separately supplied fetch client.
        const independent = await Effect.runPromise(
          HttpClient.get(source.url).pipe(
            Effect.flatMap((response) => response.json),
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.RequestInit, callerInit)
          )
        );
        expect(independent).toEqual({ id: "wrong-incarnation" });
        expect(destinationRequests).toHaveLength(1);
      }
    } finally {
      source.stop(true);
      destination.stop(true);
    }
  }
);

test("a concurrent ledger creator's 409 is still accepted by ordinary open", async () => {
  const requests: Array<string> = [];
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.push(`${request.method} ${pathname}`);
      if (pathname.includes("/exists/")) return Response.json({ exists: false });
      if (pathname.endsWith("/create")) return new Response(null, { status: 409 });
      if (pathname.includes("/info/")) return Response.json({ ledger: { t: 1 } });
      if (pathname.includes("/show/")) return Response.json({ id: "first-commit" });
      return new Response(null, { status: 404 });
    },
  });
  try {
    const instance = await Effect.runPromise(
      Effect.map(Ledger, (store) => store.instance).pipe(
        Effect.provide(layerFluree({ url: source.url.origin, ledger })),
        Effect.provide(FetchHttpClient.layer)
      )
    );
    expect(instance).toBe("first-commit");
    expect(requests).toEqual([
      `GET /v1/fluree/exists/${encodeURIComponent(ledger)}`,
      "POST /v1/fluree/create",
      `GET /v1/fluree/info/${encodeURIComponent(ledger)}`,
      `GET ${path}`,
    ]);
  } finally {
    source.stop(true);
  }
});

test.each(["create", "update"] as const)(
  "one-shot creation refuses a redirect at %s without following it",
  async (redirectAt) => {
    const destinationRequests: Array<string> = [];
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        destinationRequests.push(request.url);
        return Response.json({ ledger_id: ledger, t: 0, commit: { hash: "" } }, { status: 201 });
      },
    });
    const requests: Array<string> = [];
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        requests.push(pathname);
        if (pathname.endsWith(`/${redirectAt}`)) {
          return new Response(JSON.stringify({ ledger_id: ledger, t: 0, commit: { hash: "" } }), {
            status: 307,
            headers: { location: destination.url.href, "content-type": "application/json" },
          });
        }
        return Response.json({ ledger_id: ledger, t: 0, commit: { hash: "" } }, { status: 201 });
      },
    });
    try {
      const result = await Effect.runPromise(
        createFlureeLedgerOnce({ url: source.url.origin, ledger }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.RequestInit, callerInit)
        )
      );
      expect(result).toEqual({ status: "UNKNOWN" });
      expect(requests).toEqual(
        redirectAt === "create" ? ["/v1/fluree/create"] : ["/v1/fluree/create", "/v1/fluree/update"]
      );
      expect(destinationRequests).toEqual([]);
    } finally {
      source.stop(true);
      destination.stop(true);
    }
  }
);

test("one-shot creation stays unknown when its existing-only reopen redirects", async () => {
  const destinationRequests: Array<string> = [];
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      destinationRequests.push(request.url);
      return Response.json({ id: "first-commit" });
    },
  });
  const requests: Array<string> = [];
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.push(`${request.method} ${pathname}`);
      if (pathname.endsWith("/create")) {
        return Response.json({ ledger_id: ledger, t: 0, commit: { hash: "" } }, { status: 201 });
      }
      if (pathname.endsWith("/update")) {
        return Response.json({ ledger_id: ledger, t: 1, commit: { hash: "first-commit" } });
      }
      return new Response(JSON.stringify({ id: "first-commit" }), {
        status: 307,
        headers: { location: destination.url.href, "content-type": "application/json" },
      });
    },
  });
  try {
    const result = await Effect.runPromise(
      createFlureeLedgerOnce({ url: source.url.origin, ledger }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, callerInit)
      )
    );
    expect(result).toEqual({ status: "UNKNOWN" });
    expect(requests).toEqual(["POST /v1/fluree/create", "POST /v1/fluree/update", `GET ${path}`]);
    expect(destinationRequests).toEqual([]);
  } finally {
    source.stop(true);
    destination.stop(true);
  }
});

test("an open provider refuses redirects on ordinary, bounded and guarded reads", async () => {
  const destinationRequests: Array<string> = [];
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      destinationRequests.push(request.url);
      return Response.json({ id: "other", ledger: { t: 2 }, rows: [], t: 2 });
    },
  });
  let redirected = "";
  const requests: Array<string> = [];
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.push(pathname);
      if (pathname.includes(redirected) && redirected !== "") {
        // These valid shapes would be accepted if a non-2xx body were decoded.
        const body =
          redirected === "/info/"
            ? { ledger: { t: 2 } }
            : redirected === "/show/"
              ? { id: "other" }
              : { rows: [], t: 2 };
        return new Response(JSON.stringify(body), {
          status: 307,
          headers: { location: destination.url.href, "content-type": "application/json" },
        });
      }
      if (pathname.includes("/show/")) return Response.json({ id: "first-commit" });
      return new Response(null, { status: 404 });
    },
  });
  const runtime = ManagedRuntime.make(
    layerFluree({ url: source.url.origin, ledger }, { existingOnly: true }).pipe(
      Layer.provide(FetchHttpClient.layer)
    )
  );
  const failure = { _tag: "LedgerError", message: "Fluree request failed (HTTP 307)." };
  try {
    expect(await runtime.runPromise(Effect.map(Ledger, (store) => store.instance))).toBe(
      "first-commit"
    );
    redirected = "/info/";
    await expect(
      runtime.runPromise(
        Effect.flatMap(Ledger, (store) => store.end).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, callerInit)
        )
      )
    ).rejects.toMatchObject(failure);
    redirected = "/query/";
    await expect(
      runtime.runPromise(
        Effect.flatMap(QueryGateway, (gateway) => gateway.jsonld(1, {})).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, callerInit)
        )
      )
    ).rejects.toMatchObject(failure);
    await expect(
      runtime.runPromise(
        Effect.flatMap(QueryGateway, (gateway) => gateway.sparql(1, "SELECT * WHERE {}"))
      )
    ).rejects.toMatchObject(failure);
    redirected = "/show/";
    await expect(
      runtime.runPromise(Effect.flatMap(QueryGateway, (gateway) => gateway.pin))
    ).rejects.toMatchObject(failure);
    expect(destinationRequests).toEqual([]);
    expect(requests).toHaveLength(5);
  } finally {
    await runtime.dispose();
    source.stop(true);
    destination.stop(true);
  }
});

test.each([200, 307, 308])(
  "event HTTP %i is decoded only on success and never follows a redirect",
  async (status) => {
    const destinationRequests: Array<string> = [];
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        destinationRequests.push(request.url);
        return new Response("data: unwanted\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    let notifyRequested = () => {};
    const requested = new Promise<void>((resolve) => {
      notifyRequested = resolve;
    });
    let releaseResponse = () => {};
    const released = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let eventsHadAuthorization = false;
    let eventsHadCallerHeader = false;
    let showHadProviderToken = false;
    let bodyCancelled = false;
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.includes("/show/")) {
          showHadProviderToken = request.headers.get("authorization") === "Bearer fixture-token";
          return Response.json({ id: "first-commit" });
        }
        if (pathname.endsWith("/events")) {
          eventsHadAuthorization = request.headers.has("authorization");
          eventsHadCallerHeader = request.headers.get("x-caller-init") === "preserved";
          notifyRequested();
          await released;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: unwanted\n\n"));
            },
            cancel() {
              bodyCancelled = true;
            },
          });
          return new Response(body, {
            status,
            headers: { location: destination.url.href, "content-type": "text/event-stream" },
          });
        }
        return new Response(null, { status: 404 });
      },
    });
    const entries: Array<[string, string]> = [
      ["AUTHORIZATION", "Bearer ambient-fixture"],
      ["x-caller-init", "preserved"],
    ];
    const headers: RequestInit["headers"] =
      status === 200
        ? { Authorization: "Bearer ambient-fixture", "x-caller-init": "preserved" }
        : status === 307
          ? new Headers(entries)
          : entries;
    const transport =
      status === 308
        ? Layer.effect(HttpClient.HttpClient)(
            Effect.map(HttpClient.HttpClient, (client) =>
              HttpClient.mapRequest(client, HttpClientRequest.bearerToken("transport-fixture"))
            )
          ).pipe(Layer.provide(FetchHttpClient.layer))
        : FetchHttpClient.layer;
    const runtime = ManagedRuntime.make(
      layerFluree(
        { url: source.url.origin, ledger, token: "fixture-token" },
        { existingOnly: true }
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            transport,
            Layer.succeed(FetchHttpClient.RequestInit, {
              redirect: "follow",
              headers,
            })
          )
        )
      )
    );
    let wakes = 0;
    const consumer = runtime.runFork(
      Effect.flatMap(Ledger, (store) =>
        Stream.runForEach(store.changes, () =>
          Effect.sync(() => {
            wakes++;
          })
        )
      )
    );
    try {
      await Effect.runPromise(Effect.promise(() => requested).pipe(Effect.timeout("2 seconds")));
      await Bun.sleep(100);
      const initialWakes = wakes;
      releaseResponse();
      await Bun.sleep(200);
      if (status === 200) expect(wakes).toBeGreaterThan(initialWakes);
      else expect(wakes).toBe(initialWakes);
      expect(eventsHadAuthorization).toBe(false);
      expect(eventsHadCallerHeader).toBe(true);
      expect(showHadProviderToken).toBe(true);
      expect(bodyCancelled).toBe(status !== 200);
      expect(destinationRequests).toEqual([]);
    } finally {
      releaseResponse();
      await Effect.runPromise(Fiber.interrupt(consumer));
      await runtime.dispose();
      source.stop(true);
      destination.stop(true);
    }
  }
);
