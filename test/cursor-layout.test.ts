import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import { Cursors, cursorFileName, layerFiles } from "../src/Cursors.ts";
import { type CursorAction, cursorTransition, openCursorDirectory } from "../src/cursor-layout.ts";
import { cursorWriterIsStopped } from "../src/cursor-quiescence.ts";
import { LedgerError } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import { freshLedger } from "./fluree-server.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const upper = { address: "team/A", session: "upper-owner", runtime: "other" } as const;
const lower = { address: "team/a", session: "lower-owner", runtime: "other" } as const;
const sender = { address: "team/sender", session: "sender", runtime: "other" } as const;
const legacyName = "team%2FA.json";
const local = "local-installation";
const remote = "remote-installation";
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const fixture = (dir: string) => {
  const legacy = join(dir, "cursors");
  const exact = `${legacy}.v2`;
  const ledger = layerJsonl(join(dir, "ledger.jsonl")).pipe(Layer.provide(platform));
  const run = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Ledger>,
    io = BunFileSystem.layer
  ) => Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(ledger, io))));
  const open = () => run(openCursorDirectory(legacy, local));
  const transition = (
    action: CursorAction,
    stopped: Effect.Effect<void, LedgerError> = Effect.void,
    io = BunFileSystem.layer
  ) => run(cursorTransition(legacy, local, action, stopped), io);
  const stageLegacy = (name: string, text: string | Uint8Array) => {
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, name), text);
  };
  const oldPosition = () =>
    (JSON.parse(readFileSync(join(legacy, legacyName), "utf8")) as { cursor: number }).cursor;
  const withCursors = <A, E>(
    use: (cursors: Cursors["Service"]) => Effect.Effect<A, E>,
    io = BunFileSystem.layer
  ) =>
    Effect.runPromise(
      Effect.flatMap(Cursors, use).pipe(
        Effect.provide(layerFiles(exact).pipe(Layer.provide(Layer.merge(io, BunPath.layer))))
      )
    );
  const bus = <A, E>(
    cursors: ReturnType<typeof layerFiles> | Layer.Layer<Cursors>,
    use: Effect.Effect<A, E, Bus.Bus | Ledger>,
    installation = local
  ) =>
    Effect.runPromise(
      use.pipe(
        Effect.provide(
          Bus.layer(installation).pipe(
            Layer.provide(cursors),
            Layer.provideMerge(ledger),
            Layer.provide(platform)
          )
        )
      )
    );
  const seedRemote = layerFiles(join(dir, "remote-seed"));
  const joinLocal = (address: string) =>
    bus(
      layerFiles(join(dir, "local-seed")),
      Effect.flatMap(Bus.Bus, (bus) => bus.join({ ...upper, address, cwd: dir }))
    );
  const remoteAlias = () =>
    bus(
      seedRemote,
      Effect.flatMap(Bus.Bus, (bus) => bus.join({ ...lower, cwd: dir })),
      remote
    );
  const publish = (body: string) =>
    bus(
      seedRemote,
      Effect.flatMap(Bus.Bus, (bus) =>
        bus.publish({
          from: sender.address,
          session: sender.session,
          to: [upper.address],
          body,
          pierce: undefined,
        })
      ),
      remote
    ).then(({ message }) => message.id);
  const seed = async (options?: {
    readonly alias?: "left" | "joined";
    readonly remoteUpper?: boolean;
  }) => {
    await bus(
      layerFiles(join(dir, "local-seed")),
      Effect.flatMap(Bus.Bus, (bus) => bus.join({ ...upper, cwd: dir })),
      options?.remoteUpper ? remote : local
    );
    await bus(
      seedRemote,
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        yield* bus.join({ ...sender, cwd: dir });
        if (options?.alias !== undefined) {
          yield* bus.join({ ...lower, cwd: dir });
          if (options.alias === "left") yield* bus.leave(lower.address, lower.session);
        }
      }),
      remote
    );
    const first = await publish("first");
    const position = await run(Effect.flatMap(Ledger, (ledger) => ledger.end));
    const second = await publish("second");
    return { position, first, second };
  };
  // Inspect what the file's value leaves unread, without putting file authority back in Bus.
  const after = (position: number) =>
    run(
      Effect.gen(function* () {
        const store = yield* Ledger;
        const { entries } = yield* store.read(position);
        return entries.flatMap(({ message }) =>
          message.kind === "message" && message.to.includes(upper.address) ? [message] : []
        );
      })
    );
  const inspect = async (cursorDir: string) => {
    if (cursorDir !== exact) throw new Error("Expected the exact cursor directory");
    const position = await withCursors((cursors) => cursors.get(upper.address));
    if (Option.isNone(position)) throw new Error("Expected an exact file position");
    return after(position.value);
  };
  const head = () => run(Effect.flatMap(Ledger, (store) => store.end));
  const advanceExact = async () => {
    const position = await head();
    await withCursors((cursors) => cursors.set(upper.address, position));
  };
  const inspectLegacy = () => after(oldPosition());
  const advanceLegacy = async () =>
    stageLegacy(legacyName, JSON.stringify({ cursor: await head() }));
  return {
    dir,
    legacy,
    exact,
    open,
    transition,
    stageLegacy,
    oldPosition,
    run,
    withCursors,
    joinLocal,
    remoteAlias,
    seed,
    publish,
    inspect,
    inspectLegacy,
    advanceExact,
    advanceLegacy,
  };
};

