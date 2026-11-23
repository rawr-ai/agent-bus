// Cancellation around a guarded join. A join's presence and, when the address has no position,
// its mailbox start are admitted together. A refused join writes neither, even when the caller
// cancels after the refusal; a cancellation before the admission leaves both unwritten; one after
// the admission leaves both written at one commit. Runs the real Bus over the in-process JSONL
// ledger; only the admission's timing is held, and outcomes are read through a second ledger
// handle on the same file rather than from the cancelled caller.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect";
import * as Bus from "../src/Bus.ts";
import { latestPresences, Message, Origin, Presence } from "../src/domain.ts";
import { type Admission, Ledger } from "../src/Ledger.ts";
import type { MailboxState } from "../src/mailbox-model.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const address = "claude/cancelled";
const mine = "session:mine";
const sender = "claude/cancelled-sender";
const cwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

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

type Mode = "holdRefused" | "holdBeforeAdmit" | "holdAfterAdmit";

interface Gates {
  /** Resolved when the join reaches the held step. */
  readonly reached: Deferred.Deferred<void>;
  /** The held step continues once this is resolved. */
  readonly release: Deferred.Deferred<void>;
}

interface Seen {
  armed: boolean;
  /** The presence id the held join attempted. */
  attempted?: string;
  /** The admission's own answer, when the held step follows it. */
  admission?: Admission["status"];
}

/**
 * The real Bus with one seam on both guarded presence writes, armed for `mine`'s next join only.
 * `holdRefused` lands a competing presence first, lets the guarded write be refused, then holds
 * on the path that follows the refusal; `holdBeforeAdmit` holds before the write is sent;
 * `holdAfterAdmit` holds after the write is admitted.
 */
const fixture = (mode: Mode, gates: Gates, seen: Seen) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-cancel-"));
  const file = join(dir, "ledger.jsonl");
  const base = layerJsonl(file).pipe(Layer.provide(platform));
  const hold = Deferred.succeed(gates.reached, undefined).pipe(
    Effect.andThen(Deferred.await(gates.release))
  );
  const seams = Layer.effect(Ledger)(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const held = <E>(
        presence: Message,
        admit: Effect.Effect<Admission, E>
      ): Effect.Effect<Admission, E> => {
        if (!seen.armed || presence.presence?.session !== mine) return admit;
        seen.armed = false;
        seen.attempted = presence.id;
        const record = (admission: Admission) =>
          Effect.sync(() => {
            seen.admission = admission.status;
            return admission;
          });
        switch (mode) {
          case "holdBeforeAdmit":
            return hold.pipe(Effect.andThen(admit), Effect.flatMap(record));
          case "holdAfterAdmit":
            return admit.pipe(
              Effect.flatMap(record),
              Effect.tap(() => hold)
            );
          case "holdRefused":
            return ledger.append(competitor()).pipe(
              Effect.orDie,
              Effect.andThen(admit),
              Effect.flatMap(record),
              Effect.tap(() => hold)
            );
        }
      };
      return Ledger.of({
        ...ledger,
        admit: (presence, basis) => held(presence, ledger.admit(presence, basis)),
        admitWithStart: (presence, start, basis) =>
          held(presence, ledger.admitWithStart(presence, start, basis)),
      });
    })
  ).pipe(Layer.provide(base));
  const bus = ManagedRuntime.make(
    Bus.layer("test-installation").pipe(Layer.provideMerge(seams), Layer.provideMerge(base))
  );
  // An independent handle on the same ledger file: what was stored, not what the caller heard.
  const observer = ManagedRuntime.make(layerJsonl(file).pipe(Layer.provide(platform)));
  cleanups.push(async () => {
    await Promise.all([bus.dispose(), observer.dispose()]);
    rmSync(dir, { recursive: true, force: true });
  });
  return { bus, observer };
};

type Fixture = ReturnType<typeof fixture>;

/** The address's latest presence and mailbox state at a fresh cut of the observer's handle. */
const observe = (observer: Fixture["observer"]) =>
  observer.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const { entries, cut } = yield* ledger.presenceAt();
      const mailbox: MailboxState = yield* ledger.mailboxAt(address, cut);
      return {
        holder: latestPresences(entries).get(address),
        mine: entries.some((entry) => entry.presence?.session === mine),
        mailbox,
      };
    })
  );

/** A successful initial join points at its start until a position change. */
const currentStart = (state: MailboxState) =>
  state.status === "FOUND" && state.current.record.kind === "start"
    ? { operation: state.current.record.operation, t: state.current.t }
    : undefined;

/** A real holding of the address by another session that read its mail, then left. */
const priorHolding = (bus: Fixture["bus"]) =>
  bus.runPromise(
    Effect.gen(function* () {
      const b = yield* Bus.Bus;
      const earlier = "session:earlier";
      yield* b.join({ address, runtime: "claude", session: earlier, cwd });
      yield* b.join({ address: sender, runtime: "claude", session: "session:sender", cwd });
      yield* b.publish({ from: sender, session: "session:sender", to: [address], body: "read" });
      const read = yield* b.take(address, earlier);
      expect(read.map((message) => message.body)).toEqual(["read"]);
      yield* b.leave(address, earlier);
    })
  );

