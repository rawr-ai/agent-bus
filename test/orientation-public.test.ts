import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { orientationAssociations } from "../src/catalogue.ts";
import * as Fluree from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { updateBulletin, updateDirectory } from "../src/Orientation.ts";
import { orient } from "../src/OrientationView.ts";
import { bulletinAt, directoryAt } from "../src/orientation-read.ts";
import { QueryGateway } from "../src/Query.ts";
import * as Serve from "../src/serve.ts";
import { startFileFlureeServer } from "./fluree-file-server.ts";

let server: ReturnType<typeof startFileFlureeServer> | undefined;
const fileServer = () => (server ??= startFileFlureeServer());
afterAll(async () => {
  await (await server?.catch(() => undefined))?.stop();
});

test("an inadmissible association unit offers a new query at the same cut without consuming it", async () => {
  const f = await fixture();
  try {
    await f.run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger;
        const cursors = yield* Cursors.Cursors;
        yield* bus.join(joining("publisher"));
        yield* updateDirectory({
          from: "publisher",
          session: "publisher",
          operation: Bun.randomUUIDv7(),
          expected: null,
          directory,
          audience: ["nobody"],
        });
        const concerns = Array.from(
          { length: 100 },
          (_, index) => `c${String(index).padStart(3, "0")}${"x".repeat(100)}`
        );
        yield* bus.join({
          ...joining("associated"),
          associations: [{ directory: "project", concerns }],
        });
        const before = { head: yield* ledger.end, cursor: yield* cursors.get("associated") };
        const constrained = yield* orient({ directory: "project" }, 3_000);
        expect(constrained).toMatchObject({
          status: "UNAVAILABLE",
          reason: "INADMISSIBLE",
          cut: { head: before.head },
          recovery: {
            tool: "bus_run_query",
            input: {
              name: "orientation_associations",
              args: { directory: "project", projection: "membership", limit: 50 },
              t: before.head,
            },
          },
        });
        const recovered = yield* orientationAssociations.run(
          { directory: "project", projection: "membership", limit: 50 },
          { t: before.head },
          65_536
        );
        expect(recovered.complete).toBe(true);
        expect(recovered.rows).toMatchObject([
          { address: "associated", association: { directory: "project", concerns } },
        ]);
        expect(yield* ledger.end).toBe(before.head);
        expect(yield* cursors.get("associated")).toEqual(before.cursor);
      })
    );
  } finally {
    await f.dispose();
  }
});

