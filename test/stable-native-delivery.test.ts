import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Context, Deferred, Effect, Fiber, Layer, Option, type Scope, Stream } from "effect";
import * as Bus from "../src/Bus.ts";
import { Cursors, layerFiles } from "../src/Cursors.ts";
import { type Daemon, deliverOnce, type Queue } from "../src/codex.ts";
import { Message, Origin, Presence } from "../src/domain.ts";
import { Ledger } from "../src/Ledger.ts";
import { QueryGateway } from "../src/Query.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const installation = "7fd8a650-af65-475f-bbb0-d8d61aa6007c";
const otherInstallation = "b373d27f-5383-4688-9df6-c3dbf5c94c7c";
const originalHost = "Studio.local";
const wifiHost = "Assigned-name.example";
const codex = { address: "codex/local", runtime: "codex", session: "thread-local" } as const;
const claude = { address: "claude/local", runtime: "claude", session: "session-local" } as const;
const owners = [codex, claude] as const;
const sender = { address: "human/sender", runtime: "human", session: "sender" } as const;
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const withStore = <A, E>(
  scenario: (dir: string) => Effect.Effect<A, E, Ledger | QueryGateway | Scope.Scope>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "agent-bus-stable-delivery-"))),
        (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
      ).pipe(
        Effect.flatMap((dir) =>
          scenario(dir).pipe(
            Effect.timeout("4 seconds"),
            Effect.provide(layerJsonl(join(dir, "ledger.jsonl")).pipe(Layer.provide(platform)))
          )
        )
      )
    )
  );

const openBus = (
  dir: string,
  options: {
    readonly id: string;
    readonly hostOf: () => string;
    readonly cursorDir: string;
    readonly observeLedger?: (ledger: Ledger["Service"]) => Ledger["Service"];
    readonly onCursorRead?: (address: string) => void;
  }
) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const gateway = yield* QueryGateway;
    const files = layerFiles(join(dir, options.cursorDir));
    const cursorsLayer =
      options.onCursorRead === undefined
        ? files
        : Layer.effect(
            Cursors,
            Effect.map(Cursors, (cursors) =>
              Cursors.of({
                ...cursors,
                get: (address) =>
                  Effect.sync(() => options.onCursorRead?.(address)).pipe(
                    Effect.andThen(cursors.get(address))
                  ),
              })
            )
          ).pipe(Layer.provide(files));
    const dependencies = Layer.mergeAll(
      Layer.succeed(Ledger)(options.observeLedger?.(ledger) ?? ledger),
      Layer.succeed(QueryGateway)(gateway),
      cursorsLayer
    );
    const context = yield* Layer.build(
      Bus.layer(options.id, options.hostOf).pipe(
        Layer.provideMerge(dependencies),
        Layer.provide(platform)
      )
    );
    return { bus: Context.get(context, Bus.Bus), cursors: Context.get(context, Cursors) };
  });

const joining = (
  owner: {
    readonly address: string;
    readonly runtime: "claude" | "codex" | "human";
    readonly session: string;
  },
  dir: string
) => ({
  ...owner,
  cwd: join(dir, "absent-workdir"),
  ...(owner.runtime === "codex" ? { codexThreadId: owner.session } : {}),
});

/** A plain send with its wake notice. */
const post = (bus: Bus.Bus["Service"], to: ReadonlyArray<string>, body: string) =>
  bus.publish({ from: sender.address, session: sender.session, to, body, pierce: undefined });

const send = (bus: Bus.Bus["Service"], to: ReadonlyArray<string>, body: string) =>
  Effect.map(post(bus, to, body), (posted) => posted.message);

const observeQueue = () => {
  const calls: Array<readonly [string, string]> = [];
  const record = <A>(method: string, thread: string, answer: A) =>
    Effect.sync(() => {
      calls.push([method, thread]);
      return answer;
    });
  const queue: Queue = {
    list: (thread) => record("list", thread, []),
    add: (thread, text) =>
      record("add", thread, { id: "queue-id", clientUserMessageId: "client-id", text }),
    remove: (thread) => record("remove", thread, false),
    rollout: (thread) => record("rollout", thread, { path: undefined, historyMode: "legacy" }),
  };
  const daemon: Daemon = { borrow: (thread) => record("borrow", thread, "loaded" as const) };
  return {
    calls,
    pass: (bus: Bus.Bus["Service"]) =>
      deliverOnce(Effect.succeed(queue), daemon, new Map()).pipe(
        Effect.provideService(Bus.Bus, bus)
      ),
  };
};

