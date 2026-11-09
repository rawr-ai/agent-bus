import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Context, Effect, Layer, Option } from "effect";
import * as Bus from "../src/Bus.ts";
import { Cursors } from "../src/Cursors.ts";
import { InvalidQuery } from "../src/domain.ts";
import { Ledger } from "../src/Ledger.ts";
import { updateBulletin } from "../src/Orientation.ts";
import { BULLETIN_UNIT_BYTES, bulletinView, jsonBytes } from "../src/orientation-model.ts";
import { QueryGateway } from "../src/Query.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

test("publication refuses an oversized projection even when its stored record fits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-projection-bound-"));
  const cursors = Layer.succeed(Cursors)(
    Cursors.of({
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      clear: () => Effect.void,
    })
  );
  const layer = Bus.layer("test-installation").pipe(
    Layer.provideMerge(layerJsonl(join(dir, "ledger.jsonl"))),
    Layer.provideMerge(cursors),
    Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger;
        const operation = Bun.randomUUIDv7();
        const template = {
          kind: "bulletin" as const,
          scope: { kind: "programme" as const },
          action: "publish" as const,
          body: "body",
          publisher: "",
          publishedAt: "2026-11-03T00:00:00.000Z",
          notification: "01900000-0000-7000-8000-000000000002",
          audience: ["*"],
        };
        const address = "x".repeat(BULLETIN_UNIT_BYTES - jsonBytes(template));
        const record = { ...template, publisher: address };
        expect(jsonBytes(record)).toBe(BULLETIN_UNIT_BYTES);
        expect(jsonBytes(bulletinView({ revision: operation, value: record }, 0, true))).toBe(
          BULLETIN_UNIT_BYTES + 2
        );
        yield* bus.join({ address, runtime: "other", session: "owner", cwd: process.cwd() });
        const before = yield* ledger.end;
        let writes = 0;
        const store = Ledger.of({
          ...ledger,
          readWitness: () =>
            Effect.succeed({ status: "ABSENT", cut: { head: 1, incarnation: "jsonl" } }),
          designate: () =>
            Effect.sync(() => {
              writes += 1;
              return { status: "UNKNOWN" as const };
            }),
        });
        const gateway = QueryGateway.of({
          pin: Effect.succeed({ head: 1, incarnation: "jsonl" }),
          jsonld: () => Effect.die("unexpected query"),
          sparql: () => Effect.die("unexpected query"),
        });
        const services = Context.make(Ledger, store).pipe(Context.add(QueryGateway, gateway));
        const refused = yield* Effect.flip(
          updateBulletin({
            from: address,
            session: "owner",
            operation,
            expected: null,
            scope: { kind: "programme" },
            action: "publish",
            body: "body",
          }).pipe(Effect.provide(services))
        );
        expect(refused).toBeInstanceOf(InvalidQuery);
        expect(refused.message).toContain("projected bulletin exceeds");
        expect(writes).toBe(0);
        expect(yield* ledger.end).toBe(before);
      }).pipe(Effect.provide(layer))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
