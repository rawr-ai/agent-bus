import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Logger, Option, Schema } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { claudeWake, formatWake } from "../src/claude.ts";
import * as Client from "../src/client.ts";
import {
  appServerQueue,
  type Borrowed,
  CodexError,
  type Daemon,
  daemonBorrower,
  deliverOnce,
  deliveryTargets,
  formatNudge,
  type Holds,
  type Queue,
  type Queued,
  startDaemon,
} from "../src/codex.ts";
import { LedgerError, Message, MessageJson, Origin, Presence } from "../src/domain.ts";
import * as Fluree from "../src/Fluree.ts";
import * as Ledger from "../src/Ledger.ts";
import * as Mcp from "../src/mcp.ts";
import {
  eligibility,
  latestSettings,
  readEligibility,
  type Settings,
  type Stored,
} from "../src/rollout.ts";
import * as Serve from "../src/serve.ts";
import { validateSelect } from "../src/sparql.ts";
import { MAX_PAGES } from "../src/timing.ts";
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
          // A plain rejoin keeps the cursor; only a replay resets it.
          expect(error.message).toContain("a rejoin with replay restarts it at 0");
        }),
        fluree().layer
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

/** A settings snapshot record, as Codex writes one at each thread start and resume. */
const snapshot = (
  threadId: string | undefined,
  approval: unknown,
  options: { profile?: unknown; profileId?: string; mode?: string } = {}
) => ({
  type: "event_msg",
  payload: {
    type: "thread_settings_applied",
    thread_id: threadId,
    thread_settings: {
      approval_policy: approval,
      permission_profile: options.profile ?? { type: "disabled" },
      active_permission_profile: options.profileId === undefined ? null : { id: options.profileId },
      collaboration_mode: { mode: options.mode ?? "default", settings: {} },
    },
  },
});

/** A rollout file of these lines. */
const rolloutOf = (lines: ReadonlyArray<unknown>) => {
  const file = join(tempDir(), "rollout.jsonl");
  writeFileSync(
    file,
    `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`
  );
  return file;
};