const temporary = async (use: (f: ReturnType<typeof fixture>) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-cursor-layout-"));
  try {
    await use(fixture(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("migrate preserves the next message, not the latest head; later reads and explicit replay supersede old files", () =>
  temporary(async (f) => {
    const { position, first, second } = await f.seed();
    f.stageLegacy(legacyName, `{"cursor":${position}}`);
    await expect(f.open()).rejects.toThrow("run agent-bus cursors --action migrate");
    expect(await f.transition("check")).toMatchObject({ state: "legacy", count: 1 });
    expect(existsSync(f.exact)).toBe(false);
    const migrated = await f.transition("migrate");
    expect(migrated).toMatchObject({ state: "exact", count: 1 });
    expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([second]);
    await f.advanceExact();
    expect(await f.inspect(await f.open())).toEqual([]);
    expect(f.oldPosition()).toBe(position);
    await f.withCursors((cursors) => cursors.set(upper.address, 0));
    expect(await f.transition("migrate")).toMatchObject({ generation: migrated.generation });
    expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([first, second]);
  }));

test("even a left historical case alias makes one old slot ambiguous; no cursor or presence changes", () =>
  temporary(async (f) => {
    const { position } = await f.seed({ alias: "left" });
    f.stageLegacy(legacyName, JSON.stringify({ cursor: position }));
    const head = await f.run(Effect.flatMap(Ledger, (ledger) => ledger.end));
    await expect(f.transition("migrate")).rejects.toThrow("matches 2 historical addresses");
    expect(existsSync(f.exact)).toBe(false);
    expect(f.oldPosition()).toBe(position);
    expect(await f.run(Effect.flatMap(Ledger, (ledger) => ledger.end))).toBe(head);
  }));

for (const [filename, text, refusal] of [
  ["not-joined.json", '{"cursor":0}', "no exact historical witness"],
  ["team%2fa.json", '{"cursor":0}', "no exact historical witness"],
  [legacyName, '{"cursor":"1"}', "not readable JSON"],
  [legacyName, '{"cursor":9007199254740991}', "ahead of the pinned ledger"],
] as const) {
  test(`migration refuses ${refusal}: ${filename} ${text}`, () =>
    temporary(async (f) => {
      await f.seed();
      f.stageLegacy(filename, text);
      await expect(f.transition("migrate")).rejects.toThrow(refusal);
      expect(existsSync(f.exact)).toBe(false);
      expect(readFileSync(join(f.legacy, filename), "utf8")).toBe(text);
    }));
}

test("a revoked stopped proof and a changed source snapshot both refuse publication", () =>
  temporary(async (f) => {
    await f.seed();
    f.stageLegacy(legacyName, '{"cursor":0}');
    await expect(
      f.transition("migrate", Effect.fail(new LedgerError({ message: "not stopped" })))
    ).rejects.toThrow("not stopped");
    let calls = 0;
    const race = Effect.sync(() => {
      if (++calls === 2) f.stageLegacy(legacyName, '{"cursor":1}');
    });
    await expect(f.transition("migrate", race)).rejects.toThrow("legacy files changed");
    expect(existsSync(f.exact)).toBe(false);
    expect(f.oldPosition()).toBe(1);
  }));

test("a recognized uncommitted write is not migrated as a completed cursor", () =>
  temporary(async (f) => {
    await f.seed({ remoteUpper: true });
    const interrupted = `${legacyName}.${Bun.randomUUIDv7()}.tmp`;
    f.stageLegacy(interrupted, '{"cursor":42}');
    expect(await f.transition("migrate")).toMatchObject({ count: 0 });
    expect(await f.withCursors((cursors) => cursors.get(upper.address))).toEqual(Option.none());
    expect(existsSync(join(f.legacy, interrupted))).toBe(true);
  }));

test("Finder metadata is ignored without hiding a legitimate dot-underscore address", () =>
  temporary(async (f) => {
    await f.seed();
    await f.joinLocal("._real");
    f.stageLegacy(legacyName, '{"cursor":0}');
    f.stageLegacy("._real.json", '{"cursor":1}');
    const sidecar = `._${legacyName}`;
    const metadata = Uint8Array.of(0, 5, 22, 7, 0, 2, 0, 0);
    f.stageLegacy(sidecar, metadata);
    f.stageLegacy(".DS_Store", "non-cursor Finder data");
    expect(await f.transition("migrate")).toMatchObject({ state: "exact", count: 2 });
    expect(await f.withCursors((cursors) => cursors.get("._real"))).toEqual(Option.some(1));
    expect(readFileSync(join(f.legacy, sidecar))).toEqual(Buffer.from(metadata));
    f.stageLegacy(".DS_Store", "updated Finder data");
    expect(await f.open()).toBe(f.exact);
    expect(await f.transition("check")).toMatchObject({ state: "exact", count: 2 });
  }));

test("an explicitly local holding with unread mail cannot be mistaken for a fresh cursor directory", () =>
  temporary(async (f) => {
    const { position, second } = await f.seed();
    const hasUnread = await f.run(Effect.flatMap(Ledger, (ledger) => ledger.read(position)));
    expect(hasUnread.entries.map(({ message }) => message.id)).toEqual([second]);
    await expect(f.open()).rejects.toThrow('first: "team/A"');
    await expect(f.transition("check")).rejects.toThrow("no attributable cursor");
    await expect(f.transition("migrate")).rejects.toThrow("no attributable cursor");
    expect(existsSync(f.exact)).toBe(false);
    f.stageLegacy(legacyName, JSON.stringify({ cursor: position }));
    await f.transition("migrate");
    expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([second]);
  }));

test("export uses current exact state, and a subsequent upgrade/downgrade uses a fresh generation", () =>
  temporary(async (f) => {
    const { first: firstId, second: secondId } = await f.seed();
    f.stageLegacy(legacyName, '{"cursor":0}');
    const first = await f.transition("migrate");
    expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([firstId, secondId]);
    await f.advanceExact();
    const position = await f.run(Effect.flatMap(Ledger, (ledger) => ledger.end));
    const third = await f.publish("third");
    expect(await f.transition("export")).toMatchObject({
      state: "exported",
      generation: first.generation,
    });
    expect(f.oldPosition()).toBe(position);
    expect(existsSync(f.exact)).toBe(false);
    expect(await f.transition("export")).toMatchObject({
      state: "exported",
      generation: first.generation,
    });

    expect((await f.inspectLegacy()).map(({ id }) => id)).toEqual([third]);
    await f.advanceLegacy();
    expect(await f.inspectLegacy()).toEqual([]);
    await expect(f.transition("export")).rejects.toThrow("no completed export");
    const fourth = await f.publish("fourth");
    const second = await f.transition("migrate");
    expect(second.generation).not.toBe(first.generation);
    expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([fourth]);
    await f.advanceExact();
    const fifth = await f.publish("fifth");
    expect(await f.transition("export")).toMatchObject({
      state: "exported",
      generation: second.generation,
    });
    expect((await f.inspectLegacy()).map(({ id }) => id)).toEqual([fifth]);
    await f.advanceLegacy();
    expect(await f.inspectLegacy()).toEqual([]);
  }));

test("two conversions preserve three independent legacy filenames at zero, midrange and head", () =>
  temporary(async (f) => {
    const { position } = await f.seed();
    await f.joinLocal("team/%");
    await f.joinLocal("caf\u00e9");
    const head = await f.run(Effect.flatMap(Ledger, (ledger) => ledger.end));
    const names = [
      [upper.address, legacyName],
      ["team/%", "team%2F%25.json"],
      ["caf\u00e9", "caf%C3%A9.json"],
    ] as const;
    const round = async (positions: readonly [number, number, number]) => {
      const files = [
        [...names[0], positions[0]],
        [...names[1], positions[1]],
        [...names[2], positions[2]],
      ] as const;
      for (const [, filename, cursor] of files) {
        f.stageLegacy(filename, JSON.stringify({ cursor }));
      }
      expect(await f.transition("migrate")).toMatchObject({ state: "exact", count: 3 });
      for (const [address, , cursor] of files) {
        expect(await f.withCursors((cursors) => cursors.get(address))).toEqual(Option.some(cursor));
      }
      expect(await f.transition("export")).toMatchObject({ state: "exported", count: 3 });
      for (const [, filename, cursor] of files) {
        expect(JSON.parse(readFileSync(join(f.legacy, filename), "utf8"))).toEqual({ cursor });
      }
    };
    await round([0, position, head]);
    await round([head, 0, position]);
  }));

test("a read-only eligibility check reflects a new historical alias without assigning its cursor", () =>
  temporary(async (f) => {
    await f.open();
    await f.seed();
    await f.withCursors((cursors) => cursors.set(upper.address, 0));
    const snapshot = () =>
      readdirSync(f.exact)
        .sort()
        .map((name) => [name, readFileSync(join(f.exact, name))]);
    const before = snapshot();
    const neverStop = Effect.die("Check must not invoke the stopped-writer proof.");
    const eligible = await f.transition("check", neverStop);
    expect(eligible).toMatchObject({ state: "exact", legacyExport: { eligible: true } });
    expect(snapshot()).toEqual(before);
    await f.remoteAlias();
    expect(await f.withCursors((cursors) => cursors.get(lower.address))).toEqual(Option.none());
    const blocked = await f.transition("check", neverStop);
    expect(blocked.head).toBeGreaterThan(eligible.head);
    expect(blocked).toMatchObject({
      state: "exact",
      generation: eligible.generation,
      legacyExport: {
        eligible: false,
        reason: expect.stringContaining("alias in the legacy format"),
      },
    });
    await expect(f.transition("export")).rejects.toThrow("alias in the legacy format");
    expect(await f.open()).toBe(f.exact);
    expect(existsSync(f.legacy)).toBe(false);
    expect(snapshot()).toEqual(before);
  }));

test("a mismatched exact address witness refuses read, update, clear and export without using old data", () =>
  temporary(async (f) => {
    await f.seed();
    f.stageLegacy(legacyName, '{"cursor":0}');
    await f.transition("migrate");
    const name = readdirSync(f.exact).find((name) => name.endsWith(".json"));
    if (name === undefined) throw new Error("Missing migrated cursor");
    const file = join(f.exact, name);
    const wrong = JSON.stringify({ address: lower.address, cursor: 9 });
    writeFileSync(file, wrong);
    await expect(f.withCursors((cursors) => cursors.get(upper.address))).rejects.toThrow("cursor");
    await expect(f.withCursors((cursors) => cursors.set(upper.address, 7))).rejects.toThrow(
      "cursor"
    );
    await expect(f.withCursors((cursors) => cursors.clear(upper.address))).rejects.toThrow(
      "cursor"
    );
    await expect(f.transition("check")).rejects.toThrow("mismatched address");
    await expect(f.transition("export")).rejects.toThrow("mismatched address");
    expect(readFileSync(file, "utf8")).toBe(wrong);
    expect(f.oldPosition()).toBe(0);
  }));

test("exact cursor keys support long, canonically equivalent Unicode and malformed UTF-16 strings", () =>
  temporary(async (f) => {
    await f.open();
    const distinct = [
      "team/a",
      "team%2Fa",
      "team/%2fa",
      "\u00e9",
      "e\u0301",
      "\ud83d\ude00",
      "\ud800",
      "\ud801",
      "\ufffd",
      "\u00e9".repeat(1024),
    ];
    for (const [i, address] of distinct.entries()) {
      await f.withCursors((cursors) => cursors.set(address, i));
    }
    for (const [i, address] of distinct.entries()) {
      expect(await f.withCursors((cursors) => cursors.get(address))).toEqual(Option.some(i));
    }
  }));

test("a newly occupied key after the initial read is not overwritten during first write", () =>
  temporary(async (f) => {
    await f.open();
    const file = join(f.exact, cursorFileName(upper.address));
    const occupant = JSON.stringify({ address: lower.address, cursor: 12 });
    const competing = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) =>
        FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (path, text, options) =>
            fs
              .writeFileString(path, text, options)
              .pipe(Effect.andThen(fs.writeFileString(file, occupant, { flag: "wx" }))),
        })
      )
    ).pipe(Layer.provide(BunFileSystem.layer));
    await expect(
      f.withCursors((cursors) => cursors.set(upper.address, 3), competing)
    ).rejects.toThrow("cursor could not be read or written");
    expect(readFileSync(file, "utf8")).toBe(occupant);
  }));

