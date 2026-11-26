// The read-and-acknowledge contract where only a real store can show it, on a disposable
// Fluree: damage around a recorded batch, an earlier run's bus_ack, two calls racing under one
// read id, uncertain acknowledgements settled by reading the id back, two peeks under Fluree's
// own presence fence, and the MCP wire: a response lost after its commit, a second serve, and
// the exact carrier bytes a client receives.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type * as Bus from "../src/Bus.ts";
import { Message, Origin } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { MIN_READ_RESULT_BYTES, ReadResult } from "../src/mcp-tools.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";
import {
  ack,
  acks,
  busLayer,
  cut,
  failure,
  head,
  hold,
  holdingOf,
  ids,
  inbox,
  joinInbox,
  joinSender,
  leaveInbox,
  type Machine,
  machine,
  owner,
  type Probe,
  platform,
  position,
  reached,
  read,
  receiptOf,
  release,
  replayedReceipt,
  send,
  sender,
} from "./read-contract-support.ts";
import { carrierWidth, compactRow, incumbentWidth, readFixtureId } from "./read-wire-fixture.ts";

const TIMEOUT = 120_000;
const roots: Array<string> = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fresh Fluree ledger and Bus instances over it, one installation, disposed after the test. */
const fixture = async (
  name: string,
  body: (context: {
    readonly config: Awaited<ReturnType<typeof freshLedger>>;
    readonly root: string;
    readonly store: ReturnType<typeof storeOf>;
    readonly bus: (probe?: Probe) => Machine;
  }) => Promise<void>
) => {
  const config = await freshLedger(name);
  const root = mkdtempSync(join(tmpdir(), "agent-bus-read-fluree-"));
  roots.push(root);
  const store = storeOf(config);
  const runtimes: Array<Machine> = [];
  const bus = (probe: Probe = {}) => {
    const runtime = machine(store, root, "installation-a", probe);
    runtimes.push(runtime);
    return runtime;
  };
  try {
    await body({ config, root, store, bus });
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
  }
};
const storeOf = (config: Awaited<ReturnType<typeof freshLedger>>) =>
  layerFluree(config).pipe(Layer.provide(platform));

const peekReceipt = (outcome: Bus.ReadOutcome): Bus.AckInput["receipt"] => {
  const receipt = outcome.receipt;
  if (receipt?.basis === undefined || receipt.served === undefined)
    throw new Error("The peek returned no peek receipt.");
  return { ...receipt, basis: receipt.basis, served: receipt.served };
};

/** A typed message for the inbox whose encoding is missing: damage the raw slice cannot see. */
const insertDamage = async (config: Awaited<ReturnType<typeof freshLedger>>) => {
  const message = new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from: sender,
    to: [inbox],
    kind: "message",
    body: "damaged",
    origin: new Origin({ host: "fixture" }),
  });
  const { "bus:json": _encoding, ...node } = toNode(message, "{}");
  await insertRaw(config, node);
};

test(
  "damage after a recorded batch does not stop its replay; damage at or before its end refuses it",
  () =>
    fixture("read-damage", async ({ config, bus }) => {
      const probe: Probe = {};
      const a = bus(probe);
      const { nextReadId: readId } = await joinInbox(a);
      await joinSender(a);
      const first = await send(a, inbox, "first");
      const second = await send(a, inbox, "second");
      await insertDamage(config);
      // The prefix before the damaged commit is proved, and its limit stops short of it.
      const served = await read(a, { readId, limit: 2 });
      expect(ids(served)).toEqual([first.id, second.id]);
      const before = await head(a);
      expect(ids(await read(a, { readId }))).toEqual([first.id, second.id]);
      // The same history read without one of the served entries: damage at or before through.
      probe.hiddenId = first.id;
      expect(await failure(read(a, { readId }))).toContain("could not be established");
      expect(await head(a)).toBe(before);
    }),
  TIMEOUT
);

