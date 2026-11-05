// Reachable inactivity on both delivery backends: the wake law, the fold's orderings, pierce and
// the bus_activity contract (docs/frames/reachable-inactivity.md, Tests A-H, K, L and the tool's
// receipts). Expectations are derived from the frame; see test/activity-support.ts for the
// sentinel that makes "rang nothing" an observation rather than a timeout.
import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { deliverOnce, type Holds } from "../src/codex.ts";
import * as Ledger from "../src/Ledger.ts";
import {
  act,
  activityOf,
  backends,
  bodies,
  busOn,
  end,
  fakeCodex,
  joinAs,
  jsonlStore,
  plain,
  programme,
  rung,
  type Serve,
  say,
  sid,
  sortedMutes,
  takeAll,
  tempDir,
  topic,
  uuid,
  withSentinel,
} from "./activity-support.ts";

const x = "claude/x";
const y = "codex/y";
const TIMEOUT = 60_000;

const within = async <A>(open: () => Promise<Serve>, effect: Parameters<Serve["run"]>[0]) => {
  const serve = await open();
  try {
    return (await serve.run(effect)) as A;
  } finally {
    await serve.dispose();
  }
};

/** An APPLIED receipt, failing the test with the actual status otherwise. */
const applied = (result: unknown) => {
  const outcome = plain(result);
  expect(outcome).toMatchObject({ status: "APPLIED" });
  return outcome;
};