/** Fail the observed rename, either before it lands or as if its success were not returned. */
const renameInterrupted = (
  dir: string,
  matches: (from: string, to: string) => boolean,
  after: boolean
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) =>
      FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) => {
          if (!matches(from, to)) return fs.rename(from, to);
          const failure = fs.rename(join(dir, "no-such-file"), to);
          return after ? fs.rename(from, to).pipe(Effect.andThen(failure)) : failure;
        },
      })
    )
  ).pipe(Layer.provide(BunFileSystem.layer));

for (const after of [false, true]) {
  test(`migration restart after failure ${after ? "after" : "before"} publishing exact state`, () =>
    temporary(async (f) => {
      const { position, second } = await f.seed();
      f.stageLegacy(legacyName, JSON.stringify({ cursor: position }));
      const fs = renameInterrupted(f.dir, (_, to) => to === f.exact, after);
      await expect(f.transition("migrate", Effect.void, fs)).rejects.toThrow("cursor state");
      expect(f.oldPosition()).toBe(position);
      if (after) expect(await f.open()).toBe(f.exact);
      else await expect(f.open()).rejects.toThrow("run agent-bus cursors --action migrate");
      expect(await f.transition("migrate")).toMatchObject({ state: "exact", count: 1 });
      expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([second]);
      await f.advanceExact();
      expect(await f.inspect(await f.open())).toEqual([]);
    }));
}