test(
  "an earlier run's peek is refused by bus_ack before the store is asked, recorded or not",
  () =>
    fixture("read-earlier-run", async ({ bus }) => {
      const a = bus();
      await joinInbox(a);
      await joinSender(a);
      await send(a, inbox, "acknowledged in the first run");
      const recorded = await read(a, { peek: true });
      await ack(a, peekReceipt(recorded));
      await send(a, inbox, "peeked in the first run");
      const pending = await read(a, { peek: true });
      await leaveInbox(a);
      await joinInbox(a);
      const before = await head(a);
      expect(await failure(ack(a, peekReceipt(recorded)))).toContain("earlier run");
      expect(await failure(ack(a, peekReceipt(pending)))).toContain("changed since this peek");
      expect(await head(a)).toBe(before);
      expect(ids(await read(a))).toEqual(ids(pending));
    }),
  TIMEOUT
);

test.each([
  ["the smaller batch commits first", 1, 2],
  ["the larger batch commits first", 2, 1],
] as const)(
  "two calls racing under one readId leave one acknowledgement: %s",
  (_order, firstLimit, secondLimit) =>
    fixture("read-race", async ({ bus }) => {
      const first = { holdAck: hold() };
      const second = { holdAck: hold() };
      const a = bus(first);
      const b = bus(second);
      const { nextReadId: readId } = await joinInbox(a);
      await joinSender(a);
      await send(a, inbox, "one");
      await send(a, inbox, "two");
      // Both looked the id up, found nothing, and are held before writing different batches.
      const winning = read(a, { readId, limit: firstLimit });
      const losing = read(b, { readId, limit: secondLimit });
      await reached(first.holdAck);
      await reached(second.holdAck);
      await release(first.holdAck);
      const won = await winning;
      expect(won.receipt?.replayed).toBe(false);
      await release(second.holdAck);
      if (firstLimit <= secondLimit) {
        const lost = await losing;
        expect(lost.messages).toEqual(won.messages);
        expect(lost.receipt).toEqual(replayedReceipt(won.receipt));
      } else {
        expect(await failure(losing)).toContain(`a limit of at least ${firstLimit}`);
      }
      const recorded = (await acks(a)).filter(({ operation }) => operation === readId);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.servedCount).toBe(firstLimit);
    }),
  TIMEOUT
);

test(
  "an uncertain acknowledgement is reported only once its id reads back, and names the id to repeat",
  () =>
    fixture("read-unknown", async ({ bus }) => {
      const probe: Probe = {};
      const a = bus(probe);
      await joinInbox(a);
      await joinSender(a);

      // Committed, then answered UNKNOWN: the read-back settles it as this read's own.
      const settled = await send(a, inbox, "committed and settled");
      probe.uncertainAck = "committed";
      const readId = Bun.randomUUIDv7();
      const confirmed = await read(a, { readId });
      expect(ids(confirmed)).toEqual([settled.id]);
      expect(confirmed.receipt).toMatchObject({ readId, replayed: false });

      // Committed, and the read-back unavailable too: refused naming the id, which replays.
      const hidden = await send(a, inbox, "committed, unconfirmed");
      probe.uncertainAck = "committed";
      probe.unavailableLookups = 1;
      const message = await failure(read(a));
      const named = /readId "([0-9a-f-]{36})"/.exec(message)?.[1];
      expect(named).toBeDefined();
      const replayed = await read(a, { readId: named });
      expect(ids(replayed)).toEqual([hidden.id]);
      expect(replayed.receipt?.replayed).toBe(true);

      // Never sent: refused naming the caller's id; repeating it reads the same mail afresh.
      const unsent = await send(a, inbox, "never acknowledged");
      const before = { head: await head(a), position: await position(a) };
      probe.uncertainAck = "never-sent";
      const keyed = Bun.randomUUIDv7();
      expect(await failure(read(a, { readId: keyed }))).toContain(
        `Repeat the read with readId "${keyed}"`
      );
      expect({ head: await head(a), position: await position(a) }).toEqual(before);
      expect((await receiptOf(a, keyed)).status).toBe("ABSENT");
      const fresh = await read(a, { readId: keyed });
      expect(ids(fresh)).toEqual([unsent.id]);
      expect(fresh.receipt).toMatchObject({ readId: keyed, replayed: false });
    }),
  TIMEOUT
);

