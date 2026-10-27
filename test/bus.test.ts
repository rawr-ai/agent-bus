import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Option, Schema } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import * as Client from "../src/client.ts";
import {
  appServerQueue,
  CodexError,
  deliverOnce,
  deliveryTargets,
  formatNudge,
  type Holds,
  type Queue,
} from "../src/codex.ts";
import { Message, MessageJson, Origin, Presence } from "../src/domain.ts";
import * as Fluree from "../src/Fluree.ts";
import * as Ledger from "../src/Ledger.ts";
import * as Mcp from "../src/mcp.ts";
import * as Serve from "../src/serve.ts";
import { validateSelect } from "../src/sparql.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "agent-bus-test-"));
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);

const busOn = (ledger: Layer.Layer<Ledger.Ledger, unknown, never>, dir: string) =>
  Bus.layer.pipe(
    Layer.provideMerge(ledger),
    Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors")))
  );

const jsonl = () => {
  const dir = tempDir();
  const file = join(dir, "ledger.jsonl");
  return {
    file,
    layer: busOn(layerJsonl(file).pipe(Layer.provide(platform)), dir).pipe(Layer.provide(platform)),
  };
};

// The Fluree suites run against a throwaway in-memory server when the CLI is installed.
// Like the installed server, its data and admin APIs require a token signed by a key it trusts.
const flureeBin = Bun.which("fluree");
const flureePort = 18_500 + Math.floor(Math.random() * 400);
const flureeUrl = `http://127.0.0.1:${flureePort}`;
let flureeServer: ReturnType<typeof Bun.spawn> | undefined;
let flureeToken: string | undefined;
let ledgerCount = 0;

const command = (args: ReadonlyArray<string>, stdin?: string) => {
  const result = Bun.spawnSync([...args], {
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stderr: "ignore",
  });
  if (!result.success) throw new Error(`${args.slice(0, 3).join(" ")} failed`);
  return result.stdout.toString().trim();
};

beforeAll(async () => {
  if (flureeBin === null) return;
  const key = JSON.parse(command([flureeBin, "token", "keygen", "--format", "json"])) as {
    readonly privateKey: { readonly hex: string };
    readonly did: string;
  };
  // No subject: a token naming an identity would be held to identity policies, which deny writes.
  flureeToken = command(
    [flureeBin, "token", "create", "--private-key", "@-", "--all", "--read-all", "--write-all"],
    key.privateKey.hex
  );
  const auth = ["data", "admin"].flatMap((scope) => [
    `--${scope}-auth-mode`,
    "required",
    `--${scope}-auth-trusted-issuer`,
    key.did,
  ]);
  flureeServer = Bun.spawn(
    [
      flureeBin,
      "server",
      "run",
      "--memory",
      "--listen-addr",
      `127.0.0.1:${flureePort}`,
      "--",
    ].concat(["--cors-enabled=false", ...auth]),
    { stdout: "ignore", stderr: "ignore" }
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = await fetch(`${flureeUrl}/health`).then(
      (r) => r.ok,
      () => false
    );
    if (ready) return;
    await Bun.sleep(100);
  }
  throw new Error("fluree server did not start");
});

afterAll(() => flureeServer?.kill());

const fluree = () => {
  ledgerCount += 1;
  const config = {
    url: flureeUrl,
    ledger: `bus-test-${process.pid}-${ledgerCount}:main`,
    token: flureeToken,
  };
  return {
    config,
    layer: busOn(Fluree.layerFluree(config).pipe(Layer.provide(platform)), tempDir()).pipe(
      Layer.provide(platform)
    ),
  };
};

const backends = [
  { name: "jsonl", make: jsonl, enabled: true },
  { name: "fluree", make: fluree, enabled: flureeBin !== null },
] as const;

/**
 * Fluree 4.2.4 applies a new ledger's full-text config at its first index, so a
 * fresh ledger briefly finds nothing (or fails) for text queries. Waits until
 * a search for `word` finds something.
 */
const searchable = (bus: Bus.Bus["Service"], word: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const found = yield* Effect.option(bus.history({ query: word, limit: 1 }));
      if (found._tag === "Some" && found.value.length > 0) return;
      yield* Effect.sleep("100 millis");
    }
  });

/** Each test address's session id. */
const sid = (address: string) => `session:${address}`;

const bodies = (messages: ReadonlyArray<{ readonly body: string }>) => messages.map((m) => m.body);