for (const backend of backends) {
  const run = (effect: Parameters<Serve["run"]>[0]) => within(backend.open, effect);

  describe(`reachable inactivity: wake law (${backend.name})`, () => {
    test(
      "A. inactive: programme and topic mail ring nothing, the cursor stays and both stay readable",
      () =>
        run(
          Effect.gen(function* () {
            const cursors = yield* Cursors.Cursors;
            yield* joinAs(x, { topics: ["t"] });
            yield* withSentinel(x, y);
            yield* takeAll(x);
            applied(yield* act(x, { activity: "inactive" }));
            yield* takeAll(x);
            const before = yield* cursors.get(x);
            yield* say(y, ["*"], "programme");
            yield* say(y, ["#t"], "topic");
            expect(yield* rung(x, y)).not.toContain(x);
            expect(yield* cursors.get(x)).toEqual(before);
            expect(bodies(yield* takeAll(x))).toEqual(["programme", "topic"]);
          })
        ),
      TIMEOUT
    );

    test(
      "B. a later direct message wakes and reactivates, keeping mutes; an earlier unread one does not",
      () =>
        run(
          Effect.gen(function* () {
            const mutes = [topic("t")];
            yield* joinAs(x, { topics: ["t"] });
            yield* withSentinel(x, y);
            yield* say(y, [x], "early");
            expect(yield* rung(x, y)).toContain(x);
            applied(yield* act(x, { activity: "inactive", mutes }));
            yield* say(y, ["*"], "ambient while inactive");
            // The early direct message predates the anchor: the address stays inactive, and
            // its unchanged eligible mail does not ring again.
            expect(yield* rung(x, y)).not.toContain(x);
            expect(yield* activityOf(x, mutes)).toBe("inactive");
            yield* say(y, [x], "later");
            expect(yield* rung(x, y)).toContain(x);
            const after = applied(yield* act(x, { mutes }));
            expect(after.activity).toBe("active");
            expect(sortedMutes(after.mutes)).toEqual(sortedMutes(mutes));
            // Active again: ambient mail rings without another command.
            yield* say(y, ["*"], "ambient after");
            expect(yield* rung(x, y)).toContain(x);
            expect(bodies(yield* takeAll(x))).toEqual([
              "early",
              "ambient while inactive",
              "later",
              "ambient after",
            ]);
          })
        ),
      TIMEOUT
    );

    test(
      "G. mixed routes: one unmuted matching route wakes; direct wins over mutes and pierce",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x, { topics: ["t", "u"] });
            yield* withSentinel(x, y);
            // Active, programme muted: * alone is silent, * with an unmuted #t wakes.
            applied(yield* act(x, { mutes: [programme] }));
            yield* say(y, ["*"], "programme only");
            expect(yield* rung(x, y)).not.toContain(x);
            yield* say(y, ["*", "#t"], "programme and topic");
            expect(yield* rung(x, y)).toContain(x);
            yield* takeAll(x);
            // A topic mute covers only its topic.
            applied(yield* act(x, { mutes: [topic("t")] }));
            yield* say(y, ["#t"], "muted topic");
            expect(yield* rung(x, y)).not.toContain(x);
            yield* say(y, ["#t", "#u"], "one unmuted topic");
            expect(yield* rung(x, y)).toContain(x);
            yield* takeAll(x);
            // Inactive and programme muted: direct plus * wakes and reactivates.
            applied(yield* act(x, { activity: "inactive", mutes: [programme] }));
            yield* say(y, ["*", x], "direct and muted");
            expect(yield* rung(x, y)).toContain(x);
            expect(yield* activityOf(x, [programme])).toBe("active");
            yield* takeAll(x);
            // Inactive again: direct plus a pierce of the same address reactivates; the pierce
            // of a directly addressed recipient is dropped from the stored set.
            applied(yield* act(x, { activity: "inactive" }));
            const sent = plain(yield* say(y, [x], "direct and pierced", { pierce: [x] }));
            expect(yield* rung(x, y)).toContain(x);
            expect(yield* activityOf(x, [programme])).toBe("active");
            const ledger = yield* Ledger.Ledger;
            const stored = (yield* ledger.read(0)).entries.find(
              ({ message }) => message.id === sent.id
            );
            expect(plain(stored?.message).pierce ?? []).not.toContain(x);
          })
        ),
      TIMEOUT
    );

    test(
      "K. a compact while inactive with only topic mail rings nothing",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x, { topics: ["t"] });
            yield* withSentinel(x, y);
            applied(yield* act(x, { activity: "inactive" }));
            yield* say(y, ["#t"], "topic only");
            expect(yield* rung(x, y, true)).not.toContain(x);
            expect(yield* rung(x, y, true)).not.toContain(x);
            expect(bodies(yield* takeAll(x))).toEqual(["topic only"]);
          })
        ),
      TIMEOUT
    );
  });

  describe(`reachable inactivity: the fold's orderings (${backend.name})`, () => {
    test(
      "C. deactivate, then direct mail, then a mute-only command: active",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x);
            yield* joinAs(y, { runtime: "codex" });
            applied(yield* act(x, { activity: "inactive" }));
            yield* say(y, [x], "direct");
            const muted = applied(yield* act(x, { mutes: [programme] }));
            expect(muted.activity).toBe("active");
          })
        ),
      TIMEOUT
    );

    test(
      "C. a rejoin keeps the anchor, and races a direct message to the same result in either order",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x);
            yield* joinAs(y, { runtime: "codex" });
            applied(yield* act(x, { activity: "inactive" }));
            yield* joinAs(x);
            expect(yield* activityOf(x, [])).toBe("inactive");
            yield* say(y, [x], "after the rejoin");
            expect(yield* activityOf(x, [])).toBe("active");

            applied(yield* act(x, { activity: "inactive" }));
            yield* say(y, [x], "before the rejoin");
            yield* joinAs(x);
            expect(yield* activityOf(x, [])).toBe("active");
          })
        ),
      TIMEOUT
    );

    test(
      "C. re-deactivation moves the anchor past earlier direct mail and is never a no-op",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x);
            yield* withSentinel(x, y);
            const first = applied(yield* act(x, { activity: "inactive" }));
            yield* say(y, [x], "direct");
            expect(yield* activityOf(x, [])).toBe("active");
            yield* takeAll(x);
            const second = applied(yield* act(x, { activity: "inactive" }));
            expect(second.activity).toBe("inactive");
            expect(Number(plain(second.cut).head)).toBeGreaterThan(Number(plain(first.cut).head));
            yield* say(y, ["*"], "ambient");
            expect(yield* rung(x, y)).not.toContain(x);
            // Deactivating while already inactive still writes: it moves the anchor's t.
            const head = yield* end;
            applied(yield* act(x, { activity: "inactive" }));
            expect(yield* end).toBeGreaterThan(head);
          })
        ),
      TIMEOUT
    );

    test(
      "C. a leave and join, or a takeover, resets to active with no mutes",
      () =>
        run(
          Effect.gen(function* () {
            const bus = yield* Bus.Bus;
            yield* joinAs(x, { topics: ["t"] });
            yield* withSentinel(x, y);
            applied(yield* act(x, { activity: "inactive", mutes: [programme, topic("t")] }));
            yield* bus.leave(x, sid(x));
            yield* joinAs(x, { topics: ["t"] });
            yield* say(y, ["*"], "after rejoin from left");
            expect(yield* rung(x, y)).toContain(x);
            // An activity-only command reports the mutes it left untouched: none survive a reset.
            expect(applied(yield* act(x, { activity: "active" })).mutes).toEqual([]);

            applied(yield* act(x, { activity: "inactive", mutes: [programme] }));
            const holder = (yield* bus.peers).find((peer) => peer.address === x);
            const successor = "session:successor";
            yield* bus.join({
              address: x,
              runtime: "claude",
              session: successor,
              cwd: process.cwd(),
              takeover: holder?.joinId,
            });
            const reset = applied(yield* act(x, { activity: "active", session: successor }));
            expect(reset.mutes).toEqual([]);
          })
        ),
      TIMEOUT
    );

    test(
      "E. a replay starts a new run but keeps the anchor and the mutes",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x);
            applied(yield* act(x, { activity: "inactive", mutes: [programme] }));
            yield* joinAs(x, { replay: true });
            expect(yield* activityOf(x, [programme])).toBe("inactive");
            const kept = applied(yield* act(x, { activity: "inactive" }));
            expect(sortedMutes(kept.mutes)).toEqual(sortedMutes([programme]));
          })
        ),
      TIMEOUT
    );

    test(
      "D. a command changes neither the join id nor since, and does not re-ring",
      () =>
        run(
          Effect.gen(function* () {
            const bus = yield* Bus.Bus;
            yield* joinAs(x);
            yield* withSentinel(x, y);
            yield* say(y, [x], "unread");
            expect(yield* rung(x, y)).toContain(x);
            const before = (yield* bus.peers).find((peer) => peer.address === x);
            applied(yield* act(x, { mutes: [topic("unrelated")] }));
            applied(yield* act(x, { activity: "inactive" }));
            const after = (yield* bus.peers).find((peer) => peer.address === x);
            expect([after?.joinId, after?.since]).toEqual([before?.joinId, before?.since]);
            expect(after?.presence.rejoinOf).toBe(before?.presence.rejoinOf);
            // The same join and the same eligible unread mail: no second ring.
            expect(yield* rung(x, y)).not.toContain(x);
          })
        ),
      TIMEOUT
    );
  });

  describe(`reachable inactivity: pierce (${backend.name})`, () => {
    const w = "claude/w";
    const v = "claude/v";

    /** x inactive, w active with programme muted, v active and unmuted; all receive *. */
    const audience = Effect.gen(function* () {
      yield* joinAs(x, { topics: ["t"] });
      yield* joinAs(w, { session: sid(x) });
      yield* joinAs(v);
      yield* withSentinel(x, y);
      applied(yield* act(x, { activity: "inactive" }));
      applied(yield* act(w, { mutes: [programme], session: sid(x) }));
    });

    test(
      "H. a named pierce wakes its recipients and leaves them inactive",
      () =>
        run(
          Effect.gen(function* () {
            yield* audience;
            applied(yield* act(w, { activity: "inactive", session: sid(x) }));
            yield* say(y, ["*"], "pierced", { pierce: [x] });
            const woke = yield* rung(x, y);
            expect(woke).toContain(x);
            expect(woke).not.toContain(w);
            expect(yield* activityOf(x, [])).toBe("inactive");
          })
        ),
      TIMEOUT
    );

    test(
      "H. pierce all: without confirm nothing is sent; the digest sends exactly the confirmed set",
      () =>
        run(
          Effect.gen(function* () {
            const ledger = yield* Ledger.Ledger;
            yield* audience;
            const head = yield* end;
            const first = plain(yield* say(y, ["*"], "everyone", { pierce: "all" }));
            expect(first.status).toBe("NOT_SENT");
            // Suppressed members only: v is reachable anyway, and the sender is no recipient.
            expect([...(first.bypass as Array<string>)].sort()).toEqual([w, x].sort());
            expect(typeof first.digest).toBe("string");
            expect(yield* end).toBe(head);
            expect(yield* takeAll(x)).toEqual([]);

            const sent = plain(
              yield* say(y, ["*"], "everyone", { pierce: "all", confirm: String(first.digest) })
            );
            expect(sent.status).not.toBe("NOT_SENT");
            const stored = (yield* ledger.read(0)).entries.find(
              ({ message }) => message.id === sent.id
            );
            const pierce = plain(stored?.message).pierce;
            expect(Array.isArray(pierce) ? [...pierce].sort() : pierce).toEqual([w, x].sort());
            expect(plain(stored?.message).to).toEqual(["*"]);
            const woke = yield* rung(x, y);
            expect(woke).toContain(x);
            expect(woke).toContain(w);
            // A pierce never changes activity.
            expect(yield* activityOf(x, [])).toBe("inactive");
          })
        ),
      TIMEOUT
    );

    test(
      "H. a stale or mismatched digest returns NOT_SENT with the current set and sends nothing",
      () =>
        run(
          Effect.gen(function* () {
            yield* audience;
            const first = plain(yield* say(y, ["*"], "everyone", { pierce: "all" }));
            applied(yield* act(v, { activity: "inactive" }));
            const head = yield* end;
            const stale = plain(
              yield* say(y, ["*"], "everyone", { pierce: "all", confirm: String(first.digest) })
            );
            expect(stale.status).toBe("NOT_SENT");
            expect([...(stale.bypass as Array<string>)].sort()).toEqual([v, w, x].sort());
            expect(stale.digest).not.toBe(first.digest);
            const changed = plain(
              yield* say(y, ["*"], "a different body", {
                pierce: "all",
                confirm: String(stale.digest),
              })
            );
            expect(changed.status).toBe("NOT_SENT");
            expect(yield* end).toBe(head);
          })
        ),
      TIMEOUT
    );

    test(
      "H. directly addressed members are excluded from the bypass set; an outsider is refused",
      () =>
        run(
          Effect.gen(function* () {
            yield* audience;
            const offered = plain(yield* say(y, ["*", x], "with direct", { pierce: "all" }));
            expect(offered.status).toBe("NOT_SENT");
            expect(offered.bypass).toEqual([w]);
            // v is not subscribed to #t, so it is outside this message's audience.
            const head = yield* end;
            const refused = yield* Effect.flip(say(y, ["#t"], "topic", { pierce: [v] }));
            expect(refused).toBeDefined();
            expect(yield* end).toBe(head);
          })
        ),
      TIMEOUT
    );
  });

  describe(`bus_activity contract (${backend.name})`, () => {
    test(
      "an APPLIED receipt carries the operation, its cut, the activity and the mutes",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x);
            const operation = uuid();
            const result = applied(
              yield* act(x, { activity: "inactive", mutes: [topic("b"), programme], operation })
            );
            expect(result).toMatchObject({ operation, activity: "inactive" });
            expect(typeof plain(result.cut).head).toBe("number");
            expect(typeof plain(result.cut).incarnation).toBe("string");
            expect(sortedMutes(result.mutes)).toEqual(sortedMutes([programme, topic("b")]));
          })
        ),
      TIMEOUT
    );

    test(
      "local refusals are typed errors that write nothing",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x);
            applied(yield* act(x, { activity: "inactive" }));
            const head = yield* end;
            const never = yield* Effect.flip(act("claude/never", { activity: "inactive" }));
            expect(never._tag).toBe("NotJoined");
            const stranger = yield* Effect.flip(
              act(x, { activity: "active", session: "session:stranger" })
            );
            expect(stranger._tag).toBe("NotOwner");
            expect(yield* end).toBe(head);
          })
        ),
      TIMEOUT
    );

    test(
      "invalid input is refused before writing: nothing to change, an unknown scope, a bad operation",
      () =>
        run(
          Effect.gen(function* () {
            const bus = yield* Bus.Bus;
            yield* joinAs(x);
            applied(yield* act(x, { mutes: [] }));
            const head = yield* end;
            const call = (input: Record<string, unknown>) =>
              Effect.flip(
                bus.activity({
                  address: x,
                  session: sid(x),
                  operation: uuid(),
                  ...input,
                } as never)
              );
            yield* call({});
            yield* call({ mutes: [{ scope: "thread", thread: "m-1" }] });
            yield* call({ mutes: [{ scope: "topic" }] });
            yield* call({ activity: "asleep" });
            yield* call({ activity: "inactive", operation: "not-a-uuid" });
            yield* call({ activity: "inactive", operation: undefined });
            expect(yield* end).toBe(head);
          })
        ),
      TIMEOUT
    );

    test(
      "a retry returns the original receipt and writes nothing; normalized mutes are the same intent",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x);
            const operation = uuid();
            const first = applied(
              yield* act(x, { activity: "inactive", mutes: [topic("a"), programme], operation })
            );
            const head = yield* end;
            const again = plain(
              yield* act(x, {
                activity: "inactive",
                mutes: [programme, topic("a"), topic("a")],
                operation,
              })
            );
            expect(again).toEqual(first);
            expect(yield* end).toBe(head);
            const reused = plain(yield* act(x, { activity: "active", operation }));
            expect(reused).toMatchObject({ status: "IDENTITY_MISMATCH", operation });
            expect(yield* end).toBe(head);
          })
        ),
      TIMEOUT
    );

    test(
      "a retry after a replay returns the original receipt: intent ignores the run",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x);
            const operation = uuid();
            const first = applied(yield* act(x, { activity: "inactive", operation }));
            yield* joinAs(x, { replay: true });
            const head = yield* end;
            const again = plain(yield* act(x, { activity: "inactive", operation }));
            expect(again).toEqual(first);
            expect(yield* end).toBe(head);
          })
        ),
      TIMEOUT
    );

    test(
      "after a takeover: a recorded operation returns its receipt, an absent one is refused unwritten",
      () =>
        run(
          Effect.gen(function* () {
            const bus = yield* Bus.Bus;
            yield* joinAs(x);
            const operation = uuid();
            const first = applied(yield* act(x, { activity: "inactive", operation }));
            const holder = (yield* bus.peers).find((peer) => peer.address === x);
            yield* bus.join({
              address: x,
              runtime: "claude",
              session: "session:successor",
              cwd: process.cwd(),
              takeover: holder?.joinId,
            });
            const head = yield* end;
            expect(plain(yield* act(x, { activity: "inactive", operation }))).toEqual(first);
            expect(yield* end).toBe(head);
            const absent = yield* Effect.flip(act(x, { activity: "inactive" }));
            expect(absent._tag).toBe("NotOwner");
            expect(yield* end).toBe(head);
          })
        ),
      TIMEOUT
    );
  });
}