test(
  "two peeks with identical batches under different topics: Fluree's fence admits only the later",
  () =>
    fixture("read-peek-fence", async ({ bus }) => {
      const a = bus();
      await joinInbox(a, { topics: ["alpha"] });
      await joinSender(a);
      const direct = await send(a, inbox, "the same direct message");
      const first = await read(a, { peek: true });
      await joinInbox(a, { topics: ["beta"] });
      const second = await read(a, { peek: true });
      expect(ids(first)).toEqual([direct.id]);
      expect(peekReceipt(first).served).toEqual(peekReceipt(second).served);
      const before = await head(a);
      expect(await failure(ack(a, peekReceipt(first)))).toContain("changed since this peek");
      expect(await head(a)).toBe(before);
      expect((await ack(a, peekReceipt(second))).receipt.replayed).toBe(false);
      expect(await position(a)).toBe(peekReceipt(second).through);
    }),
  TIMEOUT
);

// ---- the MCP wire ---------------------------------------------------------------------------

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  return port;
};

/** A `serve` over the shared store and its official MCP client. */
const serving = async (store: ReturnType<typeof storeOf>, root: string, probe: Probe = {}) => {
  const port = freePort();
  const runtime = ManagedRuntime.make(
    Serve.layerHttp({ port, version: "test" }).pipe(
      Layer.provideMerge(busLayer(store, root, "installation-a", probe))
    )
  );
  await runtime.runPromise(Effect.void);
  const client = new Client({ name: "read-contract", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return {
    client,
    dispose: async () => {
      await client.close();
      await runtime.dispose();
    },
  };
};

type Received = Awaited<ReturnType<Client["callTool"]>>;
/** The bytes the client received, counted independently: both copies, without JSON-RPC framing. */
const receivedBytes = (result: Received) =>
  Buffer.byteLength(
    JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
      isError: false,
    }),
    "utf8"
  );
const textOf = (result: Received) =>
  Array.isArray(result.content)
    ? result.content.map((item) => ("text" in item ? String(item.text) : "")).join("\n")
    : "";
const decoded = (result: Received) =>
  Schema.decodeUnknownSync(ReadResult)(result.structuredContent);
const checkWire = (result: Received, expected: object) => {
  expect(result.structuredContent).toEqual(expected);
  expect(result.content).toEqual([
    { type: "text", text: JSON.stringify(result.structuredContent) },
  ]);
  expect(receivedBytes(result)).toBe(carrierWidth(expected));
};

const digest = (values: ReadonlyArray<string>) =>
  createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex");

