import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { cursorFileName } from "../src/Cursors.ts";
import { LedgerError, Message, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { initializeInstallation, loadInstallation } from "../src/installation.ts";
import { Ledger } from "../src/Ledger.ts";
import {
  captureMailboxSource,
  importMailboxPositions,
  legacyCursorPath,
  type MailboxSource,
  verifyMailboxImport,
} from "../src/mailbox-import.ts";
import { mailboxReceiptIri } from "../src/mailbox-model.ts";
import type { Pin } from "../src/Query.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const stopped = Effect.void;
const notStopped = Effect.fail(new LedgerError({ message: "old writer is not held" }));
const presence = (
  address: string,
  installation?: string,
  status: "joined" | "left" = "joined",
  rejoinOf?: string
) =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from: address,
    to: ["*"],
    kind: "presence",
    body: `${address} ${status}`,
    presence: new Presence({
      runtime: "other",
      session: `owner:${address}`,
      topics: [],
      status,
      ...(installation === undefined ? {} : { installation }),
      ...(rejoinOf === undefined ? {} : { rejoinOf }),
    }),
  });

const fixture = async () => {
  const config = await freshLedger("paired-mailbox-import");
  const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-import-"));
  const roots = [join(root, "copy-a"), join(root, "copy-b")] as const;
  let lose: string | undefined;
  const admissions: Array<{ address: string; head: number }> = [];
  let renewAtAdmission: Message | undefined;
  let substitutePosition: number | undefined;
  let loseAck = false;
  let originFault:
    | { address: string; operation: string; status: "UNAVAILABLE" | "ABSENT" }
    | undefined;
  const selected = layerFluree(config);
  const withFault = Layer.effect(Ledger)(
    Effect.map(Ledger, (ledger) =>
      Ledger.of({
        ...ledger,
        mailboxReceiptAt: (address, operation, cut) => {
          if (originFault?.address !== address || originFault.operation !== operation)
            return ledger.mailboxReceiptAt(address, operation, cut);
          const { status } = originFault;
          originFault = undefined;
          return Effect.succeed(status === "ABSENT" ? { status, cut } : { status });
        },
        appendMailboxAck: (ack, basis) =>
          ledger.appendMailboxAck(ack, basis).pipe(
            Effect.map((result) => {
              if (!loseAck || result.status !== "APPLIED") return result;
              loseAck = false;
              return { status: "UNKNOWN" as const };
            })
          ),
        importMailbox: (record, basis) =>
          Effect.gen(function* () {
            admissions.push({ address: record.address, head: basis.head });
            if (renewAtAdmission?.from === record.address) {
              const renewal = renewAtAdmission;
              renewAtAdmission = undefined;
              const renewed = yield* ledger.admit(renewal, basis).pipe(Effect.orDie);
              expect(renewed.status).toBe("ADMITTED");
            }
            const result = yield* ledger.importMailbox(
              substitutePosition === undefined
                ? record
                : { ...record, position: substitutePosition },
              basis
            );
            if (record.address !== lose || result.status !== "APPLIED") return result;
            lose = undefined;
            return { status: "UNKNOWN" as const };
          }),
        classifyMailboxImport: (record, basis) => {
          admissions.push({ address: record.address, head: basis.head });
          return ledger.classifyMailboxImport(record, basis);
        },
      })
    )
  ).pipe(Layer.provideMerge(selected));
  const runtime = ManagedRuntime.make(withFault.pipe(Layer.provideMerge(platform)));
  const cleanup = async () => {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  };
  const [one, two] = await runtime
    .runPromise(
      Effect.all(
        roots.map((dir) => initializeInstallation(dir).pipe(Effect.andThen(loadInstallation(dir))))
      )
    )
    .catch(async (error: unknown) => {
      await cleanup();
      throw error;
    });
  if (one === undefined || two === undefined) {
    await cleanup();
    throw new Error("fixture installation missing");
  }
  const use = <A, E>(f: (ledger: Ledger["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Ledger, f));
  const cutNow = () => use((ledger) => ledger.presenceAt().pipe(Effect.map(({ cut }) => cut)));
  const stage = (cut: Pin) => {
    const paths = roots.map((dir) => {
      // Build the files where the released writer put them, independently of the importer.
      const path = join(
        dir,
        "fluree-cursors",
        encodeURIComponent(config.ledger),
        cut.incarnation + ".v2"
      );
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, "layout"),
        JSON.stringify({
          generation: Bun.randomUUIDv7(),
          legacy: createHash("sha256").update("[]").digest("hex"),
        })
      );
      return path;
    });
    return (at: 0 | 1, address: string, cursor: number, differentAddress?: string): string => {
      const dir = paths[at];
      if (dir === undefined) throw new Error("fixture layout missing");
      const file = join(dir, cursorFileName(address));
      writeFileSync(file, JSON.stringify({ address: differentAddress ?? address, cursor }));
      return file;
    };
  };
  const captures = async (cut: Pin, confirm: Effect.Effect<void, LedgerError> = stopped) => {
    const receipts = await runtime.runPromise(
      Effect.all(roots.map((dir) => captureMailboxSource(dir, config.ledger, cut, confirm)))
    );
    const [a, b] = receipts;
    if (a === undefined || b === undefined) throw new Error("fixture capture missing");
    return [a, b] as const;
  };
  const copies = (receipts: readonly [MailboxSource, MailboxSource]) =>
    [
      { root: roots[0], receipt: receipts[0] },
      { root: roots[1], receipt: receipts[1] },
    ] as const;
  const run = (
    receipts: readonly [MailboxSource, MailboxSource],
    confirm: Effect.Effect<void, LedgerError> = stopped
  ) => runtime.runPromise(importMailboxPositions(config.ledger, copies(receipts), one, confirm));
  const verify = (
    receipts: readonly [MailboxSource, MailboxSource],
    beforeRead?: (
      address: string,
      cut: Pin,
      ledger: Ledger["Service"]
    ) => Effect.Effect<void, LedgerError>
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const proof = verifyMailboxImport(config.ledger, copies(receipts), one);
        if (beforeRead === undefined) return yield* proof;
        return yield* proof.pipe(
          Effect.provideService(
            Ledger,
            Ledger.of({
              ...ledger,
              mailboxAt: (address, cut) =>
                beforeRead(address, cut, ledger).pipe(
                  Effect.andThen(ledger.mailboxAt(address, cut))
                ),
            })
          )
        );
      })
    );
  const state = async (address: string) => {
    const cut = await cutNow();
    return use((ledger) => ledger.mailboxAt(address, cut));
  };
  return {
    one,
    two,
    damageReceipt: (id: string) =>
      insertRaw(config, {
        "@id": mailboxReceiptIri(id),
        "https://example.invalid/unexpected": "damaged",
      }),
    loseNextAck: () => {
      loseAck = true;
    },
    failNextOriginLookup: (
      address: string,
      operation: string,
      status: "UNAVAILABLE" | "ABSENT"
    ) => {
      originFault = { address, operation, status };
    },
    machine: (installation: string) =>
      ManagedRuntime.make(
        Bus.layer(installation).pipe(
          Layer.provideMerge(withFault),
          Layer.provide(Cursors.layerFiles(join(root, installation))),
          Layer.provide(platform)
        )
      ),
    stage,
    captures,
    run,
    verify,
    state,
    cutNow,
    use,
    admissions,
    renewBeforeWrite: (entry: Message) => {
      renewAtAdmission = entry;
    },
    writeDifferentPosition: (value: number) => {
      substitutePosition = value;
    },
    loseFirst: (address: string) => {
      lose = address;
    },
    cleanup,
  };
};

