import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Message, MessageJson, Origin, Presence, runOf } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { mailboxServedDigest } from "../src/mailbox-model.ts";
import { messageCarrierBytes } from "../src/message-carrier.ts";
import { QueryGateway } from "../src/Query.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const cwd = process.cwd();
const inbox = "fixture/mailbox";
const sender = "fixture/sender";
const owner = "session:owner";
const successor = "session:successor";
const publisher = "session:publisher";
const TIMEOUT = 60_000;

interface Hold {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  armed: boolean;
}

interface Probe {
  readonly reads?: Array<number>;
  readonly hold?: Hold;
  readonly holdAck?: Hold;
  uncertainAck?: "committed" | "never-sent";
  hiddenId?: string;
}

type Store = Layer.Layer<Ledger | QueryGateway, unknown, never>;

/** Separate Bus instances have separate installations and local cursor roots, but one ledger. */
const machine = (store: Store, root: string, installation: string, probe: Probe = {}) => {
  const observed = Layer.effect(Ledger)(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const beforePresence = (message: Message) =>
        Effect.gen(function* () {
          const hold = probe.hold;
          if (
            hold?.armed === true &&
            message.from === inbox &&
            message.presence?.session === successor
          ) {
            hold.armed = false;
            yield* Deferred.succeed(hold.reached, undefined);
            yield* Deferred.await(hold.release);
          }
        });
      return Ledger.of({
        ...ledger,
        admit: (entry, basis) =>
          beforePresence(entry).pipe(Effect.andThen(ledger.admit(entry, basis))),
        admitWithStart: (entry, start, basis) =>
          beforePresence(entry).pipe(Effect.andThen(ledger.admitWithStart(entry, start, basis))),
        appendMailboxAck: (record, basis) =>
          Effect.gen(function* () {
            const hold = probe.holdAck;
            if (hold?.armed === true && record.address === inbox) {
              hold.armed = false;
              yield* Deferred.succeed(hold.reached, undefined);
              yield* Deferred.await(hold.release);
            }
            const uncertain = probe.uncertainAck;
            delete probe.uncertainAck;
            if (uncertain === "never-sent") return { status: "UNKNOWN" as const };
            const outcome = yield* ledger.appendMailboxAck(record, basis);
            return uncertain === "committed" ? { status: "UNKNOWN" as const } : outcome;
          }),
        readAt: (from, cut) =>
          Effect.sync(() => probe.reads?.push(from)).pipe(
            Effect.andThen(ledger.readAt(from, cut)),
            Effect.map((slice) => ({
              ...slice,
              entries: slice.entries.filter((entry) => entry.message.id !== probe.hiddenId),
            }))
          ),
      });
    })
  ).pipe(Layer.provideMerge(store));
  return ManagedRuntime.make(
    Bus.layer(installation).pipe(
      Layer.provideMerge(observed),
      Layer.provideMerge(Cursors.layerFiles(join(root, installation))),
      Layer.provide(platform)
    )
  );
};
type Machine = ReturnType<typeof machine>;

const mailbox = async (runtime: Machine) => {
  const state = await runtime.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      return yield* ledger.mailboxAt(inbox, (yield* ledger.presenceAt()).cut);
    })
  );
  if (state.status !== "FOUND") throw new Error("The fixture mailbox has no position.");
  return state;
};

const head = (runtime: Machine) =>
  runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.end));

const joinSender = (runtime: Machine) =>
  runtime.runPromise(
    Effect.flatMap(Bus.Bus, (bus) =>
      bus.join({ address: sender, runtime: "other", session: publisher, cwd })
    )
  );

const joinInbox = (runtime: Machine, topics: ReadonlyArray<string> = []) =>
  runtime.runPromise(
    Effect.flatMap(Bus.Bus, (bus) =>
      bus.join({ address: inbox, runtime: "other", session: owner, cwd, topics })
    )
  );

const send = (runtime: Machine, to: string, body: string) =>
  runtime.runPromise(
    Effect.flatMap(Bus.Bus, (bus) =>
      bus.publish({ from: sender, session: publisher, to: [to], body })
    )
  );