test(
  "replays a predecessor-shaped v1 record and acknowledges an old peek unchanged",
  () =>
    fixture("read-incumbent-shape", async ({ store, root, bus }) => {
      const a = bus();
      const { nextReadId: readId } = await joinInbox(a);
      const holder = await holdingOf(a);
      await joinSender(a);

      // Write an independent predecessor-shaped receipt through real fenced storage,
      // bypassing the candidate's acknowledgement builder and wire serializer.
      const record = async (id: string, message: Message, render: "incumbent" | "compact") => {
        const dataCut = await cut(a);
        const range = { from: await position(a), through: dataCut.head };
        const receipt = { readId: id, ...range, replayed: false };
        const compact = carrierWidth({
          messages: [compactRow(message)],
          receipt,
          nextReadId: readFixtureId,
        });
        const incumbent = incumbentWidth([message], receipt);
        expect(compact).toBeLessThan(incumbent);
        const write = await a.runPromise(
          Effect.flatMap(Ledger, (ledger) =>
            ledger.appendMailboxAck(
              {
                version: 1,
                kind: "ack",
                operation: id,
                address: inbox,
                mode: "read",
                run: holder.joinId,
                ...range,
                dataCut,
                subscription: { presenceId: holder.joinId, topicsDigest: digest([]) },
                servedCount: 1,
                servedDigest: digest([message.id]),
                carrierBytes: render === "incumbent" ? incumbent : compact,
              },
              dataCut
            )
          )
        );
        expect(write.status).toBe("APPLIED");
        return { ...receipt, replayed: true };
      };

      const first = await send(a, inbox, "old keyed batch");
      const predecessor = await record(readId, first, "incumbent");
      const second = await send(a, inbox, 'old peek with newline\n and quoted "body"');
      const peekCut = await cut(a);
      const peek = {
        readId: Bun.randomUUIDv7(),
        from: predecessor.through,
        through: peekCut.head,
        replayed: false,
        basis: { ledger: peekCut.incarnation, t: peekCut.head },
        served: { count: 1, digest: digest([second.id]) },
      };

      const successor = await serving(store, root);
      try {
        const call = (name: string, args: Record<string, unknown>) =>
          successor.client.callTool({
            name,
            arguments: { address: inbox, session: owner, ...args },
          });
        const before = { head: await head(a), position: await position(a) };
        const replay = await call("bus_wait", { readId, timeoutSeconds: 0 });
        expect(replay.isError).not.toBe(true);
        checkWire(replay, {
          messages: [compactRow(first)],
          receipt: predecessor,
          nextReadId: decoded(replay).nextReadId,
        });
        expect({ head: await head(a), position: await position(a) }).toEqual(before);

        const applied = await call("bus_ack", { receipt: peek });
        expect(applied.isError).not.toBe(true);
        expect(applied.structuredContent).toMatchObject({
          receipt: { readId: peek.readId, from: peek.from, through: peek.through, replayed: false },
        });
        expect(await head(a)).toBe(before.head + 1);
        expect(await position(a)).toBe(peek.through);
        const duplicate = await call("bus_ack", { receipt: peek });
        expect(duplicate.isError).not.toBe(true);
        expect(duplicate.structuredContent).toMatchObject({ receipt: { replayed: true } });
        expect(await head(a)).toBe(before.head + 1);
        const restored = await call("bus_read", { readId: peek.readId });
        expect(restored.isError).not.toBe(true);
        expect(decoded(restored).messages).toEqual([compactRow(second)]);
        expect(await head(a)).toBe(before.head + 1);

        // A v1 record with the new wire width is not a valid alternative interpretation.
        const wrongId = Bun.randomUUIDv7();
        const third = await send(a, inbox, "negative v1 width control");
        await record(wrongId, third, "compact");
        const saved = { head: await head(a), position: await position(a) };
        const refused = await call("bus_read", { readId: wrongId });
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toBeUndefined();
        expect(textOf(refused)).toContain("could not be established");
        expect({ head: await head(a), position: await position(a) }).toEqual(saved);
      } finally {
        await successor.dispose();
      }
    }),
  TIMEOUT
);