for (const phase of ["publish legacy", "retire exact"] as const) {
  test(`rollback safely resumes an interruption before it can ${phase}`, () =>
    temporary(async (f) => {
      const { position } = await f.seed();
      f.stageLegacy(legacyName, '{"cursor":0}');
      const migrated = await f.transition("migrate");
      await f.withCursors((cursors) => cursors.set(upper.address, position));
      const fs = renameInterrupted(
        f.dir,
        (from, to) => (phase === "publish legacy" ? to === f.legacy : from === f.exact),
        false
      );
      await expect(f.transition("export", Effect.void, fs)).rejects.toThrow("cursor state");
      expect(existsSync(f.exact)).toBe(true);
      await expect(f.open()).rejects.toThrow("legacy export is unfinished");
      await expect(f.transition("migrate")).rejects.toThrow("legacy export is unfinished");
      expect(await f.transition("export")).toMatchObject({
        state: "exported",
        generation: migrated.generation,
      });
      expect(f.oldPosition()).toBe(position);
      expect(existsSync(f.exact)).toBe(false);
    }));
}

for (const phase of ["move original", "publish legacy", "retire exact"] as const) {
  test(`a remote alias can interrupt export before ${phase} without trapping the exact writer`, () =>
    temporary(async (f) => {
      const { position, second } = await f.seed();
      f.stageLegacy(legacyName, '{"cursor":0}');
      const migrated = await f.transition("migrate");
      await f.withCursors((cursors) => cursors.set(upper.address, position));
      const fs = renameInterrupted(
        f.dir,
        (from, to) =>
          phase === "move original"
            ? from === f.legacy
            : phase === "publish legacy"
              ? to === f.legacy
              : from === f.exact,
        false
      );
      await expect(f.transition("export", Effect.void, fs)).rejects.toThrow("cursor state");
      await f.remoteAlias();
      await expect(f.transition("export")).rejects.toThrow("alias in the legacy format");
      await expect(f.open()).rejects.toThrow("legacy export is unfinished");

      if (phase === "retire exact") {
        // Interrupt the abort as it restores the original, after parking the verified projection.
        const abort = renameInterrupted(f.dir, (_, to) => to === f.legacy, false);
        await expect(f.transition("abort-export", Effect.void, abort)).rejects.toThrow(
          "cursor state"
        );
        await expect(f.transition("export")).rejects.toThrow("resume abort-export");
        await expect(f.open()).rejects.toThrow("legacy export is unfinished");
      }
      const recovered = await f.transition("abort-export");
      expect(recovered).toMatchObject({ state: "exact", generation: migrated.generation });
      if (phase === "retire exact") {
        if (typeof recovered.parked !== "string") throw new Error("Expected a retained projection");
        expect(existsSync(join(f.dir, recovered.parked, legacyName))).toBe(true);
      } else {
        expect(recovered.parked).toBeUndefined();
      }
      expect(f.oldPosition()).toBe(0);
      expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([second]);
      await f.advanceExact();
      expect(await f.inspect(await f.open())).toEqual([]);
    }));
}

