import { expect, test } from "bun:test";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { listing, orientationDirectories } from "../src/catalogue.ts";
import { Message } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger, messageIri, revisionIri, scopeIri, witnessIri } from "../src/Ledger.ts";
import { canonicalJson } from "../src/orientation-model.ts";
import { QueryGateway } from "../src/Query.ts";
import { startFileFlureeServer } from "./fluree-file-server.ts";

const revision = "01900000-0000-7000-8000-000000000001";
const notice = "01900000-0000-7000-8000-000000000002";
const ts = "2026-11-03T12:00:00.000Z";
const directory = (id: string, alias: string) => ({
  id,
  name: id === "d" ? "D".repeat(300) : `Directory ${id}`,
  aliases: [alias],
  concerns: [],
});
const notification = JSON.stringify({
  id: notice,
  ts,
  from: "publisher",
  to: ["reader"],
  kind: "message",
  body: "notice",
});
const record = (id: string, alias: string) =>
  JSON.stringify({
    kind: "directory",
    directory: directory(id, alias),
    publisher: "publisher",
    publishedAt: ts,
    notification: notice,
    audience: ["reader"],
  });
const intent = (id: string, alias: string) =>
  canonicalJson({
    action: "replace",
    scope: { kind: "directory", directory: id },
    expected: null,
    directory: directory(id, alias),
    audience: ["reader"],
    publisher: "publisher",
  });

const fixture = (
  aliases: Array<[string, string]>,
  damage: Record<
    string,
    | "pointer"
    | "pointer-multiple"
    | "record"
    | "record-missing"
    | "record-multiple"
    | "notice"
    | "notice-malformed"
    | "notice-multiple"
  > = {}
) => {
  const entries = new Map(aliases);
  let current = "";
  const gateway = Layer.succeed(
    QueryGateway,
    QueryGateway.of({
      pin: Effect.succeed({ head: 10, incarnation: "test-ledger" }),
      sparql: () => Effect.die("unexpected sparql"),
      jsonld: (_t, query) =>
        Effect.sync(() => {
          const select = query.select ?? query.selectDistinct;
          if (JSON.stringify(select) === '["?scope"]') {
            return [...entries.keys()]
              .sort()
              .slice(Number(query.offset), Number(query.offset) + Number(query.limit))
              .map((id) => [scopeIri({ kind: "directory", directory: id })]);
          }
          const where = query.where as Array<Record<string, unknown>> | Record<string, unknown>;
          const first = Array.isArray(where) ? where[0] : where;
          const subject = first?.["@id"];
          if (
            typeof subject === "string" &&
            subject.startsWith("urn:agent-bus:orientation:directory:")
          ) {
            const id = subject.slice("urn:agent-bus:orientation:directory:".length);
            current = id;
            if (damage[id] === "pointer") return [["directory", id, null, null]];
            if (damage[id] === "pointer-multiple")
              return [
                ["directory", id, null, revision],
                ["directory", id, null, "other"],
              ];
            return [["directory", id, null, revision]];
          }
          if (subject === revisionIri(revision)) {
            if (damage[current] === "record-missing") return [];
            if (damage[current] === "record")
              return [
                [scopeIri({ kind: "directory", directory: current }), "bad", messageIri(notice)],
              ];
            const row = [
              scopeIri({ kind: "directory", directory: current }),
              record(current, entries.get(current) ?? ""),
              messageIri(notice),
            ];
            return damage[current] === "record-multiple" ? [row, row] : [row];
          }
          if (subject === messageIri(notice)) {
            if (damage[current] === "notice") return [];
            if (damage[current] === "notice-malformed") return [["bad"]];
            if (damage[current] === "notice-multiple") return [[notification], [notification]];
            return [[notification]];
          }
          if (subject === witnessIri(revision))
            return [[intent(current, entries.get(current) ?? ""), revision, messageIri(notice)]];
          return [];
        }),
    })
  );
  return gateway;
};

const run = (
  gateway: ReturnType<typeof fixture>,
  args: Parameters<typeof orientationDirectories.run>[0],
  input: Parameters<typeof orientationDirectories.run>[1] = {},
  budget?: number
) =>
  Effect.runPromise(orientationDirectories.run(args, input, budget).pipe(Effect.provide(gateway)));

test("new catalogue schemas describe public arguments and nested row properties", () => {
  const operations = listing({ head: 10, incarnation: "test-ledger" }).operations;
  for (const name of ["orientation_directories", "orientation_associations"]) {
    const operation = operations.find((item) => item.name === name);
    expect(operation).toBeDefined();
    const check = (schema: unknown) => {
      if (typeof schema !== "object" || schema === null || !("properties" in schema)) return;
      for (const property of Object.values(
        schema.properties as Record<string, { description?: string }>
      )) {
        expect(property.description?.length).toBeGreaterThan(0);
        check(property);
      }
    };
    check(operation?.args);
    check(operation?.row);
  }
});