test(
  "over MCP: a response lost after its commit is recovered by its readId through a second serve, at exact byte bounds",
  () =>
    fixture("read-wire", async ({ store, root, bus }) => {
      const a = bus();
      const probe: Probe = {};
      const first = await serving(store, root, probe);
      let second: Awaited<ReturnType<typeof serving>> | undefined;
      const held = hold();
      try {
        const call = (
          client: Client,
          name: string,
          args: Record<string, unknown>,
          signal?: AbortSignal
        ) => client.callTool({ name, arguments: args }, undefined, signal ? { signal } : {});
        const ok = async (client: Client, name: string, args: Record<string, unknown>) => {
          const result = await call(client, name, args);
          expect(result.isError).not.toBe(true);
          return result;
        };
        const refused = async (client: Client, args: Record<string, unknown>) => {
          const before = await head(a);
          const result = await call(client, "bus_read", {
            address: inbox,
            session: owner,
            ...args,
          });
          expect(result.isError).toBe(true);
          expect(await head(a)).toBe(before);
          return textOf(result);
        };
        const joined = await ok(first.client, "bus_join", {
          address: inbox,
          session: owner,
          runtime: "other",
          cwd: process.cwd(),
        });
        const { nextReadId: readId } = Schema.decodeUnknownSync(
          Schema.Struct({ nextReadId: Schema.String, cursor: Schema.Number })
        )(joined.structuredContent);
        await joinSender(a);
        const aMessage = await send(
          a,
          inbox,
          'multi-byte € 🙂, quotes " \\ , a newline\n, U+2028 \u2028 and \u0001'
        );
        const bMessage = await send(a, inbox, "a second commit");
        const mail = [aMessage, bMessage];

        // The compact peek is admitted using the larger predecessor allowance.
        const beforePeek = await head(a);
        const peek = await ok(first.client, "bus_read", {
          address: inbox,
          session: owner,
          peek: true,
        });
        const peekBytes = receivedBytes(peek);
        const peeked = decoded(peek);
        expect(peeked.receipt).toBeDefined();
        const peekAllowance = incumbentWidth(mail, peeked.receipt);
        expect(peekBytes).toBeLessThan(peekAllowance);
        checkWire(peek, { ...peeked, messages: mail.map(compactRow) });
        expect(
          receivedBytes(
            await ok(first.client, "bus_read", {
              address: inbox,
              session: owner,
              peek: true,
              maxResultBytes: peekAllowance,
            })
          )
        ).toBe(peekBytes);
        // One byte under, the result shrinks by a whole commit, still writing nothing.
        const shrunk = decoded(
          await ok(first.client, "bus_read", {
            address: inbox,
            session: owner,
            peek: true,
            maxResultBytes: peekAllowance - 1,
          })
        );
        expect(shrunk.messages).toEqual(peeked.messages.slice(0, 1));
        expect(await head(a)).toBe(beforePeek);

        const from = peeked.receipt?.from ?? -1;
        const through = peeked.receipt?.through ?? -1;
        const freshReceipt = { readId, from, through, replayed: false };
        const exact = incumbentWidth(mail, freshReceipt);
        // A lone first commit too large for the limit is refused, naming what it needs.
        const lone = incumbentWidth([aMessage], {
          ...freshReceipt,
          through: shrunk.receipt?.through ?? -1,
        });
        expect(await refused(first.client, { readId, maxResultBytes: lone - 1 })).toContain(
          `needs ${lone} result bytes of allowance (including origin) and a limit of at least 1`
        );

        // The response is lost after the acknowledgement commits.
        probe.holdAfterAck = held;
        const abort = new AbortController();
        const lost = call(
          first.client,
          "bus_read",
          { address: inbox, session: owner, readId, maxResultBytes: exact },
          abort.signal
        );
        await reached(held);
        abort.abort();
        await expect(lost).rejects.toThrow();
        await release(held);
        const stored = await receiptOf(a, readId);
        expect(
          stored.status === "FOUND" && stored.record.kind === "ack" && stored.record
        ).toMatchObject({ from, through, carrierBytes: exact, servedCount: 2 });

        // A second serve, on its own process state, replays it from the ledger alone.
        second = await serving(store, root);
        const after = { head: await head(a), position: await position(a) };
        expect(after.position).toBe(through);
        const replayReceipt = { ...freshReceipt, replayed: true };
        const replayAllowance = incumbentWidth(mail, replayReceipt);
        expect(replayAllowance).toBe(exact - 2);
        expect(
          await refused(second.client, { readId, maxResultBytes: replayAllowance - 1 })
        ).toContain(`needs ${replayAllowance} result bytes of allowance (including origin)`);
        const replay = await ok(second.client, "bus_read", {
          address: inbox,
          session: owner,
          readId,
          maxResultBytes: replayAllowance,
        });
        expect(receivedBytes(replay)).toBeLessThan(replayAllowance);
        checkWire(replay, {
          messages: mail.map(compactRow),
          receipt: replayReceipt,
          nextReadId: decoded(replay).nextReadId,
        });
        expect({ head: await head(a), position: await position(a) }).toEqual(after);

        // The minimum holds an empty result exactly; one byte less is refused by validation.
        const empty = await ok(second.client, "bus_read", {
          address: inbox,
          session: owner,
          maxResultBytes: MIN_READ_RESULT_BYTES,
        });
        expect(receivedBytes(empty)).toBe(MIN_READ_RESULT_BYTES);
        expect(MIN_READ_RESULT_BYTES).toBe(216);
        await refused(second.client, { maxResultBytes: MIN_READ_RESULT_BYTES - 1 });

        // bus_wait has no peek: true is refused before anything is read, not ignored.
        await send(a, inbox, "after the refused wait");
        const beforeWait = { head: await head(a), position: await position(a) };
        const waited = await call(second.client, "bus_wait", {
          address: inbox,
          session: owner,
          peek: true,
          timeoutSeconds: 0,
        });
        expect(waited.isError).toBe(true);
        expect({ head: await head(a), position: await position(a) }).toEqual(beforeWait);
        const still = await ok(second.client, "bus_read", { address: inbox, session: owner });
        expect(decoded(still).messages.map(({ body }) => body)).toEqual(["after the refused wait"]);
      } finally {
        await release(held);
        await first.dispose();
        await second?.dispose();
      }
    }),
  TIMEOUT
);