for (const backend of backends) {
  const run = <A, E>(effect: Effect.Effect<A, E, Bus.Bus | Ledger.Ledger>) =>
    Effect.runPromise(Effect.provide(effect, backend.make().layer));

  describe.if(backend.enabled)(`delivery (${backend.name})`, () => {
    test("routes direct, topic and broadcast messages, never back to the sender", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "claude/a",
            runtime: "claude",
            session: sid("claude/a"),
            cwd: process.cwd(),
          });
          yield* bus.join({
            address: "codex/b",
            runtime: "codex",
            session: sid("codex/b"),
            cwd: process.cwd(),
            topics: ["reviews"],
          });
          yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["codex/b"],
            body: "direct",
          });
          yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["#reviews"],
            body: "topic",
          });
          yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["#other"],
            body: "other topic",
          });
          yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["*"],
            body: "everyone",
          });

          expect(bodies(yield* bus.take("codex/b", sid("codex/b")))).toEqual([
            "direct",
            "topic",
            "everyone",
          ]);
          expect(yield* bus.take("claude/a", sid("claude/a"))).toEqual([]);
        })
      ));

    test("take marks messages read; a limit leaves the rest unread", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "claude/a",
            runtime: "claude",
            session: sid("claude/a"),
            cwd: process.cwd(),
          });
          yield* bus.join({
            address: "codex/b",
            runtime: "codex",
            session: sid("codex/b"),
            cwd: process.cwd(),
          });
          for (const body of ["one", "two", "three"]) {
            yield* bus.publish({
              from: "claude/a",
              session: sid("claude/a"),
              to: ["codex/b"],
              body,
            });
          }
          expect(bodies(yield* bus.take("codex/b", sid("codex/b"), 2))).toEqual(["one", "two"]);
          expect(bodies(yield* bus.take("codex/b", sid("codex/b")))).toEqual(["three"]);
          expect(yield* bus.take("codex/b", sid("codex/b"))).toEqual([]);
        })
      ));

    test("new subscribers start at the present; replay and rejoin keep history", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "claude/a",
            runtime: "claude",
            session: sid("claude/a"),
            cwd: process.cwd(),
          });
          yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["*"],
            body: "before",
          });
          yield* bus.join({
            address: "codex/late",
            runtime: "codex",
            session: sid("codex/late"),
            cwd: process.cwd(),
          });
          yield* bus.join({
            address: "codex/replay",
            runtime: "codex",
            session: sid("codex/replay"),
            cwd: process.cwd(),
            replay: true,
          });
          expect(yield* bus.take("codex/late", sid("codex/late"))).toEqual([]);
          expect(bodies(yield* bus.take("codex/replay", sid("codex/replay")))).toEqual(["before"]);

          yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["codex/late"],
            body: "while away",
          });
          yield* bus.join({
            address: "codex/late",
            runtime: "codex",
            session: sid("codex/late"),
            cwd: process.cwd(),
          });
          expect(bodies(yield* bus.take("codex/late", sid("codex/late")))).toEqual(["while away"]);
        })
      ));

    test("reading requires joining, and leaving removes a peer", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const missing = yield* Effect.flip(bus.take("nobody", sid("nobody")));
          expect(missing._tag).toBe("NotJoined");

          yield* bus.join({
            address: "codex/b",
            runtime: "codex",
            session: sid("codex/b"),
            cwd: process.cwd(),
            note: "testing",
          });
          expect((yield* bus.peers).map((peer) => peer.address)).toEqual(["codex/b"]);
          yield* bus.leave("codex/b", sid("codex/b"));
          expect(yield* bus.peers).toEqual([]);
        })
      ));

    test("wait returns as soon as a message arrives, and times out empty", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "codex/b",
            runtime: "codex",
            session: sid("codex/b"),
            cwd: process.cwd(),
          });
          yield* bus.join({
            address: "claude/a",
            runtime: "claude",
            session: sid("claude/a"),
            cwd: process.cwd(),
          });
          const waiting = yield* Effect.forkChild(bus.wait("claude/a", sid("claude/a"), 10));
          yield* Effect.sleep("200 millis");
          yield* bus.publish({
            from: "codex/b",
            session: sid("codex/b"),
            to: ["claude/a"],
            body: "ping",
          });
          expect(bodies(yield* Fiber.join(waiting))).toEqual(["ping"]);
          expect(yield* bus.wait("claude/a", sid("claude/a"), 0.3)).toEqual([]);
        })
      ));
  });

  test.if(backend.enabled)(`records where each sender joined from (${backend.name})`, () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const gone = tempDir();
        yield* bus.join({
          address: "claude/a",
          runtime: "claude",
          session: sid("claude/a"),
          cwd: process.cwd(),
        });
        yield* bus.join({
          address: "claude/gone",
          runtime: "claude",
          session: sid("claude/gone"),
          cwd: gone,
        });
        rmSync(gone, { recursive: true });

        const message = yield* bus.publish({
          from: "claude/a",
          session: sid("claude/a"),
          to: ["*"],
          body: "x",
        });
        expect(message.origin?.cwd).toBe(process.cwd());
        expect(message.origin?.repo).toBe(process.cwd());
        expect(message.origin?.branch).toBeDefined();
        const [stored] = yield* bus.history({ limit: 1 });
        expect(stored?.origin).toEqual(message.origin);

        // A directory that has since disappeared records only the machine and the path.
        const fromGone = yield* bus.publish({
          from: "claude/gone",
          session: sid("claude/gone"),
          to: ["*"],
          body: "y",
        });
        expect(fromGone.origin).toEqual(new Origin({ host: hostname(), cwd: gone }));
        // A sender that never joined can't send at all.
        const anonymous = yield* Effect.flip(
          bus.publish({ from: "claude/never", session: sid("claude/never"), to: ["*"], body: "z" })
        );
        expect(anonymous._tag).toBe("NotJoined");
      })
    )
  );

  test.if(backend.enabled)(`history filters by participant and text (${backend.name})`, () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* bus.join({
          address: "claude/a",
          runtime: "claude",
          session: sid("claude/a"),
          cwd: process.cwd(),
        });
        yield* bus.join({
          address: "codex/b",
          runtime: "codex",
          session: sid("codex/b"),
          cwd: process.cwd(),
        });
        yield* bus.join({
          address: "claude/c",
          runtime: "claude",
          session: sid("claude/c"),
          cwd: process.cwd(),
        });
        yield* bus.publish({
          from: "claude/a",
          session: sid("claude/a"),
          to: ["codex/b"],
          body: "the ledger adapter is ready",
        });
        yield* bus.publish({
          from: "codex/b",
          session: sid("codex/b"),
          to: ["claude/c"],
          subject: "ledger",
          body: "noted",
        });
        yield* bus.publish({
          from: "claude/c",
          session: sid("claude/c"),
          to: ["*"],
          body: "lunch?",
        });

        expect(bodies(yield* bus.history({ limit: 10 }))).toEqual([
          "the ledger adapter is ready",
          "noted",
          "lunch?",
        ]);
        expect(bodies(yield* bus.history({ limit: 2 }))).toEqual(["noted", "lunch?"]);
        expect(bodies(yield* bus.history({ participant: "claude/c", limit: 10 }))).toEqual([
          "noted",
          "lunch?",
        ]);
        yield* searchable(bus, "ledger");
        expect(bodies(yield* bus.history({ query: "ledger", limit: 10 }))).toEqual([
          "the ledger adapter is ready",
          "noted",
        ]);
        expect(
          bodies(yield* bus.history({ query: "ledger", participant: "claude/a", limit: 10 }))
        ).toEqual(["the ledger adapter is ready"]);
      })
    )
  );
}

describe.if(flureeBin !== null)("fluree ledger", () => {
  test("ranks stemmed full-text matches, with quotes and parentheses kept literal", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "claude/a",
            runtime: "claude",
            session: sid("claude/a"),
            cwd: process.cwd(),
          });
          yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["*"],
            body: "Deploying the adapters now",
          });
          yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["*"],
            body: "unrelated",
          });
          yield* searchable(bus, "adapter");
          expect(bodies(yield* bus.history({ query: "deploy adapter", limit: 5 }))).toEqual([
            "Deploying the adapters now",
          ]);
          expect(yield* bus.history({ query: '") (bind ?x', limit: 5 })).toEqual([]);
        }),
        fluree().layer
      )
    ));

  test("a second process sees appends and is woken by the event stream", async () => {
    const first = fluree();
    const second = busOn(
      Fluree.layerFluree(first.config).pipe(Layer.provide(platform)),
      tempDir()
    ).pipe(Layer.provide(platform));
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "codex/b",
            runtime: "codex",
            session: sid("codex/b"),
            cwd: process.cwd(),
          });
        }),
        second
      )
    );
    const waiting = Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          return yield* bus.wait("codex/b", sid("codex/b"), 10);
        }),
        second
      )
    );
    await Bun.sleep(500);
    const started = Date.now();
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "claude/a",
            runtime: "claude",
            session: sid("claude/a"),
            cwd: process.cwd(),
          });
          yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["codex/b"],
            body: "across processes",
          });
        }),
        first.layer
      )
    );
    expect(bodies(await waiting)).toEqual(["across processes"]);
    // Sooner than a failed stream's reconnect (5 s) or the poll (15 s) could deliver it.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test(
    "reads span several windows of commits",
    () =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const bus = yield* Bus.Bus;
            yield* bus.join({
              address: "claude/a",
              runtime: "claude",
              session: sid("claude/a"),
              cwd: process.cwd(),
            });
            yield* bus.join({
              address: "codex/b",
              runtime: "codex",
              session: sid("codex/b"),
              cwd: process.cwd(),
            });
            const sent = Array.from({ length: 520 }, (_, i) => `m${i}`);
            yield* Effect.forEach(
              sent,
              (body) =>
                bus.publish({ from: "claude/a", session: sid("claude/a"), to: ["codex/b"], body }),
              { concurrency: 16 }
            );
            const received = bodies(yield* bus.take("codex/b", sid("codex/b")));
            expect([...received].sort()).toEqual([...sent].sort());
          }),
          fluree().layer
        )
      ),
    60_000
  );

  test("names the ledger instance by its first commit", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ledger = yield* Ledger.Ledger;
          expect(ledger.instance).toStartWith("bag");
        }),
        fluree().layer
      )
    ));

  test("a cursor ahead of the ledger fails loudly", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ledger = yield* Ledger.Ledger;
          const head = yield* ledger.end;
          const error = yield* Effect.flip(ledger.read(head + 5));
          expect(error.message).toContain("ahead of");
        }),
        fluree().layer
      )
    ));
});

describe("codex delivery text", () => {
  test("lists every message and how to reply to the first", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "claude/a",
            runtime: "claude",
            session: sid("claude/a"),
            cwd: process.cwd(),
          });
          const first = yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["codex/b"],
            subject: "s",
            body: "one",
          });
          const second = yield* bus.publish({
            from: "claude/a",
            session: sid("claude/a"),
            to: ["codex/b"],
            body: "two",
          });
          const text = Client.formatDelivery("codex/b", [first, second]);
          expect(text).toStartWith("[agent-bus] 2 new messages for codex/b");
          expect(text).toContain("subject: s");
          expect(text).toContain(`replyTo "${first.id}"`);
        }),
        jsonl().layer
      )
    ));
});

