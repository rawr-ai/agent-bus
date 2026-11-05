import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { CATALOGUE_VERSION, history, orientationAssociations } from "../src/catalogue.ts";
import { Message, Presence } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { Ledger, messageIri, revisionIri, scopeIri } from "../src/Ledger.ts";
import { updateBulletin } from "../src/Orientation.ts";
import { QueryGateway } from "../src/Query.ts";
import * as Serve from "../src/serve.ts";
import { startFileFlureeServer } from "./fluree-file-server.ts";
import { insertRaw } from "./fluree-server.ts";

type Association = { directory: string; concerns: Array<string> };
type State = {
  address: string;
  session?: string;
  status?: "joined" | "left";
  associations?: Array<Association>;
  topics?: Array<string>;
  note?: string;
};

// Explicit stored states, not join behavior or production normalization as the oracle.
const entry = (t: number, state: State) => {
  const id = `presence-${t}`;
  const ts = `2026-11-01T00:${String(t).padStart(2, "0")}:00.000Z`;
  return [
    t,
    id,
    JSON.stringify({
      id,
      ts,
      from: state.address,
      to: ["*"],
      kind: "presence",
      body: "presence",
      origin: { host: "fixture-host", cwd: "/fixture/project" },
      presence: {
        runtime: "codex",
        status: state.status ?? "joined",
        topics: state.topics ?? [],
        ...(state.session === undefined ? {} : { session: state.session }),
        ...(state.associations === undefined ? {} : { associations: state.associations }),
        ...(state.note === undefined ? {} : { note: state.note }),
      },
    }),
  ] as const;
};

const a = { directory: "project", concerns: ["one", "removed"] };
const b = { directory: "other", concerns: ["two"] };
const revision = "01900000-0000-7000-8000-000000000001";
const notice = "01900000-0000-7000-8000-000000000002";
const publishedAt = "2026-11-03T12:00:00.000Z";
const directoryRecord = (id: string, registered = true) => ({
  kind: "directory",
  directory: {
    id,
    name: id,
    aliases: [],
    concerns: registered
      ? [{ id: id === "other" ? "two" : "one", name: "Concern", topic: "topic" }]
      : [],
  },
  publisher: "publisher",
  publishedAt,
  notification: notice,
  audience: ["reader"],
});
const notification = {
  id: notice,
  ts: publishedAt,
  from: "publisher",
  to: ["reader"],
  kind: "message" as const,
  body: "notice",
};
const timeline = [
  entry(2, { address: "alice", session: "a", associations: [a, b], topics: ["topic"] }),
  entry(3, { address: "bob", session: "b", associations: [a] }),
  entry(4, { address: "cora", session: "c", associations: [a] }),
  entry(5, { address: "legacy", associations: [a] }),
  entry(6, { address: "path-only", session: "p", topics: ["project", "one"] }),
  entry(7, { address: "bob", session: "b", status: "left", associations: [a] }),
  entry(8, { address: "bob", session: "b" }),
  entry(9, { address: "cora", session: "c", associations: [] }),
  entry(10, { address: "alice", session: "a", associations: [a, b], topics: ["topic"] }),
  entry(11, { address: "dana", session: "d", associations: [a] }),
  entry(12, { address: "dana", session: "new-owner" }),
  entry(13, { address: "eve", session: "e", associations: [a] }),
  entry(14, {
    address: "zoe",
    session: "z",
    associations: [{ directory: "project", concerns: [] }],
  }),
];

