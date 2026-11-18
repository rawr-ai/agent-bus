import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import * as Bus from "../src/Bus.ts";
import { layerFiles } from "../src/Cursors.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const upper = { address: "team/A", session: "upper-owner" };
const lower = { address: "team/a", session: "lower-owner" };
const sender = { address: "team/sender", session: "sender" };

for (const [idle, recipient] of [
  [upper, lower],
  [lower, upper],
] as const) {
  test(`an empty scan for ${idle.address} cannot consume ${recipient.address}'s direct mail`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bus-cursor-identity-"));
    try {
      writeFileSync(join(dir, "Case-Probe"), "");
      const caseInsensitive = existsSync(join(dir, "case-probe"));
      // Run on every filesystem; the reproducer requires a proven case-insensitive volume.
      if (process.env.AGENT_BUS_REQUIRE_CASE_INSENSITIVE === "1") {
        expect(caseInsensitive).toBe(true);
      }
      const layer = Bus.layer("fixture").pipe(
        Layer.provide(layerFiles(join(dir, "cursors"))),
        Layer.provide(layerJsonl(join(dir, "ledger.jsonl"))),
        Layer.provide(platform)
      );
      const published = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          for (const owner of [upper, lower, sender]) {
            yield* bus.join({ ...owner, runtime: "other", cwd: dir });
          }
          const { message } = yield* bus.publish({
            from: sender.address,
            session: sender.session,
            to: [recipient.address],
            body: "only for the exact recipient",
            pierce: undefined,
          });
          let scanned = false;
          yield* bus.deliver(idle.address, () => Effect.die("Unexpected wake"), {
            idle: () =>
              Effect.sync(() => {
                scanned = true;
              }),
          });
          expect(scanned).toBe(true);
          return message.id;
        }).pipe(Effect.provide(layer))
      );
      const read = (owner: typeof upper) =>
        Effect.runPromise(
          Effect.flatMap(Bus.Bus, (bus) => bus.take(owner.address, owner.session)).pipe(
            Effect.provide(layer)
          )
        );

      const names = readdirSync(join(dir, "cursors"));
      // Also distinguish the old name scheme on a case-sensitive filesystem.
      expect(names).toHaveLength(3);
      expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(3);
      // Each call reopens the same persisted ledger and cursors with a new Bus.
      expect((await read(recipient)).map(({ id }) => id)).toEqual([published]);
      expect(await read(idle)).toEqual([]);
      expect(await read(recipient)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