test("scan bound advances an empty page and finds the 201st scope at the same cut", async () => {
  const aliases: Array<[string, string]> = Array.from({ length: 200 }, (_, i) => [
    `id${String(i).padStart(3, "0")}`,
    "/other",
  ]);
  aliases.push(["id200", "/repo"]);
  const gateway = fixture(aliases);
  const first = await run(gateway, { cwd: "/repo/child", limit: 20 });
  expect(first).toMatchObject({ rows: [], exhausted: false, complete: false, t: 10 });
  expect(first.next).toBeDefined();
  const second = await run(gateway, { cwd: "/repo/child", limit: 20 }, { cursor: first.next });
  expect(second.rows).toEqual([{ id: "id200", name: "Directory id200", revision }]);
  expect(second).toMatchObject({ exhausted: true, complete: true, t: 10 });
  const exact = await run(fixture(aliases.slice(0, 200)), { cwd: "/repo" });
  expect(exact).toMatchObject({ rows: [], exhausted: true, complete: true });
  expect(exact.next).toBeUndefined();
});

test("path boundary, bounded whole rows and passed positions never skip matches", async () => {
  const gateway = fixture([
    ["a", "/other"],
    ["b", "/repo"],
    ["c", "/other"],
    ["d", "/repo"],
    ["e", "/repository"],
  ]);
  const args = { cwd: "/repo/child", limit: 20 };
  const full = await run(gateway, args);
  expect(full.rows.map((row) => row.id)).toEqual(["b", "d"]);
  let first: typeof full | undefined;
  for (let budget = Buffer.byteLength(JSON.stringify(full)) - 1; budget > 0; budget--) {
    try {
      const page = await run(gateway, args, {}, budget);
      if (!page.exhausted) {
        first = page;
        break;
      }
    } catch {
      break;
    }
  }
  expect(first?.next).toBeDefined();
  const rows = [...(first?.rows ?? [])];
  let next = first?.next;
  while (next !== undefined) {
    const page = await run(gateway, args, { cursor: next });
    rows.push(...page.rows);
    next = page.next;
  }
  expect(rows.map((row) => row.id)).toEqual(["b", "d"]);
  expect((await run(gateway, { cwd: "/repository/child" })).rows.map((row) => row.id)).toEqual([
    "e",
  ]);
});

test("pointer, record and notification damage is not hidden by nonmatching aliases", async () => {
  const gateway = fixture(
    [
      ["a", "/other"],
      ["b", "/other"],
      ["c", "/other"],
    ],
    { a: "pointer", b: "record", c: "notice" }
  );
  const result = await run(gateway, { cwd: "/repo" });
  expect(result).toMatchObject({
    rows: [],
    damage: "checked",
    damaged: 3,
    damagedTotal: 3,
    exhausted: true,
    complete: false,
  });
  expect(result.damagedAt).toBeUndefined();
  for (const kind of [
    "pointer-multiple",
    "record-missing",
    "record-multiple",
    "notice-malformed",
    "notice-multiple",
  ] as const) {
    const page = await run(fixture([["damaged", "/other"]], { damaged: kind }), { cwd: "/repo" });
    expect(page).toMatchObject({ rows: [], damaged: 1, damagedTotal: 1, complete: false });
  }
});

test("directory discovery's page deadline fails rather than consuming a position", async () => {
  const gateway = Layer.succeed(
    QueryGateway,
    QueryGateway.of({
      pin: Effect.succeed({ head: 10, incarnation: "test-ledger" }),
      jsonld: () => Effect.never,
      sparql: () => Effect.die("unexpected sparql"),
    })
  );
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.flip(orientationDirectories.run({ cwd: "/repo" }, {}, undefined))
      );
      yield* TestClock.adjust("10 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.mergeAll(gateway, TestClock.layer())))
  );
  expect(error._tag).toBe("LedgerError");
  expect(error.message).toContain("timed out");
});

test("file-backed Fluree validates and discovers a current directory through the shared reader", async () => {
  const server = await startFileFlureeServer();
  const runtime = ManagedRuntime.make(
    layerFluree(server.freshLedger("directory-query")).pipe(Layer.provide(FetchHttpClient.layer))
  );
  try {
    await runtime.runPromise(Effect.void);
    const message = new Message({
      id: notice,
      ts,
      from: "publisher",
      to: ["reader"],
      kind: "message",
      body: "notice",
    });
    await runtime.runPromise(
      Effect.flatMap(Ledger, (ledger) =>
        ledger.designate({
          scope: { kind: "directory", directory: "project" },
          expected: null,
          operation: revision,
          intent: intent("project", "/repo"),
          record: record("project", "/repo"),
          notification: message,
        })
      )
    );
    const result = await runtime.runPromise(
      orientationDirectories.run({ cwd: "/repo/child" }, {}, undefined)
    );
    expect(result.rows).toEqual([{ id: "project", name: "Directory project", revision }]);
    expect(result).toMatchObject({ exhausted: true, complete: true, damagedTotal: 0 });
    expect(
      (await runtime.runPromise(orientationDirectories.run({ cwd: "/repository" }, {}, undefined)))
        .rows
    ).toEqual([]);
  } finally {
    await runtime.dispose();
    await server.stop();
  }
}, 30_000);