describe("codex delivery", () => {
  /** Each thread's rollout: the owner's default, full access with approval never. */
  const fullAccess = (threadId: string) => ({
    path: rolloutOf([
      { type: "session_meta", payload: { id: threadId } },
      snapshot(threadId, "never", { profileId: ":danger-full-access" }),
      { type: "event_msg", payload: { type: "task_complete" } },
    ]),
    historyMode: "legacy",
  });

  /**
   * Codex thread queues: each thread's waiting items, in order. `queue` makes
   * every request fail, makes an add land and then report a failure, as a
   * timed-out request might, or refuses adds as a subagent's queue does.
   * `opened` counts the app-servers started; `rollout` is where each thread's
   * session file is.
   */
  const fakeQueue = () => {
    const items = new Map<string, Array<Queued>>();
    const queueState = {
      queue: "accept" as "accept" | "fail" | "lands, then fails" | "subagent" | "hangs",
      /** Removal alone fails, or finds the writer took the item first. */
      remove: "accept" as "accept" | "fail" | "not deleted",
      opened: 0,
      listing: false,
      removed: [] as Array<string>,
      rollout: fullAccess as (threadId: string) => Stored,
      /** `thread/read` alone fails. */
      readFails: false,
    };
    let added = 0;
    const queued = (threadId: string) => items.get(threadId) ?? [];
    /** The text of each waiting item, in order. */
    const waiting = (threadId: string) => queued(threadId).map(({ text }) => text);
    const fail = (method: string, message = "no answer within 2 seconds") =>
      Effect.fail(new CodexError({ method, message }));
    /** An item the owner queued, with ids of its own. */
    const put = (threadId: string, text: string) => {
      added += 1;
      const item = { id: `owner-${added}`, clientUserMessageId: `owner-c${added}`, text };
      items.set(threadId, [...queued(threadId), item]);
      return item;
    };
    /** An item in place of the one with this id, whatever Codex might do to it. */
    const replace = (threadId: string, id: string | undefined, item: Queued) =>
      items.set(
        threadId,
        queued(threadId).map((each) => (each.id === id ? item : each))
      );
    /** The owner edits an item, which keeps its ids. */
    const edit = (threadId: string, id: string | undefined, text: string) =>
      items.set(
        threadId,
        queued(threadId).map((item) => (item.id === id ? { ...item, text } : item))
      );
    const queue: Queue = {
      list: (threadId) => {
        if (queueState.queue === "fail") return fail("thread/queue/list");
        if (queueState.queue === "hangs") {
          return Effect.sync(() => {
            queueState.listing = true;
          }).pipe(Effect.andThen(Effect.never));
        }
        return Effect.succeed(queued(threadId));
      },
      add: (threadId, text) => {
        if (queueState.queue === "fail") return fail("thread/queue/add");
        if (queueState.queue === "subagent") {
          return fail(
            "thread/queue/add",
            "direct app-server input is not allowed for unloaded spawned sub-agents"
          );
        }
        added += 1;
        const item = { id: `q${added}`, clientUserMessageId: `c${added}`, text };
        items.set(threadId, [...queued(threadId), item]);
        return queueState.queue === "lands, then fails"
          ? fail("thread/queue/add")
          : Effect.succeed(item);
      },
      remove: (threadId, id) => {
        if (queueState.queue === "fail" || queueState.remove === "fail") {
          return fail("thread/queue/delete");
        }
        const before = queued(threadId);
        items.set(
          threadId,
          before.filter((item) => item.id !== id)
        );
        // Not deleted: the writer took the item first.
        if (queueState.remove === "not deleted") return Effect.succeed(false);
        queueState.removed.push(id);
        return Effect.succeed(before.some((item) => item.id === id));
      },
      rollout: (threadId) =>
        queueState.readFails ? fail("thread/read") : Effect.succeed(queueState.rollout(threadId)),
    };
    const openQueue = Effect.sync(() => {
      queueState.opened += 1;
      return queue;
    });
    /** Whichever app-server has the thread loaded runs its next waiting item. */
    const runNext = (threadId: string) => items.set(threadId, queued(threadId).slice(1));
    return { openQueue, waiting, queued, put, edit, replace, runNext, queueState };
  };

  /**
   * The daemon: each borrow is recorded and answered as `answer` says. A
   * `gate` holds borrows until it is opened.
   */
  const fakeDaemon = () => {
    const daemonState = {
      answer: "loaded" as Borrowed | "fails" | "times out",
      borrows: [] as Array<string>,
      gate: undefined as Deferred.Deferred<void> | undefined,
    };
    const daemon: Daemon = {
      borrow: (threadId) =>
        Effect.gen(function* () {
          daemonState.borrows.push(threadId);
          if (daemonState.gate !== undefined) yield* Deferred.await(daemonState.gate);
          if (daemonState.answer === "times out") {
            return yield* new CodexError({ method: "borrow", message: "no answer within 25s" });
          }
          if (daemonState.answer === "fails") {
            return yield* new CodexError({
              method: "thread/resume",
              message: `no rollout found for thread id ${threadId}`,
            });
          }
          return daemonState.answer;
        }),
    };
    return { daemon, daemonState };
  };

  /** A Codex peer `codex/a` on thread t-1 with one message from `claude/b`, and a deliverer for it. */
  const setup = Effect.gen(function* () {
    const bus = yield* Bus.Bus;
    const queued = fakeQueue();
    const { daemon, daemonState } = fakeDaemon();
    const holds: Holds = new Map();
    const deliverer = (state: Holds) => deliverOnce(queued.openQueue, daemon, hostname(), state);
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
      daemonState,
      holds,
      deliver: deliverer(holds),
      /** A deliverer that has just started, as after a restart. */
      restarted: deliverer(new Map()),
      join,
      send,
    };
  });

  /** What the deliverer logged in the latest `run`, as "Level: message". */
  let logs: Array<string> = [];
  const capture = Logger.make(({ logLevel, message }) => {
    logs.push(`${logLevel}: ${Array.isArray(message) ? message.join(" ") : String(message)}`);
  });
  const run = <A, E>(effect: Effect.Effect<A, E, Bus.Bus>) => {
    logs = [];
    return Effect.runPromise(
      Effect.provide(
        effect,
        Layer.mergeAll(jsonl().layer, TestClock.layer(), Logger.layer([capture]))
      )
    );
  };

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

  test("a woken thread that rejoins before reading isn't nudged again; a replay, a leave or a takeover starts over", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, runNext, holds, deliver, send, join: rejoin } = yield* setup;
        const joinA = (extra: Partial<Bus.JoinInput> = {}) =>
          bus.join({
            address: "codex/a",
            runtime: "codex",
            session: "t-1",
            cwd: process.cwd(),
            codexThreadId: "t-1",
            ...extra,
          });
        yield* deliver;
        const covered = holds.get("codex/a")?.covered;
        // The nudge runs, and its turn rejoins before reading: the same mail, so no second nudge.
        runNext("t-1");
        yield* rejoin;
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);
        expect(holds.get("codex/a")?.covered).toEqual(covered);
        // Twice over, between cycles.
        yield* rejoin;
        yield* rejoin;
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);

        // A replay asks for its mail again: woken afresh, though the unread mail is the same.
        yield* joinA({ replay: true });
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        runNext("t-1");
        // So is a join after a leave, even when both land between cycles.
        yield* bus.leave("codex/a", "t-1");
        yield* rejoin;
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        runNext("t-1");
        // And either, followed by ordinary rejoins before the next cycle.
        yield* joinA({ replay: true });
        yield* rejoin;
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        runNext("t-1");
        yield* bus.leave("codex/a", "t-1");
        yield* rejoin;
        yield* rejoin;
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        runNext("t-1");
        // And new mail after a rejoin is woken as before.
        yield* rejoin;
        yield* send("two");
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);

        // A takeover by another thread starts over for it.
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
        expect(waiting("t-2").length).toBe(1);
      })
    ));

  test("a rejoin keeps the reconcile schedule", () =>
    run(
      Effect.gen(function* () {
        const { waiting, runNext, holds, deliver, join: rejoin } = yield* setup;
        yield* deliver;
        runNext("t-1");
        yield* TestClock.adjust("5 minutes");
        yield* deliver;
        expect(holds.get("codex/a")?.covered?.reconciles).toBe(1);
        runNext("t-1");
        yield* rejoin;
        // Not due again for 15 minutes from the reconcile, rejoin or not.
        yield* TestClock.adjust("5 minutes");
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);
        yield* TestClock.adjust("10 minutes");
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        expect(holds.get("codex/a")?.covered?.reconciles).toBe(2);
      })
    ));

  test("once the mail is read, our waiting nudge is removed, and nothing of the owner's", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, put, queueState, holds, deliver } = yield* setup;
        yield* deliver;
        // The owner's own input, one quoting our header, and one that is our text word for word.
        put("t-1", "my own input");
        put("t-1", `${formatNudge("codex/a").split(".")[0]}. please`);
        put("t-1", formatNudge("codex/a"));
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(queueState.removed).toEqual(["q1"]);
        expect(waiting("t-1")).toEqual([
          "my own input",
          `${formatNudge("codex/a").split(".")[0]}. please`,
          formatNudge("codex/a"),
        ]);
        expect(holds.get("codex/a")?.posted).toBeUndefined();
        // Removal is tried once: later cycles start no app-server for it.
        const opened = queueState.opened;
        yield* deliver;
        expect(queueState.opened).toBe(opened);
      })
    ));

  test("a copy of our nudge that the owner queued is never removed", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, put, runNext, queueState, holds, deliver, send } = yield* setup;
        yield* deliver;
        runNext("t-1");
        // The owner pastes our text word for word; new mail finds it waiting and adds nothing.
        put("t-1", formatNudge("codex/a"));
        yield* send("two");
        yield* deliver;
        expect(waiting("t-1")).toEqual([formatNudge("codex/a")]);
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(queueState.removed).toEqual([]);
        expect(waiting("t-1")).toEqual([formatNudge("codex/a")]);
        expect(holds.get("codex/a")?.posted).toBeUndefined();
      })
    ));

  test("removal needs both of our ids and our text: an item matching only some of them is left", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, put, queued, replace, runNext, queueState, deliver, send } =
          yield* setup;
        // Our id, our text, another client id.
        yield* deliver;
        const ours = queued("t-1")[0];
        replace("t-1", ours?.id, {
          id: ours?.id,
          clientUserMessageId: "other",
          text: ours?.text ?? "",
        });
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(queueState.removed).toEqual([]);
        runNext("t-1");
        // Ours has run; the owner queues our text word for word, with ids of its own.
        yield* send("two");
        yield* deliver;
        runNext("t-1");
        put("t-1", formatNudge("codex/a"));
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(queueState.removed).toEqual([]);
        expect(waiting("t-1")).toEqual([formatNudge("codex/a")]);
      })
    ));

  test("a nudge that has run, or was edited, is left, and the record is cleared", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, edit, queued, runNext, queueState, holds, deliver, send } =
          yield* setup;
        yield* deliver;
        runNext("t-1");
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(queueState.removed).toEqual([]);
        expect(holds.get("codex/a")?.posted).toBeUndefined();

        // The owner edits our nudge, which keeps its ids: it is theirs now.
        yield* send("two");
        yield* deliver;
        edit("t-1", queued("t-1")[0]?.id, "my edit");
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(queueState.removed).toEqual([]);
        expect(waiting("t-1")).toEqual(["my edit"]);
        expect(holds.get("codex/a")?.posted).toBeUndefined();
      })
    ));

  test("a removal that fails, or finds the item taken, clears the record without back-off", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, runNext, queueState, holds, deliver, send } = yield* setup;
        for (const failure of ["not deleted", "fail", "list fails"] as const) {
          yield* deliver;
          expect(holds.get("codex/a")?.posted).toBeDefined();
          yield* bus.take("codex/a", "t-1");
          if (failure === "list fails") queueState.queue = "fail";
          else queueState.remove = failure;
          yield* deliver;
          expect(holds.get("codex/a")?.posted).toBeUndefined();
          expect(holds.get("codex/a")?.failures).toBe(0);
          queueState.queue = "accept";
          queueState.remove = "accept";
          // A nudge the removal missed runs once, as an empty turn; the next mail is woken at once.
          if (waiting("t-1").length > 0) runNext("t-1");
          yield* send(failure);
        }
      })
    ));

  test("a waiting nudge stays while any of the mail it covers is unread, and new mail after a removal is woken", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, queueState, deliver, send } = yield* setup;
        yield* send("two");
        yield* deliver;
        // A partial read leaves the nudge for the rest.
        yield* bus.take("codex/a", "t-1", 1);
        yield* deliver;
        expect(queueState.removed).toEqual([]);
        expect(waiting("t-1").length).toBe(1);
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);
        yield* send("three");
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
      })
    ));

  test("a nudge whose borrow or rollout read failed is still known, and removed once the mail is read, back-off or not", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, daemonState, queueState, holds, deliver, send } = yield* setup;
        daemonState.answer = "fails";
        yield* deliver;
        expect(holds.get("codex/a")?.failures).toBe(1);
        expect(holds.get("codex/a")?.posted).toBeDefined();
        // Read mid-turn, inside the back-off: removed at once, and nothing posted meanwhile.
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);
        yield* send("two");
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);
        yield* TestClock.adjust("30 seconds");
        daemonState.answer = "loaded";
        queueState.readFails = true;
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        // A second failure in a row: the back-off doubles.
        expect(holds.get("codex/a")?.failures).toBe(2);
        expect(holds.get("codex/a")?.posted).toBeDefined();
        yield* bus.take("codex/a", "t-1");
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);
        // Removal outcomes are not warnings.
        expect(logs.filter((line) => line.startsWith("Warn") && line.includes("remove"))).toEqual(
          []
        );
      })
    ));

  test("a rejoin after the cycle read its peers starts the back-off over for the new join", () =>
    run(
      Effect.gen(function* () {
        const { bus, daemonState, holds, deliver, send } = yield* setup;
        // A second peer, which the cycle reaches after codex/a.
        const joinZero = bus.join({
          address: "codex/0",
          runtime: "codex",
          session: "t-0",
          cwd: process.cwd(),
          codexThreadId: "t-0",
        });
        const mailZero = (body: string) =>
          bus.publish({ from: "claude/b", session: sid("claude/b"), to: ["codex/0"], body });
        yield* joinZero;
        yield* mailZero("x");
        daemonState.answer = "fails";
        yield* deliver;
        expect(holds.get("codex/0")?.failures).toBe(1);
        yield* TestClock.adjust("30 seconds");
        yield* send("two");
        yield* mailZero("y");
        daemonState.borrows = [];
        daemonState.gate = yield* Deferred.make<void>();
        const cycle = yield* Effect.forkChild(deliver);
        while (daemonState.borrows.length === 0) yield* Effect.promise(() => Bun.sleep(5));
        expect(daemonState.borrows).toEqual(["t-1"]);
        // codex/0 rejoins after the cycle read the peers, before its turn comes.
        yield* joinZero;
        yield* Deferred.succeed(daemonState.gate, undefined);
        yield* Fiber.join(cycle);
        daemonState.gate = undefined;
        expect(daemonState.borrows).toEqual(["t-1", "t-0"]);
        // The new join's first failure, not the old join's second.
        expect(holds.get("codex/0")?.failures).toBe(1);
      })
    ));

  test("a thread that rejoins while its borrow is in flight isn't nudged again", () =>
    run(
      Effect.gen(function* () {
        const { waiting, runNext, daemonState, deliver, join: rejoin } = yield* setup;
        daemonState.gate = yield* Deferred.make<void>();
        const borrowing = yield* Effect.forkChild(deliver);
        while (daemonState.borrows.length === 0) yield* Effect.promise(() => Bun.sleep(5));
        // The borrowed turn runs the nudge and rejoins before the borrow answers.
        runNext("t-1");
        yield* rejoin;
        yield* Deferred.succeed(daemonState.gate, undefined);
        yield* Fiber.join(borrowing);
        daemonState.gate = undefined;
        yield* deliver;
        expect(waiting("t-1")).toEqual([]);
        expect(daemonState.borrows).toEqual(["t-1"]);
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

  test("an eligible thread's nudge is followed by one borrow, and covered mail isn't borrowed again", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, daemonState, queueState, holds, deliver } = yield* setup;
        yield* deliver;
        expect(waiting("t-1")).toEqual([formatNudge("codex/a")]);
        expect(daemonState.borrows).toEqual(["t-1"]);
        expect(holds.get("codex/a")?.covered?.reconciles).toBe(0);
        yield* deliver;
        expect(daemonState.borrows).toEqual(["t-1"]);
        expect(queueState.opened).toBe(1);
        // A borrow moves no cursor: only the owner's read does.
        expect(bodies(yield* bus.take("codex/a", "t-1"))).toEqual(["hi"]);
      })
    ));

  test("a thread that can't be borrowed still gets its nudge, and says why once per reason", () =>
    run(
      Effect.gen(function* () {
        const {
          bus,
          waiting,
          daemonState,
          queueState,
          holds,
          deliver,
          send,
          join: rejoin,
        } = yield* setup;
        const warnings = () => logs.filter((line) => line.startsWith("Warn: Not borrowing"));
        queueState.rollout = (threadId) => ({
          path: rolloutOf([
            { type: "session_meta", payload: { id: threadId } },
            snapshot(threadId, "on-request"),
          ]),
          historyMode: "legacy",
        });
        yield* deliver;
        yield* send("two");
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        expect(daemonState.borrows).toEqual([]);
        expect(holds.get("codex/a")?.warned).toContain("on-request");
        expect(warnings()).toEqual([expect.stringContaining('approval policy is "on-request"')]);

        // Nor is one whose rollout can't be found, a new reason, which is said.
        queueState.rollout = () => ({
          path: join(tempDir(), "missing.jsonl"),
          historyMode: "legacy",
        });
        yield* send("three");
        yield* deliver;
        expect(daemonState.borrows).toEqual([]);
        expect(warnings().length).toBe(2);
        expect(warnings()[1]).toContain("can't be read (it doesn't exist)");

        // The thread rejoining as it runs isn't told again; a join after a leave is.
        yield* rejoin;
        yield* send("four");
        yield* deliver;
        expect(warnings().length).toBe(2);
        yield* bus.leave("codex/a", "t-1");
        yield* rejoin;
        yield* send("five");
        yield* deliver;
        expect(warnings().length).toBe(3);
      })
    ));

  test("a reason that would name the thread is logged without it", () =>
    run(
      Effect.gen(function* () {
        const { bus, queueState, deliver, send, join: rejoin } = yield* setup;
        // Codex's own words are quoted in some reasons.
        queueState.rollout = (threadId) => ({ path: undefined, historyMode: threadId });
        yield* deliver;
        // A file system error's message names the rollout's path, which names the thread.
        const unreadable = join(tempDir(), "rollout-t-1.jsonl");
        writeFileSync(unreadable, `${JSON.stringify(snapshot("t-1", "never"))}\n`);
        chmodSync(unreadable, 0o000);
        queueState.rollout = () => ({ path: unreadable, historyMode: "legacy" });
        yield* bus.leave("codex/a", "t-1");
        yield* rejoin;
        yield* send("two");
        yield* deliver;
        expect(logs.filter((line) => line.startsWith("Warn: Not borrowing"))).toEqual([
          expect.stringContaining('kept as "<thread>"'),
          expect.stringContaining("can't be read (error EACCES)"),
        ]);
        expect(logs.join("\n")).not.toContain("t-1");
      })
    ));

  test("once a borrow times out, the cycle's other borrows fail at once and back off", () =>
    run(
      Effect.gen(function* () {
        const { bus, daemonState, holds, deliver } = yield* setup;
        yield* bus.join({
          address: "codex/c",
          runtime: "codex",
          session: "t-2",
          cwd: process.cwd(),
          codexThreadId: "t-2",
        });
        yield* bus.publish({
          from: "claude/b",
          session: sid("claude/b"),
          to: ["codex/c"],
          body: "hi",
        });
        daemonState.answer = "times out";
        yield* deliver;
        expect(daemonState.borrows.length).toBe(1);
        expect(holds.get("codex/a")?.failures).toBe(1);
        expect(holds.get("codex/c")?.failures).toBe(1);
        expect(logs.filter((line) => line.includes("not tried")).length).toBe(1);

        // The next cycle tries again.
        daemonState.answer = "loaded";
        yield* TestClock.adjust("30 seconds");
        yield* deliver;
        expect(daemonState.borrows.length).toBe(3);
      })
    ));

  test("a failed borrow leaves the mail uncovered, and the retry borrows without a second nudge", () =>
    run(
      Effect.gen(function* () {
        const { waiting, daemonState, holds, deliver } = yield* setup;
        daemonState.answer = "fails";
        yield* deliver;
        expect(waiting("t-1").length).toBe(1);
        expect(holds.get("codex/a")?.failures).toBe(1);
        expect(holds.get("codex/a")?.covered).toBeUndefined();

        daemonState.answer = "loaded";
        yield* TestClock.adjust("29 seconds");
        yield* deliver;
        expect(daemonState.borrows.length).toBe(1);
        yield* TestClock.adjust("1 second");
        yield* deliver;
        expect(daemonState.borrows.length).toBe(2);
        expect(waiting("t-1").length).toBe(1);
        expect(holds.get("codex/a")?.failures).toBe(0);
      })
    ));

  test("unread mail is reconciled after 5, 15 and 60 minutes, then hourly, until the owner reads it", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, runNext, daemonState, holds, deliver } = yield* setup;
        // Another process holds the thread, as a running codex exec might, and never runs the nudge.
        daemonState.answer = "held";
        yield* deliver;
        const borrowsAfter = (wait: Duration.Input) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(wait);
            yield* deliver;
            return daemonState.borrows.length;
          });
        expect(yield* borrowsAfter("299 seconds")).toBe(1);
        // Our nudge still waits: the daemon is asked again, with no second nudge.
        daemonState.answer = "loaded";
        expect(yield* borrowsAfter("1 second")).toBe(2);
        expect(waiting("t-1").length).toBe(1);

        // The nudge ran but the turn didn't read: the next reconcile posts it again.
        runNext("t-1");
        expect(yield* borrowsAfter("14 minutes")).toBe(2);
        expect(yield* borrowsAfter("1 minute")).toBe(3);
        expect(waiting("t-1").length).toBe(1);
        expect(yield* borrowsAfter("59 minutes")).toBe(3);
        expect(yield* borrowsAfter("1 minute")).toBe(4);
        expect(yield* borrowsAfter("60 minutes")).toBe(5);
        expect(holds.get("codex/a")?.covered?.reconciles).toBe(4);
        expect(logs.filter((line) => line.includes("hasn't read its mail")).length).toBe(1);

        // Once read, nothing more.
        yield* bus.take("codex/a", "t-1");
        expect(yield* borrowsAfter("2 hours")).toBe(5);
      })
    ));

  test("new mail is attempted at once, not on the old mail's schedule", () =>
    run(
      Effect.gen(function* () {
        const { daemonState, holds, deliver, send } = yield* setup;
        yield* deliver;
        yield* send("two");
        yield* deliver;
        expect(daemonState.borrows.length).toBe(2);
        expect(holds.get("codex/a")?.covered?.reconciles).toBe(0);
      })
    ));

  test("a borrow's result belongs to the join it was for: a takeover during it is woken afresh", () =>
    run(
      Effect.gen(function* () {
        const { bus, waiting, daemonState, holds, deliver } = yield* setup;
        daemonState.gate = yield* Deferred.make<void>();
        const borrowing = yield* Effect.forkChild(deliver);
        while (daemonState.borrows.length === 0) yield* Effect.promise(() => Bun.sleep(5));
        const holder = (yield* bus.peers).find((peer) => peer.address === "codex/a");
        yield* bus.join({
          address: "codex/a",
          runtime: "codex",
          session: "t-2",
          cwd: process.cwd(),
          codexThreadId: "t-2",
          takeover: holder?.joinId,
        });
        yield* Deferred.succeed(daemonState.gate, undefined);
        yield* Fiber.join(borrowing);
        daemonState.gate = undefined;
        expect(holds.get("codex/a")?.joinId).toBe(holder?.joinId);

        yield* deliver;
        expect(daemonState.borrows).toEqual(["t-1", "t-2"]);
        expect(waiting("t-2").length).toBe(1);
      })
    ));

  test("a subagent, refused at the queue, is never borrowed", () =>
    run(
      Effect.gen(function* () {
        const { daemonState, queueState, deliver } = yield* setup;
        queueState.queue = "subagent";
        yield* deliver;
        expect(daemonState.borrows).toEqual([]);
      })
    ));
});

