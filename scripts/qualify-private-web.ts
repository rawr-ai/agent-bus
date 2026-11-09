// Disposable real-host qualification. No environment or live Bus configuration is loaded.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Message, Origin } from "../src/domain.ts";
import { toNode } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { EvidencePage } from "../src/private-web/model.ts";
import { serveEvidence } from "../src/private-web/program.ts";
import { READ_SCOPE } from "../src/private-web/tools.ts";
import { QueryGateway } from "../src/Query.ts";
import * as Serve from "../src/serve.ts";
import { busOn, flureeStore } from "../test/activity-support.ts";
import { boundary, stallMidBody } from "../test/fluree-boundary.ts";
import { freshLedger, insertRaw, stopFlureeServer } from "../test/fluree-server.ts";
import { spawnSupervised } from "../test/supervised.ts";

const HOST_SHA256 = "cdb182c1695db3bba023f6b85dadb2d3dbe63a9f15713e69bce9e512e311d428";
const BUS_VERSION = "synthetic-private-web-qualification";
const PAGE_BYTES = 32_768;
const API_HEADER = "x-api-key";
const proof = {
  issuer: "https://fixture-issuer.invalid",
  audience: "https://fixture-resource.invalid/mcp",
  subject: "fixture-owner",
};
const shell = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
};

async function fixtureHost(entry: string, port: number, busPort: number, scenario: string) {
  const apiKey = process.env.FIXTURE_KEY;
  if (!apiKey) throw new Error("Synthetic credentials were not supplied.");
  const module: unknown = await import(entry);
  if (
    typeof module !== "object" ||
    module === null ||
    !("serveTools" in module) ||
    typeof module.serveTools !== "function"
  )
    throw new Error("The verified host has no direct tool program.");

  const serveTools = module.serveTools;
  await serveEvidence({
    busPort,
    pageBytes: PAGE_BYTES,
    expectedBusVersion: BUS_VERSION,
    owner: proof,
    verify: async (token) => {
      const state = await Bun.file(scenario).text();
      if (token !== apiKey || state === "unavailable") return undefined;
      return {
        issuer: state === "issuer" ? "https://wrong-issuer.invalid" : proof.issuer,
        subject: state === "owner" ? "wrong-owner" : proof.subject,
        audience: state === "audience" ? "https://wrong-resource.invalid/mcp" : proof.audience,
        scopes: state === "scope" ? [] : [READ_SCOPE],
      };
    },
    runHost: (tools, { resolveContext, signal: shutdown }) =>
      serveTools(
        {
          name: "agent-bus-private-evidence-fixture",
          version: "1.0.0",
          host: "127.0.0.1",
          port,
          endpoint: "/mcp",
          transport: "httpStream",
          serverAuth: { type: "apiKey", key: apiKey },
          httpLimits: {
            maxHeaderSize: 8192,
            headersTimeout: 5000,
            requestTimeout: 5000,
            connectionsCheckingInterval: 1000,
            keepAliveTimeout: 1000,
            maxConnections: 16,
            maxBodyBytes: 8192,
            maxInflightRequests: 8,
            maxConcurrentWork: 1,
            rate: { requestsPerSecond: 60, burst: 80 },
          },
        },
        tools,
        {
          ...(shutdown === undefined ? {} : { signal: shutdown }),
          resolveContext: ({
            auth,
            signal,
          }: {
            readonly auth?: { readonly authType: string };
            readonly signal: AbortSignal;
          }) =>
            resolveContext({
              // Only this synthetic harness substitutes locally confirmed API-key admission
              // for the future OAuth provider boundary. No grants or OAuth routes are created.
              auth:
                auth?.authType === "apiKey"
                  ? { authType: "oauth", accessToken: apiKey }
                  : undefined,
              signal,
            }),
        }
      ),
  });
}

function freePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Could not select a fixture port.");
  return port;
}

