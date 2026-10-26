import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import * as Client from "../src/client.ts";
import {
  CodexError,
  connect,
  type Daemon,
  deliverOnce,
  deliveryTargets,
  formatDelivery,
  type Refusals,
} from "../src/codex.ts";
import { Message, Origin, Presence } from "../src/domain.ts";
import * as Fluree from "../src/Fluree.ts";
import * as Ledger from "../src/Ledger.ts";
import * as Mcp from "../src/mcp.ts";
import * as Serve from "../src/serve.ts";
import { validateSelect } from "../src/sparql.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "agent-bus-test-"));
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);

const busOn = (ledger: Layer.Layer<Ledger.Ledger, unknown, never>, dir: string) =>
  Bus.layer.pipe(
    Layer.provideMerge(ledger),
    Layer.provide(Cursors.layerFiles(join(dir, "cursors")))
  );

const jsonl = () => {
  const dir = tempDir();
  const file = join(dir, "ledger.jsonl");
  return {
    file,
    layer: busOn(Ledger.layerJsonl(file).pipe(Layer.provide(platform)), dir).pipe(
      Layer.provide(platform)
    ),
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

const bodies = (messages: ReadonlyArray<{ readonly body: string }>) => messages.map((m) => m.body);

for (const backend of backends) {
  const run = <A, E>(effect: Effect.Effect<A, E, Bus.Bus | Ledger.Ledger>) =>
    Effect.runPromise(Effect.provide(effect, backend.make().layer));

  describe.if(backend.enabled)(`delivery (${backend.name})`, () => {
    test("routes direct, topic and broadcast messages, never back to the sender", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({ address: "claude/a", runtime: "claude", cwd: process.cwd() });
          yield* bus.join({
            address: "codex/b",
            runtime: "codex",
            cwd: process.cwd(),
            topics: ["reviews"],
          });
          yield* bus.publish({ from: "claude/a", to: ["codex/b"], body: "direct" });
          yield* bus.publish({ from: "claude/a", to: ["#reviews"], body: "topic" });
          yield* bus.publish({ from: "claude/a", to: ["#other"], body: "other topic" });
          yield* bus.publish({ from: "claude/a", to: ["*"], body: "everyone" });

          expect(bodies(yield* bus.take("codex/b"))).toEqual(["direct", "topic", "everyone"]);
          expect(yield* bus.take("claude/a")).toEqual([]);
        })
      ));

    test("take marks messages read; a limit leaves the rest unread", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({ address: "codex/b", runtime: "codex", cwd: process.cwd() });
          for (const body of ["one", "two", "three"]) {
            yield* bus.publish({ from: "claude/a", to: ["codex/b"], body });
          }
          expect(bodies(yield* bus.take("codex/b", 2))).toEqual(["one", "two"]);
          expect(bodies(yield* bus.take("codex/b"))).toEqual(["three"]);
          expect(yield* bus.take("codex/b")).toEqual([]);
        })
      ));

    test("new subscribers start at the present; replay and rejoin keep history", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.publish({ from: "claude/a", to: ["*"], body: "before" });
          yield* bus.join({ address: "codex/late", runtime: "codex", cwd: process.cwd() });
          yield* bus.join({
            address: "codex/replay",
            runtime: "codex",
            cwd: process.cwd(),
            replay: true,
          });
          expect(yield* bus.take("codex/late")).toEqual([]);
          expect(bodies(yield* bus.take("codex/replay"))).toEqual(["before"]);

          yield* bus.publish({ from: "claude/a", to: ["codex/late"], body: "while away" });
          yield* bus.join({ address: "codex/late", runtime: "codex", cwd: process.cwd() });
          expect(bodies(yield* bus.take("codex/late"))).toEqual(["while away"]);
        })
      ));

    test("reading requires joining, and leaving removes a peer", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const missing = yield* Effect.flip(bus.take("nobody"));
          expect(missing._tag).toBe("NotJoined");

          yield* bus.join({
            address: "codex/b",
            runtime: "codex",
            cwd: process.cwd(),
            note: "testing",
          });
          expect((yield* bus.peers).map((peer) => peer.address)).toEqual(["codex/b"]);
          yield* bus.leave("codex/b");
          expect(yield* bus.peers).toEqual([]);
        })
      ));

    test("wait returns as soon as a message arrives, and times out empty", () =>
      run(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({ address: "claude/a", runtime: "claude", cwd: process.cwd() });
          const waiting = yield* Effect.forkChild(bus.wait("claude/a", 10));
          yield* Effect.sleep("200 millis");
          yield* bus.publish({ from: "codex/b", to: ["claude/a"], body: "ping" });
          expect(bodies(yield* Fiber.join(waiting))).toEqual(["ping"]);
          expect(yield* bus.wait("claude/a", 0.3)).toEqual([]);
        })
      ));
  });

  test.if(backend.enabled)(`records where each sender joined from (${backend.name})`, () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const gone = tempDir();
        yield* bus.join({ address: "claude/a", runtime: "claude", cwd: process.cwd() });
        yield* bus.join({ address: "claude/gone", runtime: "claude", cwd: gone });
        rmSync(gone, { recursive: true });

        const message = yield* bus.publish({ from: "claude/a", to: ["*"], body: "x" });
        expect(message.origin?.cwd).toBe(process.cwd());
        expect(message.origin?.repo).toBe(process.cwd());
        expect(message.origin?.branch).toBeDefined();
        const [stored] = yield* bus.history({ limit: 1 });
        expect(stored?.origin).toEqual(message.origin);

        // A directory that has since disappeared, or a sender that never joined, records only the machine.
        const fromGone = yield* bus.publish({ from: "claude/gone", to: ["*"], body: "y" });
        expect(fromGone.origin).toEqual(new Origin({ host: hostname(), cwd: gone }));
        const anonymous = yield* bus.publish({ from: "claude/never", to: ["*"], body: "z" });
        expect(anonymous.origin).toEqual(new Origin({ host: hostname() }));
      })
    )
  );

  test.if(backend.enabled)(`history filters by participant and text (${backend.name})`, () =>
    run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* bus.publish({
          from: "claude/a",
          to: ["codex/b"],
          body: "the ledger adapter is ready",
        });
        yield* bus.publish({ from: "codex/b", to: ["claude/c"], subject: "ledger", body: "noted" });
        yield* bus.publish({ from: "claude/c", to: ["*"], body: "lunch?" });

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
          yield* bus.publish({ from: "claude/a", to: ["*"], body: "Deploying the adapters now" });
          yield* bus.publish({ from: "claude/a", to: ["*"], body: "unrelated" });
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
          yield* bus.join({ address: "codex/b", runtime: "codex", cwd: process.cwd() });
        }),
        second
      )
    );
    const waiting = Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          return yield* bus.wait("codex/b", 10);
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
          yield* bus.publish({ from: "claude/a", to: ["codex/b"], body: "across processes" });
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
            yield* bus.join({ address: "codex/b", runtime: "codex", cwd: process.cwd() });
            const sent = Array.from({ length: 520 }, (_, i) => `m${i}`);
            yield* Effect.forEach(
              sent,
              (body) => bus.publish({ from: "claude/a", to: ["codex/b"], body }),
              { concurrency: 16 }
            );
            const received = bodies(yield* bus.take("codex/b"));
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