const take = (runtime: Machine, session = owner, limit?: number) =>
  runtime.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.take(inbox, session, limit)));

test(
  "a bounded mailbox reads past a proved large registration but not an unwitnessed carrier",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-registration-window-"));
    const config = await freshLedger("registration-window");
    const store = layerFluree(config, { mailboxHistoryBytes: 8192 }).pipe(Layer.provide(platform));
    const a = machine(store, root, "installation-a");
    try {
      await joinInbox(a);
      await joinSender(a);
      const position = (await mailbox(a)).position;
      await send(a, inbox, "before registration");
      await a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({
            address: "fixture/large",
            session: "large-owner",
            runtime: "other",
            cwd,
            topics: ["x".repeat(12_000)],
          })
        )
      );
      await send(a, inbox, "after registration");
      const cold = await a.runPromise(
        Effect.flatMap(Ledger, (ledger) =>
          Effect.flatMap(ledger.presenceAt(), ({ cut }) => ledger.readAt(position, { ...cut }))
        )
      );
      expect(
        cold.entries.some(({ message }) => message.presence?.topics[0]?.length === 12_000)
      ).toBe(true);
      expect((await take(a)).map(({ body }) => body)).toEqual([
        "before registration",
        "after registration",
      ]);
      const acknowledged = await mailbox(a);

      const unknown = new Message({
        id: Bun.randomUUIDv7(),
        ts: new Date().toISOString(),
        from: "fixture/unknown",
        to: ["*"],
        body: "joined",
        kind: "presence",
        presence: new Presence({
          runtime: "other",
          status: "joined",
          topics: ["y".repeat(12_000)],
        }),
      });
      await insertRaw(config, {
        "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
        "@id": `urn:agent-bus:message:${unknown.id}`,
        "bus:json": Schema.encodeSync(MessageJson)(unknown),
      });
      await send(a, inbox, "beyond unproved registration");
      await expect(take(a)).rejects.toThrow("exceeded 8192 bytes");
      expect(await mailbox(a)).toEqual(acknowledged);
    } finally {
      await a.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

test(
  "a later singleton presence cannot hide two carriers asserted in one commit",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-registration-duplicate-"));
    const config = await freshLedger("registration-duplicate");
    const store = layerFluree(config, { mailboxHistoryBytes: 8192 }).pipe(Layer.provide(platform));
    const a = machine(store, root, "installation-a");
    try {
      await joinInbox(a);
      await joinSender(a);
      const before = await mailbox(a);
      const entry = new Message({
        id: Bun.randomUUIDv7(),
        ts: new Date().toISOString(),
        from: "fixture/double",
        to: ["*"],
        body: "joined",
        kind: "presence",
        presence: new Presence({
          runtime: "other",
          status: "joined",
          topics: ["p".repeat(12_000)],
        }),
      });
      const carrier = Schema.encodeSync(MessageJson)(entry);
      const node = toNode(entry, carrier);
      const extra = "not a carrier";
      await insertRaw(config, { ...node, "bus:json": [carrier, extra] });
      const response = await fetch(
        `${config.url}/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
          body: JSON.stringify({
            "@context": node["@context"],
            delete: { "@id": node["@id"], "bus:json": extra },
          }),
        }
      );
      expect(response.status).toBe(200);
      expect(
        (await a.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.presenceAt()))).entries.some(
          (presence) => presence.id === entry.id
        )
      ).toBe(true);
      await send(a, inbox, "must remain unread");
      await expect(take(a)).rejects.toThrow("exceeded 8192 bytes");
      expect(await mailbox(a)).toEqual(before);
    } finally {
      await a.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

test(
  "a cross-installation takeover inherits an acknowledgement that wins during the join",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-runtime-"));
    const store = layerJsonl(join(root, "ledger.jsonl")).pipe(Layer.provide(platform));
    const hold = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
          armed: true,
        };
      })
    );
    const a = machine(store, root, "installation-a");
    const b = machine(store, root, "installation-b", { hold });
    let joining: Promise<unknown> | undefined;
    try {
      await joinSender(a);
      await joinInbox(a);
      await send(a, inbox, "first");
      await send(a, inbox, "second");
      const peers = await a.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.peers));
      const oldJoin = peers.find((peer) => peer.address === inbox)?.joinId;
      if (oldJoin === undefined) throw new Error("The original holding was not observed.");

      joining = b.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({
            address: inbox,
            runtime: "other",
            session: successor,
            takeover: oldJoin,
            cwd,
          })
        )
      );
      await Promise.race([
        Effect.runPromise(Deferred.await(hold.reached).pipe(Effect.timeout("10 seconds"))),
        joining.then(() => {
          throw new Error("The takeover did not reach the held admission.");
        }),
      ]);
      expect((await take(a, owner, 1)).map((message) => message.body)).toEqual(["first"]);
      const afterAck = await mailbox(a);
      const firstReceipt = afterAck.current.record;
      expect(firstReceipt?.kind).toBe("ack");
      await Effect.runPromise(Deferred.succeed(hold.release, undefined));
      const joined = await joining;
      expect(joined).toMatchObject({ cursor: afterAck.position });
      const afterJoin = await mailbox(b);
      expect(afterJoin.position).toBe(afterAck.position);
      expect(afterJoin.current).toEqual(afterAck.current);

      const rejected = await a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) => Effect.flip(bus.take(inbox, owner)))
      );
      expect(rejected._tag).toBe("NotOwner");
      expect((await mailbox(b)).current).toEqual(afterAck.current);
      expect((await take(b, successor)).map((message) => message.body)).toEqual(["second"]);
    } finally {
      await Effect.runPromise(Deferred.succeed(hold.release, undefined));
      await joining?.catch(() => undefined);
      await Promise.all([a.dispose(), b.dispose()]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

test(
  "a takeover settling first refuses the old run's in-flight acknowledgement",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-stale-"));
    const store = layerJsonl(join(root, "ledger.jsonl")).pipe(Layer.provide(platform));
    const hold = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
          armed: true,
        };
      })
    );
    const a = machine(store, root, "installation-a", { holdAck: hold });
    const b = machine(store, root, "installation-b");
    let reading: Promise<unknown> | undefined;
    try {
      await joinSender(a);
      await joinInbox(a);
      const sent = await send(a, inbox, "still unread after takeover");
      const before = await mailbox(a);
      const oldJoin = before.current.record.operation;
      if (oldJoin === undefined) throw new Error("Missing fixture start.");
      const response = take(a);
      reading = response.catch(() => undefined);
      await Promise.race([
        Effect.runPromise(Deferred.await(hold.reached).pipe(Effect.timeout("10 seconds"))),
        response.then(() => {
          throw new Error("The read did not reach the held acknowledgement.");
        }),
      ]);
      const joined = await b.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({ address: inbox, runtime: "other", session: successor, takeover: oldJoin, cwd })
        )
      );
      expect(joined.cursor).toBe(before.position);
      const admissionHead = await head(b);
      await Effect.runPromise(Deferred.succeed(hold.release, undefined));
      await expect(response).rejects.toThrow("nothing was acknowledged");
      expect(await head(b)).toBe(admissionHead);
      expect((await mailbox(b)).current).toEqual(before.current);
      const served = await take(b, successor);
      expect(served.map(({ id }) => id)).toEqual([sent.message.id]);
      const after = await mailbox(b);
      expect(after.position).toBe(admissionHead);
      expect(after.current.record).toMatchObject({
        kind: "ack",
        from: before.position,
        through: admissionHead,
        servedDigest: mailboxServedDigest([sent.message.id]),
        carrierBytes: messageCarrierBytes(served),
      });
    } finally {
      await Effect.runPromise(Deferred.succeed(hold.release, undefined));
      await reading;
      await Promise.all([a.dispose(), b.dispose()]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

test.each(["committed", "never-sent"] as const)(
  "an unconfirmed %s read does not give a false acknowledgement result",
  async (fault) => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-unknown-"));
    const store = layerJsonl(join(root, "ledger.jsonl")).pipe(Layer.provide(platform));
    const probe: Probe = {};
    const a = machine(store, root, "installation-a", probe);
    try {
      await joinSender(a);
      await joinInbox(a);
      const sent = await send(a, inbox, "uncertain to the caller");
      const before = await mailbox(a);
      const through = await head(a);
      probe.uncertainAck = fault;
      await expect(take(a)).rejects.toThrow("may have committed");
      const observed = await mailbox(a);
      if (fault === "committed") {
        expect(observed.position).toBe(through);
        expect(observed.current.record).toMatchObject({
          through,
          servedDigest: mailboxServedDigest([sent.message.id]),
        });
        expect(await take(a)).toEqual([]);
      } else {
        expect(await head(a)).toBe(through);
        expect(observed.current).toEqual(before.current);
        expect((await take(a)).map(({ id }) => id)).toEqual([sent.message.id]);
      }
    } finally {
      await a.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

test(
  "a rejoin after leave inherits across installations; a different owner starts at the present",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-rejoin-"));
    const store = layerJsonl(join(root, "ledger.jsonl")).pipe(Layer.provide(platform));
    const a = machine(store, root, "installation-a");
    const b = machine(store, root, "installation-b");
    try {
      await joinSender(a);
      await joinInbox(a);
      const initialPeers = await a.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.peers));
      const initial = initialPeers.find((peer) => peer.address === inbox);
      if (initial === undefined) throw new Error("The original holding was not observed.");
      await send(a, inbox, "before leave");
      expect((await take(a)).map((message) => message.body)).toEqual(["before leave"]);
      const beforeLeave = await mailbox(a);
      await a.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.leave(inbox, owner)));
      await send(a, inbox, "while left");

      const rejoined = await joinInbox(b);
      expect(rejoined.cursor).toBe(beforeLeave.position);
      const nextPeers = await b.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.peers));
      const next = nextPeers.find((peer) => peer.address === inbox);
      if (next === undefined) throw new Error("The rejoined holding was not observed.");
      expect(runOf(next)).not.toBe(runOf(initial));
      const rejected = await a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) => Effect.flip(bus.take(inbox, owner)))
      );
      expect(rejected._tag).toBe("NotJoined");
      expect((await mailbox(b)).current).toEqual(beforeLeave.current);
      expect((await take(b)).map((message) => message.body)).toEqual(["while left"]);

      await b.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.leave(inbox, owner)));
      await send(a, inbox, "before new owner");
      const decisionHead = await head(a);
      const newOwner = "session:new-owner";
      const joined = await a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({ address: inbox, runtime: "other", session: newOwner, cwd })
        )
      );
      expect(joined.cursor).toBe(decisionHead);
      expect(await take(a, newOwner)).toEqual([]);
    } finally {
      await Promise.all([a.dispose(), b.dispose()]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

test(
  "an unresolved import survives ordinary join, replay and a would-be successor's restart",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-unresolved-"));
    const store = layerJsonl(join(root, "ledger.jsonl")).pipe(Layer.provide(platform));
    const a = machine(store, root, "installation-a");
    try {
      await joinSender(a);
      const oldJoin = Bun.randomUUIDv7();
      await a.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          yield* ledger.append(
            new Message({
              id: oldJoin,
              ts: new Date().toISOString(),
              from: inbox,
              to: ["*"],
              kind: "presence",
              body: "the previous file-based join",
              presence: new Presence({
                status: "joined",
                runtime: "other",
                session: owner,
                installation: "installation-a",
                topics: [],
              }),
            })
          );
          const basis = (yield* ledger.presenceAt()).cut;
          const result = yield* ledger.classifyMailboxImport(
            {
              version: 1,
              kind: "unresolved",
              operation: Bun.randomUUIDv7(),
              address: inbox,
              reason: "conflict",
            },
            basis
          );
          expect(result.status).toBe("APPLIED");
        })
      );
      await send(a, inbox, "position unknown for this older mail");
      const restartAt = await head(a);
      const joinAs = (input: Partial<Bus.JoinInput>) =>
        a.runPromise(
          Effect.flatMap(Bus.Bus, (bus) =>
            bus.join({ address: inbox, runtime: "other", session: owner, cwd, ...input })
          )
        );
      for (const input of [
        {},
        { replay: true },
        { session: successor, takeover: oldJoin, restartPosition: true },
      ]) {
        await expect(joinAs(input)).rejects.toThrow("unresolved (conflict)");
      }
      await expect(take(a)).rejects.toThrow("unresolved (conflict)");
      expect(await head(a)).toBe(restartAt);
      const restarted = await joinAs({ restartPosition: true });
      expect(restarted.cursor).toBe(restartAt);
      const resolved = await mailbox(a);
      expect(resolved.current.record).toMatchObject({
        kind: "start",
        origin: "restart",
        position: restartAt,
      });
      expect(resolved.current.record.operation).not.toBe(oldJoin);
      expect(await take(a)).toEqual([]);
      const next = await send(a, inbox, "mail after deliberate restart");
      expect((await take(a)).map(({ id }) => id)).toEqual([next.message.id]);
    } finally {
      await a.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

test(
  "a head behind the in-memory scan invalidates the hint even without an incarnation change",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-restore-"));
    const file = join(root, "ledger.jsonl");
    const store = layerJsonl(file).pipe(Layer.provide(platform));
    const reads: Array<number> = [];
    const a = machine(store, root, "installation-a", { reads });
    try {
      await joinSender(a);
      await joinInbox(a);
      await send(a, inbox, "acknowledged before the retained cut");
      await take(a);
      const durable = await mailbox(a);
      const retainedHead = await head(a);
      await send(a, "fixture/elsewhere", "x".repeat(4096));
      const scannedThrough = await head(a);
      expect(await take(a)).toEqual([]);
      expect(await take(a)).toEqual([]);
      expect(reads.at(-1)).toBe(scannedThrough);
      // Disposable ledger restore: the retained position remains valid but the scanned tail is gone.
      truncateSync(file, retainedHead);
      const replacement = await send(a, inbox, "new mail after the retained cut");
      expect(await head(a)).toBeLessThan(scannedThrough);
      expect((await take(a)).map(({ id }) => id)).toEqual([replacement.message.id]);
      expect(reads.at(-1)).toBe(durable.position);
    } finally {
      await a.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

test(
  "empty scans write nothing and a topic change, replay or takeover invalidates their hint",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-hint-"));
    const reads: Array<number> = [];
    const store = layerJsonl(join(root, "ledger.jsonl")).pipe(Layer.provide(platform));
    const a = machine(store, root, "installation-a", { reads });
    try {
      await joinSender(a);
      await joinInbox(a, ["alpha"]);
      await send(a, inbox, "acknowledged");
      expect((await take(a)).map((message) => message.body)).toEqual(["acknowledged"]);
      const acknowledged = await mailbox(a);
      expect(acknowledged.current.record.kind).toBe("ack");
      const settledHead = await head(a);
      let nudges = 0;
      await a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.deliver(inbox, () =>
            Effect.sync(() => {
              nudges += 1;
            })
          )
        )
      );
      expect(nudges).toBe(0);
      expect(
        await a.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.wait(inbox, owner, 0)))
      ).toEqual([]);
      expect(await head(a)).toBe(settledHead);
      expect((await mailbox(a)).current).toEqual(acknowledged.current);

      await send(a, "#beta", "previously skipped");
      const beforeEmpty = await head(a);
      expect(await take(a)).toEqual([]);
      expect(await head(a)).toBe(beforeEmpty);
      expect((await mailbox(a)).current).toEqual(acknowledged.current);

      await send(a, "#gamma", "also unrelated");
      const afterUnrelated = await head(a);
      const priorReads = reads.length;
      expect(await take(a)).toEqual([]);
      expect(reads.slice(priorReads).length).toBeGreaterThan(0);
      expect(reads[priorReads]).toBe(beforeEmpty);
      expect(await head(a)).toBe(afterUnrelated);
      expect((await mailbox(a)).current).toEqual(acknowledged.current);

      await joinInbox(a, ["beta"]);
      expect((await take(a)).map((message) => message.body)).toEqual(["previously skipped"]);
      expect(await take(a)).toEqual([]);
      const beforeReplay = await head(a);
      expect(await take(a)).toEqual([]);
      expect(reads.at(-1)).toBe(beforeReplay);
      await a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({ address: inbox, runtime: "other", session: owner, cwd, replay: true })
        )
      );
      expect((await take(a)).map((message) => message.body)).toEqual([
        "acknowledged",
        "previously skipped",
      ]);
      expect(reads.at(-1)).toBe(0);

      // Exercise a live hint in the same Bus, with no topic change to invalidate it.
      const inherited = await mailbox(a);
      expect(await take(a)).toEqual([]);
      const beforeTakeover = await head(a);
      expect(await take(a)).toEqual([]);
      expect(reads.at(-1)).toBe(beforeTakeover);
      const current = (await a.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.peers))).find(
        ({ address }) => address === inbox
      );
      if (current === undefined) throw new Error("Missing replay holding.");
      const takeover = await a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({
            address: inbox,
            runtime: "other",
            session: successor,
            takeover: current.joinId,
            topics: ["beta"],
            cwd,
          })
        )
      );
      expect(takeover.cursor).toBe(inherited.position);
      expect(await take(a, successor)).toEqual([]);
      expect(reads.at(-1)).toBe(inherited.position);
    } finally {
      await a.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

test(
  "a failed completeness check does not hide a candidate on the next scan",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-omission-"));
    const probe: Probe = {};
    const store = layerJsonl(join(root, "ledger.jsonl")).pipe(Layer.provide(platform));
    const a = machine(store, root, "installation-a", probe);
    try {
      await joinSender(a);
      await joinInbox(a);
      const posted = await send(a, inbox, "temporarily omitted");
      if (!("message" in posted)) throw new Error("The fixture send was not admitted.");
      probe.hiddenId = posted.message.id;
      const before = await mailbox(a);
      const beforeHead = await head(a);
      const error = await a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) => Effect.flip(bus.take(inbox, owner)))
      );
      expect(["LedgerError", "InvalidQuery"]).toContain(error._tag);
      expect((await mailbox(a)).current).toEqual(before.current);
      expect(await head(a)).toBe(beforeHead);
      delete probe.hiddenId;
      expect((await take(a)).map((message) => message.body)).toEqual(["temporarily omitted"]);
    } finally {
      await a.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT
);

for (const indexed of [true, false]) {
  test(
    "a mixed commit with an " +
      (indexed ? "indexed" : "unindexed") +
      " unreadable candidate is not split",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-damage-"));
      const config = await freshLedger("mailbox-runtime-damage");
      const store = layerFluree(config).pipe(Layer.provide(platform));
      const a = machine(store, root, "installation-a");
      try {
        await joinInbox(a);
        const before = await mailbox(a);
        const valid = new Message({
          id: Bun.randomUUIDv7(),
          ts: new Date().toISOString(),
          from: sender,
          to: [inbox],
          kind: "message",
          body: "valid same-commit message",
          origin: new Origin({ host: "fixture" }),
        });
        const encoded = Schema.encodeSync(MessageJson)(valid);
        const node = toNode(valid, encoded);
        const { "@context": context, ...ordinary } = node;
        const id = Bun.randomUUIDv7();
        await insertRaw(config, {
          "@context": context,
          "@graph": [
            ordinary,
            {
              "@id": "urn:agent-bus:message:" + id,
              "@type": "bus:Message",
              ...(indexed ? { "bus:id": id, "bus:to": [inbox] } : {}),
            },
          ],
        });
        const beforeRead = await head(a);
        for (const limit of [1, undefined]) {
          const error = await a.runPromise(
            Effect.flatMap(Bus.Bus, (bus) => Effect.flip(bus.take(inbox, owner, limit)))
          );
          expect(["LedgerError", "InvalidQuery"]).toContain(error._tag);
          expect((await mailbox(a)).current).toEqual(before.current);
          expect(await head(a)).toBe(beforeRead);
        }
      } finally {
        await a.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT
  );
}
