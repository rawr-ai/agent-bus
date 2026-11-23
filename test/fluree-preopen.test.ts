import { expect, test } from "bun:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { createFlureeLedgerOnce, flureeLedgerExists, layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { boundary } from "./fluree-boundary.ts";
import { freshLedger } from "./fluree-server.ts";

test("pre-open probe requires an explicit boolean from the authenticated exists route", async () => {
  let response = new Response();
  const seen: Array<string> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      return response;
    },
  });
  const config = { url: server.url.origin, ledger: "pre-open:main" };
  const probe = () =>
    Effect.runPromise(flureeLedgerExists(config).pipe(Effect.provide(FetchHttpClient.layer)));
  try {
    for (const invalid of [
      Response.json({}),
      Response.json({ exists: "false" }),
      new Response("broken"),
      new Response(null, { status: 503 }),
      Response.redirect(new URL("/incorrect", server.url).href, 307),
    ]) {
      response = invalid;
      await expect(probe()).rejects.toMatchObject({ _tag: "LedgerError" });
    }
    expect(seen).toEqual(Array(5).fill("GET /v1/fluree/exists/pre-open%3Amain"));
  } finally {
    server.stop(true);
  }
  await expect(probe()).rejects.toMatchObject({ _tag: "LedgerError" });
});

test.each(["created", "conflict", "lost-create", "lost-config", "wrong-reopen"] as const)(
  "one-shot creation: %s",
  async (mode) => {
    const config = await freshLedger("one-shot");
    const relay = boundary(config.url);
    const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
    try {
      if (mode === "conflict") {
        const other = await fetch(config.url + "/v1/fluree/create", {
          method: "POST",
          headers,
          body: JSON.stringify({ ledger: config.ledger }),
        });
        expect(other.status).toBe(201);
      }
      const lost =
        mode === "lost-create"
          ? relay.loseNextCreate()
          : mode === "lost-config"
            ? relay.loseNextUpdate()
            : undefined;
      const wrong =
        mode === "wrong-reopen"
          ? relay.nextPin(() => Response.json({ id: "different-first-commit" }))
          : undefined;
      const result = await Effect.runPromise(
        createFlureeLedgerOnce({ ...config, url: relay.url }).pipe(
          Effect.provide(FetchHttpClient.layer)
        )
      );
      if (wrong) await wrong;
      if (lost) expect(await lost).toEqual({ status: mode === "lost-create" ? 201 : 200 });
      expect(result.status).toBe(
        mode === "created" ? "CREATED" : mode === "conflict" ? "CONFLICT" : "UNKNOWN"
      );
      const committed = mode === "created" || mode === "lost-config" || mode === "wrong-reopen";
      expect(relay.creates()).toBe(1);
      expect(relay.updates()).toBe(committed ? 1 : 0);
      const info = await fetch(
        config.url + "/v1/fluree/info/" + encodeURIComponent(config.ledger),
        { headers }
      ).then((r) => r.json() as Promise<{ ledger: { t: number } }>);
      expect(info.ledger.t).toBe(committed ? 1 : 0);
      if (committed) {
        const first = await Effect.runPromise(
          Effect.gen(function* () {
            const ledger = yield* Ledger;
            const cut = { head: 1, incarnation: ledger.instance };
            expect(yield* ledger.ownershipEraAt(cut)).toBe(1);
            return cut;
          }).pipe(
            Effect.provide(layerFluree(config, { existingOnly: true })),
            Effect.provide(FetchHttpClient.layer)
          )
        );
        if (mode === "created") expect(result).toEqual({ status: "CREATED", cut: first });
      }
    } finally {
      relay.stop();
    }
  }
);