describe("codex app-server queue", () => {
  /**
   * A stand-in `codex` whose `app-server` speaks JSON-RPC on stdio. It records
   * each request it receives, and answers as `mode` says.
   */
  const fakeCodex = (
    mode: "answers" | "pages" | "loops" | "endless" | "asks" | "refuses" | "silent" | "stubborn"
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
  else if (mode === "endless" && message.method === "thread/queue/list") reply(message.id, { result: { data: [], nextCursor: "p" + message.id } });
  else if (mode === "asks" && message.method === "thread/queue/list") {
    // A request of the server's own that happens to reuse the pending id is not the reply.
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, method: "item/requestApproval", params: {} }) + "\\n");
    reply(message.id, { result: { data: [], nextCursor: null } });
  }
  else if (message.method === "thread/queue/list") reply(message.id, { result: { data: [{ id: "q1", clientUserMessageId: "c1", input: [{ type: "text", text: "waiting", text_elements: [] }] }, { id: "q2", input: [{ type: "image", url: 7 }] }, { id: "q3" }], nextCursor: null } });
  else if (message.method === "thread/read") reply(message.id, { result: { thread: { id: message.params.threadId, historyMode: "legacy", path: message.params.threadId === "t-1" ? "/codex/sessions/rollout-t-1.jsonl" : null } } });
  else if (message.method === "thread/queue/delete") reply(message.id, { result: { deleted: message.params.queuedSubmissionId === "q1" } });
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
    expect(result._tag === "Success" && result.success).toEqual([
      { id: "q1", clientUserMessageId: "c1", text: "waiting" },
      { id: "q2", clientUserMessageId: undefined, text: "" },
      { id: "q3", clientUserMessageId: undefined, text: "" },
    ]);
    const [initialize, initialized, list, add] = codex.requests();
    expect(initialize?.params?.capabilities).toEqual({ experimentalApi: true });
    expect(initialized?.method).toBe("initialized");
    expect(list?.params).toEqual({ threadId: "t-1", limit: 100, cursor: null });
    expect(add?.params?.threadId).toBe("t-1");
    expect(add?.params?.input).toEqual([
      { type: "text", text: "read your mail", text_elements: [] },
    ]);
  });

  test("a thread's rollout is found with a thread/read that loads nothing", async () => {
    const codex = fakeCodex("answers");
    const result = await withQueue(codex.bin, (queue) =>
      Effect.all([queue.rollout("t-1"), queue.rollout("t-ephemeral")])
    );
    expect(result._tag === "Success" && result.success).toEqual([
      { path: "/codex/sessions/rollout-t-1.jsonl", historyMode: "legacy" },
      { path: undefined, historyMode: "legacy" },
    ]);
    expect(codex.requests()[2]).toMatchObject({
      method: "thread/read",
      params: { threadId: "t-1" },
    });
  });

  test("a listing follows every page", async () => {
    const codex = fakeCodex("pages");
    const result = await withQueue(codex.bin, (queue) => queue.list("t-1"));
    expect(
      result._tag === "Success" && result.success && result.success.map(({ text }) => text)
    ).toEqual(["first page", "second page"]);
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

  test("a listing reads at most MAX_PAGES pages", async () => {
    const codex = fakeCodex("endless");
    const result = await withQueue(codex.bin, (queue) => queue.list("t-1"));
    expect(result._tag === "Failure" && result.failure.message).toBe(
      `the listing didn't end after ${MAX_PAGES} pages`
    );
    const lists = codex.requests().filter(({ method }) => method === "thread/queue/list");
    expect(lists).toHaveLength(MAX_PAGES);
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

describe("codex thread eligibility", () => {
  const owned = (
    approval: unknown,
    snapshot: Partial<NonNullable<Settings["snapshot"]>>
  ): Settings => ({
    session: { dynamicTools: 0, forked: false },
    approval,
    snapshot: { profileId: undefined, profile: { type: "disabled" }, mode: "default", ...snapshot },
    status: undefined,
  });
  const restricted = (...entries: Array<unknown>) => ({
    type: "managed",
    file_system: { type: "restricted", entries },
    network: "restricted",
  });
  const root = { path: { type: "special", value: { kind: "root" } }, access: "read" };
  const cwd = { path: { type: "path", path: "/work" }, access: "write" };

  test("only a thread that can't wait on a person, and keeps its permissions on resume, is eligible", () => {
    const eligible = (settings: Settings) => eligibility(settings).eligible;
    // Never asks, in Default mode, with permissions a resume keeps: a built-in profile,
    // full access, read-only.
    for (const profileId of [":workspace", ":read-only", ":danger-full-access"]) {
      expect(eligible(owned("never", { profileId, profile: restricted(root, cwd) }))).toBe(true);
    }
    expect(eligible(owned("never", { profile: { type: "disabled" } }))).toBe(true);
    expect(eligible(owned("never", { profile: restricted(root) }))).toBe(true);
    expect(
      eligible(
        owned("never", { profile: { type: "managed", file_system: { type: "unrestricted" } } })
      )
    ).toBe(true);
    // A path that is only denied is kept too, and older names for Default mode count.
    expect(
      eligible(owned("never", { profile: restricted(root, { ...cwd, access: "deny" }) }))
    ).toBe(true);
    expect(eligible(owned("never", { mode: "code" }))).toBe(true);

    // A turn could wait on an approval.
    for (const approval of ["on-request", "untrusted", "on-failure", { granular: {} }]) {
      expect(eligible(owned(approval, { profileId: ":danger-full-access" }))).toBe(false);
    }
    // Or on the user's answer, in Plan mode.
    expect(eligibility(owned("never", { mode: "plan" }))).toMatchObject({
      eligible: false,
      reason: expect.stringContaining('"plan"'),
    });
    // The older workspace-write lists paths, which a resume drops for the daemon's default.
    expect(eligibility(owned("never", { profile: restricted(root, cwd) }))).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("workspace-write"),
    });
    expect(
      eligible(
        owned("never", {
          profile: restricted({ path: { type: "glob_pattern", pattern: "*" }, access: "read" }),
        })
      )
    ).toBe(false);
    // A profile from the owner's config falls back to the default if it stops compiling.
    expect(eligible(owned("never", { profileId: "my-profile" }))).toBe(false);
    // Switching to a built-in keeps the earlier profile's denials, which compiling it
    // again on resume would drop.
    const secrets = { path: { type: "glob_pattern", pattern: "**/*.env" }, access: "deny" };
    expect(
      eligibility(owned("never", { profileId: ":read-only", profile: restricted(root, secrets) }))
    ).toMatchObject({ eligible: false, reason: expect.stringContaining("denies paths") });
    // With no snapshot of its own, a resume applies the daemon's default.
    const session = { dynamicTools: 0, forked: false };
    const status = undefined;
    expect(eligible({ session, approval: "never", snapshot: undefined, status })).toBe(false);
    expect(eligible({ session, approval: undefined, snapshot: undefined, status })).toBe(false);
    // A resume restores a client's tools, and a call to one waits for that client.
    const full = owned("never", { profileId: ":danger-full-access" });
    expect(eligibility({ ...full, session: { dynamicTools: 2, forked: false } })).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("registered tools"),
    });
    // A rollout with no session record.
    expect(eligible({ ...full, session: undefined })).toBe(false);
    // Kinds it doesn't know.
    expect(eligible(owned("never", { profile: { type: "external", network: "restricted" } }))).toBe(
      false
    );
    expect(
      eligible(owned("never", { profile: { type: "managed", file_system: { type: "new-kind" } } }))
    ).toBe(false);
  });

  const context = (approval: string) => ({
    type: "turn_context",
    payload: { approval_policy: approval },
  });
  const latest = (file: string, chunkSize?: number) =>
    Effect.runPromise(latestSettings(file, "t-1", chunkSize));

  test("approval comes from the latest record of either kind, permissions from the thread's own latest snapshot", async () => {
    const said = {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: 'a "turn_context" with "approval_policy":"on-request"' },
        ],
      },
    };
    const file = rolloutOf([
      { type: "session_meta", payload: { id: "t-1", dynamic_tools: [{ name: "list_threads" }] } },
      snapshot("t-1", "on-request", { profileId: ":workspace" }),
      snapshot("t-1", "never", { profileId: ":danger-full-access" }),
      // History copied from another thread, as a fork carries, isn't this thread's.
      snapshot("t-parent", "never", { profileId: ":read-only" }),
      context("never"),
      said,
    ]);
    // A record still being written, with no line end yet.
    writeFileSync(file, JSON.stringify(snapshot("t-1", "on-request")).slice(0, 90), { flag: "a" });
    expect(await latest(file)).toEqual({
      session: { dynamicTools: 1, forked: false },
      approval: "never",
      snapshot: {
        profileId: ":danger-full-access",
        profile: { type: "disabled" },
        mode: "default",
      },
      status: undefined,
    });
    // A latest approval other than never settles it: the rest isn't read.
    const newer = rolloutOf([snapshot("t-1", "never"), context("on-request")]);
    expect(await latest(newer)).toEqual({
      session: undefined,
      approval: "on-request",
      snapshot: undefined,
      status: undefined,
    });
    // Only another thread's snapshot: none of its own.
    const copied = await latest(rolloutOf([snapshot("t-parent", "never"), context("never")]));
    expect(copied).toEqual({
      session: undefined,
      approval: "never",
      snapshot: undefined,
      status: undefined,
    });
  });

  test("a rollout is read backwards in chunks, across lines that span them", async () => {
    const long = { type: "response_item", payload: { text: "x".repeat(5_000) } };
    const file = rolloutOf([
      {
        type: "session_meta",
        payload: {
          base_instructions: { text: "x".repeat(5_000) },
          dynamic_tools: [],
        },
      },
      snapshot("t-1", "never"),
      long,
      long,
      { type: "event_msg", payload: { type: "task_complete" } },
    ]);
    for (const chunkSize of [7, 64, 4_096, 1 << 20]) {
      const settings = await latest(file, chunkSize);
      expect(settings.snapshot?.mode).toBe("default");
      expect(settings.session).toEqual({ dynamicTools: 0, forked: false });
      expect(settings.status).toEqual({ type: "task_complete", reason: undefined });
    }
    expect(await latest(rolloutOf([{ type: "session_meta", payload: {} }]), 7)).toEqual({
      session: { dynamicTools: 0, forked: false },
      approval: undefined,
      snapshot: undefined,
      status: undefined,
    });
  });

  const event = (type: string, reason?: string) => ({
    type: "event_msg",
    payload: { type, ...(reason === undefined ? {} : { reason }) },
  });

  test("a thread whose last turn was interrupted isn't eligible, since Codex runs no queued input then", async () => {
    const meta = (payload: Record<string, unknown> = {}) => ({
      type: "session_meta",
      payload: { id: "t-1", ...payload },
    });
    const check = async (...lines: Array<unknown>) =>
      eligibility(await latest(rolloutOf([meta(), snapshot("t-1", "never"), ...lines])));
    for (const reason of ["interrupted", "budget_limited"]) {
      expect(await check(event("task_started"), event("turn_aborted", reason))).toMatchObject({
        eligible: false,
        reason: expect.stringContaining("interrupted"),
      });
    }
    // Other abort reasons and a failed turn restore an errored status, which runs the queue.
    for (const reason of ["replaced", "review_ended"]) {
      expect(await check(event("turn_aborted", reason))).toEqual({ eligible: true });
    }
    const failed = {
      type: "event_msg",
      payload: { type: "task_complete", error: { message: "x" } },
    };
    expect(await check(failed)).toEqual({ eligible: true });
    // A later turn, or one cut off by a crash, leaves the interruption behind.
    expect(
      await check(
        event("turn_aborted", "interrupted"),
        event("task_started"),
        event("task_complete")
      )
    ).toEqual({ eligible: true });
    expect(await check(event("turn_aborted", "interrupted"), event("task_started"))).toEqual({
      eligible: true,
    });
    // Transient events are never written, but one that was wouldn't count.
    expect(await check(event("turn_aborted", "interrupted"), event("error"))).toMatchObject({
      eligible: false,
    });
    // A thread that has never run a turn isn't interrupted; a fork by reference with no turn of
    // its own takes its status from its lineage, which its own file doesn't hold.
    expect(await check()).toEqual({ eligible: true });
    const fork = rolloutOf([meta({ history_base: { ordinal: 3 } }), snapshot("t-1", "never")]);
    expect(eligibility(await latest(fork))).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("forked"),
    });
    const ran = rolloutOf([
      meta({ history_base: { ordinal: 3 } }),
      snapshot("t-1", "never"),
      event("task_complete"),
    ]);
    expect(eligibility(await latest(ran))).toEqual({ eligible: true });
  });

  test("the status event and the snapshot are both found, in either order and across chunks", async () => {
    const statusFirst = rolloutOf([
      { type: "session_meta", payload: {} },
      event("turn_aborted", "interrupted"),
      { type: "response_item", payload: { text: "y".repeat(3_000) } },
      snapshot("t-1", "never"),
    ]);
    const snapshotFirst = rolloutOf([
      { type: "session_meta", payload: {} },
      snapshot("t-1", "never"),
      { type: "response_item", payload: { text: "y".repeat(3_000) } },
      event("turn_aborted", "interrupted"),
    ]);
    for (const chunkSize of [5, 512, 1 << 20]) {
      for (const file of [statusFirst, snapshotFirst]) {
        const settings = await latest(file, chunkSize);
        expect(settings.status).toEqual({ type: "turn_aborted", reason: "interrupted" });
        expect(settings.snapshot?.mode).toBe("default");
      }
    }
  });

  test("a rollout that is missing, or of a history mode it doesn't know, makes a thread ineligible, not a failure", async () => {
    const check = (stored: Stored) => Effect.runPromise(readEligibility("t-1", stored));
    expect(
      await check({ path: join(tempDir(), "missing.jsonl"), historyMode: "legacy" })
    ).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("can't be read"),
    });
    expect(await check({ path: undefined, historyMode: "legacy" })).toMatchObject({
      eligible: false,
    });
    const good = rolloutOf([
      { type: "session_meta", payload: { id: "t-1" } },
      snapshot("t-1", "never"),
    ]);
    expect(await check({ path: good, historyMode: "legacy" })).toEqual({ eligible: true });
    expect(await check({ path: good, historyMode: "paginated" })).toEqual({ eligible: true });
    expect(await check({ path: good, historyMode: "segmented" })).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("segmented"),
    });
    expect(await check({ path: good, historyMode: undefined })).toMatchObject({ eligible: false });
  });
});