const fixture = async () => {
  const config = (await fileServer()).freshLedger("orientation-public");
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-orientation-public-"));
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  const bus = Bus.layer.pipe(
    Layer.provideMerge(Fluree.layerFluree(config)),
    Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
    Layer.provide(platform)
  );
  const runtime = ManagedRuntime.make(
    Serve.layerHttp({ port, version: "orientation-test" }).pipe(Layer.provideMerge(bus))
  );
  return {
    run: runtime.runPromise,
    url: `http://127.0.0.1:${port}/mcp`,
    dispose: async () => {
      try {
        await runtime.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
};

test("public MCP writes and read-only orientation expose matching text and structured programme guidance", async () => {
  const f = await fixture();
  const client = new Client({ name: "orientation-public-test", version: "1" });
  try {
    await f.run(Effect.void);
    await client.connect(new StreamableHTTPClientTransport(new URL(f.url)));
    const tools = (await client.listTools()).tools;
    expect(tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["bus_orient", "bus_directory", "bus_bulletin"])
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      expect(result.isError).not.toBe(true);
      const first = result.content[0];
      if (first?.type !== "text") throw new Error(`no text result from ${name}`);
      const decoded: unknown = JSON.parse(first.text);
      expect(decoded).toEqual(result.structuredContent);
      return decoded;
    };
    await call("bus_join", {
      address: "publisher",
      runtime: "other",
      session: "publisher",
      cwd: process.cwd(),
    });
    const operation = Bun.randomUUIDv7();
    const written = await call("bus_bulletin", {
      from: "publisher",
      session: "publisher",
      operation,
      expected: null,
      scope: { kind: "programme" },
      action: "publish",
      body: "First programme guidance. TAIL-SENTINEL.",
    });
    expect(written).toMatchObject({ status: "APPLIED", operation, revision: operation });
    const before = await f.run(Effect.flatMap(Ledger, (ledger) => ledger.end));
    const result = await call("bus_orient", {});
    expect(result).toMatchObject({
      status: "COMPLETE",
      selection: { state: "UNRESOLVED" },
      programme: {
        state: "CURRENT",
        revision: operation,
        body: "First programme guidance. TAIL-SENTINEL.",
      },
    });
    expect(await f.run(Effect.flatMap(Ledger, (ledger) => ledger.end))).toBe(before);
    const malformed = [
      { operation: "not-a-uuid", scope: { kind: "programme" } },
      { operation: "0198a111-1111-4111-8111-111111111111", scope: { kind: "programme" } },
      { operation: Bun.randomUUIDv7(), scope: { kind: "directory", directory: "project" } },
    ];
    for (const fields of malformed) {
      const rejected = CallToolResultSchema.parse(
        await client.callTool({
          name: "bus_bulletin",
          arguments: {
            from: "publisher",
            session: "publisher",
            expected: null,
            action: "publish",
            body: "invalid",
            ...fields,
          },
        })
      );
      expect(rejected.isError).toBe(true);
      expect(await f.run(Effect.flatMap(Ledger, (ledger) => ledger.end))).toBe(before);
    }
  } finally {
    try {
      await client.close();
    } finally {
      await f.dispose();
    }
  }
});

test("one public orientation composes selected context, guidance and explicit association diagnostics", async () => {
  const f = await fixture();
  const client = new Client({ name: "orientation-composed-test", version: "1" });
  try {
    await f.run(Effect.void);
    await client.connect(new StreamableHTTPClientTransport(new URL(f.url)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      expect(result.isError).not.toBe(true);
      const first = result.content[0];
      if (first?.type !== "text") throw new Error(`no text result from ${name}`);
      const decoded: unknown = JSON.parse(first.text);
      expect(decoded).toEqual(result.structuredContent);
      return decoded;
    };
    await call("bus_join", {
      address: "publisher",
      runtime: "other",
      session: "publisher",
      cwd: process.cwd(),
    });
    const defined = {
      ...directory,
      concerns: [...directory.concerns, { id: "ops", name: "Operations", topic: "ops" }],
    };
    const directoryRevision = Bun.randomUUIDv7();
    expect(
      await call("bus_directory", {
        from: "publisher",
        session: "publisher",
        operation: directoryRevision,
        expected: null,
        directory: defined,
        audience: ["observer"],
      })
    ).toMatchObject({ status: "APPLIED", revision: directoryRevision });
    const programmeRevision = Bun.randomUUIDv7();
    expect(
      await call("bus_bulletin", {
        from: "publisher",
        session: "publisher",
        operation: programmeRevision,
        expected: null,
        scope: { kind: "programme" },
        action: "publish",
        body: "Programme TAIL-SENTINEL.",
      })
    ).toMatchObject({ status: "APPLIED" });
    const concernRevision = Bun.randomUUIDv7();
    expect(
      await call("bus_bulletin", {
        from: "publisher",
        session: "publisher",
        operation: concernRevision,
        expected: null,
        scope: { kind: "concern", directory: "project", concern: "delivery" },
        action: "publish",
        body: "Delivery handoff TAIL-SENTINEL.",
      })
    ).toMatchObject({ status: "APPLIED" });
    await call("bus_bulletin", {
      from: "publisher",
      session: "publisher",
      operation: Bun.randomUUIDv7(),
      expected: null,
      scope: { kind: "concern", directory: "project", concern: "ops" },
      action: "publish",
      body: "Do not include this unselected full body.",
    });
    await call("bus_join", {
      address: "reader",
      runtime: "other",
      session: "reader",
      cwd: process.cwd(),
      topics: ["old-topic"],
      associations: [
        { directory: "project", concerns: ["delivery", "removed"] },
        { directory: "unregistered", concerns: ["missing"] },
      ],
    });
    const before = await f.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const cursors = yield* Cursors.Cursors;
        return { head: yield* ledger.end, cursor: yield* cursors.get("reader") };
      })
    );
    const selected = await call("bus_orient", { directory: "project", concern: "delivery" });
    expect(selected).toMatchObject({
      status: "COMPLETE",
      cut: { head: before.head },
      programme: {
        state: "CURRENT",
        revision: programmeRevision,
        body: "Programme TAIL-SENTINEL.",
      },
      selection: { state: "SELECTED", basis: "explicit", directory: "project" },
      directory: { revision: directoryRevision, value: { directory: defined } },
      concern: {
        id: "delivery",
        state: "REGISTERED",
        bulletin: {
          state: "CURRENT",
          revision: concernRevision,
          body: "Delivery handoff TAIL-SENTINEL.",
        },
      },
      summaries: [{ concern: "ops", bulletin: { state: "CURRENT" } }],
      subscriptions: { state: "SEPARATE_QUERY", query: "peers", t: before.head },
      members: {
        name: "orientation_associations",
        complete: true,
        rows: [
          {
            address: "reader",
            association: { directory: "project", concerns: ["delivery", "removed"] },
            resolution: {
              directory: "REGISTERED",
              concern: "REGISTERED",
              danglingConcerns: ["removed"],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(selected)).not.toContain("Do not include this unselected full body.");
    const missing = await call("bus_orient", { directory: "unregistered", concern: "missing" });
    expect(missing).toMatchObject({
      status: "COMPLETE",
      selection: { state: "MISSING", directory: "unregistered" },
      programme: { revision: programmeRevision },
      unresolvedAssociations: {
        rows: [
          { address: "reader", resolution: { directory: "UNRESOLVED", concern: "UNRESOLVED" } },
        ],
      },
    });
    expect(missing).not.toHaveProperty("members");
    const missingConcern = await call("bus_orient", { directory: "project", concern: "removed" });
    expect(missingConcern).toMatchObject({
      selection: { state: "SELECTED", directory: "project" },
      concern: { id: "removed", state: "UNRESOLVED" },
      unresolvedAssociations: {
        rows: [
          { address: "reader", resolution: { directory: "REGISTERED", concern: "UNRESOLVED" } },
        ],
      },
    });
    expect(missingConcern).not.toHaveProperty("members");
    const discovered = await call("bus_orient", { cwd: "/workspace/project/packages/core" });
    expect(discovered).toMatchObject({
      selection: { state: "SELECTED", basis: "alias", directory: "project" },
      directory: { revision: directoryRevision },
    });
    const sibling = await call("bus_orient", { cwd: "/workspace/project-other" });
    expect(sibling).toMatchObject({ selection: { state: "UNRESOLVED", basis: "alias" } });
    const cli = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/bin.ts"),
        "orient",
        "--directory",
        "project",
        "--concern",
        "delivery",
      ],
      {
        timeout: 20_000,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, AGENT_BUS_PORT: new URL(f.url).port },
      }
    );
    const [exit, cliOutput] = await Promise.all([
      cli.exited,
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
    ]);
    expect(exit).toBe(0);
    const cliResult: unknown = JSON.parse(cliOutput);
    expect(cliResult).toMatchObject({
      status: "COMPLETE",
      programme: { revision: programmeRevision },
      concern: { bulletin: { revision: concernRevision, body: "Delivery handoff TAIL-SENTINEL." } },
    });
    const after = await f.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const cursors = yield* Cursors.Cursors;
        return { head: yield* ledger.end, cursor: yield* cursors.get("reader") };
      })
    );
    expect(after).toEqual(before);
    const joined = await call("bus_join", {
      address: "newcomer",
      runtime: "other",
      session: "newcomer",
      cwd: "/workspace/project/packages/core",
      associations: [{ directory: "project", concerns: ["delivery"] }],
      orient: true,
    });
    expect(joined).toMatchObject({
      address: "newcomer",
      associations: [{ directory: "project", concerns: ["delivery"] }],
      orientation: {
        status: "COMPLETE",
        selection: { state: "SELECTED", basis: "alias", directory: "project" },
        programme: { revision: programmeRevision },
        members: {
          rows: expect.arrayContaining([expect.objectContaining({ address: "newcomer" })]),
        },
      },
    });
    expect(
      await call("bus_directory", {
        from: "publisher",
        session: "publisher",
        operation: Bun.randomUUIDv7(),
        expected: null,
        directory: { ...directory, id: "another", name: "Another project" },
        audience: ["observer"],
      })
    ).toMatchObject({ status: "APPLIED" });
    const ambiguous = await call("bus_orient", { cwd: "/workspace/project/packages/core" });
    expect(ambiguous).toMatchObject({
      status: "COMPLETE",
      selection: { state: "AMBIGUOUS", basis: "alias" },
      programme: { revision: programmeRevision },
      candidates: { complete: true, rows: [{ id: "another" }, { id: "project" }] },
    });
    expect(ambiguous).not.toHaveProperty("directory");
  } finally {
    try {
      await client.close();
    } finally {
      await f.dispose();
    }
  }
});

