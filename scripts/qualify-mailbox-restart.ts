/**
 * Starts the selected CLI twice on a new disposable Fluree ledger. No installed bus,
 * launchd job, operator credential or live mailbox is used. Invoke with the pinned Bun:
 *   bun --no-env-file scripts/qualify-mailbox-restart.ts [--cli path/to/app/cli.js]
 *   bun --no-env-file scripts/qualify-mailbox-restart.ts --file-baseline --cli old/app/cli.js
 * The baseline reuses its files. The ledger candidate gets only the installation id,
 * test credential and ledger configuration in a fresh directory on restart.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { QueryGateway } from "../src/Query.ts";
import { boundary } from "../test/fluree-boundary.ts";
import { freshLedger, stopFlureeServer } from "../test/fluree-server.ts";
import { type Supervised, spawnSupervised } from "../test/supervised.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { cli: { type: "string" }, "file-baseline": { type: "boolean" } },
});
const cli = resolve(values.cli ?? join(import.meta.dir, "../src/bin.ts"));
const files = values["file-baseline"] === true;
const reader = "fixture/mailbox-restart-reader";
const author = "fixture/mailbox-restart-sender";
const sid = (address: string) => `synthetic:${address}`;
const key = `urn:agent-bus:mailbox:${createHash("sha256").update(Buffer.from(reader, "utf16le")).digest("hex")}`;
const receiptPrefix = "urn:agent-bus:mailbox-receipt:";
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.Array(Schema.String)));
const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })));

const run = async () => {
  const config = await freshLedger("qualify-mailbox-restart");
  const proxy = boundary(config.url);
  const root = mkdtempSync(join(tmpdir(), "agent-bus-qualify-restart-"));
  const roots = [join(root, "before"), join(root, "fresh")] as const;
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
  const witness = ManagedRuntime.make(layerFluree(config).pipe(Layer.provide(platform)));
  const pin = () => witness.runPromise(Effect.flatMap(QueryGateway, (q) => q.pin));
  const facts = (t: number, subject: string, predicates: string[]) =>
    witness.runPromise(
      Effect.flatMap(QueryGateway, (q) =>
        q
          .jsonld(t, {
            select: predicates.map((_, i) => `?x${i}`),
            where: {
              "@id": subject,
              ...Object.fromEntries(predicates.map((p, i) => [p, `?x${i}`])),
            },
          })
          .pipe(Effect.map(strings))
      )
    );
  const pointer = async (t: number) => {
    const found = await facts(t, key, ["bus:mailboxMarker", "bus:mailboxHead"]);
    assert.equal(found.length, 1);
    const [marker, ref] = found[0] ?? [];
    assert.equal(marker, "v1");
    assert(ref !== undefined && ref.startsWith(receiptPrefix));
    return ref;
  };
  const receipt = async (t: number, ref: string) => {
    const found = await facts(t, ref, ["bus:mailboxRecord"]);
    assert.equal(found.length, 1);
    const json = found[0]?.[0];
    assert(json);
    return object(JSON.parse(json));
  };
  const presences = async () => {
    const { entries } = await witness.runPromise(Effect.flatMap(Ledger, (l) => l.presenceAt()));
    return entries.filter((e) => e.from === reader);
  };
  let processHandle: Supervised | undefined;
  let client: Client | undefined;
  const stop = async () => {
    await client?.close().catch(() => {});
    client = undefined;
    if (processHandle) {
      processHandle.kill();
      await processHandle.exited;
      processHandle = undefined;
    }
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    assert(client);
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name} returned an MCP tool error`);
    return object(result.structuredContent);
  };
  const start = async (dir: string) => {
    const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = portProbe.port;
    portProbe.stop(true);
    processHandle = spawnSupervised(
      [process.execPath, "--no-env-file", cli, "serve", "--codex", "/usr/bin/false"],
      {
        env: {
          HOME: dir,
          PATH: process.env.PATH ?? dirname(process.execPath),
          AGENT_BUS_PORT: String(port),
          AGENT_BUS_DIR: dir,
        },
        stdout: "ignore",
        stderr: "ignore",
      }
    );
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    for (let attempt = 0; attempt < 80 && processHandle.exitCode === null; attempt++) {
      const next = new Client({ name: "mailbox-restart-qualification", version: "1" });
      try {
        await next.connect(new StreamableHTTPClientTransport(endpoint));
      } catch {
        await next.close().catch(() => {});
        await Bun.sleep(100);
        continue;
      }
      client = next;
      await client.listTools();
      // A port opening is not proof of which ledger this endpoint serves.
      assert.equal((await call("bus_queries", {})).ledger, (await pin()).incarnation);
      return;
    }
    throw new Error("Disposable serve did not initialize an MCP client.");
  };
  const joinPeer = (address: string, topics: string[]) =>
    call("bus_join", { address, topics, session: sid(address), runtime: "other", cwd: root });
  const send = async (body: string) => {
    const { id } = await call("bus_publish", {
      from: author,
      session: sid(author),
      to: [reader],
      body,
    });
    assert.equal(typeof id, "string");
    return id;
  };
  const read = async () =>
    rows((await call("bus_read", { address: reader, session: sid(reader) })).messages).map(
      (m) => m.id
    );
  const joinAfterLostAnswer = async (topics: string[]) => {
    const lost = proxy.loseNextUpdate();
    const result = await joinPeer(reader, topics);
    assert.equal(result.address, reader);
    assert.deepEqual(result.topics, topics);
    // Only proves the proxy forwarded a response. State assertions below prove whose write landed.
    assert.deepEqual(
      await Promise.race([lost, Bun.sleep(1000).then(() => "update not intercepted")]),
      { status: 200 }
    );
  };
  try {
    const installation = randomUUID();
    for (const dir of roots) {
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({ fluree: { url: proxy.url, ledger: config.ledger } }),
        { mode: 0o600 }
      );
      writeFileSync(join(dir, "fluree-token"), config.token, { mode: 0o600 });
      writeFileSync(join(dir, "installation-id"), installation, { mode: 0o600 });
    }
    await start(roots[0]);
    await joinPeer(author, []);
    const beforeJoin = (await pin()).head;
    if (files) await joinPeer(reader, []);
    else {
      await joinAfterLostAnswer(["alpha", "beta"]);
      const t = (await pin()).head;
      assert.equal(t, beforeJoin + 1);
      const joined = await presences();
      assert.equal(joined.length, 1);
      const entry = joined[0];
      assert(entry);
      assert.equal(entry.presence?.session, sid(reader));
      assert.deepEqual(entry.presence?.topics, ["alpha", "beta"]);
      const startRef = await pointer(t);
      assert.equal(startRef, receiptPrefix + entry.id);
      const fact = await receipt(t, startRef);
      assert.deepEqual(
        [fact.kind, fact.operation, fact.position, fact.mailbox, fact.previous],
        ["start", entry.id, beforeJoin, key, null]
      );
      await joinAfterLostAnswer(["beta", "alpha"]);
      assert.equal((await pin()).head, t + 1);
      const renewed = await presences();
      assert.equal(renewed.length, 2);
      assert.equal(renewed[1]?.presence?.rejoinOf, entry.id);
      assert.deepEqual(renewed[1]?.presence?.topics, ["beta", "alpha"]);
      assert.equal(await pointer(t + 1), startRef);
    }
    const first = await send("before restart");
    const beforeRead = (await pin()).head;
    assert.deepEqual(await read(), [first]);
    const acknowledged = (await pin()).head;
    assert.equal(acknowledged, beforeRead + (files ? 0 : 1));
    if (!files) {
      const startRef = await pointer(beforeRead);
      const ackRef = await pointer(acknowledged);
      assert.notEqual(startRef, ackRef);
      const ack = await receipt(acknowledged, ackRef);
      assert.deepEqual(
        [ack.kind, ack.mailbox, ack.previous, ack.from, ack.through, ack.servedCount],
        ["ack", key, startRef.slice(receiptPrefix.length), beforeJoin, beforeRead, 1]
      );
      assert.equal(ackRef, receiptPrefix + ack.operation);
    }
    await stop();
    await start(files ? roots[0] : roots[1]);
    assert.deepEqual(await read(), []);
    assert.equal((await pin()).head, acknowledged);
    const next = await send("after restart");
    assert.notEqual(next, first);
    assert.deepEqual(await read(), [next]);
    assert.deepEqual(await read(), []);
    assert.equal(readdirSync(roots[0]).includes("fluree-cursors"), files);
    assert.equal(readdirSync(roots[1]).includes("fluree-cursors"), false);
    console.log(
      `PASS: ${files ? "retained-file baseline" : "ledger pointer, lost join and renewal responses, no cursor files"}; process restart, exact mail IDs and zero-write empty read.`
    );
  } finally {
    try {
      await stop();
    } finally {
      proxy.stop();
      try {
        await witness.dispose();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
};
try {
  await run();
} finally {
  await stopFlureeServer();
}