const firstText = (result: CallToolResult) => {
  const [only, ...rest] = result.content;
  return rest.length === 0 && only?.type === "text" ? only.text : "";
};
const decodePage = Schema.decodeUnknownOption(EvidencePage, { onExcessProperty: "error" });
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String }))
);
const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const pageOf = (result: CallToolResult) => {
  const page = decodePage(result.structuredContent);
  const refusal = decodeRefusal(firstText(result));
  assert(
    !result.isError && page._tag === "Some",
    `A valid evidence page was not returned (${refusal._tag === "Some" ? refusal.value.code : "invalid result"}).`
  );
  assert(
    isEqualJson(result.structuredContent, parsed(firstText(result))),
    "Text and structured evidence differed."
  );
  return page.value;
};
const isEqualJson = (first: unknown, second: unknown): boolean => {
  // JSON text and the published structured object should have identical data.
  try {
    assert.deepEqual(first, second);
    return true;
  } catch {
    return false;
  }
};
const codeOf = (result: CallToolResult) => {
  assert(result.isError, "Expected a refusal.");
  const refusal = decodeRefusal(firstText(result));
  return refusal._tag === "Some" ? refusal.value.code : undefined;
};
const tool = (operation: string, args: Record<string, unknown>) => ({
  name: `bus_evidence_${operation}`,
  arguments: args,
});