describe("codex daemon borrow", () => {
  /** A Unix socket path short enough for macOS's limit, whatever the temp directory. */
  const socketPath = () => join(mkdtempSync("/tmp/ab-"), "d.sock");

  /**
   * A stand-in daemon on a Unix socket: WebSocket JSON-RPC at `/rpc`. It
   * records requests and answers each as `answer` says; "silent" sends nothing.
   */
  const standIn = (
    answer: (
      method: string,
      count: number
    ) => { result: unknown } | { error: { message: string } } | "silent",
    socket = socketPath()
  ) => {
    const requests: Array<{ method: string; params?: unknown }> = [];
    const counts = new Map<string, number>();
    const state = { open: 0 };
    const server = Bun.serve({
      unix: socket,
      fetch: (request, server) =>
        new URL(request.url).pathname === "/rpc" && server.upgrade(request)
          ? undefined
          : new Response("not found", { status: 404 }),
      websocket: {
        open: () => {
          state.open += 1;
        },
        close: () => {
          state.open -= 1;
        },
        message: (ws, data) => {
          const message = JSON.parse(String(data)) as {
            id?: number;
            method: string;
            params?: unknown;
          };
          requests.push({ method: message.method, params: message.params });
          if (message.id === undefined) return;
          const count = (counts.get(message.method) ?? 0) + 1;
          counts.set(message.method, count);
          const reply =
            message.method === "initialize" ? { result: {} } : answer(message.method, count);
          if (reply !== "silent")
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }));
        },
      },
    });
    return { socket, requests, state, stop: () => server.stop(true) };
  };
  const ok = (method: string) => ({
    result: method === "thread/unsubscribe" ? { status: "unsubscribed" } : { thread: {} },
  });
  const refuse = (message: string) => ({ error: { message } });
  const notStarted = Effect.fail(
    new CodexError({ method: "app-server daemon start", message: "not expected" })
  );

  const borrow = (
    socket: string,
    start: Effect.Effect<void, CodexError> = notStarted,
    timeout = Duration.seconds(2),
    startTimeout = Duration.seconds(2)
  ) =>
    Effect.runPromise(
      Effect.result(daemonBorrower({ socket, start, timeout, startTimeout }).borrow("t-1"))
    );

  test("a borrow resumes with a 5 s release, unsubscribes and disconnects, asking nothing else", async () => {
    const daemon = standIn(ok);
    const result = await borrow(daemon.socket);
    expect(result._tag === "Success" && result.success).toBe("loaded");
    expect(daemon.requests.map((r) => r.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/unsubscribe",
    ]);
    expect(daemon.requests[0]?.params).toMatchObject({ capabilities: null });
    expect(daemon.requests[2]?.params).toEqual({
      threadId: "t-1",
      excludeTurns: true,
      config: { thread_unload_delay_secs: 5 },
    });
    for (let tries = 0; daemon.state.open > 0 && tries < 100; tries++) await Bun.sleep(10);
    expect(daemon.state.open).toBe(0);
    daemon.stop();
  });

  test("a thread another process holds is left to it", async () => {
    const daemon = standIn(() => refuse("thread t-1 already has an active writer"));
    const result = await borrow(daemon.socket);
    expect(result._tag === "Success" && result.success).toBe("held");
    expect(daemon.requests.map((r) => r.method)).not.toContain("thread/unsubscribe");
    daemon.stop();
  });

  test("a thread being released is asked for once more, a second later", async () => {
    const closing = refuse("thread t-1 is closing; retry thread/resume after the thread is closed");
    const daemon = standIn((method, count) =>
      method === "thread/resume" && count === 1 ? closing : ok(method)
    );
    const started = Date.now();
    const result = await borrow(daemon.socket);
    expect(result._tag === "Success" && result.success).toBe("loaded");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(daemon.requests.filter((r) => r.method === "thread/resume").length).toBe(2);
    daemon.stop();

    const still = standIn(() => closing);
    const again = await borrow(still.socket);
    expect(again._tag === "Failure" && again.failure.message).toContain("is closing");
    still.stop();
  });

  test("any other refusal fails with Codex's message", async () => {
    const daemon = standIn(() => refuse("no rollout found for thread id t-1"));
    const result = await borrow(daemon.socket);
    expect(result._tag === "Failure" && result.failure.message).toContain("no rollout found");
    daemon.stop();
  });

  test("a missing daemon is started, then borrowed; one that won't start fails the borrow", async () => {
    const socket = socketPath();
    let starts = 0;
    let daemon: ReturnType<typeof standIn> | undefined;
    const start = Effect.sync(() => {
      starts += 1;
      daemon = standIn(ok, socket);
    });
    const result = await borrow(socket, start);
    expect(result._tag === "Success" && result.success).toBe("loaded");
    expect(starts).toBe(1);
    daemon?.stop();

    const failing = await borrow(
      socketPath(),
      Effect.fail(
        new CodexError({
          method: "app-server daemon start",
          message: "exited with 1: no managed package",
        })
      )
    );
    expect(failing._tag === "Failure" && failing.failure.message).toContain("no managed package");
  });

  test("a daemon that refuses the connection isn't started again", async () => {
    const socket = socketPath();
    const server = Bun.serve({
      unix: socket,
      fetch: () => new Response("upgrade refused", { status: 400 }),
    });
    let starts = 0;
    const result = await borrow(
      socket,
      Effect.sync(() => {
        starts += 1;
      })
    );
    expect(result._tag === "Failure" && result.failure.message).toBe(
      "the daemon refused the connection"
    );
    expect(starts).toBe(0);
    server.stop(true);
  });

  test("a start and the load after it share one deadline", async () => {
    const socket = socketPath();
    let daemon: ReturnType<typeof standIn> | undefined;
    const slowStart = Effect.andThen(
      Effect.sleep(Duration.millis(400)),
      Effect.sync(() => {
        daemon = standIn(() => "silent", socket);
      })
    );
    const started = Date.now();
    const result = await borrow(socket, slowStart, Duration.millis(300), Duration.millis(300));
    // 300 + 300 ms, not the start's 400 plus another 300.
    expect(Date.now() - started).toBeLessThan(680);
    expect(result._tag === "Failure" && result.failure.message).toContain("no answer within 600");
    daemon?.stop();
  });

  test("an unsubscribe that isn't answered doesn't fail the load", async () => {
    const daemon = standIn((method) => (method === "thread/unsubscribe" ? "silent" : ok(method)));
    const result = await borrow(daemon.socket);
    expect(result._tag === "Success" && result.success).toBe("loaded");
    daemon.stop();
  });

  test("a daemon that never answers is cut off at the deadline", async () => {
    const daemon = standIn(() => "silent");
    const started = Date.now();
    const result = await borrow(daemon.socket, notStarted, Duration.millis(300));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result._tag === "Failure" && result.failure.message).toContain("no answer within");
    daemon.stop();
  });

  /** A stand-in `codex` that records its arguments, then behaves as `mode` says. */
  const fakeCli = (mode: "starts" | "fails" | "hangs") => {
    const dir = tempDir();
    const bin = join(dir, "codex");
    const log = join(dir, "args");
    writeFileSync(
      bin,
      `#!${process.execPath}
await Bun.write(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
if (${JSON.stringify(mode)} === "fails") { console.error("error: no managed daemon package is installed"); process.exit(3); }
if (${JSON.stringify(mode)} === "hangs") await Bun.sleep(60_000);
`
    );
    chmodSync(bin, 0o755);
    return { bin, args: () => JSON.parse(readFileSync(log, "utf8")) as Array<string> };
  };

  test("starting the daemon runs the CLI's daemon start, and reports why it failed", async () => {
    const starts = fakeCli("starts");
    expect((await Effect.runPromise(Effect.result(startDaemon(starts.bin))))._tag).toBe("Success");
    expect(starts.args()).toEqual(["app-server", "daemon", "start"]);

    const fails = await Effect.runPromise(Effect.result(startDaemon(fakeCli("fails").bin)));
    expect(fails._tag === "Failure" && fails.failure.message).toContain(
      "exited with 3: error: no managed daemon package"
    );

    const started = Date.now();
    const hangs = await Effect.runPromise(
      Effect.result(startDaemon(fakeCli("hangs").bin, Duration.millis(300)))
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hangs._tag === "Failure" && hangs.failure.message).toContain("no answer within");
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
        expect(missing._tag).toBe("BusCallError");
        const placeholder = { AGENT_BUS_SESSION: "${AGENT_BUS_SESSION}" };
        const other = yield* Effect.flip(Client.sessionFor("other", undefined, placeholder));
        expect(other._tag).toBe("BusCallError");
        expect(other.message).toBe(
          "No usable session id for runtime other: pass --session, or run where $AGENT_BUS_SESSION is set."
        );
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

  const cliIn = (dir: string, args: ReadonlyArray<string>) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/bin.ts"), ...args], {
      stdin: "ignore",
      env: { ...process.env, AGENT_BUS_PORT: "9", AGENT_BUS_DIR: dir },
      timeout: 10_000,
    });
  const outcome = (run: ReturnType<typeof cliIn>) => [
    run.exitCode,
    run.stdout.toString(),
    run.stderr.toString(),
  ];

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

  test("a rejoin that names no topics keeps them; one that names topics replaces them; a leave clears them", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const topicsOf = () =>
          Effect.map(
            bus.peers,
            (peers) => peers.find((peer) => peer.address === "claude/a")?.presence.topics
          );
        yield* bus.join({
          address: "claude/a",
          runtime: "claude",
          session: "s1",
          cwd,
          topics: ["x", "y"],
        });
        yield* bus.join({ address: "claude/b", runtime: "claude", session: "sb", cwd });
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "s1", cwd });
        expect(yield* topicsOf()).toEqual(["x", "y"]);
        // Topic mail sent before a rejoin is still the subscriber's to read.
        yield* bus.publish({ from: "claude/b", session: "sb", to: ["#x"], body: "topic" });
        yield* bus.join({
          address: "claude/a",
          runtime: "claude",
          session: "s1",
          cwd,
          replay: false,
        });
        expect(bodies(yield* bus.take("claude/a", "s1"))).toEqual(["topic"]);
        yield* bus.join({
          address: "claude/a",
          runtime: "claude",
          session: "s1",
          cwd,
          topics: ["y"],
        });
        expect(yield* topicsOf()).toEqual(["y"]);
        yield* bus.leave("claude/a", "s1");
        yield* bus.join({ address: "claude/a", runtime: "claude", session: "s1", cwd });
        expect(yield* topicsOf()).toEqual([]);
      })
    ));

  test("a rejoin while joined continues its run of joins; a replay, a join after a leave or a takeover starts one", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const join = (session: string, extra: Partial<Bus.JoinInput> = {}) =>
          bus.join({ address: "claude/a", runtime: "claude", session, cwd, ...extra });
        const current = () =>
          Effect.map(bus.peers, (peers) => peers.find((peer) => peer.address === "claude/a"));
        yield* join("s1");
        const first = (yield* current())?.joinId;
        expect((yield* current())?.presence.rejoinOf).toBeUndefined();
        yield* join("s1");
        yield* join("s1");
        expect((yield* current())?.presence.rejoinOf).toBe(first);
        yield* join("s1", { replay: true });
        expect((yield* current())?.presence.rejoinOf).toBeUndefined();
        yield* bus.leave("claude/a", "s1");
        yield* join("s1");
        expect((yield* current())?.presence.rejoinOf).toBeUndefined();
        const holder = (yield* current())?.joinId;
        yield* join("s2", { takeover: holder });
        expect((yield* current())?.presence.rejoinOf).toBeUndefined();
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

describe("claude wake", () => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, Bus.Bus | Ledger.Ledger | Cursors.Cursors>
  ): Promise<A> => Effect.runPromise(Effect.provide(effect, jsonl().layer));
  const a = sid("claude/a");
  const joinBoth = (bus: Bus.Bus["Service"]) =>
    Effect.gen(function* () {
      for (const [address, runtime] of [
        ["claude/a", "claude"],
        ["codex/b", "codex"],
      ] as const) {
        yield* bus.join({ address, runtime, session: sid(address), cwd: process.cwd() });
      }
    });
  const send = (bus: Bus.Bus["Service"], body: string, to = "claude/a") =>
    bus.publish({ from: "codex/b", session: sid("codex/b"), to: [to], body });
  const nothing = { addresses: [], owns: true, superseded: false };
  // The timeout bounds the whole call, its first look included: long enough for that look,
  // or short when nothing is expected.
  const soon = (bus: Bus.Bus["Service"], session: string) => bus.wake(session, 5);
  const quiet = (bus: Bus.Bus["Service"], session: string) => bus.wake(session, 0.3);

  test("wakes once for unread mail and again only when it changes, marking nothing read", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* joinBoth(bus);
        yield* send(bus, "one");
        expect(yield* soon(bus, a)).toEqual({ ...nothing, addresses: ["claude/a"] });
        // Mail left unread doesn't wake again, so an ignored wake isn't repeated.
        expect(yield* quiet(bus, a)).toEqual(nothing);
        yield* send(bus, "two");
        expect((yield* soon(bus, a)).addresses).toEqual(["claude/a"]);
        // A partial read changes what is unread, so the rest wakes it once more.
        expect(bodies(yield* bus.take("claude/a", a, 1))).toEqual(["one"]);
        expect((yield* soon(bus, a)).addresses).toEqual(["claude/a"]);
        expect(bodies(yield* bus.take("claude/a", a))).toEqual(["two"]);
        expect(yield* quiet(bus, a)).toEqual(nothing);
      })
    ));

  test("waits for mail; a session that owns nothing returns at once; a newer wait ends an older one", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* joinBoth(bus);
        const waiting = yield* Effect.forkChild(bus.wake(a, 10));
        yield* Effect.sleep("100 millis");
        yield* send(bus, "later");
        expect((yield* Fiber.join(waiting)).addresses).toEqual(["claude/a"]);

        expect(yield* bus.wake(sid("claude/nobody"), 50)).toEqual({ ...nothing, owns: false });

        const older = yield* Effect.forkChild(bus.wake(a, 10));
        yield* Effect.sleep("100 millis");
        const newer = yield* Effect.forkChild(bus.wake(a, 10));
        expect(yield* Fiber.join(older)).toEqual({ ...nothing, superseded: true });
        yield* send(bus, "after");
        expect((yield* Fiber.join(newer)).addresses).toEqual(["claude/a"]);
        expect(bodies(yield* bus.take("claude/a", a))).toEqual(["later", "after"]);
      })
    ));

  test(
    "mail that races a newer wait wakes exactly one of the two",
    () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* joinBoth(bus);
          for (let round = 0; round < 12; round++) {
            const older = yield* Effect.forkChild(bus.wake(a, 5));
            yield* Effect.sleep(`${round * 3} millis`);
            yield* send(bus, `round ${round}`);
            const newer = yield* Effect.forkChild(bus.wake(a, 0.3));
            const woke = [yield* Fiber.join(older), yield* Fiber.join(newer)].filter(
              (found) => found.addresses.length > 0
            );
            expect([round, woke.length]).toEqual([round, 1]);
            yield* bus.take("claude/a", a);
          }
        })
      ),
    15_000
  );

  test("passes over what isn't the session's mail, as its read would, without waking it", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger.Ledger;
        const cursors = yield* Cursors.Cursors;
        yield* joinBoth(bus);
        yield* send(bus, "kept");
        expect((yield* soon(bus, a)).addresses).toEqual(["claude/a"]);
        yield* bus.take("claude/a", a);
        yield* send(bus, "elsewhere", "codex/c");
        yield* bus.publish({ from: "claude/a", session: a, to: ["codex/b"], body: "own" });
        expect(yield* quiet(bus, a)).toEqual(nothing);
        expect(yield* cursors.get("claude/a")).toEqual(Option.some(yield* ledger.end));
      })
    ));

  test("wakes only Claude addresses joined from this machine", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger.Ledger;
        yield* joinBoth(bus);
        // The same session holding an address joined on another machine, and a Codex one.
        for (const [address, runtime, host] of [
          ["claude/far", "claude", "elsewhere.local"],
          ["codex/same-id", "codex", hostname()],
        ] as const) {
          yield* ledger.append(
            new Message({
              id: Bun.randomUUIDv7(),
              ts: new Date().toISOString(),
              from: address,
              to: ["*"],
              kind: "presence",
              body: `${address} joined`,
              origin: new Origin({ host }),
              presence: new Presence({ runtime, status: "joined", topics: [], session: a }),
            })
          );
        }
        yield* send(bus, "far", "claude/far");
        yield* send(bus, "codex", "codex/same-id");
        yield* send(bus, "near");
        expect(yield* soon(bus, a)).toEqual({ ...nothing, addresses: ["claude/a"] });
      })
    ));

  test("a rejoin wakes again for mail still unread; after a takeover the old session owns nothing", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* joinBoth(bus);
        yield* send(bus, "kept");
        expect((yield* soon(bus, a)).addresses).toEqual(["claude/a"]);
        yield* bus.join({ address: "claude/a", runtime: "claude", session: a, cwd: process.cwd() });
        expect((yield* soon(bus, a)).addresses).toEqual(["claude/a"]);

        const holder = (yield* bus.peers).find((peer) => peer.address === "claude/a");
        yield* bus.join({
          address: "claude/a",
          runtime: "claude",
          session: "session:replacement",
          takeover: holder?.joinId,
          cwd: process.cwd(),
        });
        expect(yield* soon(bus, a)).toEqual({ ...nothing, owns: false });
        expect((yield* soon(bus, "session:replacement")).addresses).toEqual(["claude/a"]);
        expect(bodies(yield* bus.take("claude/a", "session:replacement"))).toEqual(["kept"]);
      })
    ));

  test("a session's waiting hook counts as an open wait for anyone refused its address", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* joinBoth(bus);
        const refusal = () =>
          Effect.flip(
            bus.join({
              address: "claude/a",
              runtime: "claude",
              session: "session:stranger",
              cwd: process.cwd(),
            })
          );
        expect((yield* refusal()).message).toContain("no wait open on this machine");
        const waiting = yield* Effect.forkChild(bus.wake(a, 10));
        yield* Effect.sleep("100 millis");
        expect((yield* refusal()).message).toContain("a wait open now");
        yield* Fiber.interrupt(waiting);
        expect((yield* refusal()).message).toContain("no wait open on this machine");
      })
    ));

  test("marks move only where no other wake moved them, and a lost result puts them back", () => {
    const mark = (unread: string) => ({ joinId: "join", unread });
    const woken = new Map([["claude/b", mark("b1..b1")]]);
    const moved: Array<Bus.Moved> = [];
    const found = [
      { address: "claude/a", previous: undefined, mark: mark("a1..a1") },
      // Read before another wake moved claude/b's mark: stale, so skipped.
      { address: "claude/b", previous: undefined, mark: mark("b1..b2") },
      { address: "claude/c", previous: undefined, mark: mark("c1..c1") },
    ];
    expect(Bus.commitMarks(woken, found, moved)).toEqual(["claude/a", "claude/c"]);
    // Unchanged unread mail moves nothing.
    const again = { address: "claude/a", previous: woken.get("claude/a"), mark: mark("a1..a1") };
    expect(Bus.commitMarks(woken, [again], [])).toEqual([]);
    // claude/a's result was returned; claude/c's was lost, so its mark goes back.
    Bus.restoreMarks(woken, moved, ["claude/a"]);
    expect([...woken.keys()].sort()).toEqual(["claude/a", "claude/b"]);
    // A mark another wake has moved since is left alone.
    const later = [{ address: "claude/a", previous: undefined, mark: mark("a1..a1") }];
    woken.set("claude/a", mark("a1..a2"));
    Bus.restoreMarks(woken, later, []);
    expect(woken.get("claude/a")).toEqual(mark("a1..a2"));
  });

  test("a join says whether this bus has seen the session's wake hook", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const join = (address: string) =>
          bus.join({ address, runtime: "claude", session: a, cwd: process.cwd() });
        expect(yield* join("claude/a")).not.toHaveProperty("hooked");
        yield* quiet(bus, a);
        expect((yield* join("claude/a")).hooked).toBe(true);
        expect((yield* join("claude/a2")).hooked).toBe(true);
        // Only Claude addresses are woken, so only a Claude join is told whether its hook runs.
        expect(
          yield* bus.join({ address: "other/a", runtime: "other", session: a, cwd: process.cwd() })
        ).not.toHaveProperty("hooked");
        expect(
          yield* bus.join({
            address: "codex/b",
            runtime: "codex",
            session: sid("codex/b"),
            cwd: process.cwd(),
          })
        ).not.toHaveProperty("hooked");
      })
    ));

  /** A JSONL bus whose next reads can be planned: read, fail, or wait for a signal first. */
  const unreliable = () => {
    const dir = tempDir();
    const planned: Array<"read" | "fail" | Deferred.Deferred<void>> = [];
    const ledger = Layer.effect(
      Ledger.Ledger,
      Effect.gen(function* () {
        const inner = yield* Ledger.Ledger;
        return Ledger.Ledger.of({
          ...inner,
          read: (from) =>
            Effect.suspend(() => {
              const next = planned.shift() ?? "read";
              if (next === "read") return inner.read(from);
              if (next === "fail") return Effect.fail(new LedgerError({ message: "store down" }));
              return Effect.andThen(Deferred.await(next), inner.read(from));
            }),
        });
      })
    ).pipe(Layer.provide(layerJsonl(join(dir, "ledger.jsonl")).pipe(Layer.provide(platform))));
    return {
      layer: busOn(ledger, dir).pipe(Layer.provide(platform)),
      plan: (...reads: typeof planned) => {
        planned.push(...reads);
      },
    };
  };

  test("a read that fails for a later address loses no earlier address's wake", () => {
    const { layer, plan } = unreliable();
    return Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* joinBoth(bus);
        yield* bus.join({
          address: "claude/a2",
          runtime: "claude",
          session: a,
          cwd: process.cwd(),
        });
        yield* send(bus, "first");
        yield* send(bus, "second", "claude/a2");
        // claude/a is read, then claude/a2's read fails: claude/a wakes now, claude/a2 next pass.
        plan("read", "fail");
        expect((yield* soon(bus, a)).addresses).toEqual(["claude/a"]);
        expect((yield* soon(bus, a)).addresses).toEqual(["claude/a2"]);
      }).pipe(Effect.provide(layer))
    );
  });

  test("a scan outrun by a takeover doesn't overwrite the new owner's mark", () => {
    const { layer, plan } = unreliable();
    return Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* joinBoth(bus);
        yield* bus.join({
          address: "claude/a2",
          runtime: "claude",
          session: a,
          cwd: process.cwd(),
        });
        yield* send(bus, "first");
        yield* send(bus, "second", "claude/a2");
        // The old owner's scan reads claude/a, then stalls on claude/a2.
        const stall = yield* Deferred.make<void>();
        plan("read", stall);
        const old = yield* Effect.forkChild(soon(bus, a));
        yield* Effect.sleep("50 millis");
        const holder = (yield* bus.peers).find((peer) => peer.address === "claude/a");
        yield* bus.join({
          address: "claude/a",
          runtime: "claude",
          session: "session:new",
          takeover: holder?.joinId,
          cwd: process.cwd(),
        });
        expect((yield* soon(bus, "session:new")).addresses).toEqual(["claude/a"]);
        yield* Deferred.succeed(stall, undefined);
        expect((yield* Fiber.join(old)).addresses).toEqual(["claude/a2"]);
        expect(yield* quiet(bus, "session:new")).toEqual(nothing);
      }).pipe(Effect.provide(layer))
    );
  });

  test("a stalled read doesn't outlast the timeout or a newer wait, and moves no mark", () => {
    const { layer, plan } = unreliable();
    return Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* joinBoth(bus);
        yield* send(bus, "held");
        const stall = yield* Deferred.make<void>();
        plan(stall);
        const started = Date.now();
        expect(yield* quiet(bus, a)).toEqual(nothing);
        expect(Date.now() - started).toBeLessThan(2_000);

        plan(stall);
        const older = yield* Effect.forkChild(bus.wake(a, 10));
        yield* Effect.sleep("50 millis");
        const newer = yield* Effect.forkChild(bus.wake(a, 10));
        expect(yield* Fiber.join(older)).toEqual({ ...nothing, superseded: true });
        expect((yield* Fiber.join(newer)).addresses).toEqual(["claude/a"]);
        yield* Deferred.succeed(stall, undefined);
      }).pipe(Effect.provide(layer))
    );
  });

  test("a wait without a usable session is refused", () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        for (const session of [undefined, "", "${CLAUDE_CODE_SESSION_ID}"]) {
          expect((yield* Effect.flip(bus.wake(session, 0)))._tag).toBe("NotOwner");
        }
      })
    ));
});