const directory = {
  id: "project",
  name: "Project",
  aliases: ["/workspace/project"],
  concerns: [{ id: "delivery", name: "Delivery", topic: "old-topic" }],
};
const joining = (address: string, session = address) => ({
  address,
  session,
  runtime: "other" as const,
  cwd: process.cwd(),
});

test("semantic retries preserve original receipt across later revision and reject reuse", async () => {
  const f = await fixture();
  try {
    await f.run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger;
        yield* bus.join(joining("publisher"));
        yield* bus.join(joining("reader"));
        yield* bus.join(joining("other"));
        const operation = Bun.randomUUIDv7();
        const first = {
          from: "publisher",
          session: "publisher",
          operation,
          expected: null,
          directory,
          audience: ["reader", "reader"],
        };
        const applied = yield* updateDirectory(first);
        expect(applied.status).toBe("APPLIED");
        if (applied.status !== "APPLIED") throw new Error("first directory was not applied");
        expect(applied.notification.to).toEqual(["reader"]);
        expect((yield* bus.take("reader", "reader")).map(({ id }) => id)).toEqual([
          applied.notification.id,
        ]);
        const end = yield* ledger.end;
        const retry = yield* updateDirectory({
          ...first,
          directory: { ...directory, aliases: ["/workspace/project/./", "/workspace/project"] },
          audience: ["reader"],
        });
        expect(retry).toMatchObject({
          status: "APPLIED",
          operation,
          expected: null,
          revision: applied.revision,
          notification: applied.notification,
        });
        if (retry.status !== "APPLIED") throw new Error("retry was not applied");
        expect(retry.cut.head).toBeGreaterThanOrEqual(applied.cut.head);
        const upper = yield* updateDirectory({ ...first, operation: operation.toUpperCase() });
        expect(upper).toMatchObject({
          status: "APPLIED",
          operation,
          revision: applied.revision,
          notification: applied.notification,
        });
        expect(yield* ledger.end).toBe(end);
        expect(yield* bus.take("reader", "reader")).toEqual([]);
        const superseding = yield* updateDirectory({
          ...first,
          operation: Bun.randomUUIDv7(),
          expected: operation,
          directory: { ...directory, name: "Project after revision" },
        });
        expect(superseding.status).toBe("APPLIED");
        const historical = yield* updateDirectory(first);
        expect(historical).toMatchObject({
          status: "APPLIED",
          operation,
          expected: null,
          revision: applied.revision,
          notification: applied.notification,
        });
        if (historical.status !== "APPLIED") throw new Error("historical receipt not returned");
        expect(historical.cut.head).toBeGreaterThan(applied.cut.head);
        const afterSupersession = yield* ledger.end;
        expect(
          (yield* updateDirectory({ ...first, directory: { ...directory, name: "different" } }))
            .status
        ).toBe("IDENTITY_MISMATCH");
        expect((yield* updateDirectory({ ...first, from: "other", session: "other" })).status).toBe(
          "IDENTITY_MISMATCH"
        );
        expect(yield* ledger.end).toBe(afterSupersession);
        const gateway = yield* QueryGateway;
        const pin = yield* gateway.pin;
        expect((yield* directoryAt(gateway, pin.head, "project"))?.value.directory.name).toBe(
          "Project after revision"
        );
      })
    );
  } finally {
    await f.dispose();
  }
});