describe("jsonl ledger", () => {
  test("ignores a partial trailing line until it is complete", () => {
    const { file, layer } = jsonl();
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const ledger = yield* Ledger.Ledger;
          yield* bus.join({ address: "codex/b", runtime: "codex", cwd: process.cwd() });
          yield* bus.publish({ from: "claude/a", to: ["codex/b"], body: "whole" });
          const before = yield* ledger.end;
          appendFileSync(file, '{"id":"partial"');
          const slice = yield* ledger.read(0);
          expect(slice.next).toBe(before);
          expect(bodies(yield* bus.take("codex/b"))).toEqual(["whole"]);
        }),
        layer
      )
    );
  });
});

describe("codex delivery text", () => {
  test("lists every message and how to reply to the first", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const first = yield* bus.publish({
            from: "claude/a",
            to: ["codex/b"],
            subject: "s",
            body: "one",
          });
          const second = yield* bus.publish({ from: "claude/a", to: ["codex/b"], body: "two" });
          const text = formatDelivery("codex/b", [first, second]);
          expect(text).toStartWith("[agent-bus] 2 new messages for codex/b");
          expect(text).toContain("subject: s");
          expect(text).toContain(`replyTo "${first.id}"`);
        }),
        jsonl().layer
      )
    ));
});

describe("codex delivery routing", () => {
  test("each machine's deliverer wakes only the Codex peers that joined from it", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const ledger = yield* Ledger.Ledger;
          yield* bus.join({
            address: "codex/here",
            runtime: "codex",
            cwd: process.cwd(),
            codexThreadId: "t-here",
          });
          yield* bus.join({ address: "codex/no-thread", runtime: "codex", cwd: process.cwd() });
          yield* bus.join({ address: "claude/here", runtime: "claude", cwd: process.cwd() });
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

describe("codex daemon connection", () => {
  test("a daemon that never completes the handshake fails at the deadline", async () => {
    const socketPath = join(tempDir(), "silent.sock");
    const silent = Bun.listen({ unix: socketPath, socket: { data() {} } });
    try {
      const started = Date.now();
      const result = await Effect.runPromise(
        Effect.result(Effect.scoped(connect(socketPath, Duration.millis(300))))
      );
      expect(result._tag).toBe("Failure");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      silent.stop(true);
    }
  });
});

describe("codex delivery retries", () => {
  /** A daemon that records turn requests and refuses them while `refuse` is set. */
  const fakeDaemon = () => {
    const turns: Array<string> = [];
    const state = { refuse: true };
    const daemon: Daemon = {
      request: (method, params) => {
        if (method === "thread/loaded/list") return Effect.succeed({ data: ["t-1"] });
        const { threadId } = params as { readonly threadId: string };
        turns.push(threadId);
        return state.refuse
          ? Effect.fail(
              new CodexError({ method, message: `thread ${threadId} already has an active writer` })
            )
          : Effect.succeed({});
      },
    };
    return { daemon, turns, state };
  };

  test("a refused thread is retried after a doubling delay, and delivered once accepted", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          const { daemon, turns, state } = fakeDaemon();
          const refusals: Refusals = new Map();
          const deliver = deliverOnce(Effect.succeed(daemon), hostname(), refusals);
          yield* bus.join({
            address: "codex/a",
            runtime: "codex",
            cwd: process.cwd(),
            codexThreadId: "t-1",
          });
          yield* bus.join({ address: "claude/b", runtime: "claude", cwd: process.cwd() });
          yield* bus.publish({ from: "claude/b", to: ["codex/a"], body: "hi" });

          yield* deliver;
          yield* deliver; // still waiting out the first refusal
          expect(turns).toEqual(["t-1"]);

          yield* TestClock.adjust("30 seconds");
          yield* deliver;
          yield* TestClock.adjust("30 seconds"); // the second refusal waits a minute
          yield* deliver;
          expect(turns).toEqual(["t-1", "t-1"]);

          state.refuse = false;
          yield* TestClock.adjust("30 seconds");
          yield* deliver;
          expect(turns).toEqual(["t-1", "t-1", "t-1"]);
          expect(refusals.size).toBe(0);
          expect(yield* bus.take("codex/a")).toEqual([]);
        }),
        Layer.merge(jsonl().layer, TestClock.layer())
      )
    ));
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
  /** Starts a delivery to `address` that holds its batch until `release` completes. */
  const heldDelivery = (bus: Bus.Bus["Service"], address: string) =>
    Effect.gen(function* () {
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        bus.deliver(address, () =>
          Deferred.succeed(holding, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(true)
          )
        )
      );
      yield* Deferred.await(holding);
      return { fiber, release };
    });

  test("a read during a delivery waits, and does not see the delivered messages again", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({ address: "codex/a", runtime: "codex", cwd: process.cwd() });
          yield* bus.publish({ from: "claude/b", to: ["codex/a"], body: "once" });
          const { fiber, release } = yield* heldDelivery(bus, "codex/a");
          const read = yield* Effect.forkChild(bus.take("codex/a"));
          yield* Deferred.succeed(release, undefined);
          expect(bodies(yield* Fiber.join(fiber))).toEqual(["once"]);
          expect(yield* Fiber.join(read)).toEqual([]);
        }),
        jsonl().layer
      )
    ));

  test("a replay during a delivery takes effect after it, rather than being overwritten", () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* Bus.Bus;
          yield* bus.join({ address: "codex/a", runtime: "codex", cwd: process.cwd() });
          yield* bus.publish({ from: "claude/b", to: ["codex/a"], body: "again" });
          const { fiber, release } = yield* heldDelivery(bus, "codex/a");
          const rejoin = yield* Effect.forkChild(
            bus.join({ address: "codex/a", runtime: "codex", cwd: process.cwd(), replay: true })
          );
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          yield* Fiber.join(rejoin);
          expect(bodies(yield* bus.take("codex/a"))).toEqual(["again"]);
        }),
        jsonl().layer
      )
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
              arguments: { address, runtime: "other", cwd: process.cwd() },
            });
          }
          yield* client.callTool({
            tool: tool("bus_publish"),
            schema: Mcp.Published,
            arguments: { from: "codex/b", to: ["claude/a"], body: "over http" },
          });
          const { messages } = yield* client.callTool({
            tool: tool("bus_read"),
            schema: Mcp.Messages,
            arguments: { address: "claude/a" },
          });
          expect(bodies(messages)).toEqual(["over http"]);
          expect(messages[0]?.origin?.cwd).toBe(process.cwd());

          const relative = yield* client.callTool({
            tool: tool("bus_join"),
            arguments: { address: "claude/c", runtime: "other", cwd: "relative/dir" },
          });
          expect(relative.isError).toBe(true);
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
        yield* call("bus_join", Mcp.Joined, {
          address: "claude/a",
          runtime: "claude",
          cwd: process.cwd(),
        });
        expect(yield* Client.waitFor(url, "claude/a", 1)).toEqual([]);
        const waiting = yield* Effect.forkChild(Client.waitFor(url, "claude/a"));
        yield* Effect.sleep("200 millis");
        yield* call("bus_publish", Mcp.Published, {
          from: "codex/b",
          to: ["claude/a"],
          body: "wake",
        });
        expect(bodies(yield* Fiber.join(waiting))).toEqual(["wake"]);
        const notJoined = yield* Effect.flip(Client.waitFor(url, "claude/nobody", 1));
        // An unreachable bus is retried until the deadline, not reported as a timeout at once.
        const started = Date.now();
        const unreachable = yield* Client.waitFor("http://127.0.0.1:9/mcp", "claude/a", 1.5);
        expect(unreachable).toEqual([]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
        expect(notJoined.refused).toBe(true);
      }).pipe(Effect.provide(Layer.merge(layer, FetchHttpClient.layer)))
    );
  });
});