for (const changed of ["exact source", "published legacy"] as const) {
  test(`abort refuses a diverged ${changed} and keeps the installation held`, () =>
    temporary(async (f) => {
      const { position } = await f.seed();
      f.stageLegacy(legacyName, '{"cursor":0}');
      await f.transition("migrate");
      await f.withCursors((cursors) => cursors.set(upper.address, position));
      const fs = renameInterrupted(f.dir, (from) => from === f.exact, false);
      await expect(f.transition("export", Effect.void, fs)).rejects.toThrow("cursor state");
      if (changed === "exact source") {
        await f.withCursors((cursors) => cursors.set(upper.address, 0));
        await expect(f.transition("abort-export")).rejects.toThrow("exact files changed");
      } else {
        f.stageLegacy(legacyName, '{"cursor":0}');
        await expect(f.transition("abort-export")).rejects.toThrow("legacy files diverged");
      }
      expect(existsSync(f.exact)).toBe(true);
      await expect(f.open()).rejects.toThrow("legacy export is unfinished");
    }));
}

test("completed export can recover forward from its verified latest positions, not the retired generation", () =>
  temporary(async (f) => {
    const { first, second } = await f.seed();
    f.stageLegacy(legacyName, '{"cursor":0}');
    const migrated = await f.transition("migrate");
    expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([first, second]);
    await f.advanceExact();
    const position = await f.run(Effect.flatMap(Ledger, (ledger) => ledger.end));
    const unread = await f.publish("after the exact writer advanced");
    const exported = await f.transition("export");
    expect(exported).toMatchObject({ state: "exported", generation: migrated.generation });
    const archived = `${f.exact}.saved-${migrated.generation}`;
    const retiredCursor = join(archived, cursorFileName(upper.address));
    const retired = readFileSync(retiredCursor);
    await expect(f.open()).rejects.toThrow("a legacy export receipt is present");
    await expect(f.transition("abort-export")).rejects.toThrow("no active exact generation");
    expect(f.oldPosition()).toBe(position);
    expect(existsSync(f.exact)).toBe(false);
    expect(await f.transition("export")).toEqual(exported);
    const resumed = await f.transition("migrate");
    expect(resumed).toMatchObject({ state: "exact", incarnation: migrated.incarnation });
    expect(resumed.generation).not.toBe(migrated.generation);
    expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([unread]);
    await f.advanceExact();
    expect(await f.inspect(await f.open())).toEqual([]);
    expect(readFileSync(retiredCursor)).toEqual(retired);
  }));