describe("claude wake hook", () => {
  /** A stand-in for the bus that answers each call with the next result, recording the calls. */
  const scripted = (results: ReadonlyArray<Effect.Effect<unknown, Client.BusCallError>>) => {
    const calls: Array<readonly [string, Record<string, unknown>]> = [];
    const call = ((name: string, _schema: unknown, args: Record<string, unknown>) => {
      calls.push([name, args]);
      return results[Math.min(calls.length, results.length) - 1];
    }) as unknown as ReturnType<typeof Client.call>;
    return { call, calls };
  };
  const input = JSON.stringify({ session_id: sid("claude/a"), hook_event_name: "Stop" });
  const answer = (addresses: ReadonlyArray<string>, owns = true, superseded = false) =>
    Effect.succeed({ addresses, owns, superseded });
  const failure = Effect.fail(new Client.BusCallError({ message: "no" }));
  // The stand-in never calls out, but the hook's type still names an HTTP client.
  const wake = (hookInput: string, call: ReturnType<typeof Client.call>) =>
    Effect.runPromise(
      claudeWake("unused", hookInput, call).pipe(Effect.provide(FetchHttpClient.layer))
    );

  test("waits through empty answers, then nudges once per address, naming only the address", async () => {
    const { call, calls } = scripted([answer([]), answer(["claude/a", "claude/b"])]);
    expect(await wake(input, call)).toEqual(
      Option.some(`${formatWake("claude/a")}\n${formatWake("claude/b")}`)
    );
    expect(calls).toEqual([
      ["bus_wake", { session: sid("claude/a") }],
      ["bus_wake", { session: sid("claude/a") }],
    ]);
    expect(formatWake("claude/a")).toStartWith(
      '[agent-bus] New messages for "claude/a". Read them'
    );
  });

  test("ends without a wake when superseded, owning nothing, or given no session", async () => {
    for (const result of [answer([], true, true), answer([], false)]) {
      const { call } = scripted([result]);
      expect(await wake(input, call)).toEqual(Option.none());
    }
    for (const bad of ["{}", "not json", JSON.stringify({ session_id: "" })]) {
      const { call, calls } = scripted([answer(["claude/a"])]);
      expect(await wake(bad, call)).toEqual(Option.none());
      expect(calls).toEqual([]);
    }
  });

  test("retries any failure every five seconds, and gives up after ten minutes of them", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // Unreachable, then refused (a bus from before bus_wake, or its store down), then up.
        const retried = scripted([failure, failure, answer(["claude/a"])]);
        const fiber = yield* Effect.forkChild(claudeWake("unused", input, retried.call));
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(fiber)).toEqual(Option.some(formatWake("claude/a")));

        const down = scripted([failure]);
        const giving = yield* Effect.forkChild(
          claudeWake("unused", input, down.call, Duration.minutes(10))
        );
        yield* TestClock.adjust("10 minutes");
        expect(yield* Fiber.join(giving)).toEqual(Option.none());
        expect(down.calls.length).toBe(121);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), FetchHttpClient.layer)))
    ));
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

  test("the CLI looks up an address's runtime on the bus, and refuses one that hasn't joined", () => {
    const { url, layer } = serve();
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* Client.call(url)("bus_join", Mcp.Joined, {
          address: "claude/a",
          runtime: "claude",
          session: sid("claude/a"),
          cwd: process.cwd(),
        });
        expect(yield* Client.runtimeOf(url, "claude/a")).toBe("claude");
        expect((yield* Effect.flip(Client.runtimeOf(url, "claude/nobody")))._tag).toBe(
          "BusCallError"
        );
      }).pipe(Effect.provide(Layer.merge(layer, FetchHttpClient.layer)))
    );
  });

  test("the plugin's hook command runs the checkout through ~/.local/bin/agent-bus, with bun only in ~/.bun/bin", () => {
    const { url, port, layer } = serve();
    const marketplace = JSON.parse(
      readFileSync(join(import.meta.dir, "../.claude-plugin/marketplace.json"), "utf8")
    ) as { readonly plugins: ReadonlyArray<{ readonly source: string }> };
    expect(marketplace.plugins.map((plugin) => plugin.source)).toEqual(["./plugin"]);
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "../plugin/.claude-plugin/plugin.json"), "utf8")
    ) as {
      readonly hooks: Record<
        string,
        ReadonlyArray<{ readonly hooks: ReadonlyArray<{ readonly command: string }> }>
      >;
    };
    const commands = new Set(
      Object.values(manifest.hooks).flatMap((matchers) =>
        matchers.flatMap((matcher) => matcher.hooks.map((hook) => hook.command))
      )
    );
    expect(commands.size).toBe(1);
    // The cached plugin holds only the manifest, so the command names nothing inside it.
    const command = [...commands][0];
    expect(command).not.toContain("CLAUDE_PLUGIN_ROOT");
    // A home whose bun is ~/.bun/bin/bun and whose launcher links to this checkout; a PATH
    // whose own `bun` and `agent-bus` fail; another working directory, so the checkout's
    // dependencies come through the link.
    const home = tempDir();
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    symlinkSync(process.execPath, join(home, ".bun", "bin", "bun"));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(join(import.meta.dir, "../src/bin.ts"), join(home, ".local", "bin", "agent-bus"));
    const decoys = join(home, "decoys");
    mkdirSync(decoys);
    for (const name of ["bun", "agent-bus"]) {
      writeFileSync(join(decoys, name), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    }
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
        yield* call("bus_publish", Mcp.Published, {
          from: "codex/b",
          session: sid("codex/b"),
          to: ["claude/a"],
          body: "wake",
        });
        const result = yield* Effect.promise(async () => {
          const child = Bun.spawn(["/bin/sh", "-c", command ?? ""], {
            cwd: home,
            timeout: 20_000,
            stdin: new Blob([JSON.stringify({ session_id: sid("claude/a") })]),
            stdout: "ignore",
            stderr: "pipe",
            env: { HOME: home, PATH: `${decoys}:/usr/bin:/bin`, AGENT_BUS_PORT: String(port) },
          });
          const [code, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          return { code, stderr: stderr.trim() };
        });
        expect(result).toEqual({ code: 2, stderr: formatWake("claude/a") });
      }).pipe(Effect.provide(Layer.merge(layer, FetchHttpClient.layer)))
    );
  });

  test("the CLI takes an address over only with --takeover, through bus_takeover", () => {
    const { url, port, layer } = serve();
    const cli = (...args: Array<string>) =>
      Effect.promise(async () => {
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, "../src/bin.ts"), ...args],
          {
            timeout: 20_000,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, AGENT_BUS_PORT: String(port) },
          }
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, out: (stdout + stderr).trim() };
      });
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* Client.call(url)("bus_join", Mcp.Joined, {
          address: "claude/a",
          runtime: "claude",
          session: "old",
          cwd: process.cwd(),
        });
        const joining = [
          "join",
          "--address",
          "claude/a",
          "--runtime",
          "claude",
          "--session",
          "new",
        ];
        const refused = yield* cli(...joining);
        expect(refused.code).toBe(1);
        expect(refused.out).toContain("bus_takeover");
        const holder = /holder "([^"]+)"/.exec(refused.out)?.[1] ?? "";
        expect(yield* cli(...joining, "--takeover", holder)).toEqual({
          code: 0,
          out: "joined as claude/a",
        });
      }).pipe(Effect.provide(Layer.merge(layer, FetchHttpClient.layer)))
    );
  });

  test("the Claude wake hook exits 2 with the nudge on stderr, marking nothing read, and 0 for a stranger", () => {
    const { url, port, layer } = serve();
    const hook = (session: string) =>
      Effect.promise(async () => {
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, "../src/bin.ts"), "claude-wake"],
          {
            stdin: new Blob([JSON.stringify({ session_id: session, hook_event_name: "Stop" })]),
            stdout: "ignore",
            stderr: "pipe",
            env: {
              ...process.env,
              AGENT_BUS_PORT: String(port),
              AGENT_BUS_DIR: join(tmpdir(), "no-agent-bus"),
            },
          }
        );
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        return { code, stderr: stderr.trim() };
      });
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
        yield* call("bus_publish", Mcp.Published, {
          from: "codex/b",
          session: sid("codex/b"),
          to: ["claude/a"],
          body: "wake",
        });
        expect(yield* hook(sid("claude/a"))).toEqual({ code: 2, stderr: formatWake("claude/a") });
        expect(yield* hook("session:nobody")).toEqual({ code: 0, stderr: "" });
        const { messages } = yield* call("bus_read", Mcp.Messages, {
          address: "claude/a",
          session: sid("claude/a"),
        });
        expect(bodies(messages)).toEqual(["wake"]);
      }).pipe(Effect.provide(Layer.merge(layer, FetchHttpClient.layer)))
    );
  });
});
