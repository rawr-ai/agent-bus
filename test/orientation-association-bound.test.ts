import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import * as Bus from "../src/Bus.ts";
import { Cursors } from "../src/Cursors.ts";
import { Ledger } from "../src/Ledger.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

test("association address admission counts UTF-8 bytes without changing unassociated policy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-orientation-bound-"));
  const values = new Map<string, number>();
  let accesses = 0;
  const cursors = Layer.succeed(Cursors)(
    Cursors.of({
      get: (address) =>
        Effect.sync(() => {
          accesses += 1;
          return Option.fromNullishOr(values.get(address));
        }),
      set: (address, value) =>
        Effect.sync(() => {
          accesses += 1;
          values.set(address, value);
        }),
    })
  );
  const layer = Bus.layer.pipe(
    Layer.provideMerge(layerJsonl(join(dir, "ledger.jsonl"))),
    Layer.provideMerge(cursors),
    Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger;
        const boundary = `a/${"é".repeat(255)}`;
        const oversized = `a/${"é".repeat(256)}`;
        expect(Buffer.byteLength(boundary, "utf8")).toBe(512);
        expect(Buffer.byteLength(oversized, "utf8")).toBe(514);
        const input = { runtime: "other" as const, session: "owner", cwd: process.cwd() };
        const association = [{ directory: "project", concerns: [] }];
        expect(
          (yield* bus.join({ ...input, address: boundary, associations: association })).associations
        ).toEqual(association);
        const before = { head: yield* ledger.end, accesses };
        const refused = yield* Effect.flip(
          bus.join({ ...input, address: oversized, associations: association })
        );
        expect(refused._tag).toBe("InvalidAssociations");
        expect(yield* ledger.end).toBe(before.head);
        expect(accesses).toBe(before.accesses);
        expect((yield* bus.join({ ...input, address: oversized })).associations).toEqual([]);
      }).pipe(Effect.provide(layer))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
