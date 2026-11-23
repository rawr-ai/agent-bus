import { expect, test } from "bun:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { flureeLedgerExists } from "../src/Fluree.ts";

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