describe("codex delivery routing", () => {
  test("presences from earlier versions, which recorded where a thread ran, still decode", async () => {
    const earlier = JSON.stringify({
      id: "m-1",
      ts: new Date().toISOString(),
      from: "codex/a",
      to: ["*"],
      kind: "presence",
      body: "codex/a joined",
      presence: {
        runtime: "codex",
        status: "joined",
        topics: [],
        codexThreadId: "t-1",
        codexHost: "daemon",
      },
    });
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(MessageJson)(earlier));
    expect(decoded.presence?.codexThreadId).toBe("t-1");
    // So does an earlier server's join result.
    const joined = await Effect.runPromise(
      Schema.decodeUnknownEffect(Mcp.Joined)({ address: "codex/a", cursor: 3, codexHost: "other" })
    );
    expect(joined).toEqual({ address: "codex/a", cursor: 3 });
  });

  test("each machine's deliverer wakes only the Codex peers that joined from it", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const ledger = yield* Ledger.Ledger;
          yield* bus.join({
            address: "codex/here",
            runtime: "codex",
            session: sid("codex/here"),
            cwd: process.cwd(),
            codexThreadId: sid("codex/here"),
          });
          yield* bus.join({
            address: "codex/no-thread",
            runtime: "codex",
            session: sid("codex/no-thread"),
            cwd: process.cwd(),
          });
          yield* bus.join({
            address: "claude/here",
            runtime: "claude",
            session: sid("claude/here"),
            cwd: process.cwd(),
          });
          yield* ledger.append(
            new Message({
              id: Bun.randomUUIDv7(),
              ts: new Date().toISOString(),
              from: "codex/there",
              to: ["*"],
              kind: "presence",
              body: "codex/there joined",
              origin: new Origin({ host: "Other-Machine.local" }),
              presence: new Presence({
                runtime: "codex",
                status: "joined",
                topics: [],
                session: "t-there",
                codexThreadId: "t-there",
              }),
            })
          );
          const peers = yield* bus.peers;
          const local = hostname().split(".")[0]?.toUpperCase() ?? "";
          expect(deliveryTargets(peers, `${local}.lan`).map((p) => p.address)).toEqual([
            "codex/here",
          ]);
          expect(deliveryTargets(peers, "other-machine").map((p) => p.address)).toEqual([
            "codex/there",
          ]);
        }),
        jsonl().layer
      )
    ));
});

describe("codex delivery", () => {
  /**
   * Codex thread queues: each thread's waiting items, in order. `queue` makes
   * every request fail, makes an add land and then report a failure, as a
   * timed-out request might, or refuses adds as a subagent's queue does.
   * `opened` counts the app-servers started.
   */
  const fakeQueue = () => {
    const items = new Map<string, Array<string>>();
    const queueState = {
      queue: "accept" as "accept" | "fail" | "lands, then fails" | "subagent" | "hangs",
      opened: 0,
      listing: false,
    };
    const waiting = (threadId: string) => items.get(threadId) ?? [];
    const fail = (method: string, message = "no answer within 2 seconds") =>
      Effect.fail(new CodexError({ method, message }));
    const queue: Queue = {
      list: (threadId) => {
        if (queueState.queue === "fail") return fail("thread/queue/list");
        if (queueState.queue === "hangs") {
          return Effect.sync(() => {
            queueState.listing = true;
          }).pipe(Effect.andThen(Effect.never));
        }
        return Effect.succeed(waiting(threadId));
      },
      add: (threadId, text) => {
        if (queueState.queue === "fail") return fail("thread/queue/add");
        if (queueState.queue === "subagent") {
          return fail(
            "thread/queue/add",
            "direct app-server input is not allowed for unloaded spawned sub-agents"
          );
        }
        items.set(threadId, [...waiting(threadId), text]);
        return queueState.queue === "lands, then fails" ? fail("thread/queue/add") : Effect.void;
      },
    };
    const openQueue = Effect.sync(() => {
      queueState.opened += 1;
      return queue;
    });
    /** Whichever app-server has the thread loaded runs its next waiting item. */
    const runNext = (threadId: string) => items.set(threadId, waiting(threadId).slice(1));
    return { openQueue, waiting, runNext, queueState };
  };

  /** A Codex peer `codex/a` on thread t-1 with one message from `claude/b`, and a deliverer for it. */
  const setup = Effect.gen(function* () {
    const bus = yield* Bus.Bus;
    const queued = fakeQueue();
    const holds: Holds = new Map();
    const deliverer = (state: Holds) => deliverOnce(queued.openQueue, hostname(), state);
    const join = bus.join({
      address: "codex/a",
      runtime: "codex",
      session: "t-1",
      cwd: process.cwd(),
      codexThreadId: "t-1",
    });
    yield* join;
    yield* bus.join({
      address: "claude/b",
      runtime: "claude",
      session: sid("claude/b"),
      cwd: process.cwd(),
    });
    const send = (body: string) =>
      bus.publish({ from: "claude/b", session: sid("claude/b"), to: ["codex/a"], body });
    yield* send("hi");
    return {
      bus,
      ...queued,
      holds,
      deliver: deliverer(holds),
      /** A deliverer that has just started, as after a restart. */
      restarted: deliverer(new Map()),
      join,
      send,
    };
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Bus.Bus>) =>
    Effect.runPromise(Effect.provide(effect, Layer.merge(jsonl().layer, TestClock.layer())));

  test("a Codex thread is nudged with none of its mail, and its messages stay unread", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, deliver } = yield* setup;
        yield* bus.publish({
          from: "claude/b",
          session: sid("claude/b"),
          to: ["codex/a"],
          subject: "private subject",
          body: "private body",
        });
        yield* deliver;
        expect(waiting("t-1")).toEqual([formatNudge("codex/a")]);
        const text = waiting("t-1")[0] ?? "";
        expect(text).toStartWith('[agent-bus] New messages for "codex/a".');
        for (const leaked of ["private", "claude/b"]) expect(text).not.toContain(leaked);
        expect(bodies(yield* bus.take("codex/a", "t-1"))).toEqual(["hi", "private body"]);
      })
    ));

  test("more mail while a nudge waits adds nothing, and starts no app-server once covered", () =>
    run(
      Effect.gen(function* () {
        const { waiting, queueState, deliver, send } = yield* setup;
        yield* deliver;
        yield* send("two");
        yield* deliver;
        expect(queueState.opened).toBe(2);
        yield* deliver;
        expect(queueState.opened).toBe(2);
        expect(waiting("t-1").length).toBe(1);
      })
    ));

  test("once the nudge has run, only mail it didn't cover, or a partial read, is nudged again", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, runNext, deliver, send } = yield* setup;
        yield* deliver;
        runNext("t-1");
        // The thread didn't read: nothing new, so no nudge.
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);
        // New mail arrives: one nudge.
        yield* send("two");
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);

        // The thread reads part of it: the rest is nudged.
        runNext("t-1");
        expect(bodies(yield* bus.take("codex/a", "t-1", 1))).toEqual(["hi"]);
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        // It reads everything: nothing more.
        runNext("t-1");
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);
      })
    ));

  test("mail read another way while a nudge waits, then new mail, adds nothing", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, deliver, send } = yield* setup;
        yield* deliver;
        for (const body of ["two", "three"]) {
          // The owner reads mid-turn; the nudge still waits.
          yield* bus.take("codex/a", "t-1");
          yield* send(body);
          yield* deliver;
        }
        expect(waiting("t-1").length).toBe(1);
      })
    ));

  test("an add that lands but reports failure is retried without a second nudge", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, queueState, holds, deliver } = yield* setup;
        queueState.queue = "lands, then fails";
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        expect(holds.get("codex/a")?.failures).toBe(1);

        queueState.queue = "accept";
        yield* TestClock.adjust("30 seconds");
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        expect(holds.get("codex/a")?.failures).toBe(0);
        expect(bodies(yield* bus.take("codex/a", "t-1"))).toEqual(["hi"]);
      })
    ));

  test("a failing queue leaves the mail unread and is retried after a delay doubling to five minutes", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, queueState, holds, deliver } = yield* setup;
        queueState.queue = "fail";
        const delays: Array<number> = [];
        for (const _ of [1, 2, 3, 4, 5, 6]) {
          yield* deliver;
          const now = yield* Clock.currentTimeMillis;
          const delay = (holds.get("codex/a")?.until ?? 0) - now;
          delays.push(delay / 1000);
          // Nothing is tried again before the delay is up.
          yield* TestClock.adjust(delay - 1);
          yield* deliver;
          yield* TestClock.adjust(1);
        }
        expect(delays).toEqual([30, 60, 120, 240, 300, 300]);
        expect(queueState.opened).toBe(6);

        queueState.queue = "accept";
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        expect(holds.get("codex/a")?.failures).toBe(0);
        expect(bodies(yield* bus.take("codex/a", "t-1"))).toEqual(["hi"]);
      })
    ));

  test("a queue that never answers is cut off at the nudge's deadline, holding the owner's read until then", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, queueState, holds, deliver } = yield* setup;
        queueState.queue = "hangs";
        const nudging = yield* Effect.forkChild(deliver);
        while (!queueState.listing) yield* Effect.promise(() => Bun.sleep(5));
        const read = yield* Effect.forkChild(bus.take("codex/a", "t-1"));
        yield* Effect.promise(() => Bun.sleep(20));
        expect(read.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(nudging);
        expect(holds.get("codex/a")?.failures).toBe(1);
        expect(waiting("t-1")).toEqual([]);
        expect(bodies(yield* Fiber.join(read))).toEqual(["hi"]);
      })
    ));

  test("a rejoin by the same owner while its nudge waits adds nothing", () =>
    run(
      Effect.gen(function* () {
        const { waiting, deliver, join } = yield* setup;
        yield* deliver;
        yield* join;
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
      })
    ));

  test("a restart with a nudge waiting adds nothing", () =>
    run(
      Effect.gen(function* () {
        const { waiting, deliver, restarted } = yield* setup;
        yield* deliver;
        yield* restarted;
        expect(waiting("t-1").length).toBe(1);
      })
    ));

  test("a nudge belongs to its address's owner: leaving stops it, a takeover nudges the new one", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, runNext, deliver, join, send } = yield* setup;
        yield* deliver;
        runNext("t-1");
        yield* bus.leave("codex/a", "t-1");
        yield* send("while away");
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);

        // The owner rejoining keeps its unread mail, and gets one nudge for it.
        yield* join;
        yield* deliver;
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);

        const holder = (yield* bus.peers).find((peer) => peer.address === "codex/a");
        yield* bus.join({
          address: "codex/a",
          runtime: "codex",
          session: "t-2",
          cwd: process.cwd(),
          codexThreadId: "t-2",
          takeover: holder?.joinId,
        });
        yield* deliver;
        expect([waiting("t-1").length, waiting("t-2").length]).toEqual([1, 1]);
        expect(bodies(yield* bus.take("codex/a", "t-2"))).toEqual(["hi", "while away"]);
      })
    ));

  test("a subagent, whose queue refuses input, is not nudged again until it rejoins", () =>
    run(
      Effect.gen(function* () {
        const { bus, queueState, holds, deliver, join } = yield* setup;
        queueState.queue = "subagent";
        yield* deliver;
        yield* TestClock.adjust("1 hour");
        yield* deliver;
        expect(queueState.opened).toBe(1);
        expect(holds.get("codex/a")?.refused).toBe(true);

        yield* join;
        yield* deliver;
        expect(queueState.opened).toBe(2);
        expect(bodies(yield* bus.take("codex/a", "t-1"))).toEqual(["hi"]);
      })
    ));
});