test("lost public reply and a newly built retry return the original notification once", async () => {
  const f = await fixture();
  const writer = new Client({ name: "lost-orientation-reply", version: "1" });
  const reader = new Client({ name: "orientation-observer", version: "1" });
  let lost = false;
  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const bytes = await request.arrayBuffer();
      const parsed: unknown =
        bytes.byteLength === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes));
      const header = new Headers(request.headers);
      header.set("host", new URL(f.url).host);
      header.delete("content-length");
      const upstream = await fetch(f.url, {
        method: request.method,
        headers: header,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: bytes }),
      });
      const record = typeof parsed === "object" && parsed !== null ? parsed : {};
      const isWrite =
        "method" in record &&
        record.method === "tools/call" &&
        "params" in record &&
        typeof record.params === "object" &&
        record.params !== null &&
        "name" in record.params &&
        record.params.name === "bus_directory";
      if (isWrite && !lost) {
        lost = true;
        await upstream.arrayBuffer();
        return new Response("", { status: 504 });
      }
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    },
  });
  try {
    await f.run(Effect.void);
    await reader.connect(new StreamableHTTPClientTransport(new URL(f.url)));
    await writer.connect(new StreamableHTTPClientTransport(new URL(`/mcp`, relay.url)));
    const call = async (client: Client, name: string, args: Record<string, unknown>) =>
      CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    for (const [address, cwd] of [
      ["publisher", "/synthetic/first"],
      ["reader", "/synthetic/reader"],
    ] as const) {
      const result = await call(reader, "bus_join", {
        address,
        runtime: "other",
        session: address,
        cwd,
      });
      expect(result.isError).not.toBe(true);
    }
    const operation = Bun.randomUUIDv7();
    const input = {
      from: "publisher",
      session: "publisher",
      operation,
      expected: null,
      directory,
      audience: ["reader"],
    };
    await expect(call(writer, "bus_directory", input)).rejects.toThrow();
    expect(lost).toBe(true);
    const taken = await call(reader, "bus_read", { address: "reader", session: "reader" });
    const messages = taken.structuredContent?.messages;
    expect(Array.isArray(messages)).toBe(true);
    if (!Array.isArray(messages) || messages.length !== 1) throw new Error("one notice expected");
    const original = messages[0];
    expect(original).toMatchObject({ from: "publisher", origin: { cwd: "/synthetic/first" } });
    await call(reader, "bus_join", {
      address: "publisher",
      runtime: "other",
      session: "publisher",
      cwd: "/synthetic/second",
    });
    const retried = await call(reader, "bus_directory", {
      audience: ["reader", "reader"],
      directory: { ...directory },
      expected: null,
      operation,
      session: "publisher",
      from: "publisher",
    });
    expect(retried.structuredContent).toMatchObject({
      status: "APPLIED",
      operation,
      notification: original,
    });
    const readAgain = await call(reader, "bus_read", { address: "reader", session: "reader" });
    expect(readAgain.structuredContent).toEqual({ messages: [] });
    const all = await f.run(Effect.flatMap(Ledger, (ledger) => ledger.read(0)));
    expect(all.entries.filter(({ message }) => message.kind === "message")).toHaveLength(1);
  } finally {
    try {
      await Promise.allSettled([writer.close(), reader.close()]);
    } finally {
      relay.stop(true);
      await f.dispose();
    }
  }
});

