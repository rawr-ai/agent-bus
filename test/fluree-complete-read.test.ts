import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Fiber, Layer, Logger, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { PRESENCE_NODES } from "../src/activity-read.ts";
import * as Bus from "../src/Bus.ts";
import { Cursors } from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { ownedAddresses } from "../src/mcp.ts";

const valid = (id: string, to = ["codex/a"]) =>
  JSON.stringify({
    id,
    ts: "2026-01-01T00:00:00Z",
    from: "other/b",
    to,
    kind: "message",
    body: id,
  });
const presence = (id: string, session: string) =>
  JSON.stringify({
    id,
    ts: "2026-01-01T00:00:00Z",
    from: "codex/a",
    to: ["*"],
    kind: "presence",
    body: "joined",
    presence: {
      runtime: "codex",
      status: "joined",
      topics: [],
      session,
      installation: "test-installation",
    },
  });
const malformed = '{"secret":"DO-NOT-LEAK"';
const invalid = JSON.stringify({ id: "DO-NOT-LEAK", kind: "message" });

/**
 * A stored presence as the pinned read returns it (`PRESENCE_NODES`): its node, the entry's and
 * the id's commits, the id, the entry and the sender, bound to the node, id and sender it names.
 */
const presenceRow = ([json, t]: readonly [string, number]) => {
  let named: { id?: unknown; from?: unknown } = {};
  try {
    named = JSON.parse(json);
  } catch {}
  return [
    `urn:agent-bus:message:${String(named.id)}`,
    t,
    t,
    typeof named.id === "string" ? named.id : null,
    json,
    typeof named.from === "string" ? named.from : null,
  ];
};

/** Only the Fluree HTTP responses are controlled; production Ledger and Bus are used. */
const fixture = () => {
  let head = 1;
  let entries: Array<readonly [string, number]> = [];
  let presences: Array<readonly [string, number]> = [];
  let inserts = 0;
  let held: (() => void) | undefined;
  const windows: Array<string> = [];
  const presenceSelects: Array<unknown> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.includes("/exists/")) return Response.json({ exists: true });
      if (path.includes("/info/")) return Response.json({ ledger: { t: head } });
      if (path.includes("/show/")) return Response.json({ id: "instance" });
      if (path.endsWith("/insert")) {
        inserts += 1;
        return Response.json({});
      }
      if (path.endsWith("/query")) {
        const query: unknown = await request.json();
        const body = JSON.stringify(query);
        // Presence is read at the cut: every typed node with its entry, id and sender.
        if (body.includes("bus:Presence")) {
          presenceSelects.push(
            typeof query === "object" && query !== null && "select" in query ? query.select : null
          );
          return Response.json(presences.map(presenceRow));
        }
        if (held !== undefined) {
          held();
          held = undefined;
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve())
          );
          return new Response(null, { status: 499 });
        }
        const bounds = [...body.matchAll(/@t:(\d+)/g)].map((m) => Number(m[1]));
        const [start = 0, end = 0] = bounds;
        windows.push(`${start}-${end}`);
        return Response.json(entries.filter(([, t]) => t >= start && t <= end));
      }
      if (path.endsWith("/events"))
        return new Response("", { headers: { "content-type": "text/event-stream" } });
      return new Response(null, { status: 404 });
    },
  });
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
  const ledger = layerFluree({ url: server.url.origin, ledger: "test:main" }).pipe(
    Layer.provide(platform)
  );
  let cursor = 0;
  let writes = 0;
  const cursors = Layer.succeed(
    Cursors,
    Cursors.of({
      get: () => Effect.sync(() => Option.some(cursor)),
      set: (_address, next) =>
        Effect.sync(() => {
          cursor = next;
          writes += 1;
        }),
      clear: () => Effect.void,
    })
  );
  const bus = Bus.layer("test-installation").pipe(
    Layer.provideMerge(ledger),
    Layer.provideMerge(cursors)
  );
  return {
    ledger,
    bus,
    set: (value: {
      head: number;
      entries: Array<readonly [string, number]>;
      presences: Array<readonly [string, number]>;
    }) => {
      head = value.head;
      entries = value.entries;
      presences = value.presences;
    },
    state: () => ({ cursor, writes, inserts, windows: [...windows] }),
    presenceSelects: () => presenceSelects,
    holdRead: () =>
      new Promise<void>((resolve) => {
        held = resolve;
      }),
    stop: () => server.stop(true),
  };
};