const codexCalls: Array<readonly [string, string]> = [
  ["list", codex.session],
  ["add", codex.session],
  ["rollout", codex.session],
];

const wakeAndRead = (
  bus: Bus.Bus["Service"],
  cursors: Cursors["Service"],
  expected: ReadonlyArray<Message>
) =>
  Effect.gen(function* () {
    const before = yield* Effect.forEach(owners, (owner) => cursors.get(owner.address));
    const queue = observeQueue();
    yield* queue.pass(bus);
    expect(queue.calls).toEqual(codexCalls);
    expect((yield* bus.wake(claude.session, 2)).addresses).toEqual([claude.address]);
    expect(yield* Effect.forEach(owners, (owner) => cursors.get(owner.address))).toEqual(before);
    const read = yield* Effect.forEach(owners, (owner) => bus.take(owner.address, owner.session));
    expect(read.map((messages) => messages.map(({ id }) => id))).toEqual(
      expected.map(({ id }) => [id])
    );
  });

test("native wakes survive a hostname change and restart without selecting a foreign installation", () =>
  withStore((dir) =>
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      let host = originalHost;
      const local = { id: installation, hostOf: () => host, cursorDir: "local" };
      const foreign = [
        { ...codex, address: "codex/foreign", session: "thread-foreign" },
        { ...claude, address: "claude/foreign" },
      ];
      const withoutThread = "codex/no-thread";
      const excluded = [...foreign.map(({ address }) => address), withoutThread];
      const { backlog, joins, excludedCursors } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { bus, cursors } = yield* openBus(dir, local);
          yield* bus.join(joining(sender, dir));
          for (const owner of [...owners, ...foreign]) yield* bus.join(joining(owner, dir));
          yield* bus.join({
            address: withoutThread,
            runtime: "codex",
            session: "no-thread",
            cwd: joining(sender, dir).cwd,
          });
          const joins = (yield* bus.peers).filter(({ address }) =>
            owners.some((owner) => owner.address === address)
          );
          const sentinel = yield* send(
            bus,
            owners.map(({ address }) => address),
            "already read"
          );
          for (const owner of owners) {
            expect((yield* bus.take(owner.address, owner.session)).map(({ id }) => id)).toEqual([
              sentinel.id,
            ]);
          }

          host = wifiHost;
          const remote = yield* openBus(dir, {
            id: otherInstallation,
            hostOf: () => wifiHost,
            cursorDir: "remote",
          });
          // The owners moved these addresses; the abandoned cursors are still present locally.
          for (const owner of foreign) yield* remote.bus.join(joining(owner, dir));
          const excludedCursors = yield* Effect.forEach(excluded, cursors.get);
          expect(excludedCursors.every(Option.isSome)).toBe(true);
          // The sender's own read sees the remote joins' recorded prerequisites (another
          // installation, not this one) and the thread missing here, never a locality check.
          const forNonTargets = yield* post(bus, excluded, "mail for non-targets");
          expect(forNonTargets.wake?.lacking).toEqual([
            { address: withoutThread, standing: "no-codex-thread" },
          ]);
          const pending = yield* Effect.forEach(owners, ({ address }) =>
            Effect.map(post(bus, [address], "while renamed"), (posted) => {
              expect(posted).not.toHaveProperty("wake");
              return posted.message;
            })
          );
          expect(pending.map((message) => message.origin?.host)).toEqual([wifiHost, wifiHost]);
          yield* wakeAndRead(bus, cursors, pending);
          const backlog = yield* Effect.forEach(owners, ({ address }) =>
            send(bus, [address], "before restart")
          );
          return { backlog, joins, excludedCursors };
        })
      );

      const { bus, cursors } = yield* openBus(dir, local);
      yield* wakeAndRead(bus, cursors, backlog);
      host = originalHost;
      const returned = yield* Effect.forEach(owners, ({ address }) =>
        send(bus, [address], "back on original network")
      );
      expect(returned.map((message) => message.origin?.host)).toEqual([originalHost, originalHost]);
      yield* wakeAndRead(bus, cursors, returned);
      expect(yield* Effect.forEach(excluded, cursors.get)).toEqual(excludedCursors);
      expect(
        (yield* bus.peers).filter(({ address }) =>
          owners.some((owner) => owner.address === address)
        )
      ).toEqual(joins);
      expect(
        (yield* ledger.presenceAt()).entries
          .filter((entry) => joins.some((peer) => peer.joinId === entry.id))
          .map((entry) => entry.origin?.host)
      ).toEqual([originalHost, originalHost]);
    })
  ));