describe("codex app-server queue", () => {
  /**
   * A stand-in `codex` whose `app-server` speaks JSON-RPC on stdio. It records
   * each request it receives, and answers as `mode` says.
   */
  const fakeCodex = (
    mode: "answers" | "pages" | "loops" | "asks" | "refuses" | "silent" | "stubborn"
  ) => {
    const dir = tempDir();
    const bin = join(dir, "codex");
    const log = join(dir, "requests");
    const pidFile = join(dir, "pid");
    writeFileSync(
      bin,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
// A stubborn server outlives the end of its input.
if (mode === "stubborn") setInterval(() => {}, 1000);
const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n");
for await (const line of console) {
  if (line.trim() === "") continue;
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, line + "\\n");
  if (message.id === undefined) continue;
  if (message.method === "initialize") reply(message.id, { result: {} });
  else if (mode === "silent" || mode === "stubborn") continue;
  else if (mode === "refuses") reply(message.id, { error: { code: -32603, message: "no rollout found for thread id " + message.params.threadId } });
  else if (mode === "pages" && message.method === "thread/queue/list") reply(message.id, { result: message.params.cursor === "p2" ? { data: [{ id: "q2", input: [{ type: "text", text: "second page", text_elements: [] }] }], nextCursor: null } : { data: [{ id: "q1", input: [{ type: "text", text: "first page", text_elements: [] }] }], nextCursor: "p2" } });
  else if (mode === "loops" && message.method === "thread/queue/list") reply(message.id, { result: { data: [], nextCursor: "again" } });
  else if (mode === "asks" && message.method === "thread/queue/list") {
    // A request of the server's own that happens to reuse the pending id is not the reply.
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, method: "item/requestApproval", params: {} }) + "\\n");
    reply(message.id, { result: { data: [], nextCursor: null } });
  }
  else if (message.method === "thread/queue/list") reply(message.id, { result: { data: [{ id: "q1", clientUserMessageId: "c1", input: [{ type: "text", text: "waiting", text_elements: [] }] }, { id: "q2", input: [{ type: "image", url: 7 }] }, { id: "q3" }], nextCursor: null } });
  else reply(message.id, { result: { queuedSubmission: { id: "q2", clientUserMessageId: message.params.clientUserMessageId, input: message.params.input } } });
}
`
    );
    chmodSync(bin, 0o755);
    const requests = () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    const pid = () => Number(readFileSync(pidFile, "utf8"));
    return { bin, requests, pid };
  };

  const withQueue = <A>(bin: string, use: (queue: Queue) => Effect.Effect<A, CodexError>) =>
    Effect.runPromise(
      Effect.result(Effect.scoped(Effect.flatMap(appServerQueue(bin, Duration.seconds(1)), use)))
    );

  test("lists and adds through an experimental app-server session", async () => {
    const codex = fakeCodex("answers");
    const result = await withQueue(codex.bin, (queue) =>
      Effect.gen(function* () {
        const listed = yield* queue.list("t-1");
        yield* queue.add("t-1", "read your mail");
        return listed;
      })
    );
    // Items of shapes it doesn't know read as no text rather than failing the list.
    expect(result._tag === "Success" && result.success).toEqual(["waiting", "", ""]);
    const [initialize, initialized, list, add] = codex.requests();
    expect(initialize?.params?.capabilities).toEqual({ experimentalApi: true });
    expect(initialized?.method).toBe("initialized");
    expect(list?.params).toEqual({ threadId: "t-1", limit: 100, cursor: null });
    expect(add?.params?.threadId).toBe("t-1");
    expect(add?.params?.input).toEqual([
      { type: "text", text: "read your mail", text_elements: [] },
    ]);
  });

  test("a listing follows every page", async () => {
    const codex = fakeCodex("pages");
    const result = await withQueue(codex.bin, (queue) => queue.list("t-1"));
    expect(result._tag === "Success" && result.success).toEqual(["first page", "second page"]);
    expect(codex.requests().map((request) => request.params?.cursor)).toEqual([
      undefined,
      undefined,
      null,
      "p2",
    ]);
  });

  test("a listing that never ends fails rather than holding the lock to the deadline", async () => {
    const result = await withQueue(fakeCodex("loops").bin, (queue) => queue.list("t-1"));
    expect(result._tag === "Failure" && result.failure.message).toContain("didn't end");
  });

  test("a request from the app-server that reuses a pending id is not taken for the reply", async () => {
    const result = await withQueue(fakeCodex("asks").bin, (queue) => queue.list("t-1"));
    expect(result._tag === "Success" && result.success).toEqual([]);
  });

  test("a refusal is a failure that carries the app-server's message", async () => {
    const result = await withQueue(fakeCodex("refuses").bin, (queue) => queue.list("t-1"));
    expect(result._tag === "Failure" && result.failure.message).toContain("no rollout found");
  });

  test("an app-server that never answers is stopped at the deadline and ended", async () => {
    const codex = fakeCodex("silent");
    const started = Date.now();
    const result = await withQueue(codex.bin, (queue) => queue.list("t-1"));
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result._tag === "Failure" && result.failure.message).toContain("no answer within");
    expect(codex.requests().map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/queue/list",
    ]);
  });

  test("an app-server that outlives the end of its input is killed before the session ends", async () => {
    const codex = fakeCodex("stubborn");
    const result = await withQueue(codex.bin, (queue) => queue.list("t-1"));
    expect(result._tag).toBe("Failure");
    expect(() => process.kill(codex.pid(), 0)).toThrow();
  });

  test("a missing CLI is a failure, not a crash", async () => {
    const result = await withQueue(join(tempDir(), "missing"), (queue) => queue.list("t-1"));
    expect(result._tag).toBe("Failure");
  });
});

describe("sparql validation", () => {
  const check = (query: string) => Effect.runPromise(Effect.result(validateSelect(query)));

  test("accepts a SELECT with the bus prefixes predeclared, and drops caller comments", async () => {
    const result = await check(
      '# PRAGMA union-default-graph: true\nSELECT ?b WHERE { ?m a bus:Message ; bus:body ?b . BIND(f:fulltext(?b, "x") AS ?s) } LIMIT 1'
    );
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success).toContain("PREFIX bus: <https://rawr.ai/ns/agent-bus#>");
      expect(result.success).not.toContain("PRAGMA");
    }
  });

  test.each([
    ["an update", "INSERT DATA { <urn:a> <urn:b> 1 }"],
    ["CONSTRUCT", "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"],
    ["FROM", "SELECT * FROM <other:main> WHERE { ?s ?p ?o }"],
    ["FROM NAMED", "SELECT * FROM NAMED <other:main> WHERE { GRAPH ?g { ?s ?p ?o } }"],
    ["SERVICE", "SELECT * WHERE { SERVICE <other:main> { ?s ?p ?o } }"],
    ["SERVICE in a subquery", "SELECT * WHERE { { SELECT ?s WHERE { SERVICE ?l { ?s ?p ?o } } } }"],
    ["invalid syntax", "SELECT WHERE"],
    ["an empty query", "  "],
  ])("rejects %s", async (_name, query) => {
    expect((await check(query))._tag).toBe("Failure");
  });
});

describe("one address at a time", () => {
  /** Starts a nudge for `address` that holds its batch until `release` completes. */
  const heldDelivery = (bus: Bus.Bus["Service"], address: string) =>
    Effect.gen(function* () {
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        bus.deliver(address, () =>
          Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release)))
        )
      );
      yield* Deferred.await(holding);
      return { fiber, release };
    });

  test("a read during a nudge waits for it, and the nudge marks nothing read", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "claude/b",
            runtime: "claude",
            session: sid("claude/b"),
            cwd: process.cwd(),
          });
          yield* bus.join({
            address: "codex/a",
            runtime: "codex",
            session: sid("codex/a"),
            cwd: process.cwd(),
          });
          yield* bus.publish({
            from: "claude/b",
            session: sid("claude/b"),
            to: ["codex/a"],
            body: "once",
          });
          const { fiber, release } = yield* heldDelivery(bus, "codex/a");
          const read = yield* Effect.forkChild(bus.take("codex/a", sid("codex/a")));
          yield* Effect.promise(() => Bun.sleep(20));
          expect(read.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          expect(bodies(yield* Fiber.join(read))).toEqual(["once"]);
        }),
        jsonl().layer
      )
    ));

  test("with nothing for the subscriber, a nudge passes over only what isn't its mail", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const ledger = yield* Ledger.Ledger;
          const cursors = yield* Cursors.Cursors;
          yield* bus.join({
            address: "codex/a",
            runtime: "codex",
            session: sid("codex/a"),
            cwd: process.cwd(),
            topics: ["t"],
          });
          // A presence, its own send (even to its topic), and mail for someone else.
          yield* bus.join({
            address: "claude/b",
            runtime: "claude",
            session: sid("claude/b"),
            cwd: process.cwd(),
          });
          yield* bus.publish({ from: "codex/a", session: sid("codex/a"), to: ["#t"], body: "own" });
          yield* bus.publish({
            from: "claude/b",
            session: sid("claude/b"),
            to: ["claude/c"],
            body: "elsewhere",
          });
          let nudged = 0;
          const nudge = () =>
            Effect.sync(() => {
              nudged += 1;
            });
          yield* bus.deliver("codex/a", nudge);
          expect(nudged).toBe(0);
          expect(yield* cursors.get("codex/a")).toEqual(Option.some(yield* ledger.end));

          yield* bus.publish({
            from: "claude/b",
            session: sid("claude/b"),
            to: ["#t"],
            body: "topic",
          });
          const before = yield* cursors.get("codex/a");
          yield* bus.deliver("codex/a", nudge);
          expect(nudged).toBe(1);
          expect(yield* cursors.get("codex/a")).toEqual(before);
          expect(bodies(yield* bus.take("codex/a", sid("codex/a")))).toEqual(["topic"]);
        }),
        jsonl().layer
      )
    ));

  test("a replay waits for a nudge in progress, then rewinds past mail already read", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({
            address: "claude/b",
            runtime: "claude",
            session: sid("claude/b"),
            cwd: process.cwd(),
          });
          yield* bus.join({
            address: "codex/a",
            runtime: "codex",
            session: sid("codex/a"),
            cwd: process.cwd(),
          });
          const send = (body: string) =>
            bus.publish({ from: "claude/b", session: sid("claude/b"), to: ["codex/a"], body });
          yield* send("earlier");
          expect(bodies(yield* bus.take("codex/a", sid("codex/a")))).toEqual(["earlier"]);
          yield* send("again");
          const { fiber, release } = yield* heldDelivery(bus, "codex/a");
          const rejoin = yield* Effect.forkChild(
            bus.join({
              address: "codex/a",
              runtime: "codex",
              session: sid("codex/a"),
              cwd: process.cwd(),
              replay: true,
            })
          );
          yield* Effect.promise(() => Bun.sleep(20));
          expect(rejoin.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          yield* Fiber.join(rejoin);
          expect(bodies(yield* bus.take("codex/a", sid("codex/a")))).toEqual(["earlier", "again"]);
        }),
        jsonl().layer
      )
    ));

  test("a nudge for a peer that has left does nothing; one whose cursor is missing still fails", () => {
    const store = jsonl();
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          let nudged = 0;
          const nudge = () =>
            Effect.sync(() => {
              nudged += 1;
            });
          yield* bus.join({
            address: "claude/b",
            runtime: "claude",
            session: sid("claude/b"),
            cwd: process.cwd(),
          });
          for (const address of ["codex/gone", "codex/lost"]) {
            yield* bus.join({
              address,
              runtime: "codex",
              session: sid(address),
              cwd: process.cwd(),
            });
            yield* bus.publish({
              from: "claude/b",
              session: sid("claude/b"),
              to: [address],
              body: "hi",
            });
          }
          yield* bus.leave("codex/gone", sid("codex/gone"));
          yield* bus.deliver("codex/gone", nudge);

          rmSync(join(store.file, "..", "cursors", `${encodeURIComponent("codex/lost")}.json`));
          const lost = yield* Effect.flip(bus.deliver("codex/lost", nudge));
          expect([lost._tag, nudged]).toEqual(["NotJoined", 0]);
        }),
        store.layer
      )
    );
  });
});

describe("one session per address", () => {
  const cwd = process.cwd();
  const run = <A, E>(effect: Effect.Effect<A, E, Bus.Bus | Ledger.Ledger | Cursors.Cursors>) =>
    Effect.runPromise(Effect.provide(effect, jsonl().layer));

  /**
   * Runs `refused` and checks it failed with `tag` without touching the
   * ledger, anyone's presence, or `address`'s cursor.
   */
  const unchanged = <E extends { readonly _tag: string; readonly message: string }>(
    address: string,
    refused: Effect.Effect<unknown, E, never>,
    tag = "NotOwner"
  ) =>
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      const ledger = yield* Ledger.Ledger;
      const cursors = yield* Cursors.Cursors;
      const snapshot = Effect.all({
        end: ledger.end,
        peers: bus.peers,
        cursor: cursors.get(address),
      });
      const before = yield* snapshot;
      const error = yield* Effect.flip(refused);
      expect(error._tag).toBe(tag);
      expect(yield* snapshot).toEqual(before);
      return error;
    });

  /**
   * Holds `address`'s delivery lock until `release` completes, with a
   * delivery of a message sent to it for the purpose.
   */
  const holdLock = (bus: Bus.Bus["Service"], address: string) =>
    Effect.gen(function* () {
      yield* bus.join({ address: "claude/sender", runtime: "claude", session: "sender", cwd });
      yield* bus.publish({ from: "claude/sender", session: "sender", to: [address], body: "held" });
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        bus.deliver(address, () =>
          Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release)))
        )
      );
      yield* Deferred.await(holding);
      return { fiber, release };
    });

  /** A join or leave written without an owner, as a bus from before owners wrote them. */
  const ownerless = (address: string, presence: Partial<Presence> = {}) =>
    Effect.gen(function* () {
      const message = new Message({
        id: Bun.randomUUIDv7(),
        ts: new Date().toISOString(),
        from: address,
        to: ["*"],
        kind: "presence",
        body: `${address} ${presence.status ?? "joined"}`,
        origin: new Origin({ host: hostname(), cwd }),
        presence: new Presence({ runtime: "claude", status: "joined", topics: [], ...presence }),
      });
      yield* (yield* Ledger.Ledger).append(message);
      return message.id;
    });

  test("a second session can't join, read, wait on or send as an address another holds", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* bus.join({
          address: "claude/site",
          runtime: "claude",
          session: "s1",
          cwd,
          note: "story",
        });
        yield* bus.join({ address: "codex/director", runtime: "codex", session: "t-dir", cwd });
        yield* bus.publish({
          from: "codex/director",
          session: "t-dir",
          to: ["claude/site"],
          body: "reply",
        });

        const joining = yield* unchanged(
          "claude/site",
          bus.join({ address: "claude/site", runtime: "claude", session: "s2", cwd })
        );
        expect(joining.message).toContain('note "story"');
        expect(joining.message).toContain("join one specific to this session");
        yield* unchanged("claude/site", bus.take("claude/site", "s2"));
        yield* unchanged("claude/site", bus.wait("claude/site", "s2", 0.2));
        yield* unchanged(
          "claude/site",
          bus.publish({ from: "claude/site", session: "s2", to: ["codex/director"], body: "x" })
        );
        yield* unchanged("claude/site", bus.leave("claude/site", "s2"));
        // The same id under another runtime is another session.
        yield* unchanged(
          "claude/site",
          bus.join({ address: "claude/site", runtime: "codex", session: "s1", cwd })
        );

        expect(bodies(yield* bus.take("claude/site", "s1"))).toEqual(["reply"]);
      })
    ));

  test("calls without a usable session id are refused", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        for (const session of [
          undefined,
          "",
          "  ",
          "${CLAUDE_CODE_SESSION_ID}",
          "$CODEX_THREAD_ID",
        ]) {
          const error = yield* unchanged(
            "claude/a",
            bus.join({ address: "claude/a", runtime: "claude", session, cwd })
          );
          expect(error.message).toContain("CLAUDE_CODE_SESSION_ID");
        }
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "s1", cwd });
        yield* unchanged("claude/a", bus.take("claude/a", undefined));
        yield* unchanged(
          "claude/a",
          bus.publish({ from: "claude/a", session: "", to: ["*"], body: "x" })
        );
        // A Codex thread is woken at its own id, so it can't name another.
        yield* unchanged(
          "codex/a",
          bus.join({
            address: "codex/a",
            runtime: "codex",
            session: "t-1",
            codexThreadId: "t-2",
            cwd,
          })
        );
      })
    ));

  test("the CLI presents the runtime's own id, never another runtime's", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const claudeShell = { CLAUDE_CODE_SESSION_ID: "claude-id" };
        // A Codex process started from a Claude shell inherits the Claude id.
        const inherited = { ...claudeShell, CODEX_THREAD_ID: "codex-id" };
        expect(yield* Client.sessionFor("claude", undefined, claudeShell)).toBe("claude-id");
        expect(yield* Client.sessionFor("codex", undefined, inherited)).toBe("codex-id");
        expect(yield* Client.sessionFor("codex", "given", inherited)).toBe("given");
        const missing = yield* Effect.flip(Client.sessionFor("codex", undefined, claudeShell));
        expect(missing.refused).toBe(true);
        const placeholder = { AGENT_BUS_SESSION: "${AGENT_BUS_SESSION}" };
        expect(
          (yield* Effect.flip(Client.sessionFor("other", undefined, placeholder))).refused
        ).toBe(true);
      })
    ));

  test("a CLI refusal prints its message alone and exits 1", () => {
    // An empty session is refused before any call, so no bus or bus directory is reached.
    const cli = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../src/bin.ts"),
        "join",
        "--address",
        "claude/a",
      ].concat(["--runtime", "claude", "--session", ""]),
      {
        env: { ...process.env, AGENT_BUS_PORT: "9", AGENT_BUS_DIR: join(tmpdir(), "no-agent-bus") },
      }
    );
    expect([cli.exitCode, cli.stderr.toString().trim()]).toEqual([
      1,
      "--session is empty or an unexpanded placeholder.",
    ]);
  });

  const cliIn = (dir: string, args: ReadonlyArray<string>, stdin?: string) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/bin.ts"), ...args], {
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      env: { ...process.env, AGENT_BUS_PORT: "9", AGENT_BUS_DIR: dir },
      timeout: 10_000,
    });
  const outcome = (run: ReturnType<typeof cliIn>) => [
    run.exitCode,
    run.stdout.toString(),
    run.stderr.toString(),
  ];

  test("the retired Codex Stop hook lets the turn end, whatever its input", () => {
    const inputs = [
      '{"session_id":"t-1","transcript_path":null}',
      "not json",
      "x".repeat(4_000_000),
    ];
    for (const input of inputs) {
      expect(outcome(cliIn(tempDir(), ["codex-stop-hook"], input))).toEqual([0, "", ""]);
    }
  });

  test("serve won't start without a Fluree ledger in config.json", () => {
    const missing = tempDir();
    const empty = tempDir();
    writeFileSync(join(empty, "config.json"), "{}");
    for (const dir of [missing, empty]) {
      expect(outcome(cliIn(dir, ["serve"]))).toEqual([
        1,
        "",
        `${join(dir, "config.json")} has no Fluree ledger. Give it a "fluree" entry, as the installer writes: { "fluree": { "url": "http://127.0.0.1:8095", "ledger": "agent-bus:main" } }\n`,
      ]);
    }
  });

  test("the owner reconnects and rejoins with its mail; a left address is free, without it", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const send = (body: string) =>
          bus.publish({ from: "claude/b", session: "sb", to: ["claude/a"], body });
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "s1", cwd });
        yield* bus.join({ address: "claude/b", runtime: "claude", session: "sb", cwd });
        yield* send("kept");
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "s1", cwd });
        expect(bodies(yield* bus.take("claude/a", "s1"))).toEqual(["kept"]);

        yield* send("while away");
        yield* bus.leave("claude/a", "s1");
        yield* unchanged("claude/a", bus.take("claude/a", "s1"), "NotJoined");
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "s1", cwd });
        expect(bodies(yield* bus.take("claude/a", "s1"))).toEqual(["while away"]);

        // Another session on a left address starts at the present.
        yield* send("for s1");
        yield* bus.leave("claude/a", "s1");
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "s2", cwd });
        yield* unchanged("claude/a", bus.take("claude/a", "s1"));
        expect(yield* bus.take("claude/a", "s2")).toEqual([]);
      })
    ));

  test("two sessions joining at once: one holds the address", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const results = yield* Effect.all(
          ["s1", "s2"].map((session) =>
            Effect.result(bus.join({ address: "claude/a", runtime: "claude", session, cwd }))
          ),
          { concurrency: "unbounded" }
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect((yield* bus.peers).map((peer) => peer.address)).toEqual(["claude/a"]);
      })
    ));

  test("a takeover names the holder's join; unread messages carry over and the old owner is refused", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "old", cwd });
        yield* bus.join({ address: "claude/b", runtime: "claude", session: "sb", cwd });
        yield* bus.publish({ from: "claude/b", session: "sb", to: ["claude/a"], body: "unread" });
        const [holder] = (yield* bus.peers).filter((peer) => peer.address === "claude/a");
        const joinId = holder?.joinId ?? "";

        yield* unchanged(
          "claude/a",
          bus.join({
            address: "claude/a",
            runtime: "claude",
            session: "new",
            takeover: "stale",
            cwd,
          })
        );
        yield* bus.join({
          address: "claude/a",
          runtime: "claude",
          session: "new",
          takeover: joinId,
          cwd,
        });
        const [current] = (yield* bus.peers).filter((peer) => peer.address === "claude/a");
        expect(current?.presence.takeover).toBe(joinId);

        yield* unchanged("claude/a", bus.take("claude/a", "old"));
        yield* unchanged(
          "claude/a",
          bus.publish({ from: "claude/a", session: "old", to: ["*"], body: "x" })
        );
        yield* unchanged(
          "claude/a",
          bus.join({ address: "claude/a", runtime: "claude", session: "old", cwd })
        );
        expect(bodies(yield* bus.take("claude/a", "new"))).toEqual(["unread"]);
      })
    ));

  test("a takeover during the old owner's wait: the wait is refused, the reply goes to the new owner", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "old", cwd });
        yield* bus.join({ address: "claude/b", runtime: "claude", session: "sb", cwd });
        const waiting = yield* Effect.forkChild(Effect.flip(bus.wait("claude/a", "old", 10)));
        yield* Effect.sleep("100 millis");
        const refused = yield* Effect.flip(
          bus.join({ address: "claude/a", runtime: "claude", session: "new", cwd })
        );
        expect(refused.message).toContain("a wait open now");

        const [holder] = (yield* bus.peers).filter((peer) => peer.address === "claude/a");
        yield* bus.join({
          address: "claude/a",
          runtime: "claude",
          session: "new",
          takeover: holder?.joinId,
          cwd,
        });
        yield* bus.publish({ from: "claude/b", session: "sb", to: ["claude/a"], body: "reply" });
        expect((yield* Fiber.join(waiting))._tag).toBe("NotOwner");
        expect(bodies(yield* bus.take("claude/a", "new"))).toEqual(["reply"]);
      })
    ));

  test("a send queued behind a takeover is refused", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "old", cwd });
        const [holder] = yield* bus.peers;
        const { fiber, release } = yield* holdLock(bus, "claude/a");
        // A slow delivery doesn't hold up the owner's sends.
        yield* bus.publish({ from: "claude/a", session: "old", to: ["*"], body: "prompt" });
        const takeover = yield* Effect.forkChild(
          bus.join({
            address: "claude/a",
            runtime: "claude",
            session: "new",
            takeover: holder?.joinId,
            cwd,
          })
        );
        yield* Effect.sleep("20 millis");
        const send = yield* Effect.forkChild(
          Effect.flip(bus.publish({ from: "claude/a", session: "old", to: ["*"], body: "late" }))
        );
        yield* Effect.sleep("20 millis");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        yield* Fiber.join(takeover);
        expect((yield* Fiber.join(send))._tag).toBe("NotOwner");
        expect(yield* bus.history({ query: "late", limit: 5 })).toEqual([]);
      })
    ));

  test("joins and leaves without an owner are ignored, before or after an owned one", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* bus.join({ address: "claude/s", runtime: "claude", session: "ss", cwd });
        const send = (to: string, body: string) =>
          bus.publish({ from: "claude/s", session: "ss", to: [to], body });

        // Owned, then owner-less: the owner keeps the address and its unread mail.
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "sa", cwd });
        yield* send("claude/a", "before");
        yield* ownerless("claude/a");
        yield* ownerless("claude/a", { status: "left" });
        yield* send("claude/a", "after");
        expect(bodies(yield* bus.take("claude/a", "sa"))).toEqual(["before", "after"]);
        yield* unchanged(
          "claude/a",
          bus.join({ address: "claude/a", runtime: "claude", session: "other", cwd })
        );

        // An owner-less join's id is no takeover of the live owner.
        const unowned = yield* ownerless("claude/a");
        yield* unchanged(
          "claude/a",
          bus.join({
            address: "claude/a",
            runtime: "claude",
            session: "other",
            takeover: unowned,
            cwd,
          })
        );

        // A pre-owner join left a cursor, and mail waits behind it.
        const cursors = yield* Cursors.Cursors;
        const ledger = yield* Ledger.Ledger;
        yield* cursors.set("codex/b", yield* ledger.end);
        yield* cursors.set("claude/d", yield* ledger.end);
        yield* send("codex/b", "waiting for b");

        // Owner-less only, joined (even naming a Codex thread) or left: not joined.
        yield* ownerless("codex/b", { runtime: "codex", codexThreadId: "t-b" });
        yield* ownerless("claude/c");
        yield* ownerless("claude/c", { status: "left" });
        const listed = (yield* bus.peers).map((peer) => peer.address);
        expect(listed).not.toContain("codex/b");
        expect(listed).not.toContain("claude/c");
        expect((yield* Effect.flip(bus.take("codex/b", "t-b")))._tag).toBe("NotJoined");
        // Its first owner starts at the present, not at the pre-owner cursor.
        yield* bus.join({
          address: "codex/b",
          runtime: "codex",
          session: "t-b",
          codexThreadId: "t-b",
          cwd,
        });
        expect(yield* bus.take("codex/b", "t-b")).toEqual([]);

        // Owner-less, then owned: a plain join, even with a stale takeover, starts at the present.
        const stale = yield* ownerless("claude/d");
        yield* send("claude/d", "sent before the owner joined");
        const joined = yield* bus.join({
          address: "claude/d",
          runtime: "claude",
          session: "sd",
          takeover: stale,
          cwd,
        });
        expect(joined.address).toBe("claude/d");
        yield* send("claude/d", "sent after");
        expect(bodies(yield* bus.take("claude/d", "sd"))).toEqual(["sent after"]);
        const [holder] = (yield* bus.peers).filter((peer) => peer.address === "claude/d");
        expect(holder?.presence.takeover).toBeUndefined();
      })
    ));

  test("ownership and unread mail survive a restart of the bus", async () => {
    const dir = tempDir();
    const file = join(dir, "ledger.jsonl");
    const layer = () =>
      busOn(layerJsonl(file).pipe(Layer.provide(platform)), dir).pipe(Layer.provide(platform));
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({ address: "claude/a", runtime: "claude", session: "s1", cwd });
          yield* bus.join({ address: "claude/b", runtime: "claude", session: "sb", cwd });
          yield* bus.publish({
            from: "claude/b",
            session: "sb",
            to: ["claude/a"],
            body: "waiting",
          });
        }),
        layer()
      )
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          expect((yield* Effect.flip(bus.take("claude/a", "s2")))._tag).toBe("NotOwner");
          expect(bodies(yield* bus.take("claude/a", "s1"))).toEqual(["waiting"]);
        }),
        layer()
      )
    );
  });
});

describe("mcp over http", () => {
  // Each test gets its own server and port; Bun keeps a stopped server's port briefly.
  let nextPort = 19_000 + Math.floor(Math.random() * 500) * 4;
  const serve = () => {
    const port = nextPort++;
    return {
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      layer: Serve.layerHttp({ port, version: "test" }).pipe(Layer.provide(jsonl().layer)),
    };
  };

  const initialize = (url: string, headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    }).then((response) => response.status);

  for (const protocol of [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25]) {
    test(`sessions join, publish and read over ${protocol.protocolVersion}`, () => {
      const { url, layer } = serve();
      return Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* McpClient.McpClient;
          const tools = yield* client.listTools();
          const tool = (name: string) => {
            const found = tools.find((candidate) => candidate.name === name);
            if (found === undefined) throw new Error(`no ${name}`);
            return found;
          };
          for (const address of ["claude/a", "codex/b"]) {
            yield* client.callTool({
              tool: tool("bus_join"),
              schema: Mcp.Joined,
              arguments: { address, runtime: "other", session: sid(address), cwd: process.cwd() },
            });
          }
          yield* client.callTool({
            tool: tool("bus_publish"),
            schema: Mcp.Published,
            arguments: {
              from: "codex/b",
              session: sid("codex/b"),
              to: ["claude/a"],
              body: "over http",
            },
          });
          const { messages } = yield* client.callTool({
            tool: tool("bus_read"),
            schema: Mcp.Messages,
            arguments: { address: "claude/a", session: sid("claude/a") },
          });
          expect(bodies(messages)).toEqual(["over http"]);
          expect(messages[0]?.origin?.cwd).toBe(process.cwd());

          const relative = yield* client.callTool({
            tool: tool("bus_join"),
            arguments: {
              address: "claude/c",
              runtime: "other",
              session: sid("claude/c"),
              cwd: "relative/dir",
            },
          });
          expect(relative.isError).toBe(true);
          // A caller from before sessions gets a refusal, which ends its retries, not a protocol error.
          const anonymous = yield* client.callTool({
            tool: tool("bus_read"),
            arguments: { address: "claude/a" },
          });
          expect(anonymous.isError).toBe(true);
          const left = yield* client.callTool({
            tool: tool("bus_leave"),
            schema: Mcp.Left,
            arguments: { address: "codex/b", session: sid("codex/b") },
          });
          expect(left).toEqual({ address: "codex/b" });
        }).pipe(
          Effect.provide(
            McpClient.layerHttp({ name: "test", version: "1", url, protocol }).pipe(
              Layer.provide(FetchHttpClient.layer)
            )
          ),
          Effect.provide(layer)
        )
      );
    });
  }

  test("a Codex join returns its address and cursor, with nothing about where the thread runs", () => {
    const { url, layer } = serve();
    return Effect.runPromise(
      Effect.gen(function* () {
        const call = Client.call(url);
        const join = (address: string, args: Record<string, string>) =>
          call("bus_join", Mcp.Joined, { address, cwd: process.cwd(), ...args });
        const codex = (thread: string) => ({
          runtime: "codex",
          session: thread,
          codexThreadId: thread,
        });
        const joined = yield* join("codex/a", codex("t-1"));
        expect(Object.keys(joined).sort()).toEqual(["address", "cursor"]);
      }).pipe(Effect.provide(Layer.merge(layer, FetchHttpClient.layer)))
    );
  });

  test("refuses browser origins and foreign hosts", () => {
    const { port, url, layer } = serve();
    return Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* Effect.promise(() => initialize(url, {}))).toBe(200);
        expect(
          yield* Effect.promise(() => initialize(url, { origin: "https://example.com" }))
        ).toBe(403);
        expect(
          yield* Effect.promise(() => initialize(url, { host: `rebound.example:${port}` }))
        ).toBe(403);
      }).pipe(Effect.provide(layer))
    );
  });

  test("the CLI's wait returns arrivals, and an empty list at its timeout", () => {
    const { url, layer } = serve();
    return Effect.runPromise(
      Effect.gen(function* () {
        const call = Client.call(url);
        for (const [address, runtime] of [
          ["claude/a", "claude"],
          ["codex/b", "codex"],
        ]) {
          yield* call("bus_join", Mcp.Joined, {
            address,
            runtime,
            session: sid(address ?? ""),
            cwd: process.cwd(),
          });
        }
        const a = sid("claude/a");
        expect(yield* Client.waitFor(url, "claude/a", a, 1)).toEqual([]);
        const waiting = yield* Effect.forkChild(Client.waitFor(url, "claude/a", a));
        yield* Effect.sleep("200 millis");
        yield* call("bus_publish", Mcp.Published, {
          from: "codex/b",
          session: sid("codex/b"),
          to: ["claude/a"],
          body: "wake",
        });
        expect(bodies(yield* Fiber.join(waiting))).toEqual(["wake"]);
        const notJoined = yield* Effect.flip(Client.waitFor(url, "claude/nobody", a, 1));
        const stranger = yield* Effect.flip(Client.waitFor(url, "claude/a", "someone-else"));
        expect(stranger.refused).toBe(true);
        // An unreachable bus is retried until the deadline, not reported as a timeout at once.
        const started = Date.now();
        const unreachable = yield* Client.waitFor("http://127.0.0.1:9/mcp", "claude/a", a, 1.5);
        expect(unreachable).toEqual([]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
        expect(notJoined.refused).toBe(true);

        // Working out the session from the bus is retried the same way, and then used.
        const lookup = (at: string) =>
          Effect.flatMap(Client.runtimeOf(at, "claude/a"), (runtime) =>
            Client.sessionFor(runtime, undefined, { CLAUDE_CODE_SESSION_ID: a })
          );
        const before = Date.now();
        expect(
          yield* Client.waitFor(
            "http://127.0.0.1:9/mcp",
            "claude/a",
            lookup("http://127.0.0.1:9/mcp"),
            1.5
          )
        ).toEqual([]);
        expect(Date.now() - before).toBeGreaterThanOrEqual(1_400);
        yield* call("bus_publish", Mcp.Published, {
          from: "codex/b",
          session: sid("codex/b"),
          to: ["claude/a"],
          body: "found",
        });
        expect(bodies(yield* Client.waitFor(url, "claude/a", lookup(url), 1))).toEqual(["found"]);
      }).pipe(Effect.provide(Layer.merge(layer, FetchHttpClient.layer)))
    );
  });
});
