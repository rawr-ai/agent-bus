import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import * as Bus from "../src/Bus.ts";
import { Ledger } from "../src/Ledger.ts";
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
        Layer.provideMerge(layerJsonl(join(dir, "ledger.jsonl"))),
        Layer.provide(platform)
      );
      const published = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const ledger = yield* Ledger;
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
          const cut = (yield* ledger.presenceAt()).cut;
          const before = yield* Effect.forEach([upper, lower, sender], ({ address }) =>
            ledger.mailboxAt(address, cut)
          );
          expect(before.map((state) => state.status)).toEqual(["FOUND", "FOUND", "FOUND"]);
          expect(
            new Set(
              before.flatMap((state) =>
                state.status === "FOUND" ? [state.current.record.operation] : []
              )
            ).size
          ).toBe(3);
          let scanned = false;
          yield* bus.deliver(idle.address, () => Effect.die("Unexpected wake"), {
            idle: () =>
              Effect.sync(() => {
                scanned = true;
              }),
          });
          expect(scanned).toBe(true);
          expect(yield* ledger.end).toBe(cut.head);
          return message.id;
        }).pipe(Effect.provide(layer))
      );
      const read = (owner: typeof upper) =>
        Effect.runPromise(
          Effect.flatMap(Bus.Bus, (bus) => bus.take(owner.address, owner.session)).pipe(
            Effect.provide(layer)
          )
        );

      // Each call reopens the same persisted ledger positions with a new Bus.
      expect((await read(recipient)).map(({ id }) => id)).toEqual([published]);
      expect(await read(idle)).toEqual([]);
      expect(await read(recipient)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
