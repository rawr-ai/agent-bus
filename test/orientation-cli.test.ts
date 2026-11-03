import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import * as Ledger from "../src/Ledger.ts";
import * as Serve from "../src/serve.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const associations = '[{"directory":"bus","concerns":["orientation"]}]';
const cli = async (port: number, owner: string, ...extra: ReadonlyArray<string>) => {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../src/bin.ts"),
      "join",
      "--address",
      "other/cli",
      "--runtime",
      "other",
      "--session",
      owner,
      "--associations",
      associations,
      ...extra,
    ],
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
};

const arraySchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      directory: { type: "string" },
      concerns: { type: "array", items: { type: "string" } },
    },
    required: ["directory", "concerns"],
  },
};
const Request = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Struct({ arguments: Schema.optionalKey(Schema.Unknown) })),
});

test("a failed post-join orientation reports the committed join and retries read-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-orientation-join-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
  const bus = Bus.layer.pipe(
    Layer.provideMerge(layerJsonl(join(dir, "ledger.jsonl"))),
    Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
    Layer.provide(platform)
  );
  const runtime = ManagedRuntime.make(
    Serve.layerHttp({ port, version: "test" }).pipe(Layer.provideMerge(bus))
  );
  try {
    await runtime.runPromise(Effect.void);
    const result = await cli(port, "owner", "--orient");
    expect(result.code).toBe(0);
    expect(result.out).toContain("joined as other/cli");
    expect(result.out).toContain('"status":"UNAVAILABLE"');
    const before = await runtime.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger.Ledger;
        const cursors = yield* Cursors.Cursors;
        const presence = yield* ledger.presence;
        expect(presence).toHaveLength(1);
        return { head: yield* ledger.end, cursor: yield* cursors.get("other/cli") };
      })
    );
    const retry = Bun.spawn([process.execPath, join(import.meta.dir, "../src/bin.ts"), "orient"], {
      timeout: 20_000,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENT_BUS_PORT: String(port) },
    });
    const [code, stdout] = await Promise.all([retry.exited, new Response(retry.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout).toContain('"status":"UNAVAILABLE"');
    const after = await runtime.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger.Ledger;
        const cursors = yield* Cursors.Cursors;
        return { head: yield* ledger.end, cursor: yield* cursors.get("other/cli") };
      })
    );
    expect(after).toEqual(before);
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A recording protocol peer can advertise one contract and deliberately violate its echo. */
const recordingServer = (mode: "no-output" | "missing" | "mismatch") => {
  const calls: Array<unknown> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const message = Schema.decodeUnknownSync(Request)(await request.json());
      const base = { resultType: "complete", ttlMs: 0, cacheScope: "private" };
      let result: unknown;
      if (message.method === "server/discover") {
        result = { ...base, supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
      } else if (message.method === "tools/list") {
        const outputSchema = {
          type: "object",
          properties: { associations: arraySchema },
          required: ["associations"],
        };
        result = {
          ...base,
          tools: [
            {
              name: "bus_join",
              inputSchema: { type: "object", properties: { associations: arraySchema } },
              ...(mode === "no-output" ? {} : { outputSchema }),
            },
          ],
        };
      } else if (message.method === "tools/call") {
        calls.push(message.params?.arguments);
        const joined = {
          address: "other/cli",
          topics: [],
          cursor: 42,
          ...(mode === "mismatch" ? { associations: [{ directory: "bus", concerns: [] }] } : {}),
        };
        result = {
          resultType: "complete",
          content: [{ type: "text", text: JSON.stringify(joined) }],
          structuredContent: joined,
        };
      } else {
        return new Response(null, { status: 204 });
      }
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  return { server, calls };
};

for (const mode of ["no-output", "missing", "mismatch"] as const) {
  test(`association CLI handles ${mode} output without a second join`, async () => {
    const { server, calls } = recordingServer(mode);
    try {
      const result = await cli(Number(server.url.port), "owner");
      expect(result.code).toBe(1);
      if (mode === "no-output") {
        expect(result.out).toContain("no join was sent");
        expect(calls).toEqual([]);
      } else {
        expect(result.out).toContain("Joined as other/cli");
        expect(result.out).toContain("do not automatically rejoin");
        expect(calls).toHaveLength(1);
      }
    } finally {
      server.stop(true);
    }
  });
}

test("association CLI preserves a real owner refusal without changing presence or cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-orientation-cli-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
  const bus = Bus.layer.pipe(
    Layer.provideMerge(layerJsonl(join(dir, "ledger.jsonl"))),
    Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
    Layer.provide(platform)
  );
  const runtime = ManagedRuntime.make(
    Serve.layerHttp({ port, version: "test" }).pipe(Layer.provideMerge(bus))
  );
  try {
    const before = await runtime.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const ledger = yield* Ledger.Ledger;
        const cursors = yield* Cursors.Cursors;
        yield* bus.join({
          address: "other/cli",
          runtime: "other",
          session: "current-owner",
          cwd: process.cwd(),
        });
        return { end: yield* ledger.end, cursor: yield* cursors.get("other/cli") };
      })
    );
    const refused = await cli(port, "competitor");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("held by another session");
    expect(refused.out).toContain("holder");
    const after = await runtime.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger.Ledger;
        const cursors = yield* Cursors.Cursors;
        return { end: yield* ledger.end, cursor: yield* cursors.get("other/cli") };
      })
    );
    expect(after).toEqual(before);
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