async function qualify(artifact: string) {
  assert(Bun.version === "1.4.4", "Run with the pinned Bun on PATH.");
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-private-web-"));
  const scenario = join(dir, "provider-proof");
  const port = freePort();
  const busPort = freePort();
  const apiKey = randomBytes(32).toString("hex");
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  let host: ReturnType<typeof spawnSupervised> | undefined;
  const clients: Client[] = [];
  const stopHost = async () => {
    if (host !== undefined) {
      host.kill();
      await host.exited;
      host = undefined;
    }
  };
  let stopBus: (() => Promise<void>) | undefined;
  let stopBoundary: (() => void) | undefined;
  try {
    const sha = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(artifact).arrayBuffer())
      .digest("hex");
    assert(sha === HOST_SHA256, "The local host artifact checksum did not match.");
    const tgz = "mcp-openapi-cdb182c1695db3bb.tgz";
    copyFileSync(artifact, join(dir, tgz));
    const install = Bun.spawn(
      [process.execPath, "--no-env-file", "add", "--ignore-scripts", `./${tgz}`],
      {
        cwd: dir,
        env: shell,
        stdout: "ignore",
        stderr: "ignore",
        signal: AbortSignal.timeout(60_000),
      }
    );
    assert(
      (await install.exited) === 0,
      "Installing the verified host in the disposable fixture failed."
    );
    const entry = join(dir, "node_modules/mcp-openapi/dist/index.js");
    const config = await freshLedger("private-web-qualification");
    const upstream = boundary(config.url);
    stopBoundary = upstream.stop;
    const startBus = async (version = BUS_VERSION) => {
      const runtime = ManagedRuntime.make(
        Serve.layerHttp({ port: busPort, version }).pipe(
          Layer.provideMerge(busOn(flureeStore(config, upstream.url), dir))
        )
      );
      stopBus = () => runtime.dispose();
      await runtime.runPromise(Effect.void);
      return runtime;
    };
    let bus = await startBus();
    const originCanary = "PRIVATE_ORIGIN_CANARY";
    const hidden = "WITHHELD/ENTRY_CANARY";
    const secretBody = "WITHHELD_BODY_CANARY";
    const absent = "absent-reply";
    const damaged = "damaged-entry";
    const makeMessage = (id: string, body: string, replyTo?: string) =>
      new Message({
        id,
        ts: "2026-11-09T12:00:00.000Z",
        from: "synthetic-owner",
        to: ["#fixture"],
        kind: "message",
        body,
        origin: new Origin({ host: originCanary, cwd: "/private/canary" }),
        ...(replyTo === undefined ? {} : { replyTo }),
      });
    const append = (message: Message) =>
      bus.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.append(message)));
    const pin = async () => {
      const pinned = await bus.runPromise(Effect.flatMap(QueryGateway, (gateway) => gateway.pin));
      return { ledger: pinned.incarnation, t: pinned.head };
    };
    const presence = new Message({ ...makeMessage(hidden, secretBody), kind: "presence" });
    await insertRaw(config, {
      ...toNode(presence, JSON.stringify(presence)),
      "@type": "bus:Message",
    });
    const decisionBody = "Wombat decision: use the blue fixture switch.";
    await append(makeMessage("decision", decisionBody, hidden));
    await append(
      makeMessage("followup", "Wombat follow-up: the fixture switch is confirmed.", "decision")
    );
    await append(makeMessage("cut", "Another synthetic message.", absent));
    await insertRaw(config, toNode(makeMessage(damaged, "Unreadable."), "{invalid"));
    const escapeBody = '"\\\u0001'.repeat(2300);
    await append(makeMessage("wire", escapeBody));
    await append(
      new Message({
        ...makeMessage("filter-budget", "x".repeat(27_000)),
        from: "budget-match",
      })
    );
    await append(makeMessage("oversized", "界".repeat(15_000)));
    const snapshot = await pin();
    await Bun.write(scenario, "ok");

    const launchHost = () => {
      host = spawnSupervised(
        [
          process.execPath,
          "--no-env-file",
          import.meta.path,
          "--fixture-host",
          entry,
          String(port),
          String(busPort),
          scenario,
        ],
        {
          env: {
            ...shell,
            LOG_LEVEL: "error",
            FIXTURE_KEY: apiKey,
          },
          stdout: "ignore",
          stderr: "ignore",
        }
      );
    };
    let capture: Promise<number | undefined> | undefined;
    const capturedBytes = () => capture;
    const connect = async (key: string, measure = false) => {
      const client = new Client({ name: "local-evidence-qualification", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(endpoint, {
            requestInit: { headers: { [API_HEADER]: key } },
            ...(measure
              ? {
                  fetch: async (...args: Parameters<typeof fetch>) => {
                    const response = await fetch(...args);
                    if (
                      typeof args[1]?.body === "string" &&
                      args[1].body.includes('"tools/call"')
                    ) {
                      capture = response
                        .clone()
                        .arrayBuffer()
                        .then(
                          (bytes) => bytes.byteLength,
                          () => undefined
                        );
                    }
                    return response;
                  },
                }
              : {}),
          })
        );
        clients.push(client);
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
    };
    const ready = async () => {
      for (let tries = 0; tries < 40; tries += 1) {
        try {
          return await connect(apiKey, true);
        } catch {
          await Bun.sleep(100);
        }
      }
      throw new Error("The verified host did not accept a local MCP connection.");
    };
    launchHost();
    let client = await ready();
    const call = async (operation: string, args: Record<string, unknown>) =>
      CallToolResultSchema.parse(
        await client.callTool(tool(operation, args), CallToolResultSchema, { timeout: 25_000 })
      );
    const ok = async (operation: string, args: Record<string, unknown>) => {
      const result = await call(operation, args);
      const raw = JSON.stringify(result);
      assert(
        ![originCanary, hidden, secretBody].some((value) => raw.includes(value)),
        "Protected evidence crossed the facade."
      );
      return pageOf(result);
    };
    const catalogue = await client.listTools();
    assert.equal(
      catalogue.tools
        .map((entry) => entry.name)
        .sort()
        .join(","),
      [
        "bus_evidence_history",
        "bus_evidence_messages",
        "bus_evidence_search",
        "bus_evidence_thread",
      ].join(",")
    );
    assert(
      catalogue.tools.every(
        (entry) =>
          entry.inputSchema.additionalProperties === false &&
          entry.outputSchema?.additionalProperties === false &&
          entry.annotations?.readOnlyHint
      )
    );
    await assert.rejects(() => connect("forged-transport-key"));
    const beforeDenials = upstream.passed();
    for (const state of ["owner", "scope", "audience", "issuer", "unavailable"]) {
      await Bun.write(scenario, state);
      assert((await call("history", {})).isError, "Unverified access was admitted.");
    }
    await Bun.write(scenario, "ok");
    await assert.rejects(() => call("history", { name: "bus_query", subject: proof.subject }));
    await assert.rejects(
      () =>
        call("history", {
          fromTs: "2026-11-09T13:00:00Z",
          toTs: "2026-11-09T12:00:00Z",
        }),
      (error: unknown) => error instanceof Error && error.message.includes("Set toTs after fromTs")
    );
    await assert.rejects(() => client.callTool({ name: "bus_publish", arguments: {} }));
    assert.equal(upstream.passed(), beforeDenials, "A refused invocation reached the Bus read.");
    console.log(
      "Host catalogue and closed inputs; transport and per-invocation owner, scope, audience and issuer refusals passed."
    );

    const first = await ok("history", { limit: 1, snapshot });
    assert(first.next && first.omitted === 1 && first.rows.length === 0);
    const threadFirst = await ok("thread", { id: "decision", snapshot, limit: 1 });
    assert(threadFirst.next && threadFirst.rootOmitted && threadFirst.omitted === 1);
    await append(makeMessage("later", "Wombat after the saved snapshot.", "followup"));
    const threadNext = await ok("thread", {
      id: "decision",
      snapshot,
      limit: 1,
      cursor: threadFirst.next,
    });
    assert(threadNext.rows[0]?.id === "decision" && threadNext.rows[0].body === decisionBody);
    assert(threadNext.rows[0].replyTo === undefined && threadNext.omittedReplyTargets === 1);
    assert(threadNext.next);
    const threadEnd = await ok("thread", {
      id: "decision",
      snapshot,
      limit: 1,
      cursor: threadNext.next,
    });
    assert(threadEnd.exhausted && !threadEnd.complete && threadEnd.rows[0]?.id === "followup");
    assert.equal(threadEnd.rows[0].replyTo, "decision");
    const after = await ok("history", { limit: 1, cursor: first.next });
    assert(after.snapshot.t === snapshot.t && after.rows[0]?.id === "decision");
    assert.equal(
      codeOf(await call("history", { limit: 2, cursor: first.next })),
      "INVALID_REQUEST"
    );
    const tampered = `v1.${first.next[3] === "A" ? "B" : "A"}${first.next.slice(4)}`;
    assert.equal(codeOf(await call("history", { limit: 1, cursor: tampered })), "INVALID_CURSOR");
    const exact = await ok("messages", {
      snapshot,
      ids: ["decision", hidden, damaged, "later", "never"],
    });
    assert(exact.rows[0]?.body === decisionBody && exact.omitted === 1 && exact.damaged === 1);
    assert(exact.notFound?.join(",") === "later,never" && !exact.complete);
    const cut = await ok("thread", { id: "cut", snapshot });
    assert(cut.missingReplyTargets?.[0] === absent && cut.root === undefined);
    assert.equal(codeOf(await call("thread", { id: hidden, snapshot })), "WITHHELD");
    assert.equal(codeOf(await call("thread", { id: damaged, snapshot })), "EVIDENCE_DAMAGED");
    assert.equal(codeOf(await call("thread", { id: "never", snapshot })), "NOT_FOUND");
    assert.equal(
      codeOf(
        await call("messages", {
          ids: ["decision"],
          snapshot: { ...snapshot, ledger: "different-ledger" },
        })
      ),
      "STALE_LEDGER"
    );
    assert.equal(
      codeOf(await call("messages", { ids: ["oversized"], snapshot })),
      "EVIDENCE_TOO_LARGE"
    );
    capture = undefined;
    const wirePage = await ok("messages", { ids: ["wire"], snapshot });
    const wireBytes = await capturedBytes();
    assert(wirePage.complete && wirePage.rows[0]?.body === escapeBody && wireBytes !== undefined);
    const logicalBytes = Buffer.byteLength(JSON.stringify(wirePage));
    assert(
      wireBytes > logicalBytes * 2,
      "Wire measurement did not capture both complete carriers."
    );
    console.log(
      `Pinned history, exact reads and reply tree; refusals and opaque cursors passed. Escaped synthetic page: ${logicalBytes} logical bytes, ${wireBytes} HTTP response-body bytes.`
    );
    const baseFilter = await ok("history", { participants: ["budget-match"], snapshot });
    const wideFilter = await ok("history", {
      participants: [
        "budget-match",
        ...Array.from({ length: 49 }, (_, i) => `miss-${i}-${"x".repeat(128)}`),
      ],
      snapshot,
    });
    assert(
      isEqualJson(baseFilter, wideFilter) && wideFilter.rows[0]?.body.length === 27_000,
      "Input metadata consumed the budget for otherwise identical evidence."
    );

    const ranked = await ok("search", { text: "wombat", limit: 1, snapshot });
    assert(ranked.next && !ranked.complete && ranked.rows[0]?.score !== undefined);
    const rankedNext = await ok("search", { text: "wombat", limit: 1, cursor: ranked.next });
    assert(rankedNext.rows[0]?.id !== ranked.rows[0].id && rankedNext.snapshot.t === snapshot.t);
    await stopBus?.();
    assert.equal(codeOf(await call("history", { limit: 1 })), "UNAVAILABLE");
    await startBus("wrong-fixture-bus-version");
    assert.equal(codeOf(await call("history", { limit: 1 })), "UNAVAILABLE");
    await stopBus?.();
    bus = await startBus();
    assert.equal(
      codeOf(await call("search", { text: "wombat", limit: 1, cursor: ranked.next })),
      "RANKING_UNAVAILABLE"
    );
    assert((await ok("history", { limit: 1, cursor: first.next })).snapshot.t === snapshot.t);

    const held = upstream.next(stallMidBody);
    const abort = new AbortController();
    const abandoned = client
      .callTool(tool("history", { limit: 1 }), CallToolResultSchema, { signal: abort.signal })
      .catch(() => undefined);
    const request = await Promise.race([
      held,
      Bun.sleep(3000).then(() => {
        throw new Error("The stalled upstream query did not arrive.");
      }),
    ]);
    abort.abort();
    await abandoned;
    const burst = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetch(endpoint, {
          method: "POST",
          headers: {
            [API_HEADER]: apiKey,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: i + 100,
            method: "tools/call",
            params: tool("history", {}),
          }),
        })
      )
    );
    assert(
      burst.every((response) => response.status === 503),
      "Reconnect burst was not refused while an upstream exchange remained owned."
    );
    await Promise.all(burst.map((response) => response.arrayBuffer()));
    assert(!request.isFinalised(), "The upstream fixture settled before admission was observed.");
    await Promise.race([
      request.finalised,
      Bun.sleep(12_000).then(() => {
        throw new Error("The unanswered upstream stream did not release.");
      }),
    ]);
    await Bun.sleep(100);
    assert((await ok("history", { limit: 1, cursor: first.next })).rows[0]?.id === "decision");
    console.log(
      "The reader refused unavailable and mismatched Bus versions, then recovered. Bus restart expired the retained ranking without moving history. Actual host refused the disconnect/reconnect burst until the unanswered upstream stream timed out."
    );

    await client.close();
    await stopHost();
    client = await readyAfterRestart();
    async function readyAfterRestart() {
      launchHost();
      return ready();
    }
    assert.equal(codeOf(await call("history", { limit: 1, cursor: first.next })), "INVALID_CURSOR");
    assert((await ok("history", { limit: 1, snapshot })).snapshot.t === snapshot.t);
    console.log(
      "Facade restart invalidated previous ciphertext; an explicit reread at the retained snapshot succeeded."
    );
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopHost();
    await stopBus?.();
    stopBoundary?.();
    await stopFlureeServer();
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = Bun.argv.slice(2).filter((arg) => arg !== "--");
try {
  const [mode, entry, port, busPort, scenario] = args;
  if (mode === "--fixture-host" && entry && port && busPort && scenario) {
    await fixtureHost(entry, Number(port), Number(busPort), scenario);
  } else if (mode && args.length === 1) {
    await qualify(mode);
  } else {
    throw new Error("Usage: bun run qualify:private-web /absolute/path/to/verified-host.tgz");
  }
} catch (error) {
  // Do not print tool results or transport exceptions. Fixture assertions use fixed labels.
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : error instanceof Error && error.stack?.includes(import.meta.path) && !error.cause
        ? error.message
        : "Private evidence qualification failed."
  );
  process.exitCode = 1;
}