/** Joins as `mine`, cancels once the held step is reached, then lets the held step finish. */
const cancelAtHold = async (mode: Mode, prior = false) => {
  const gates = await Effect.runPromise(
    Effect.all({ reached: Deferred.make<void>(), release: Deferred.make<void>() })
  );
  const seen: Seen = { armed: false };
  const made = fixture(mode, gates, seen);
  // Never leave a held step waiting, even when an assertion fails first.
  cleanups.push(() => Effect.runPromise(Deferred.succeed(gates.release, undefined)).then(() => {}));
  if (prior) await priorHolding(made.bus);
  const before = await observe(made.observer);
  seen.armed = true;
  const exit = await made.bus.runPromise(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      const joining = yield* Effect.forkChild(
        bus.join({ address, runtime: "claude", session: mine, cwd })
      );
      yield* Deferred.await(gates.reached);
      // Cancel while the join is held there; nothing of it is masked, so this returns once the
      // join has stopped. Only then is the held step released.
      yield* Fiber.interrupt(joining);
      yield* Deferred.succeed(gates.release, undefined);
      return yield* Fiber.await(joining);
    })
  );
  const reached = await Effect.runPromise(Deferred.isDone(gates.reached));
  return { ...made, seen, before, after: await observe(made.observer), exit, reached };
};

describe("cancelling a guarded join", () => {
  test("cancelled after a definite refusal, an absent position stays absent", async () => {
    const result = await cancelAtHold("holdRefused");
    expect(result.reached).toBe(true);
    expect(result.seen.admission).toBe("REFUSED");
    expect(Exit.isSuccess(result.exit)).toBe(false);
    expect(result.before.mailbox).toEqual({ status: "ABSENT" });
    expect(result.after.mailbox).toEqual({ status: "ABSENT" });
    // Nothing under the attempted id: the competitor holds, and no presence of ours was stored.
    expect(result.after.holder?.presence.session).toBe("session:competitor");
    expect(result.after.mine).toBe(false);
  });

  test("cancelled after a definite refusal, a prior position is untouched", async () => {
    const result = await cancelAtHold("holdRefused", true);
    expect(result.reached).toBe(true);
    expect(result.seen.admission).toBe("REFUSED");
    expect(Exit.isSuccess(result.exit)).toBe(false);
    if (result.before.mailbox.status !== "FOUND" || result.after.mailbox.status !== "FOUND")
      throw new Error("The prior holding has no position.");
    expect(result.after.mailbox.position).toBe(result.before.mailbox.position);
    expect(result.after.mailbox.current).toEqual(result.before.mailbox.current);
    expect(result.after.holder?.presence.session).toBe("session:competitor");
    expect(result.after.mine).toBe(false);
  });

  test("cancelled before the admission, neither a presence nor a start is stored", async () => {
    const result = await cancelAtHold("holdBeforeAdmit");
    expect(result.reached).toBe(true);
    expect(result.seen.admission).toBeUndefined();
    expect(Exit.isSuccess(result.exit)).toBe(false);
    expect(result.after.mailbox).toEqual({ status: "ABSENT" });
    expect(result.after.mine).toBe(false);
    expect(result.after.holder).toBeUndefined();
  });

  test("cancelled after the admission, its presence and its start are stored at one commit", async () => {
    const result = await cancelAtHold("holdAfterAdmit");
    expect(result.reached).toBe(true);
    expect(result.seen.admission).toBe("ADMITTED");
    // The cancelled caller was not told it succeeded.
    expect(Exit.isSuccess(result.exit)).toBe(false);
    const holder = result.after.holder;
    expect(holder?.presence.session).toBe(mine);
    expect(holder?.presence.status).toBe("joined");
    expect(holder?.joinId).toBe(result.seen.attempted);
    expect(result.after.mailbox.status).toBe("FOUND");
    const start = currentStart(result.after.mailbox);
    expect(start?.operation).toBe(result.seen.attempted);
    const committed = await result.observer.runPromise(
      Effect.flatMap(Ledger, (ledger) => ledger.read(0))
    );
    const presenceEnd = committed.entries.find(
      (entry) => entry.message.id === result.seen.attempted
    )?.end;
    expect(presenceEnd).toBeDefined();
    expect(start?.t).toBe(presenceEnd);

    // The same session joining again renews its holding and adds no start.
    await result.bus.runPromise(
      Effect.flatMap(Bus.Bus, (bus) => bus.join({ address, runtime: "claude", session: mine, cwd }))
    );
    const renewed = await observe(result.observer);
    expect(renewed.holder?.presence.rejoinOf).toBe(result.seen.attempted);
    if (renewed.mailbox.status !== "FOUND" || result.after.mailbox.status !== "FOUND")
      throw new Error("The admitted join has no position.");
    expect(renewed.mailbox.position).toBe(result.after.mailbox.position);
    expect(renewed.mailbox.current).toEqual(result.after.mailbox.current);
  });
});