test("bulletin notifications address their declared audience and withdrawal retains the old audience", async () => {
  const f = await fixture();
  try {
    await f.run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger;
        for (const address of ["publisher", "old-reader", "new-reader", "direct", "associated"]) {
          yield* bus.join({
            ...joining(address),
            ...(address === "old-reader" ? { topics: ["old-topic"] } : {}),
            ...(address === "new-reader" ? { topics: ["new-topic"] } : {}),
            ...(address === "associated"
              ? { associations: [{ directory: "project", concerns: ["delivery"] }] }
              : {}),
          });
        }
        const directoryOp = Bun.randomUUIDv7();
        const registered = yield* updateDirectory({
          from: "publisher",
          session: "publisher",
          operation: directoryOp,
          expected: null,
          directory,
          audience: ["nobody"],
        });
        expect(registered.status).toBe("APPLIED");
        const programme = yield* updateBulletin({
          from: "publisher",
          session: "publisher",
          operation: Bun.randomUUIDv7(),
          expected: null,
          scope: { kind: "programme" },
          action: "publish",
          body: "Programme guidance",
        });
        expect(programme.status).toBe("APPLIED");
        if (programme.status !== "APPLIED") throw new Error("programme not applied");
        expect(programme.notification.to).toEqual(["*"]);
        for (const address of ["old-reader", "new-reader", "direct", "associated"]) {
          expect((yield* bus.take(address, address)).map(({ id }) => id)).toEqual([
            programme.notification.id,
          ]);
        }
        const operation = Bun.randomUUIDv7();
        const scope = { kind: "concern" as const, directory: "project", concern: "delivery" };
        const published = yield* updateBulletin({
          from: "publisher",
          session: "publisher",
          operation,
          expected: null,
          scope,
          action: "publish",
          body: "Concern guidance",
          recipients: ["direct", "direct"],
        });
        expect(published.status).toBe("APPLIED");
        if (published.status !== "APPLIED") throw new Error("concern not applied");
        expect(published.notification.to).toEqual(["#old-topic", "direct"]);
        const equivalent = yield* updateBulletin({
          from: "publisher",
          session: "publisher",
          operation,
          expected: null,
          scope,
          action: "publish",
          body: "Concern guidance",
          recipients: ["direct"],
        });
        expect(equivalent).toMatchObject({
          status: "APPLIED",
          notification: published.notification,
          revision: published.revision,
        });
        const changedAudience = yield* updateBulletin({
          from: "publisher",
          session: "publisher",
          operation,
          expected: null,
          scope,
          action: "publish",
          body: "Concern guidance",
          recipients: [],
        });
        expect(changedAudience.status).toBe("IDENTITY_MISMATCH");
        const headBeforeMismatch = yield* ledger.end;
        for (const change of [
          { body: "changed guidance", expected: null },
          { body: "Concern guidance", expected: Bun.randomUUIDv7() },
        ]) {
          const mismatch = yield* updateBulletin({
            from: "publisher",
            session: "publisher",
            operation,
            scope,
            action: "publish",
            recipients: ["direct"],
            ...change,
          });
          expect(mismatch.status).toBe("IDENTITY_MISMATCH");
          expect(yield* ledger.end).toBe(headBeforeMismatch);
        }
        for (const address of ["old-reader", "direct"]) {
          expect((yield* bus.take(address, address)).map(({ id }) => id)).toEqual([
            published.notification.id,
          ]);
        }
        expect(yield* bus.take("new-reader", "new-reader")).toEqual([]);
        expect(yield* bus.take("associated", "associated")).toEqual([]);
        const changedDirectory = yield* updateDirectory({
          from: "publisher",
          session: "publisher",
          operation: Bun.randomUUIDv7(),
          expected: directoryOp,
          directory: {
            ...directory,
            concerns: [{ id: "delivery", name: "Delivery", topic: "new-topic" }],
          },
          audience: ["nobody"],
        });
        expect(changedDirectory.status).toBe("APPLIED");
        const withdrawn = yield* updateBulletin({
          from: "publisher",
          session: "publisher",
          operation: Bun.randomUUIDv7(),
          expected: operation,
          scope,
          action: "withdraw",
        });
        expect(withdrawn.status).toBe("APPLIED");
        if (withdrawn.status !== "APPLIED") throw new Error("withdrawal not applied");
        expect(withdrawn.notification.to).toEqual(["#old-topic", "direct"]);
        for (const address of ["old-reader", "direct"]) {
          expect((yield* bus.take(address, address)).map(({ id }) => id)).toEqual([
            withdrawn.notification.id,
          ]);
        }
        expect(yield* bus.take("new-reader", "new-reader")).toEqual([]);
        expect(yield* bus.take("associated", "associated")).toEqual([]);
        const gateway = yield* QueryGateway;
        const pin = yield* gateway.pin;
        const current = yield* bulletinAt(gateway, pin.head, scope);
        expect(current?.value.action).toBe("withdraw");
        expect(current?.value.audience).toEqual(["#old-topic", "direct"]);
        const restore = {
          from: "publisher",
          session: "publisher",
          operation: Bun.randomUUIDv7(),
          expected: withdrawn.revision,
          scope,
          action: "publish" as const,
          body: "Restored guidance",
        };
        const restored = yield* updateBulletin(restore);
        expect(restored.status).toBe("APPLIED");
        if (restored.status !== "APPLIED") throw new Error("restoration not applied");
        const restoreHead = yield* ledger.end;
        expect(yield* updateBulletin({ ...restore, recipients: [] })).toMatchObject({
          status: "APPLIED",
          revision: restored.revision,
          notification: restored.notification,
        });
        expect(yield* ledger.end).toBe(restoreHead);
      })
    );
  } finally {
    await f.dispose();
  }
});