test("paired capture preserves manual reads without granting the old join a wake installation", async () => {
  const f = await fixture();
  let source = f.machine(f.one);
  const peer = f.machine(f.two);
  try {
    const address = "legacy/manual";
    const session = `owner:${address}`;
    const holding = presence(address);
    await f.use((ledger) => ledger.append(holding));
    const mail = (body: string) =>
      new Message({
        id: Bun.randomUUIDv7(),
        ts: new Date().toISOString(),
        from: "legacy/sender",
        to: [address],
        kind: "message",
        body,
      });
    await f.use((ledger) => ledger.append(mail("consumed")));
    const position = (await f.cutNow()).head;
    const first = mail("first unread");
    const second = mail("second unread");
    await f.use((ledger) => ledger.append(first));
    await f.use((ledger) => ledger.append(second));
    const cut = await f.cutNow();
    f.stage(cut)(0, address, position);
    const captures = await f.captures(cut);
    const result = await f.run(captures);
    const operation = result.rows[0]?.operation;
    if (!operation) throw new Error("No import operation.");
    const read = (machine: typeof source, holder: string) =>
      machine.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.take(address, holder)));
    const before = await f.cutNow();
    await expect(read(peer, session)).rejects.toThrow();
    await expect(read(source, "different-session")).rejects.toThrow();
    expect(
      await source.runPromise(
        Effect.flatMap(Bus.Bus, (bus) => bus.deliver(address, () => Effect.succeed("woke")))
      )
    ).toBeUndefined();
    expect(await f.cutNow()).toEqual(before);
    const peek = await source.runPromise(
      Effect.flatMap(Bus.Bus, (bus) => bus.read({ address, session, peek: true, limit: 1 }))
    );
    expect(peek.messages.map(({ id }) => id)).toEqual([first.id]);
    const proof = peek.receipt;
    if (!proof?.basis || !proof.served) throw new Error("No peek witness.");
    const receipt = { ...proof, basis: proof.basis, served: proof.served };
    const ack = (machine: typeof source) =>
      machine.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.ack({ address, session, receipt })));
    f.loseNextAck();
    expect((await ack(source)).receipt.readId).toBe(receipt.readId);
    await source.dispose();
    source = f.machine(f.one);
    await expect(ack(peer)).rejects.toMatchObject({
      _tag: "NotJoined",
      message: "This holding did not join from this installation; nothing was changed.",
    });
    expect((await ack(source)).receipt.replayed).toBe(true);
    const readId = Bun.randomUUIDv7();
    const keyed = (machine: typeof source, holder = session, id = readId) =>
      machine.runPromise(
        Effect.flatMap(Bus.Bus, (bus) => bus.read({ address, session: holder, readId: id }))
      );
    const afterAck = await f.cutNow();
    const acknowledged = await f.state(address);
    expect(acknowledged).toMatchObject({ current: { record: { operation: receipt.readId } } });
    f.failNextOriginLookup(address, operation, "UNAVAILABLE");
    await expect(keyed(source, "different-session")).rejects.toMatchObject({ _tag: "NotOwner" });
    await expect(keyed(source)).rejects.toMatchObject({
      _tag: "LedgerError",
      message: expect.stringMatching(/Retry the same call once.*same readId/),
    });
    await expect(keyed(peer)).rejects.toMatchObject({
      _tag: "NotJoined",
      message: "This holding did not join from this installation; nothing was changed.",
    });
    f.failNextOriginLookup(address, operation, "ABSENT");
    await expect(keyed(source)).rejects.toMatchObject({
      _tag: "LedgerError",
      message: expect.stringContaining("Ask the operator to reconcile"),
    });
    expect(await f.cutNow()).toEqual(afterAck);
    expect(await f.state(address)).toEqual(acknowledged);
    const recovered = await keyed(source);
    expect(recovered.messages.map(({ id }) => id)).toEqual([second.id]);
    expect(recovered.receipt).toMatchObject({ readId, replayed: false });
    const replay = await keyed(source);
    expect(replay.messages).toEqual(recovered.messages);
    expect(replay.receipt).toMatchObject({ readId, replayed: true });
    expect((await keyed(source, session, recovered.nextReadId)).messages).toEqual([]);
    expect((await f.use((ledger) => ledger.presenceAt())).entries).toEqual([holding]);
    expect((await f.cutNow()).head).toBe(before.head + 2);
    expect(
      await source.runPromise(
        Effect.flatMap(Bus.Bus, (bus) => bus.deliver(address, () => Effect.succeed("woke")))
      )
    ).toBeUndefined();
    await f.damageReceipt(operation);
    const damaged = await f.cutNow();
    expect(await f.state(address)).toMatchObject({ status: "FOUND" });
    const damagedEvidence = {
      _tag: "LedgerError",
      message: expect.stringContaining("Ask the operator to reconcile"),
    };
    await expect(keyed(source)).rejects.toMatchObject(damagedEvidence);
    await expect(ack(source)).rejects.toMatchObject(damagedEvidence);
    expect(await f.cutNow()).toEqual(damaged);
  } finally {
    await source.dispose();
    await peer.dispose();
    await f.cleanup();
  }
}, 30_000);