test("legacy joins need owner renewal, which keeps unread mail, subscriptions and the join run", () =>
  withStore((dir) =>
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const { bus, cursors } = yield* openBus(dir, {
        id: installation,
        hostOf: () => originalHost,
        cursorDir: "local",
      });
      yield* bus.join(joining(sender, dir));
      const topics = ["reviews"];
      const associations = [{ directory: "project", concerns: ["delivery"] }];
      const legacy = yield* Effect.forEach(owners, (owner) =>
        Effect.gen(function* () {
          yield* cursors.set(owner.address, yield* ledger.end);
          const entry = new Message({
            id: Bun.randomUUIDv7(),
            ts: new Date().toISOString(),
            from: owner.address,
            to: ["*"],
            kind: "presence",
            body: "legacy join",
            origin: new Origin({ host: originalHost }),
            presence: new Presence({
              status: "joined",
              runtime: owner.runtime,
              session: owner.session,
              topics,
              associations,
              ...(owner.runtime === "codex" ? { codexThreadId: owner.session } : {}),
            }),
          });
          yield* ledger.append(entry);
          return entry;
        })
      );
      const { message: sentinel, wake } = yield* post(
        bus,
        owners.map(({ address }) => address),
        "explicit read before renewal"
      );
      expect(wake).toEqual({
        ledger: expect.any(String),
        t: expect.any(Number),
        lacking: owners.map(({ address }) => ({ address, standing: "no-installation" })),
      });
      for (const owner of owners) {
        expect((yield* bus.take(owner.address, owner.session)).map(({ id }) => id)).toEqual([
          sentinel.id,
        ]);
      }
      const unread = yield* Effect.forEach(owners, ({ address }) =>
        send(bus, [address], "still unread")
      );
      const before = yield* Effect.forEach(owners, ({ address }) => cursors.get(address));
      const head = yield* ledger.end;
      const queue = observeQueue();
      yield* queue.pass(bus);
      expect(queue.calls).toEqual([]);
      expect(yield* bus.wake(claude.session, 2)).toEqual({
        addresses: [],
        owns: false,
        superseded: false,
      });
      for (const owner of owners) {
        const refused = yield* Effect.flip(
          bus.join(joining({ ...owner, session: "not-the-owner" }, dir))
        );
        expect(refused._tag).toBe("NotOwner");
      }
      expect(yield* ledger.end).toBe(head);
      expect(yield* Effect.forEach(owners, ({ address }) => cursors.get(address))).toEqual(before);

      const renewedCursors: Array<Option.Option<number>> = [];
      for (const [index, owner] of owners.entries()) {
        const renewed = yield* bus.join(joining(owner, dir));
        expect(renewed.topics).toEqual(topics);
        expect(renewed.associations).toEqual(associations);
        renewedCursors.push(Option.some(renewed.cursor));
        const peer = (yield* bus.peers).find(({ address }) => address === owner.address);
        expect(peer?.presence.rejoinOf).toBe(legacy[index]?.id);
      }
      expect(renewedCursors).toEqual(before);
      yield* wakeAndRead(bus, cursors, unread);
      const afterRenewal = yield* post(
        bus,
        owners.map(({ address }) => address),
        "after renewal"
      );
      expect(afterRenewal).not.toHaveProperty("wake");
    })
  ));