describe("reachable inactivity: Codex delivery", () => {
  const codexAddress = "codex/a";
  const thread = "t-1";
  const sender = "claude/b";

  /** A Codex peer on its thread, a sender, and a deliverer over a JSONL ledger with a test clock. */
  const setup = Effect.gen(function* () {
    const codex = fakeCodex();
    const holds: Holds = new Map();
    yield* joinAs(codexAddress, {
      runtime: "codex",
      session: thread,
      codexThreadId: thread,
      topics: ["t"],
    });
    yield* joinAs(sender);
    const deliver = deliverOnce(codex.openQueue, codex.daemon, hostname(), holds);
    return { ...codex, holds, deliver };
  });
  const run = <A, E>(effect: Effect.Effect<A, E, Bus.Bus | Ledger.Ledger | Cursors.Cursors>) => {
    const dir = tempDir();
    return Effect.runPromise(
      Effect.provide(
        effect,
        Layer.mergeAll(busOn(jsonlStore(`${dir}/ledger.jsonl`), dir), TestClock.layer())
      )
    );
  };

  test("L. an inactive Codex address gets no nudge and no coverage record; a direct message nudges once", () =>
    run(
      Effect.gen(function* () {
        const cursors = yield* Cursors.Cursors;
        const { waiting, holds, deliver } = yield* setup;
        applied(yield* act(codexAddress, { activity: "inactive", session: thread }));
        yield* Effect.flatMap(Bus.Bus, (bus) => bus.take(codexAddress, thread));
        const before = yield* cursors.get(codexAddress);
        yield* say(sender, ["*"], "programme");
        yield* say(sender, ["#t"], "topic");
        yield* deliver;
        expect(waiting(thread)).toEqual([]);
        expect(holds.get(codexAddress)?.covered).toBeUndefined();
        expect(yield* cursors.get(codexAddress)).toEqual(before);
        expect(Option.isSome(before)).toBe(true);

        yield* say(sender, [codexAddress], "direct");
        yield* deliver;
        yield* deliver;
        expect(waiting(thread).length).toBe(1);
        expect(bodies(yield* takeAll(codexAddress, thread))).toEqual([
          "programme",
          "topic",
          "direct",
        ]);
      })
    ));

  test("D. a command leaves the Codex hold's back-off and subagent refusal unchanged", () =>
    run(
      Effect.gen(function* () {
        const { state, waiting, holds, deliver } = yield* setup;
        yield* say(sender, [codexAddress], "hi");
        state.mode = "fail";
        yield* deliver;
        const backedOff = holds.get(codexAddress);
        expect(backedOff?.failures).toBe(1);
        applied(yield* act(codexAddress, { mutes: [topic("unrelated")], session: thread }));
        state.mode = "accept";
        yield* deliver;
        expect(waiting(thread)).toEqual([]);
        expect(holds.get(codexAddress)).toEqual(backedOff);

        // A subagent refusal belongs to the join, which a command does not change.
        yield* TestClock.adjust("1 hour");
        state.mode = "subagent";
        yield* say(sender, [codexAddress], "again");
        yield* deliver;
        expect(holds.get(codexAddress)?.refused).toBe(true);
        applied(yield* act(codexAddress, { activity: "inactive", session: thread }));
        state.mode = "accept";
        yield* say(sender, [codexAddress], "direct while refused");
        yield* deliver;
        expect(waiting(thread)).toEqual([]);
        expect(holds.get(codexAddress)?.refused).toBe(true);
      })
    ));
});