test("a dormant import distinguishes exact position, proven absence, and uncertain position when the vacancy is claimed", async () => {
  const f = await fixture();
  const a = f.machine(f.one);
  const b = f.machine(f.two);
  try {
    const addresses = [
      "same-home",
      "other-home",
      "new-owner",
      "no-files",
      "replay-empty",
      "conflict",
      "garbled",
      "renewed",
    ];
    for (const address of addresses) {
      await f.use((ledger) => ledger.append(presence(address)));
      if (address !== "renewed")
        await f.use((ledger) => ledger.append(presence(address, undefined, "left")));
    }
    const cut = await f.cutNow();
    const stage = f.stage(cut);
    for (const address of addresses)
      if (address !== "no-files" && address !== "replay-empty") stage(0, address, 1);
    stage(1, "conflict", 2);
    writeFileSync(stage(0, "garbled", 1), "not JSON");
    const captures = await f.captures(cut);
    const proof = await f.run(captures);
    expect(proof.rows.find(({ address }) => address === "conflict")).toMatchObject({
      reason: "conflict",
    });
    expect(proof.rows.find(({ address }) => address === "garbled")).toMatchObject({
      reason: "unreadable",
    });
    const verified = await f.verify(captures);
    const byAddress = new Map(verified.rows.map((row) => [row.address, row.legacyAccess]));
    expect(byAddress.get("renewed")).toBe("manual-on-source");
    expect(byAddress.get("same-home")).toBe("return-on-source");
    expect(byAddress.get("no-files")).toBe("vacant-no-files");
    expect(byAddress.get("conflict")).toBe("fresh-claimant-only");
    const claim = (machine: typeof a, address: string, session = `owner:${address}`) =>
      machine.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({ address, session, runtime: "other", cwd: "/fixture" })
        )
      );
    expect((await claim(a, "same-home")).cursor).toBe(1);
    for (const [machine, address, who] of [
      [b, "other-home", "owner:other-home"],
      [a, "new-owner", "new-session"],
      [a, "no-files", "owner:no-files"],
    ] as const) {
      const before = await f.cutNow();
      expect((await claim(machine, address, who)).cursor).toBe(before.head);
    }
    for (const address of ["conflict", "garbled"]) {
      const before = await f.cutNow();
      await expect(claim(a, address)).rejects.toThrow("unresolved");
      expect(await f.cutNow()).toEqual(before);
      expect((await claim(a, address, "new-session")).cursor).toBe(before.head);
    }
    expect(
      (
        await a.runPromise(
          Effect.flatMap(Bus.Bus, (bus) =>
            bus.join({
              address: "replay-empty",
              session: "owner:replay-empty",
              runtime: "other",
              cwd: "/fixture",
              replay: true,
            })
          )
        )
      ).cursor
    ).toBe(0);
    // This is a real renewal of a still-joined holding, not a return from a captured vacancy.
    expect((await claim(b, "renewed")).cursor).toBe(1);
    expect(
      (await f.use((ledger) => ledger.presenceAt())).entries.at(-1)?.presence?.installation
    ).toBe(f.two);
    await expect(
      a.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.take("renewed", "owner:renewed")))
    ).rejects.toThrow();
  } finally {
    await a.dispose();
    await b.dispose();
    await f.cleanup();
  }
}, 30_000);

