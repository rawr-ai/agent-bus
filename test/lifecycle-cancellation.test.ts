// Cancellation around a guarded join. After a definite refusal the staged cursor is restored
// exactly, even when the caller cancels while the restoration runs; a cancellation during the
// admission itself leaves its outcome unknown, so the staged cursor is kept. Runs the real Bus
// over the in-process JSONL ledger and real cursor files; only the services' timing is held.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Message, Origin, Presence } from "../src/domain.ts";
import { Ledger } from "../src/Ledger.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const address = "claude/cancelled";
const cwd = process.cwd();

const competitor = () =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from: address,
    to: ["*"],
    kind: "presence",
    body: `${address} joined`,
    origin: new Origin({ host: "fixture", cwd: "/work" }),
    presence: new Presence({
      runtime: "claude",
      status: "joined",
      topics: [],
      session: "session:competitor",
    }),
  });

interface Gates {
  /** Resolved when the join reaches the held step. */
  readonly reached: Deferred.Deferred<void>;
  /** The held step continues once this is resolved. */
  readonly release: Deferred.Deferred<void>;
}

/**
 * The real Bus with two seams. `admit` lands a competing presence first, so the guarded write
 * is definitely refused, or (`holdAdmit`) waits inside the admission. The cursor service holds
 * the restoration (`clear`, or the `set` of the prior value) until released.
 */
const fixture = (mode: "holdRestore" | "holdAdmit", gates: Gates, prior?: number) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-cancel-"));
  const cursorDir = join(dir, "cursors");
  const base = Layer.mergeAll(
    layerJsonl(join(dir, "ledger.jsonl")),
    Cursors.layerFiles(cursorDir)
  ).pipe(Layer.provide(platform));
  const hold = Deferred.succeed(gates.reached, undefined).pipe(
    Effect.andThen(Deferred.await(gates.release))
  );
  const seams = Layer.effect(Ledger)(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      return Ledger.of({
        ...ledger,
        admit: (presence, basis) =>
          mode === "holdAdmit"
            ? hold.pipe(Effect.andThen(ledger.admit(presence, basis)))
            : ledger.append(competitor()).pipe(Effect.andThen(ledger.admit(presence, basis))),
      });
    })
  ).pipe(
    Layer.merge(
      Layer.effect(Cursors.Cursors)(
        Effect.gen(function* () {
          const cursors = yield* Cursors.Cursors;
          const held = <A, E>(effect: Effect.Effect<A, E>) =>
            mode === "holdRestore" ? hold.pipe(Effect.andThen(effect)) : effect;
          return Cursors.Cursors.of({
            get: cursors.get,
            // Only the restoration writes the prior value back; the staging writes another.
            set: (at, cursor) =>
              cursor === prior ? held(cursors.set(at, cursor)) : cursors.set(at, cursor),
            clear: (at) => held(cursors.clear(at)),
          });
        })
      )
    ),
    Layer.provide(base)
  );
  const layer = Bus.layer("test-installation").pipe(
    Layer.provideMerge(seams),
    Layer.provideMerge(base)
  );
  const file = join(cursorDir, `${encodeURIComponent(address)}.json`);
  return { layer, file, cursorDir };
};

const cursorIn = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

/** Joins, cancels once the held step is reached, then lets the held step finish. */
const cancelAtHold = (mode: "holdRestore" | "holdAdmit", prior?: number) =>
  Effect.gen(function* () {
    const gates = {
      reached: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    const { layer, file, cursorDir } = fixture(mode, gates, prior);
    // The prior cursor is written apart from the join's services, so no seam sees it.
    if (prior !== undefined) {
      yield* Effect.flatMap(Cursors.Cursors, (cursors) => cursors.set(address, prior)).pipe(
        Effect.provide(Cursors.layerFiles(cursorDir).pipe(Layer.provide(platform)))
      );
    }
    return yield* Effect.gen(function* () {
      const before = cursorIn(file);
      const bus = yield* Bus.Bus;
      const joining = yield* Effect.forkChild(
        bus.join({ address, runtime: "claude", session: "session:mine", cwd })
      );
      yield* Deferred.await(gates.reached);
      // Interrupting waits for any uninterruptible step, so it runs alongside the release.
      const cancelling = yield* Effect.forkChild(Fiber.interrupt(joining));
      yield* Deferred.succeed(gates.release, undefined);
      yield* Fiber.join(cancelling);
      const exit = yield* Fiber.await(joining);
      const cursors = yield* Cursors.Cursors;
      return { before, after: cursorIn(file), cursor: yield* cursors.get(address), exit };
    }).pipe(Effect.provide(layer));
  });

describe("cancelling a guarded join", () => {
  test("cancelled while restoring after a definite refusal, an absent cursor stays absent", async () => {
    const result = await Effect.runPromise(cancelAtHold("holdRestore"));
    expect(result.before).toBeUndefined();
    expect(Option.isNone(result.cursor)).toBe(true);
    expect(result.after).toBeUndefined();
  });

  test("cancelled while restoring after a definite refusal, a prior cursor is put back", async () => {
    const result = await Effect.runPromise(cancelAtHold("holdRestore", 7));
    expect(Option.getOrUndefined(result.cursor)).toBe(7);
    expect(result.after).toBe(result.before);
  });

  test("cancelled during the admission, the outcome is unknown and the staged cursor is kept", async () => {
    const result = await Effect.runPromise(cancelAtHold("holdAdmit"));
    expect(result.before).toBeUndefined();
    // A new owner's cursor was staged at the cut before the write and is not rolled back.
    expect(Option.isSome(result.cursor)).toBe(true);
  });
});