// DRA pin: explicit reactivation rings once for eligible unread mail its join's last wake mark
// does not cover (mail suppressed while inactive); mail that join was already notified of is not
// re-rung, and stays unread and readable; a fresh compact pass still rings unchanged unread mail.
for (const backend of backends) {
  const run = (effect: Parameters<Serve["run"]>[0]) => within(backend.open, effect);

  describe(`reachable inactivity: explicit reactivation and the wake mark (${backend.name})`, () => {
    test(
      "reactivation does not re-ring mail the join was already notified of; a fresh pass does",
      () =>
        run(
          Effect.gen(function* () {
            yield* joinAs(x, { topics: ["t"] });
            yield* withSentinel(x, y);
            yield* takeAll(x);
            yield* say(y, ["#t"], "already rung");
            expect(yield* rung(x, y)).toContain(x);
            // Left unread. Deactivate and reactivate with no new mail.
            applied(yield* act(x, { activity: "inactive" }));
            applied(yield* act(x, { activity: "active" }));
            expect(yield* rung(x, y)).not.toContain(x);
            expect(yield* rung(x, y, true)).toContain(x);
            expect(bodies(yield* takeAll(x))).toEqual(["already rung"]);
          })
        ),
      TIMEOUT
    );

    test(
      "reactivation rings once for mail suppressed while inactive; a mute-only command neither re-rings nor changes the join",
      () =>
        run(
          Effect.gen(function* () {
            const bus = yield* Bus.Bus;
            yield* joinAs(x, { topics: ["t"] });
            yield* withSentinel(x, y);
            yield* takeAll(x);
            yield* say(y, ["#t"], "A");
            expect(yield* rung(x, y)).toContain(x);
            applied(yield* act(x, { activity: "inactive" }));
            yield* say(y, ["#t"], "B");
            expect(yield* rung(x, y)).not.toContain(x);
            const before = (yield* bus.peers).find((peer) => peer.address === x);
            applied(yield* act(x, { activity: "active" }));
            expect(yield* rung(x, y)).toContain(x);
            expect(yield* rung(x, y)).not.toContain(x);
            applied(yield* act(x, { mutes: [topic("unrelated")] }));
            const after = (yield* bus.peers).find((peer) => peer.address === x);
            expect([after?.joinId, after?.since]).toEqual([before?.joinId, before?.since]);
            expect(yield* rung(x, y)).not.toContain(x);
            expect(bodies(yield* takeAll(x))).toEqual(["A", "B"]);
          })
        ),
      TIMEOUT
    );
  });
}
