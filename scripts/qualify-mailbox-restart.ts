/**
 * Restarts the selected CLI on a new disposable Fluree ledger. No installed bus,
 * launchd job, operator credential or live mailbox is used. Invoke with the pinned Bun:
 *   bun --no-env-file scripts/qualify-mailbox-restart.ts [--release /abs/release --expect sha256]
 * On restart, only the verified binding, identity, test credential and configuration
 * are retained in a fresh directory.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Message, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { QueryGateway } from "../src/Query.ts";
import { boundary, type Forwarded } from "../test/fluree-boundary.ts";
import { freshLedger, insertRaw, stopFlureeServer } from "../test/fluree-server.ts";
import { createFixtureLedger, fixtureAttach } from "../test/serve-binding-fixture.ts";
import { type Supervised, spawnSupervised } from "../test/supervised.ts";
import { verify } from "./release.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { release: { type: "string" }, expect: { type: "string" } },
});
assert.equal(
  values.release === undefined,
  values.expect === undefined,
  "--release requires --expect"
);
const sealed =
  values.release !== undefined && values.expect !== undefined
    ? verify(values.release, { expect: values.expect })
    : null;
assert(
  sealed === null || (sealed.ok && sealed.root),
  "The selected sealed package did not verify."
);
const release = sealed?.root;
const cli = release
  ? [
      join(release, "runtime/bun"),
      "--no-env-file",
      `--config=${join(release, "app/bunfig.toml")}`,
      join(release, "app/cli.js"),
    ]
  : [
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      resolve(import.meta.dir, "../src/bin.ts"),
    ];
const reader = "fixture/mailbox-restart-reader";
const author = "fixture/mailbox-restart-sender";
const sid = (address: string) => `synthetic:${address}`;
const key = `urn:agent-bus:mailbox:${createHash("sha256").update(Buffer.from(reader, "utf16le")).digest("hex")}`;
const receiptPrefix = "urn:agent-bus:mailbox-receipt:";
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.Array(Schema.String)));
const objectSchema = Schema.Record(Schema.String, Schema.Unknown);
const object = Schema.decodeUnknownSync(objectSchema);
const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })));

const run = async () => {
  const config = await freshLedger("qualify-mailbox-restart");
  const proxy = boundary(config.url);
  const root = mkdtempSync(join(tmpdir(), "agent-bus-qualify-restart-"));
  const home = join(root, "home");
  const roots = [join(root, "before"), join(root, "fresh")] as const;
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
  const witness = ManagedRuntime.make(
    layerFluree(config, { existingOnly: true }).pipe(Layer.provide(platform))
  );
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
  const invoke = (name: string, args: Record<string, unknown>) => {
    assert(client);
    return client.callTool({ name, arguments: args });
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await invoke(name, args);
    assert.notEqual(result.isError, true, `${name} returned an MCP tool error`);
    return object(result.structuredContent);
  };
  const start = async (dir: string) => {
    const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = portProbe.port;
    portProbe.stop(true);
    processHandle = spawnSupervised([...cli, "serve", "--codex", "/usr/bin/false"], {
      env: {
        HOME: home,
        PATH: process.env.PATH ?? dirname(process.execPath),
        AGENT_BUS_PORT: String(port),
        AGENT_BUS_DIR: dir,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
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
  const joining = (address: string, topics: string[]) => ({
    address,
    topics,
    session: sid(address),
    runtime: "other",
    cwd: root,
  });
  const joinPeer = (address: string, topics: string[]) =>
    call("bus_join", joining(address, topics));
  const send = async (body: string, to = reader) => {
    const { id } = await call("bus_publish", {
      from: author,
      session: sid(author),
      to: [to],
      body,
    });
    assert.equal(typeof id, "string");
    return id;
  };
  const read = async (address = reader) =>
    rows((await call("bus_read", { address, session: sid(address) })).messages).map((m) => m.id);
  const intercepted = async (lost: Promise<Forwarded>) => {
    // Only proves the proxy forwarded a response. State assertions below prove whose write landed.
    assert.deepEqual(
      await Promise.race([lost, Bun.sleep(1000).then(() => "update not intercepted")]),
      { status: 200 }
    );
  };
  const joinAfterLostAnswer = async (topics: string[]) => {
    const lost = proxy.loseNextUpdate();
    const result = await joinPeer(reader, topics);
    assert.equal(result.address, reader);
    assert.deepEqual(result.topics, topics);
    await intercepted(lost);
  };
  const unknownJoin = async () => {
    const address = "fixture/mailbox-unconfirmed";
    const topics = ["unconfirmed", "large-registration-" + "x".repeat(12 * 1024), "recovery"];
    const before = (await pin()).head;
    const lost = proxy.loseNextUpdate({ disconnect: true });
    try {
      const result = CallToolResultSchema.parse(await invoke("bus_join", joining(address, topics)));
      assert.equal(result.isError, true);
      const entry = result.content[0];
      assert(entry?.type === "text");
      assert.match(entry.text, /could not confirm|unconfirmed/i);
      assert.match(entry.text, /bus_owned_addresses/);
      assert.match(entry.text, /bus_peers/);
      await intercepted(lost);
    } finally {
      assert(proxy.reconnect() > 0, "no confirmation request was refused");
    }
    const after = (await pin()).head;
    assert.equal(after, before + 1);
    const owned = await call("bus_owned_addresses", { session: sid(address), runtime: "other" });
    assert.deepEqual(owned.addresses, [address]);
    const peers = Schema.decodeUnknownSync(Schema.Array(objectSchema))(
      (await call("bus_peers", {})).peers
    );
    assert.deepEqual(peers.find((p) => p.address === address)?.topics, topics);
    const registrations = (
      await witness.runPromise(Effect.flatMap(Ledger, (l) => l.presenceAt()))
    ).entries.filter((entry) => entry.from === address);
    assert.equal(registrations.length, 1);
    assert.deepEqual(registrations[0]?.presence?.topics, topics);
    assert.equal((await pin()).head, after);
    // Evidence of current ownership, not a historical receipt. No resubmitted join.
    const id = await send("recover by inspecting current state", "#recovery");
    assert.deepEqual(await read(address), [id]);
    assert.deepEqual(await read(address), []);
  };
  const idleGap = async (installation: string) => {
    const before = (await pin()).head;
    const first = await send("before a long idle gap");
    await stop();
    const runs = new Map<string, string>();
    for (let i = 0; i < 100; i++) {
      const address = `fixture/idle-${i % 25}`;
      const id = Bun.randomUUIDv7();
      const prior = runs.get(address);
      runs.set(address, prior ?? id);
      const message = new Message({
        id,
        ts: new Date().toISOString(),
        from: address,
        to: ["*"],
        kind: "presence",
        body: "synthetic registration",
        presence: new Presence({
          status: "joined",
          runtime: "other",
          topics: ["infra", "releases", "observability"],
          session: sid(address),
          installation,
          ...(prior === undefined ? {} : { rejoinOf: prior }),
        }),
      });
      await witness.runPromise(Effect.flatMap(Ledger, (l) => l.append(message)));
    }
    for (let i = 0; i < 402; i++) {
      await insertRaw(config, {
        "@id": `urn:fixture:idle:${i}`,
        "urn:fixture:idle-tag": "non-mail",
      });
    }
    // A new process has no scan hint. The actual IDs are on opposite sides of one 500-commit window.
    await start(roots[1]);
    const next = await send("after the idle gap");
    const through = (await pin()).head;
    assert(through - before > 500);
    assert.deepEqual(await read(), [first, next]);
    assert.deepEqual(await read(), []);
    assert.equal((await pin()).head, through + 1);
  };
  try {
    mkdirSync(home, { mode: 0o700 });
    for (const dir of roots) mkdirSync(dir, { mode: 0o700 });
    const administer = (args: string[]) =>
      Bun.spawn([...cli, ...args], {
        env: { HOME: home, AGENT_BUS_DIR: roots[0], PATH: "/usr/bin:/bin" },
        stdout: "ignore",
        stderr: "ignore",
        timeout: 20_000,
      }).exited;
    assert.equal(await administer(["initialize-installation"]), 0);
    const identity = join(roots[0], "installation-id");
    const installation = readFileSync(identity, "utf8").trim();
    copyFileSync(identity, join(roots[1], "installation-id"));
    for (const dir of roots) {
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({ fluree: { url: proxy.url, ledger: config.ledger } }),
        { mode: 0o600 }
      );
      writeFileSync(join(dir, "fluree-token"), config.token, { mode: 0o600 });
    }
    const provisioned = await createFixtureLedger(config);
    assert.deepEqual(await pin(), { head: provisioned.head, incarnation: provisioned.incarnation });
    const attach = await administer(fixtureAttach(installation, provisioned));
    assert.equal(attach, 0, "The selected CLI could not attach to the disposable ledger.");
    copyFileSync(join(roots[0], ".serve-binding-v1"), join(roots[1], ".serve-binding-v1"));
    await start(roots[0]);
    await joinPeer(author, []);
    const beforeJoin = (await pin()).head;
    {
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
    assert.equal(acknowledged, beforeRead + 1);
    {
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
    await start(roots[1]);
    assert.deepEqual(await read(), []);
    assert.equal((await pin()).head, acknowledged);
    const next = await send("after restart");
    assert.notEqual(next, first);
    assert.deepEqual(await read(), [next]);
    assert.deepEqual(await read(), []);
    for (const dir of roots) assert.equal(readdirSync(dir).includes("fluree-cursors"), false);
    await unknownJoin();
    await idleGap(installation);
    console.log(
      "PASS: unconfirmed registration recovered without rejoining; cold read served exact IDs across the 500-commit boundary."
    );
    console.log(
      "PASS: binding-only restart, exact mail IDs, lost join and renewal responses, and zero-write empty read."
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