test("invalid publication scope and audience refuse before mutation", async () => {
  const f = await fixture();
  try {
    await f.run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger;
        yield* bus.join(joining("publisher"));
        const before = yield* ledger.end;
        const invalids = [
          updateDirectory({
            from: "publisher",
            session: "publisher",
            operation: Bun.randomUUIDv7(),
            expected: null,
            directory,
            audience: [],
          }),
          updateBulletin({
            from: "publisher",
            session: "publisher",
            operation: Bun.randomUUIDv7(),
            expected: null,
            scope: { kind: "programme" },
            action: "publish",
            body: "programme",
            recipients: [],
          }),
          updateBulletin({
            from: "publisher",
            session: "publisher",
            operation: Bun.randomUUIDv7(),
            expected: null,
            scope: { kind: "concern", directory: "not-registered", concern: "missing" },
            action: "publish",
            body: "concern",
          }),
        ];
        for (const operation of invalids) {
          expect((yield* Effect.flip(operation))._tag).toBe("InvalidQuery");
          expect(yield* ledger.end).toBe(before);
        }
      })
    );
  } finally {
    await f.dispose();
  }
});

test("expiry, withdrawal and historical designation are distinct at their stated cut", async () => {
  const f = await fixture();
  try {
    await f.run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger;
        yield* bus.join(joining("publisher"));
        const operation = Bun.randomUUIDv7();
        const published = yield* updateBulletin({
          from: "publisher",
          session: "publisher",
          operation,
          expected: null,
          scope: { kind: "programme" },
          action: "publish",
          body: "Original programme",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
        expect(published.status).toBe("APPLIED");
        const publicationT = yield* ledger.end;
        const readAt = (time: number) =>
          Effect.gen(function* () {
            yield* TestClock.setTime(time);
            return yield* orient({ t: publicationT });
          }).pipe(Effect.provide(TestClock.layer()));
        const boundary = Date.parse("2030-01-01T00:00:00.000Z");
        expect(yield* readAt(boundary - 1)).toMatchObject({ programme: { state: "CURRENT" } });
        expect(yield* readAt(boundary)).toMatchObject({ programme: { state: "EXPIRED" } });
        expect(yield* readAt(boundary + 1)).toMatchObject({ programme: { state: "EXPIRED" } });
        const withdrawn = yield* updateBulletin({
          from: "publisher",
          session: "publisher",
          operation: Bun.randomUUIDv7(),
          expected: operation,
          scope: { kind: "programme" },
          action: "withdraw",
        });
        expect(withdrawn.status).toBe("APPLIED");
        expect(yield* orient({})).toMatchObject({ programme: { state: "WITHDRAWN" } });
        expect(yield* readAt(boundary - 1)).toMatchObject({
          cut: { head: publicationT },
          programme: { state: "CURRENT", body: "Original programme" },
        });
      })
    );
  } finally {
    await f.dispose();
  }
});