const expectSafe = (error: { readonly _tag: string; readonly message: string }, t: number) => {
  expect(error._tag).toBe("LedgerError");
  expect(error.message).toBe(`A ledger entry at t=${t} could not be decoded.`);
  expect(JSON.stringify(error)).not.toContain("DO-NOT-LEAK");
};

describe("complete Fluree reads", () => {
  test("fails malformed and schema-invalid entries, including a later window; valid rows remain ordered", async () => {
    const f = fixture();
    const logs: Array<string> = [];
    const capture = Logger.make(({ message }) => logs.push(String(message)));
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          f.set({
            head: 502,
            entries: [
              [valid("one"), 1],
              [malformed, 501],
            ],
            presences: [],
          });
          expectSafe(yield* Effect.flip(ledger.read(0)), 501);
          expect(f.state().windows).toEqual(["1-500", "501-502"]);
          f.set({
            head: 19,
            entries: [
              [valid("one"), 2],
              [invalid, 7],
            ],
            presences: [],
          });
          expectSafe(yield* Effect.flip(ledger.read(0)), 7);
          f.set({
            head: 2,
            entries: [
              [valid("one"), 1],
              [valid("two"), 2],
            ],
            presences: [],
          });
          const slice = yield* ledger.read(0);
          expect(slice.entries.map(({ message, end }) => [message.id, end])).toEqual([
            ["one", 1],
            ["two", 2],
          ]);
          expect(slice.next).toBe(2);
          f.set({ head: 2, entries: [], presences: [] });
          expect(yield* ledger.read(0)).toEqual({ entries: [], next: 2 });
        }).pipe(Effect.provide(Layer.mergeAll(f.ledger, Logger.layer([capture]))))
      );
      expect(logs.join("\n")).not.toContain("DO-NOT-LEAK");
    } finally {
      f.stop();
    }
  });

  test("limited owner reads and background delivery leave cursor and callbacks untouched on later damage", async () => {
    const f = fixture();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          f.set({
            head: 501,
            entries: [
              [valid("first"), 1],
              [invalid, 501],
            ],
            presences: [[presence("join", "owner"), 1]],
          });
          expectSafe(yield* Effect.flip(bus.take("codex/a", "owner", 1)), 501);
          expectSafe(yield* Effect.flip(bus.take("codex/a", "owner")), 501);
          let nudges = 0;
          let idles = 0;
          expectSafe(
            yield* Effect.flip(
              bus.deliver(
                "codex/a",
                () =>
                  Effect.sync(() => {
                    nudges += 1;
                  }),
                {
                  idle: () =>
                    Effect.sync(() => {
                      idles += 1;
                    }),
                }
              )
            ),
            501
          );
          expect({ ...f.state(), windows: undefined, nudges, idles }).toEqual({
            cursor: 0,
            writes: 0,
            inserts: 0,
            windows: undefined,
            nudges: 0,
            idles: 0,
          });
          f.set({
            head: 2,
            entries: [
              [valid("elsewhere", ["other/c"]), 1],
              [malformed, 2],
            ],
            presences: [[presence("join", "owner"), 1]],
          });
          expectSafe(
            yield* Effect.flip(
              bus.deliver(
                "codex/a",
                () =>
                  Effect.sync(() => {
                    nudges += 1;
                  }),
                {
                  idle: () =>
                    Effect.sync(() => {
                      idles += 1;
                    }),
                }
              )
            ),
            2
          );
          expectSafe(
            yield* Effect.flip(
              bus.deliver(
                "codex/a",
                () =>
                  Effect.sync(() => {
                    nudges += 1;
                  }),
                {
                  idle: () =>
                    Effect.sync(() => {
                      idles += 1;
                    }),
                }
              )
            ),
            2
          );
          expect({ cursor: f.state().cursor, writes: f.state().writes, nudges, idles }).toEqual({
            cursor: 0,
            writes: 0,
            nudges: 0,
            idles: 0,
          });
          f.set({
            head: 2,
            entries: [
              [valid("first"), 1],
              [valid("second"), 2],
            ],
            presences: [[presence("join", "owner"), 1]],
          });
          expect((yield* bus.take("codex/a", "owner", 1)).map((m) => m.id)).toEqual(["first"]);
          expect(f.state().cursor).toBe(1);
        }).pipe(Effect.provide(f.bus))
      );
    } finally {
      f.stop();
    }
  });

  test("interrupting a pending read remains interruption rather than a decode error", async () => {
    const f = fixture();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const arrived = f.holdRead();
          const fiber = yield* Effect.forkChild(ledger.read(0));
          yield* Effect.promise(() => arrived);
          yield* Fiber.interrupt(fiber);
          expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        }).pipe(Effect.provide(f.ledger))
      );
    } finally {
      f.stop();
    }
  });

  test("damaged complete presence history refuses roster, takeover and leave before mutations", async () => {
    const f = fixture();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const ledger = yield* Ledger;
          for (const damaged of [malformed, invalid]) {
            for (const { presences, t } of [
              {
                presences: [
                  [presence("old", "old"), 3],
                  [damaged, 9],
                ] as const,
                t: 9,
              },
              {
                presences: [
                  [damaged, 3],
                  [presence("new", "owner"), 8],
                ] as const,
                t: 3,
              },
            ]) {
              f.set({ head: 19, entries: [], presences: [...presences] });
              expectSafe(
                yield* Effect.flip(Effect.map(ledger.presenceAt(), (read) => read.entries)),
                t
              );
              expectSafe(yield* Effect.flip(bus.peers), t);
              expectSafe(yield* Effect.flip(ownedAddresses("owner", "codex")), t);
              expectSafe(yield* Effect.flip(bus.take("codex/a", "owner")), t);
              expectSafe(
                yield* Effect.flip(
                  bus.publish({ from: "codex/a", session: "owner", to: ["*"], body: "x" })
                ),
                t
              );
              expectSafe(
                yield* Effect.flip(
                  bus.join({ address: "codex/a", runtime: "codex", session: "owner", cwd: "." })
                ),
                t
              );
              expectSafe(
                yield* Effect.flip(
                  bus.join({
                    address: "codex/a",
                    runtime: "codex",
                    session: "owner",
                    replay: true,
                    cwd: ".",
                  })
                ),
                t
              );
              expectSafe(
                yield* Effect.flip(
                  bus.join({
                    address: "codex/unrelated",
                    runtime: "codex",
                    session: "unrelated",
                    cwd: ".",
                  })
                ),
                t
              );
              expectSafe(
                yield* Effect.flip(
                  bus.join({
                    address: "codex/a",
                    runtime: "codex",
                    session: "new",
                    takeover: "old",
                    cwd: ".",
                  })
                ),
                t
              );
              expectSafe(yield* Effect.flip(bus.leave("codex/a", "owner")), t);
              expect(f.state()).toMatchObject({ cursor: 0, writes: 0, inserts: 0 });
            }
          }
          f.set({
            head: 2,
            entries: [],
            presences: [
              [presence("old", "old"), 1],
              [presence("new", "owner"), 2],
            ],
          });
          expect((yield* bus.peers).map((p) => [p.address, p.joinId])).toEqual([
            ["codex/a", "new"],
          ]);
          expect(f.presenceSelects().length).toBeGreaterThan(0);
          expect(
            f
              .presenceSelects()
              .every((select) => JSON.stringify(select) === JSON.stringify(PRESENCE_NODES.select))
          ).toBe(true);
        }).pipe(Effect.provide(f.bus))
      );
    } finally {
      f.stop();
    }
  });
});