const expected = (
  address: string,
  t: number,
  association: Association,
  topics: Array<string> = [],
  concern: "REGISTERED" | "UNRESOLVED" | "NOT_SELECTED" = "NOT_SELECTED"
) => ({
  address,
  runtime: "codex" as const,
  status: "joined" as const,
  topics,
  since: `2026-11-01T00:${String(t).padStart(2, "0")}:00.000Z`,
  t,
  host: "fixture-host",
  association,
  resolution: {
    directory: "REGISTERED" as const,
    concern,
    danglingConcerns:
      association.directory === "project" && association.concerns.includes("removed")
        ? ["removed"]
        : [],
  },
});
const fixture = () => {
  let head = 14;
  let incarnation = "incarnation-1";
  let current = "project";
  let currentT = 0;
  let missingIdAt: number | undefined;
  const rows: Array<readonly [number, string, string | null]> = [...timeline];
  const gateway = Layer.succeed(
    QueryGateway,
    QueryGateway.of({
      pin: Effect.sync(() => ({ head, incarnation })),
      jsonld: (t, query) =>
        Effect.sync(() => {
          const where = query.where as Array<Record<string, unknown>> | Record<string, unknown>;
          const subject = (Array.isArray(where) ? where[0] : where)?.["@id"];
          if (
            typeof subject === "string" &&
            subject.startsWith("urn:agent-bus:orientation:directory:")
          ) {
            current = subject.slice("urn:agent-bus:orientation:directory:".length);
            currentT = t;
            if (current === "missing") return [];
            return [["directory", current, null, revision]];
          }
          if (subject === revisionIri(revision))
            return [
              [
                scopeIri({ kind: "directory", directory: current }),
                JSON.stringify(directoryRecord(current, currentT < 15)),
                messageIri(notice),
              ],
            ];
          if (subject === messageIri(notice)) return [[JSON.stringify(notification)]];
          if (query.select !== undefined && JSON.stringify(query.select) === '["?predicate"]')
            return [];
          if (JSON.stringify(query.selectDistinct) === '["?m"]')
            return missingIdAt !== undefined && missingIdAt <= t ? [["urn:unkeyed-presence"]] : [];
          return rows.filter((row) => row[0] <= t);
        }),
      sparql: () => Effect.die("unexpected sparql"),
    })
  );
  return {
    run: (
      args: Parameters<typeof orientationAssociations.run>[0],
      input: Parameters<typeof orientationAssociations.run>[1] = {},
      budget?: number
    ) =>
      Effect.runPromise(
        orientationAssociations.run(args, input, budget).pipe(Effect.provide(gateway))
      ),
    old: (args: Parameters<typeof history.run>[0], input: Parameters<typeof history.run>[1] = {}) =>
      Effect.runPromise(history.run(args, input, undefined).pipe(Effect.provide(gateway))),
    add: (row: readonly [number, string, string | null]) => {
      rows.push(row);
      head = row[0];
    },
    addMissingId: (t: number) => {
      missingIdAt = t;
      head = t;
    },
    replace: () => {
      incarnation = "incarnation-2";
    },
  };
};