test("an update between component reads cannot mix orientation cuts", async () => {
  const f = await fixture();
  try {
    await f.run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger;
        const gateway = yield* QueryGateway;
        yield* bus.join(joining("publisher"));
        yield* updateDirectory({
          from: "publisher",
          session: "publisher",
          operation: Bun.randomUUIDv7(),
          expected: null,
          directory,
          audience: ["nobody"],
        });
        const originalOperation = Bun.randomUUIDv7();
        yield* updateBulletin({
          from: "publisher",
          session: "publisher",
          operation: originalOperation,
          expected: null,
          scope: { kind: "programme" },
          action: "publish",
          body: "Earlier programme",
        });
        const at = yield* ledger.end;
        let injected = false;
        const environment = Context.make(Bus.Bus, bus).pipe(
          Context.add(Ledger, ledger),
          Context.add(QueryGateway, gateway)
        );
        const intercept = QueryGateway.of({
          ...gateway,
          jsonld: (t, body) =>
            Effect.gen(function* () {
              const result = yield* gateway.jsonld(t, body);
              if (!injected) {
                injected = true;
                const replacement = yield* updateBulletin({
                  from: "publisher",
                  session: "publisher",
                  operation: Bun.randomUUIDv7(),
                  expected: originalOperation,
                  scope: { kind: "programme" },
                  action: "publish",
                  body: "Later programme",
                }).pipe(Effect.provide(environment), Effect.orDie);
                expect(replacement.status).toBe("APPLIED");
              }
              return result;
            }),
        });
        const result = yield* orient({ directory: "project" }).pipe(
          Effect.provideService(QueryGateway, intercept)
        );
        expect(injected).toBe(true);
        expect(result).toMatchObject({
          status: "COMPLETE",
          cut: { head: at },
          programme: { body: "Earlier programme" },
          directory: { value: { directory: { id: "project" } } },
        });
        const after = yield* ledger.end;
        expect(after).toBeGreaterThan(at);
        expect(result).toHaveProperty("currentHeadT", after);
        expect(yield* orient({ directory: "project" })).toMatchObject({
          programme: { body: "Later programme" },
        });
      })
    );
  } finally {
    await f.dispose();
  }
});