test("the released layout encodes the ledger, preserves the raw incarnation, and rejects escaping components", async () => {
  const root = join(tmpdir(), "mailbox-layout-fixture");
  expect(await Effect.runPromise(legacyCursorPath(root, "inbox/test:main", "gen:#%2F"))).toBe(
    join(root, "fluree-cursors", "inbox%2Ftest%3Amain", "gen:#%2F")
  );
  for (const incarnation of [
    "",
    ".",
    "..",
    "/escape",
    "nested/../escape",
    "bad\\path",
    "bad\0path",
  ]) {
    await expect(
      Effect.runPromise(legacyCursorPath(root, "inbox:main", incarnation))
    ).rejects.toThrow("safe cursor directories");
  }
  await expect(Effect.runPromise(legacyCursorPath(root, "..", "generation"))).rejects.toThrow(
    "safe cursor directories"
  );
});

test("paired import preserves exact local and left positions, classifies conflicting sources, and never overwrites a foreign fact", async () => {
  const f = await fixture();
  try {
    for (const address of [
      "kept",
      "left",
      "duplicate",
      "missing",
      "wrong-host",
      "malformed",
      "mismatch",
      "ahead",
      "already",
    ]) {
      await f.use((ledger) => ledger.append(presence(address, f.one)));
    }
    await f.use((ledger) => ledger.append(presence("left", undefined, "left")));
    const earlier = await f.cutNow();
    expect(
      (
        await f.use((ledger) =>
          ledger.importMailbox(
            {
              version: 1,
              kind: "start",
              operation: Bun.randomUUIDv7(),
              address: "already",
              run: "written-before-import",
              origin: "import",
              position: 0,
            },
            earlier
          )
        )
      ).status
    ).toBe("APPLIED");
    const cut = await f.cutNow();
    const stage = f.stage(cut);
    const retained = stage(0, "kept", 2);
    stage(0, "left", 3);
    stage(0, "duplicate", 4);
    stage(1, "duplicate", 4);
    stage(1, "wrong-host", 5);
    writeFileSync(stage(0, "malformed", 0), "{}");
    stage(0, "mismatch", 0, "another-address");
    stage(0, "ahead", cut.head + 1);
    stage(0, "already", 0);
    const originalBytes = readFileSync(retained);
    const captures = await f.captures(cut);
    await expect(f.run(captures, notStopped)).rejects.toThrow("old writer is not held");
    expect(await f.cutNow()).toEqual(cut);
    const report = await f.run(captures);
    expect(report.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: "kept", status: "IMPORTED", position: 2 }),
        expect.objectContaining({ address: "left", status: "IMPORTED", position: 3 }),
        expect.objectContaining({ address: "duplicate", status: "CLASSIFIED", reason: "conflict" }),
        expect.objectContaining({ address: "missing", status: "CLASSIFIED", reason: "missing" }),
        expect.objectContaining({ address: "wrong-host", status: "CLASSIFIED", reason: "stale" }),
        expect.objectContaining({
          address: "malformed",
          status: "CLASSIFIED",
          reason: "unreadable",
        }),
        expect.objectContaining({
          address: "mismatch",
          status: "CLASSIFIED",
          reason: "unattributable",
        }),
        expect.objectContaining({ address: "ahead", status: "CLASSIFIED", reason: "ahead" }),
        expect.objectContaining({ address: "already", status: "UNCHANGED" }),
      ])
    );
    expect(await f.state("kept")).toMatchObject({ status: "FOUND", position: 2 });
    expect(await f.state("left")).toMatchObject({ status: "FOUND", position: 3 });
    expect(await f.state("duplicate")).toMatchObject({ status: "UNRESOLVED", reason: "conflict" });
    expect(await f.state("already")).toMatchObject({ status: "FOUND", position: 0 });
    const after = await f.cutNow();
    await expect(f.verify(captures)).rejects.toThrow("no exact current receipt for already");
    expect(await f.cutNow()).toEqual(after);
    expect(readFileSync(retained)).toEqual(originalBytes);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a changing source or truncated copy refuses before any classification or import", async () => {
  const f = await fixture();
  try {
    await f.use((ledger) => ledger.append(presence("first", f.one)));
    await f.use((ledger) => ledger.append(presence("second", f.two)));
    const cut = await f.cutNow();
    const stage = f.stage(cut);
    const first = stage(0, "first", 0);
    const missing = stage(1, "second", 1);
    const initial = readFileSync(first);
    let holdChecks = 0;
    await expect(
      f.captures(
        cut,
        Effect.sync(() => {
          if (++holdChecks === 2) writeFileSync(first, '{"address":"first","cursor":1}');
        })
      )
    ).rejects.toThrow("inventory changed during capture");
    writeFileSync(first, initial);
    const captures = await f.captures(cut);
    await expect(f.run([captures[0], captures[0]])).rejects.toThrow("two distinct installations");
    rmSync(missing);
    await expect(f.run(captures)).rejects.toThrow("inventory does not match");
    expect(await f.cutNow()).toEqual(cut);
    expect(await f.state("first")).toEqual({ status: "ABSENT" });
    expect(await f.state("second")).toEqual({ status: "ABSENT" });
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a later presence fences the old installation's snapshot at the original cut", async () => {
  const f = await fixture();
  try {
    await f.use((ledger) => ledger.append(presence("moved", f.one)));
    const original = await f.cutNow();
    f.stage(original)(0, "moved", original.head);
    const captures = await f.captures(original);
    // A rogue earlier writer moved this holding after the source capture, with no ledger start.
    await f.use((ledger) => ledger.append(presence("moved", f.two)));
    const moved = await f.cutNow();
    await expect(f.run(captures)).rejects.toThrow("changed after capture");
    expect(await f.cutNow()).toEqual(moved);
    expect(await f.state("moved")).toEqual({ status: "ABSENT" });
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("capture defines the source; a fresh admission cut may include earlier rows of the same import", async () => {
  const f = await fixture();
  try {
    for (const address of ["a-first", "b-left", "c-missing"])
      await f.use((ledger) => ledger.append(presence(address, f.one)));
    const left = presence("b-left", undefined, "left");
    await f.use((ledger) => ledger.append(left));
    const source = await f.cutNow();
    const stage = f.stage(source);
    stage(0, "a-first", 0);
    stage(0, "b-left", 1);
    const captures = await f.captures(source);
    await f.use((ledger) =>
      ledger.append(
        new Message({
          id: Bun.randomUUIDv7(),
          ts: new Date().toISOString(),
          from: "other/sender",
          to: ["other/reader"],
          kind: "message",
          body: "after the paired capture",
        })
      )
    );
    const result = await f.run(captures);
    expect(result.cut).toEqual(source);
    expect(f.admissions).toEqual([
      { address: "a-first", head: source.head + 1 },
      { address: "b-left", head: source.head + 2 },
      { address: "c-missing", head: source.head + 3 },
    ]);
    expect(result.rows[1]).toMatchObject({ address: "b-left", status: "IMPORTED", position: 1 });
    expect(result.rows[2]).toMatchObject({ address: "c-missing", status: "CLASSIFIED" });
    expect(await f.state("a-first")).toMatchObject({ status: "FOUND", position: 0 });
    expect(await f.state("b-left")).toMatchObject({ status: "FOUND", position: 1 });
    expect(await f.state("c-missing")).toMatchObject({ status: "UNRESOLVED", reason: "missing" });
    const before = await f.cutNow();
    const replayed = await f.run(captures);
    expect(replayed.rows.map(({ status }) => status)).toEqual([
      "VERIFIED_IMPORT",
      "VERIFIED_IMPORT",
      "VERIFIED_CLASSIFICATION",
    ]);
    expect(replayed.rows.map(({ operation }) => operation)).toEqual(
      result.rows.map(({ operation }) => operation)
    );
    expect(f.admissions).toHaveLength(3);
    expect(await f.cutNow()).toEqual(before);
    const seen: Pin[] = [];
    const proof = await f.verify(captures, (_, at) =>
      Effect.sync(() => {
        seen.push(at);
      })
    );
    expect(proof).toMatchObject({
      cut: source,
      verifiedAt: before,
      rows: [
        { address: "a-first", status: "VERIFIED_IMPORT", position: 0, latestStatus: "joined" },
        {
          address: "b-left",
          status: "VERIFIED_IMPORT",
          position: 1,
          latestStatus: "left",
          latestPresenceId: left.id,
          lastJoinId: expect.any(String),
        },
        { address: "c-missing", status: "VERIFIED_CLASSIFICATION", reason: "missing" },
      ],
    });
    expect(proof.rows[1]?.lastJoinId).not.toBe(left.id);
    expect(proof.rows.map(({ operation }) => operation)).toEqual(
      result.rows.map(({ operation }) => operation)
    );
    expect(seen).toEqual([before, before, before]);
    expect(await f.cutNow()).toEqual(before);
    const renewal = presence("a-first", f.one, "joined", proof.rows[0]?.latestPresenceId);
    expect((await f.use((ledger) => ledger.admit(renewal, before))).status).toBe("ADMITTED");
    const renewed = await f.cutNow();
    expect((await f.run(captures)).rows[0]?.status).toBe("VERIFIED_IMPORT");
    await expect(f.verify(captures)).rejects.toThrow("holding for a-first changed after capture");
    expect(await f.cutNow()).toEqual(renewed);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("proof requires every classification to be current, not merely an immutable historical success", async () => {
  const f = await fixture();
  try {
    for (const address of ["a-good", "b-missing"])
      await f.use((ledger) => ledger.append(presence(address, f.one)));
    const cut = await f.cutNow();
    f.stage(cut)(0, "a-good", 0);
    const captures = await f.captures(cut);
    f.loseFirst("a-good");
    await expect(f.run(captures)).rejects.toThrow("returned UNKNOWN");
    const partial = await f.cutNow();
    await expect(f.verify(captures)).rejects.toThrow("no exact current receipt for b-missing");
    expect(await f.cutNow()).toEqual(partial);
    const complete = await f.run(captures);
    const expected = complete.rows[1];
    if (expected === undefined) throw new Error("missing fixture classification");
    const verified = await f.cutNow();
    const proof = await f.verify(captures, (address, at, ledgerForRace) =>
      address !== "b-missing"
        ? Effect.void
        : Effect.gen(function* () {
            const result = yield* ledgerForRace.importMailbox(
              {
                version: 1,
                kind: "start",
                address,
                operation: Bun.randomUUIDv7(),
                origin: "reconcile",
                run: "recovered",
                position: 0,
              },
              at
            );
            expect(result.status).toBe("APPLIED");
          })
    );
    expect(proof.verifiedAt).toEqual(verified);
    expect(proof.rows[1]).toMatchObject({
      status: "VERIFIED_CLASSIFICATION",
      operation: expected.operation,
    });
    const advanced = await f.cutNow();
    expect(advanced.head).toBe(verified.head + 1);
    expect(
      (await f.use((ledger) => ledger.mailboxReceiptAt("b-missing", expected.operation, advanced)))
        .status
    ).toBe("FOUND");
    await expect(f.verify(captures)).rejects.toThrow("no exact current receipt for b-missing");
    expect(await f.cutNow()).toEqual(advanced);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("an exact operation id alone does not prove the captured position", async () => {
  const f = await fixture();
  try {
    const original = presence("holding", f.one);
    await f.use((ledger) => ledger.append(original));
    const cut = await f.cutNow();
    f.stage(cut)(0, "holding", 1);
    const captures = await f.captures(cut);
    f.writeDifferentPosition(0);
    const reported = await f.run(captures);
    expect(reported.rows[0]).toMatchObject({ status: "IMPORTED", position: 1 });
    const before = await f.cutNow();
    expect(await f.state("holding")).toMatchObject({
      status: "FOUND",
      position: 0,
      current: { record: { operation: reported.rows[0]?.operation } },
    });
    await expect(f.verify(captures)).rejects.toThrow("no exact current receipt");
    expect(await f.cutNow()).toEqual(before);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a renewal after authorization but before the import write leaves the position absent", async () => {
  const f = await fixture();
  try {
    const old = presence("held", f.one);
    await f.use((ledger) => ledger.append(old));
    const source = await f.cutNow();
    f.stage(source)(0, "held", 0);
    const captures = await f.captures(source);
    f.renewBeforeWrite(presence("held", f.one, "joined", old.id));
    await expect(f.run(captures)).rejects.toThrow("returned CONFLICT");
    expect((await f.cutNow()).head).toBe(source.head + 1);
    expect(await f.state("held")).toEqual({ status: "ABSENT" });
    await expect(f.run(captures)).rejects.toThrow("changed after capture");
    expect(f.admissions).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("resuming an uncertain import verifies the same durable operation before finishing other addresses", async () => {
  const f = await fixture();
  try {
    await f.use((ledger) => ledger.append(presence("first", f.one)));
    await f.use((ledger) => ledger.append(presence("second", f.two)));
    const cut = await f.cutNow();
    const stage = f.stage(cut);
    stage(0, "first", 1);
    stage(1, "second", 2);
    const captures = await f.captures(cut);
    f.loseFirst("first");
    await expect(f.run(captures)).rejects.toThrow("returned UNKNOWN");
    const changed = await f.state("first");
    if (changed.status !== "FOUND") throw new Error("fixture lost the committed write");
    const operation = changed.current.record.operation;
    expect(await f.state("second")).toEqual({ status: "ABSENT" });
    const resumed = await f.run(captures);
    expect(resumed.rows).toEqual([
      { address: "first", operation, status: "VERIFIED_IMPORT", position: 1 },
      { address: "second", operation: expect.any(String), status: "IMPORTED", position: 2 },
    ]);
    expect(await f.state("first")).toEqual(changed);
    expect((await f.cutNow()).head).toBe(cut.head + 2);
  } finally {
    await f.cleanup();
  }
}, 30_000);