test("an exact source change after parking legacy aborts export before publishing the projection", () =>
  temporary(async (f) => {
    const { position } = await f.seed();
    f.stageLegacy(legacyName, '{"cursor":0}');
    await f.transition("migrate");
    await f.withCursors((cursors) => cursors.set(upper.address, position));
    const changedAfterMove = Effect.sync(() => {
      if (!existsSync(f.legacy)) {
        const target = join(f.exact, cursorFileName(upper.address));
        writeFileSync(target, JSON.stringify({ address: upper.address, cursor: 0 }));
      }
    });
    await expect(f.transition("export", changedAfterMove)).rejects.toThrow(
      "exact files or pending export changed"
    );
    expect(existsSync(f.legacy)).toBe(false);
    await expect(f.open()).rejects.toThrow("legacy export is unfinished");
  }));

test("an exact cursor requiring a legacy temporary filename beyond the component limit cannot export", () =>
  temporary(async (f) => {
    await f.open();
    // The final old filename fits in 255 bytes; its 41-byte temporary suffix would not.
    const address = "a".repeat(210);
    await f.joinLocal(address);
    await f.withCursors((cursors) => cursors.set(address, 0));
    expect(await f.transition("check")).toMatchObject({
      state: "exact",
      legacyExport: {
        eligible: false,
        reason: expect.stringContaining("cannot be written by the legacy format"),
      },
    });
    await expect(f.transition("export")).rejects.toThrow("cannot be written by the legacy format");
    expect(await f.open()).toBe(f.exact);
    expect(existsSync(f.legacy)).toBe(false);
  }));