test("former owner is refused and current owner can replay the original receipt", async () => {
  const f = await fixture();
  try {
    await f.run(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger;
        yield* bus.join(joining("publisher", "old-session"));
        const input = {
          from: "publisher",
          session: "old-session",
          operation: Bun.randomUUIDv7(),
          expected: null,
          directory,
          audience: ["reader"],
        };
        const original = yield* updateDirectory(input);
        const holder = (yield* ledger.presence).at(-1)?.id;
        expect(holder).toBeDefined();
        yield* bus.join({ ...joining("publisher", "new-session"), takeover: holder });
        const before = yield* ledger.end;
        expect((yield* Effect.flip(updateDirectory(input)))._tag).toBe("NotOwner");
        const replayed = yield* updateDirectory({ ...input, session: "new-session" });
        expect(original.status).toBe("APPLIED");
        if (original.status !== "APPLIED") throw new Error("original receipt not returned");
        expect(replayed).toMatchObject({
          status: "APPLIED",
          operation: input.operation,
          expected: null,
          revision: original.revision,
          notification: original.notification,
        });
        if (replayed.status !== "APPLIED") throw new Error("takeover replay not returned");
        expect(replayed.cut.head).toBeGreaterThan(original.cut.head);
        expect(yield* ledger.end).toBe(before);
      })
    );
  } finally {
    await f.dispose();
  }
});