describe("orientation members", () => {
  test("folds the complete latest states at named cuts without inferring membership", async () => {
    const f = fixture();
    expect((await f.run({ directory: "project" }, { t: 6 })).rows).toEqual([
      expected("alice", 2, a, ["topic"]),
      expected("bob", 3, a),
      expected("cora", 4, a),
    ]);
    expect((await f.run({ directory: "project" })).rows).toEqual([
      expected("alice", 10, a, ["topic"]),
      expected("eve", 13, a),
      expected("zoe", 14, { directory: "project", concerns: [] }),
    ]);
    const filtered = await f.run({ directory: "project", concern: "one" });
    expect(filtered.rows).toEqual([
      expected("alice", 10, a, ["topic"], "REGISTERED"),
      expected("eve", 13, a, [], "REGISTERED"),
    ]);
    expect(Object.keys(filtered.rows[0] ?? {}).sort()).toEqual([
      "address",
      "association",
      "host",
      "resolution",
      "runtime",
      "since",
      "status",
      "t",
      "topics",
    ]);
    expect((await f.run({ directory: "other", concern: "two" })).rows).toEqual([
      expected("alice", 10, b, ["topic"], "REGISTERED"),
    ]);
    expect((await f.run({ directory: "missing" })).rows).toEqual([]);
    expect((await f.run({ directory: "project", concern: "removed" })).rows).toEqual([
      expected("alice", 10, a, ["topic"], "UNRESOLVED"),
      expected("eve", 13, a, [], "UNRESOLVED"),
    ]);
  });

  test("pages an independently expected ordered relation at a fixed cut and rejects mismatched cursors", async () => {
    for (const limit of [1, 2]) {
      const f = fixture();
      const args = { directory: "project", limit };
      const first = await f.run(args);
      expect(first.next).toBeDefined();
      f.add(entry(15, { address: "alice", session: "a", associations: [] }));
      const pages = [first];
      while (pages.at(-1)?.next !== undefined)
        pages.push(await f.run(args, { cursor: pages.at(-1)?.next }));
      expect(pages.flatMap((page) => page.rows)).toEqual([
        expected("alice", 10, a, ["topic"]),
        expected("eve", 13, a),
        expected("zoe", 14, { directory: "project", concerns: [] }),
      ]);
      expect(pages.every((page) => page.t === 14)).toBe(true);
      expect(pages.at(-1)?.complete).toBe(true);
      await expect(f.run({ ...args, concern: "one" }, { cursor: first.next })).rejects.toThrow();
      await expect(f.run({ ...args, limit: limit + 1 }, { cursor: first.next })).rejects.toThrow();
      await expect(f.run(args, { cursor: first.next, t: 15 })).rejects.toThrow();
      f.replace();
      await expect(f.run(args, { cursor: first.next })).rejects.toThrow();
    }
  });

  test("projection keeps the same association relation and refuses cross-projection cursors", async () => {
    const f = fixture();
    const args = { directory: "project", concern: "one", limit: 1 };
    const full = await f.run(args);
    const minimal = await f.run({ ...args, projection: "membership" });
    expect(minimal.rows).toEqual([
      {
        address: "alice",
        runtime: "codex",
        status: "joined",
        association: a,
        resolution: {
          directory: "REGISTERED",
          concern: "REGISTERED",
          danglingConcerns: ["removed"],
        },
      },
    ]);
    expect(Object.keys(minimal.rows[0] ?? {}).sort()).toEqual([
      "address",
      "association",
      "resolution",
      "runtime",
      "status",
    ]);
    await expect(
      f.run({ ...args, projection: "membership" }, { cursor: full.next })
    ).rejects.toThrow();
    const sequences = async (projection: "full" | "membership") => {
      const pages = [await f.run({ ...args, projection })];
      while (pages.at(-1)?.next !== undefined)
        pages.push(await f.run({ ...args, projection }, { cursor: pages.at(-1)?.next }));
      return pages.flatMap(({ rows }) =>
        rows.map(({ address, association }) => ({ address, association }))
      );
    };
    expect(await sequences("full")).toEqual(await sequences("membership"));
    const first = await f.run(args);
    f.add(entry(15, { address: "new", session: "new" }));
    const continuation = await f.run(args, { cursor: first.next });
    expect(continuation.rows[0]?.resolution).toEqual({
      directory: "REGISTERED",
      concern: "REGISTERED",
      danglingConcerns: ["removed"],
    });
    expect((await f.run(args)).rows[0]?.resolution.concern).toBe("UNRESOLVED");
  });

  test("unknown directories and removed concerns remain explicit references, not membership", async () => {
    const f = fixture();
    f.add(
      entry(15, {
        address: "ghost",
        session: "g",
        associations: [{ directory: "missing", concerns: ["gone"] }],
      })
    );
    expect(
      (await f.run({ directory: "missing", concern: "gone", projection: "membership" })).rows
    ).toEqual([
      {
        address: "ghost",
        runtime: "codex",
        status: "joined",
        association: { directory: "missing", concerns: ["gone"] },
        resolution: { directory: "UNRESOLVED", concern: "UNRESOLVED", danglingConcerns: ["gone"] },
      },
    ]);
  });

  test("admits only whole rows and does not consume an oversized first unit", async () => {
    const f = fixture();
    const args = { directory: "project", limit: 3 };
    const full = await f.run(args);
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    let trimmed: typeof full | undefined;
    for (let budget = fullBytes - 1; budget > 0; budget -= 1) {
      try {
        const result = await f.run(args, {}, budget);
        if (result.rows.length < full.rows.length) {
          trimmed = result;
          break;
        }
      } catch {
        break;
      }
    }
    expect(trimmed?.rows.length).toBeGreaterThan(0);
    expect(trimmed?.next).toBeDefined();
    const continuation = await f.run(args, { cursor: trimmed?.next });
    expect([...(trimmed?.rows ?? []), ...continuation.rows]).toEqual([...full.rows]);
    const oversized = fixture();
    oversized.add(
      entry(15, { address: "a", session: "large", associations: [a], note: "x".repeat(70_000) })
    );
    await expect(oversized.run(args, {}, 65_536)).rejects.toThrow(
      "Start a new orientation_associations traversal at t=15"
    );
    await expect(oversized.run(args, {}, 65_536)).rejects.toThrow(
      '"projection":"membership","limit":3}, without a cursor.'
    );
    expect(
      (await oversized.run({ ...args, projection: "membership" }, { t: 15 }, 65_536)).rows[0]
        ?.address
    ).toBe("a");
    expect((await oversized.run(args)).rows[0]?.address).toBe("a");
  });

  test("association and associated-address bounds are damage, but long unassociated legacy rows are not", async () => {
    const f = fixture();
    f.add(entry(15, { address: "x".repeat(513), session: "long" }));
    expect((await f.run({ directory: "project" })).damagedTotal).toBe(0);
    f.add(entry(16, { address: "x".repeat(513), session: "long", associations: [a] }));
    const badAddress = await f.run({ directory: "project" });
    expect(badAddress).toMatchObject({ rows: [], damagedTotal: 1, complete: false });
    const large = fixture();
    large.add(
      entry(15, {
        address: "alice",
        session: "a",
        associations: [
          {
            directory: "project",
            concerns: Array.from({ length: 200 }, (_, i) => `${i}${"x".repeat(100)}`),
          },
        ],
      })
    );
    expect(await large.run({ directory: "project" })).toMatchObject({
      rows: [],
      damagedTotal: 1,
      complete: false,
    });
  });

  test("unknown damaged latest address suppresses stale rows and reports damage once", async () => {
    const f = fixture();
    f.add([15, "bad-presence", "not json"]);
    f.add([16, "missing-json", null]);
    f.add([17, "multiple-json", "bad one"]);
    f.add([17, "multiple-json", "bad two"]);
    const args = { directory: "project", limit: 1 };
    for (const result of [await f.run(args), await f.run(args, { t: 17 })]) {
      expect(result.rows).toEqual([]);
      expect(result).toMatchObject({
        damaged: 3,
        damagedAt: [15, 16, 17],
        damagedTotal: 3,
        damage: "checked",
        exhausted: true,
        complete: false,
      });
      expect(result.next).toBeUndefined();
    }
    expect((await f.run(args, { t: 14 })).rows).toEqual([expected("alice", 10, a, ["topic"])]);
  });

  test("an unkeyed typed presence refuses the current relation without changing an older cut", async () => {
    const f = fixture();
    const args = { directory: "project", limit: 1 };
    const first = await f.run(args);
    expect(first.rows).toEqual([expected("alice", 10, a, ["topic"])]);
    f.addMissingId(15);
    await expect(f.run(args)).rejects.toThrow("Orientation data is damaged at this cut.");
    expect((await f.run(args, { t: 14 })).rows).toEqual(first.rows);
    const continued = await f.run(args, { cursor: first.next });
    expect(continued.t).toBe(14);
    expect(continued.rows).toEqual([expected("eve", 13, a)]);
  });

  test("leaves the existing operation and catalogue cursor identity intact", async () => {
    const f = fixture();
    const first = await f.old({ kinds: ["presence"], limit: 1 });
    expect(first.catalogueVersion).toBe(1);
    expect(CATALOGUE_VERSION).toBe(1);
    expect(first.next).toBeDefined();
    expect((await f.old({ kinds: ["presence"], limit: 1 }, { cursor: first.next })).t).toBe(14);
  });
});