test("a witnessless exact position is preserved while export is refused", () =>
  temporary(async (f) => {
    await f.open();
    const address = "uncertain/first-join";
    const witness = join(f.exact, cursorFileName(address));
    await f.withCursors((cursors) => cursors.set(address, 0));
    const before = readFileSync(witness);
    expect(await f.transition("check")).toMatchObject({
      state: "exact",
      legacyExport: { eligible: false, reason: expect.stringContaining("no historical witness") },
    });
    await expect(f.transition("export")).rejects.toThrow("no historical witness");
    expect(readFileSync(witness)).toEqual(before);
    expect(existsSync(f.legacy)).toBe(false);
    // Presence may settle after the cursor was staged; do not round-trip through legacy first.
    await f.joinLocal(address);
    expect(await f.transition("check")).toMatchObject({
      state: "exact",
      legacyExport: { eligible: true },
    });
    expect(readFileSync(witness)).toEqual(before);
  }));

test("changed retained legacy bytes refuse exact startup and check until the original is restored", () =>
  temporary(async (f) => {
    const { position, second } = await f.seed();
    const original = JSON.stringify({ cursor: position });
    f.stageLegacy(legacyName, original);
    const migrated = await f.transition("migrate");
    const cursor = join(f.exact, cursorFileName(upper.address));
    const exact = readFileSync(cursor);
    f.stageLegacy(legacyName, '{"cursor":0}');
    await expect(f.open()).rejects.toThrow("retained legacy files changed since migration");
    await expect(f.transition("check")).rejects.toThrow(
      "retained legacy files changed since migration"
    );
    expect(readFileSync(cursor)).toEqual(exact);
    expect(f.oldPosition()).toBe(0);
    f.stageLegacy(legacyName, original);
    expect(await f.transition("check")).toMatchObject({
      state: "exact",
      generation: migrated.generation,
      legacyExport: { eligible: true },
    });
    expect((await f.inspect(await f.open())).map(({ id }) => id)).toEqual([second]);
  }));