test("a send's wake notice comes from its one ownership read, before the append", () =>
  withStore((dir) =>
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const cuts: Array<{ readonly head: number; readonly incarnation: string }> = [];
      const { bus } = yield* openBus(dir, {
        id: installation,
        hostOf: () => originalHost,
        cursorDir: "local",
        observeLedger: (inner) => ({
          ...inner,
          presenceAt: (at) =>
            Effect.tap(inner.presenceAt(at), (read) => Effect.sync(() => cuts.push(read.cut))),
        }),
      });
      const gone = { ...claude, address: "claude/gone", session: "session-gone" };
      for (const owner of [sender, codex, gone]) yield* bus.join(joining(owner, dir));
      yield* bus.leave(gone.address, gone.session);
      const never = "codex/never";
      const head = yield* ledger.end;
      cuts.length = 0;
      const { message, wake } = yield* post(
        bus,
        [sender.address, gone.address, never, "*", "#reviews", never, codex.address],
        "to a mixed audience"
      );
      expect(cuts.map((cut) => cut.head)).toEqual([head]);
      expect(wake).toEqual({
        ledger: cuts[0]?.incarnation ?? "",
        t: head,
        lacking: [
          { address: gone.address, standing: "not-joined" },
          { address: never, standing: "not-joined" },
        ],
      });
      // Stored either way, and read by the recipient that is joined.
      expect((yield* ledger.read(head)).entries.map((entry) => entry.message.id)).toEqual([
        message.id,
      ]);
      expect((yield* bus.take(codex.address, codex.session)).map(({ id }) => id)).toEqual([
        message.id,
      ]);
      // Topic and programme mail, and mail to oneself, carry no notice.
      cuts.length = 0;
      const ambient = yield* post(bus, ["*", "#reviews", sender.address], "ambient");
      expect(ambient).not.toHaveProperty("wake");
      expect(cuts).toHaveLength(1);
      // However many lack and however long their addresses, the notice lists the prefix whose
      // JSON array fits the budget and counts the rest. The docs say 4 KiB.
      expect(Bus.WAKE_LISTED_BYTES).toBe(4096);
      const rowBytes = (rows: ReadonlyArray<unknown>) => Buffer.byteLength(JSON.stringify(rows));
      const many = Array.from({ length: 200 }, (_, i) => `codex/absent-${i}`);
      const bounded = yield* post(bus, many, "to many");
      const listed = bounded.wake?.lacking ?? [];
      expect(listed).toEqual(
        many.slice(0, listed.length).map((address) => ({ address, standing: "not-joined" }))
      );
      expect(rowBytes(listed)).toBeLessThanOrEqual(Bus.WAKE_LISTED_BYTES);
      expect(
        rowBytes([...listed, { address: many[listed.length], standing: "not-joined" }])
      ).toBeGreaterThan(Bus.WAKE_LISTED_BYTES);
      expect(bounded.wake?.unlisted).toBe(many.length - listed.length);
      // One address too long to list, even one quoted twice over, is only counted.
      const long = `codex/${'"'.repeat(Bus.WAKE_LISTED_BYTES)}`;
      expect((yield* post(bus, [long, "codex/absent-0"], "long")).wake).toEqual({
        ledger: cuts[0]?.incarnation ?? "",
        t: expect.any(Number),
        lacking: [],
        unlisted: 2,
      });
    })
  ));

test.each(owners.map((owner) => [owner.runtime, owner] as const))(
  "%s rechecks locality before even reading a stale local cursor",
  (_runtime, owner) =>
    withStore((dir) =>
      Effect.gen(function* () {
        const captured = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let pauseDiscovery = false;
        const reads: Array<string> = [];
        const { bus, cursors } = yield* openBus(dir, {
          id: installation,
          hostOf: () => originalHost,
          cursorDir: "local",
          onCursorRead: (address) => reads.push(address),
          observeLedger: (ledger) => ({
            ...ledger,
            // One controlled notification after the stale first pass; no filesystem event races.
            changes: Stream.fromEffect(Deferred.await(release)),
            presenceAt: (at) =>
              ledger.presenceAt(at).pipe(
                Effect.tap(() =>
                  Effect.suspend(() => {
                    if (!pauseDiscovery) return Effect.void;
                    pauseDiscovery = false;
                    return Deferred.succeed(captured, undefined).pipe(
                      Effect.andThen(Deferred.await(release))
                    );
                  })
                )
              ),
          }),
        });
        yield* bus.join(joining(sender, dir));
        yield* bus.join(joining(owner, dir));
        const previous = yield* cursors.get(owner.address);
        expect(Option.isSome(previous)).toBe(true);
        reads.length = 0;
        const remote = yield* openBus(dir, {
          id: otherInstallation,
          hostOf: () => originalHost,
          cursorDir: "remote",
        });
        const queue = observeQueue();
        pauseDiscovery = true;
        const delivery = yield* Effect.forkChild(
          Effect.gen(function* () {
            return owner.runtime === "codex"
              ? yield* queue.pass(bus)
              : yield* bus.wake(owner.session, 2);
          })
        );
        yield* Deferred.await(captured);
        yield* remote.bus.join(joining(owner, dir));
        // No mail for this address: a late guard on only the nudge callback cannot protect its cursor.
        yield* send(bus, ["human/elsewhere"], "unrelated traffic");
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(delivery);
        if (owner.runtime === "claude")
          expect(result).toEqual({ addresses: [], owns: false, superseded: false });
        expect(queue.calls).toEqual([]);
        expect(reads).toEqual([]);
        expect(yield* cursors.get(owner.address)).toEqual(previous);
      })
    )
);