const dirs: Array<string> = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const testRealPresenceDamage = async (damage: "missing-json" | "missing-id") => {
  const server = await startFileFlureeServer();
  try {
    const config = server.freshLedger("orientation-members");
    const dir = mkdtempSync(join(tmpdir(), "orientation-members-"));
    dirs.push(dir);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = (() => {
      try {
        return Number(probe.url.port);
      } finally {
        probe.stop(true);
      }
    })();
    const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
    const store = layerFluree(config).pipe(Layer.provide(platform));
    const layer = Serve.layerHttp({ port, version: "test" }).pipe(
      Layer.provideMerge(
        Bus.layer.pipe(
          Layer.provideMerge(store),
          Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
          Layer.provide(platform)
        )
      )
    );
    const runtime = ManagedRuntime.make(layer);
    try {
      const client = new Client({ name: "orientation-test", version: "1" });
      try {
        await runtime.runPromise(Effect.void);
        const directorySeed = await runtime.runPromise(
          Effect.flatMap(Ledger, (ledger) =>
            ledger.designate({
              scope: { kind: "directory", directory: "project" },
              expected: null,
              operation: revision,
              intent: "fixture",
              record: JSON.stringify(directoryRecord("project")),
              notification: new Message(notification),
            })
          )
        );
        expect(directorySeed.status).toBe("APPLIED");
        const programmeSeed = await runtime.runPromise(
          Effect.gen(function* () {
            const bus = yield* Bus.Bus;
            yield* bus.join({
              address: "publisher",
              runtime: "other",
              session: "publisher",
              cwd: "/workspace",
            });
            return yield* updateBulletin({
              from: "publisher",
              session: "publisher",
              operation: Bun.randomUUIDv7(),
              expected: null,
              scope: { kind: "programme" },
              action: "publish",
              body: "Preserved programme guidance.",
            });
          })
        );
        expect(programmeSeed.status).toBe("APPLIED");
        await runtime.runPromise(
          Effect.flatMap(Ledger, (ledger) =>
            ledger.append(
              new Message({
                id: "second-presence",
                ts: "2026-11-01T00:00:30.000Z",
                from: "bob",
                to: ["*"],
                kind: "presence",
                body: "presence",
                presence: new Presence({
                  runtime: "codex",
                  status: "joined",
                  topics: [],
                  session: "b",
                  associations: [{ directory: "project", concerns: [] }],
                }),
              })
            )
          )
        );
        await runtime.runPromise(
          Effect.flatMap(Ledger, (ledger) =>
            ledger.append(
              new Message({
                id: "real-presence",
                ts: "2026-11-01T00:00:00.000Z",
                from: "alice",
                to: ["*"],
                kind: "presence",
                body: "presence",
                presence: new Presence({
                  runtime: "codex",
                  status: "joined",
                  topics: [],
                  session: "a",
                  associations: [a, b],
                }),
              })
            )
          )
        );
        const initialCut = await runtime.runPromise(
          Effect.flatMap(QueryGateway, (gateway) => gateway.pin)
        );
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
        );
        const response = await client.callTool({
          name: "bus_run_query",
          arguments: {
            name: "orientation_associations",
            args: { directory: "project", concern: "one" },
          },
        });
        expect(response.isError).not.toBe(true);
        const result = response.structuredContent as {
          rows: Array<Record<string, unknown>>;
          complete: boolean;
          t: number;
        };
        expect(result).toMatchObject({ ledger: initialCut.incarnation, t: initialCut.head });
        expect(result.complete).toBe(true);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
          address: "alice",
          association: a,
          topics: [],
          runtime: "codex",
          status: "joined",
        });
        expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual([
          "address",
          "association",
          "resolution",
          "runtime",
          "since",
          "status",
          "t",
          "topics",
        ]);
        const firstPage = await client.callTool({
          name: "bus_run_query",
          arguments: { name: "orientation_associations", args: { directory: "project", limit: 1 } },
        });
        const first = firstPage.structuredContent as {
          rows: Array<Record<string, unknown>>;
          next: string;
          t: number;
        };
        expect(first).toMatchObject({ ledger: initialCut.incarnation, t: initialCut.head });
        expect(first.rows[0]).toMatchObject({ address: "alice" });
        expect(first.next).toBeString();
        const invalid = new Message({
          id: "later-invalid",
          ts: "2026-11-01T00:01:00.000Z",
          from: "alice",
          to: ["*"],
          kind: "presence",
          body: "presence",
          presence: new Presence({ runtime: "codex", status: "joined", topics: [], session: "a" }),
        });
        const node = toNode(invalid, JSON.stringify(invalid));
        if (damage === "missing-json") {
          const { "bus:json": _json, ...withoutJson } = node;
          await insertRaw(config, withoutJson);
        } else {
          const { "bus:id": _id, ...withoutId } = node;
          await insertRaw(config, withoutId);
        }
        const damagedCut = await runtime.runPromise(
          Effect.flatMap(QueryGateway, (gateway) => gateway.pin)
        );
        expect(damagedCut.incarnation).toBe(initialCut.incarnation);
        expect(damagedCut.head).toBeGreaterThan(initialCut.head);
        const damaged = await client.callTool({
          name: "bus_run_query",
          arguments: { name: "orientation_associations", args: { directory: "project" } },
        });
        if (damage === "missing-json") {
          expect(damaged.structuredContent).toMatchObject({
            ledger: damagedCut.incarnation,
            t: damagedCut.head,
            rows: [],
            damage: "checked",
            damaged: 1,
            damagedTotal: 1,
            complete: false,
          });
        } else {
          expect(damaged.isError).toBe(true);
          expect(JSON.stringify(damaged.content)).toContain(
            "Orientation data is damaged at this cut."
          );
          const orientation = CallToolResultSchema.parse(
            await client.callTool({ name: "bus_orient", arguments: { directory: "project" } })
          );
          expect(orientation.structuredContent).toMatchObject({
            cut: damagedCut,
            status: "UNAVAILABLE",
            reason: "DAMAGE",
            section: "associations",
            programme: { state: "CURRENT", body: "Preserved programme guidance." },
            selection: { state: "SELECTED", directory: "project" },
            directory: { value: { directory: { id: "project" } } },
            recovery: { tool: "bus_run_query", input: { name: "orientation_associations" } },
          });
          const first = orientation.content[0];
          if (first?.type !== "text") throw new Error("Orientation has no text result");
          expect(JSON.parse(first.text)).toEqual(orientation.structuredContent);
        }
        const historical = await client.callTool({
          name: "bus_run_query",
          arguments: {
            name: "orientation_associations",
            args: { directory: "project", concern: "one" },
            t: result.t,
          },
        });
        if (historical.isError)
          throw new Error("The historical association query was unavailable.");
        expect(historical.structuredContent).toMatchObject({
          ledger: initialCut.incarnation,
          t: initialCut.head,
          rows: [result.rows[0]],
          damaged: 0,
          complete: true,
        });
        const continuation = await client.callTool({
          name: "bus_run_query",
          arguments: {
            name: "orientation_associations",
            args: { directory: "project", limit: 1 },
            cursor: first.next,
          },
        });
        if (continuation.isError)
          throw new Error("The historical association continuation was unavailable.");
        expect(continuation.structuredContent).toMatchObject({
          ledger: initialCut.incarnation,
          t: initialCut.head,
          rows: [{ address: "bob" }],
          damaged: 0,
          complete: true,
        });
      } finally {
        await client.close();
      }
    } finally {
      await runtime.dispose();
    }
  } finally {
    await server.stop();
  }
};

test(
  "real Fluree handles missing-json presence damage at its cut",
  () => testRealPresenceDamage("missing-json"),
  30_000
);
test(
  "real Fluree handles missing-id presence damage at its cut",
  () => testRealPresenceDamage("missing-id"),
  30_000
);