test("an existing-only Fluree cursor preflight neither provisions a missing ledger nor configures an empty one", async () => {
  const config = await freshLedger("cursor-existing-only");
  const request = (path: string, body?: unknown) =>
    fetch(`${config.url}/v1/fluree/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ledger = encodeURIComponent(config.ledger);
  const existingOnly = () =>
    Effect.runPromise(
      Ledger.pipe(
        Effect.provide(
          layerFluree(config, { existingOnly: true }).pipe(Layer.provide(FetchHttpClient.layer))
        )
      )
    );
  expect(await (await request(`exists/${ledger}`)).json()).toMatchObject({ exists: false });
  await expect(existingOnly()).rejects.toThrow();
  expect(await (await request(`exists/${ledger}`)).json()).toMatchObject({ exists: false });
  expect((await request("create", { ledger: config.ledger })).ok).toBe(true);
  await expect(existingOnly()).rejects.toThrow();
  expect(await (await request(`info/${ledger}`)).json()).toMatchObject({ ledger: { t: 0 } });
});

test("the stopped-writer proof requires the exact disabled, unloaded job and a clear explicit port", () => {
  const label = "test.bus";
  const uid = 501;
  const prove = (
    selected: string | undefined,
    disabled: string,
    status: number,
    reply: string,
    port: string | undefined = "49752",
    listeners = { status: 1, text: "" }
  ) => {
    const seen: Array<ReadonlyArray<string>> = [];
    const stopped = cursorWriterIsStopped(selected, uid, port, (command, args, capture) => {
      seen.push([command, ...args, capture]);
      if (command === "/usr/sbin/lsof") return listeners;
      return capture === "stdout" ? { status: 0, text: disabled } : { status, text: reply };
    });
    return { stopped, seen };
  };
  const disabled = '\n\t"test.bus" => disabled\n';
  const absent = 'Bad request.\nCould not find service "test.bus" in domain for user gui: 501\n';
  expect(prove(undefined, disabled, 113, absent)).toEqual({ stopped: false, seen: [] });
  expect(prove("../test.bus", disabled, 113, absent)).toEqual({ stopped: false, seen: [] });
  expect(
    cursorWriterIsStopped(label, uid, undefined, () => {
      throw new Error("Missing port must refuse before probing.");
    })
  ).toBe(false);
  expect(
    prove(label, '"test.bus.private" => disabled\n"test.bus" => enabled', 113, absent).stopped
  ).toBe(false);
  expect(prove(label, disabled, 0, absent).stopped).toBe(false);
  expect(prove(label, disabled, 113, absent.replace("501", "502")).stopped).toBe(false);
  expect(prove(label, disabled, 113, absent.replace("test.bus", "other.bus")).stopped).toBe(false);
  for (const port of ["", "0", "049752", "65536", "8096 "])
    expect(prove(label, disabled, 113, absent, port)).toEqual({ stopped: false, seen: [] });
  for (const listeners of [
    { status: 0, text: "owned-test-listener" },
    { status: 1, text: "cannot inspect socket table" },
    { status: 2, text: "" },
  ])
    expect(prove(label, disabled, 113, absent, "49752", listeners).stopped).toBe(false);
  expect(prove(label, disabled, 113, absent)).toEqual({
    stopped: true,
    seen: [
      ["/bin/launchctl", "print-disabled", "gui/501", "stdout"],
      ["/bin/launchctl", "print", "gui/501/test.bus", "stderr"],
      ["/usr/sbin/lsof", "-nP", "-iTCP:49752", "-sTCP:LISTEN", "both"],
    ],
  });
});
