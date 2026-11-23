import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
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
} from "../src/mailbox-import.ts";
import type { Pin } from "../src/Query.ts";
import { freshLedger } from "./fluree-server.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const stopped = Effect.void;
const notStopped = Effect.fail(new LedgerError({ message: "old writer is not held" }));
const presence = (address: string, installation?: string, status: "joined" | "left" = "joined") =>
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
    }),
  });

const fixture = async () => {
  const config = await freshLedger("paired-mailbox-import");
  const root = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-import-"));
  const roots = [join(root, "copy-a"), join(root, "copy-b")] as const;
  let lose: string | undefined;
  const selected = layerFluree(config);
  const withFault = Layer.effect(Ledger)(
    Effect.map(Ledger, (ledger) =>
      Ledger.of({
        ...ledger,
        importMailbox: (record, basis) =>
          ledger.importMailbox(record, basis).pipe(
            Effect.map((result) => {
              if (record.address !== lose || result.status !== "APPLIED") return result;
              lose = undefined;
              return { status: "UNKNOWN" as const };
            })
          ),
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
      const path = legacyCursorPath(dir, config.ledger, cut.incarnation) + ".v2";
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
  const run = (
    receipts: readonly [MailboxSource, MailboxSource],
    confirm: Effect.Effect<void, LedgerError> = stopped
  ) =>
    runtime.runPromise(
      importMailboxPositions(
        config.ledger,
        [
          { root: roots[0], receipt: receipts[0] },
          { root: roots[1], receipt: receipts[1] },
        ],
        one,
        confirm
      )
    );
  const state = async (address: string) => {
    const cut = await cutNow();
    return use((ledger) => ledger.mailboxAt(address, cut));
  };
  return {
    one,
    two,
    stage,
    captures,
    run,
    state,
    cutNow,
    use,
    loseFirst: (address: string) => {
      lose = address;
    },
    cleanup,
  };
};

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
    stage(0, "already", 6);
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
    await expect(f.run(captures)).rejects.toThrow("returned CONFLICT");
    expect(await f.cutNow()).toEqual(moved);
    expect(await f.state("moved")).toEqual({ status: "ABSENT" });
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
