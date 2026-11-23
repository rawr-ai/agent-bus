import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { cursorFileName } from "../src/Cursors.ts";
import { cursorImportSnapshot, verifyMailboxTransitionSentinelText } from "../src/cursor-layout.ts";
import { LedgerError } from "../src/domain.ts";
import { initializeInstallation, loadInstallation } from "../src/installation.ts";
import type { MailboxSource } from "../src/mailbox-import.ts";
import {
  buildMailboxTransitionSentinel,
  installMailboxTransitionGuard,
  preflightMailboxTransitionGuard,
  verifyMailboxTransitionGuard,
} from "../src/mailbox-transition-guard.ts";

const ledger = "test/ledger";
const cut = { incarnation: "instance+with=@percent%", head: 12 };
const emptyLegacy = Bun.CryptoHasher.hash("sha256", "[]", "hex");
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>, fs = BunFileSystem.layer) =>
  Effect.runPromise(effect.pipe(Effect.provide(fs)));

const fixture = async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-guard-"));
  const roots = [join(dir, "one"), join(dir, "two")] as const;
  const legacy = (root: string) =>
    join(root, "fluree-cursors", encodeURIComponent(ledger), cut.incarnation);
  try {
    for (const [index, root] of roots.entries()) {
      await run(initializeInstallation(root));
      const exact = `${legacy(root)}.v2`;
      mkdirSync(exact, { recursive: true });
      writeFileSync(
        join(exact, "layout"),
        JSON.stringify({ generation: Bun.randomUUIDv7(), legacy: emptyLegacy })
      );
      const address = `address-${index}`;
      writeFileSync(
        join(exact, cursorFileName(address)),
        JSON.stringify({ address, cursor: index + 1 })
      );
    }
    const one = await run(loadInstallation(roots[0]));
    const two = await run(loadInstallation(roots[1]));
    const first = await run(cursorImportSnapshot(legacy(roots[0])));
    const second = await run(cursorImportSnapshot(legacy(roots[1])));
    const sources: readonly [MailboxSource, MailboxSource] = [
      { version: 1, ledger, installation: one, cut, capturedAt: 1234, digest: first.digest },
      { version: 1, ledger, installation: two, cut, capturedAt: 1235, digest: second.digest },
    ];
    const operation = Bun.randomUUIDv7();
    const exact = `${legacy(roots[0])}.v2`;
    const marker = join(exact, ".export-pending");
    const cursor = join(exact, cursorFileName("address-0"));
    const build = (pair: readonly [MailboxSource, MailboxSource] = sources, op = operation) =>
      run(buildMailboxTransitionSentinel(ledger, pair, one, op));
    const install = (
      held: Effect.Effect<void, LedgerError> = Effect.void,
      pair: readonly [MailboxSource, MailboxSource] = sources,
      op = operation,
      fs = BunFileSystem.layer
    ) => run(installMailboxTransitionGuard(roots[0], ledger, pair, one, op, held), fs);
    const preflight = (
      held: Effect.Effect<void, LedgerError> = Effect.void,
      pair: readonly [MailboxSource, MailboxSource] = sources,
      op = operation,
      fs = BunFileSystem.layer
    ) => run(preflightMailboxTransitionGuard(roots[0], ledger, pair, one, op, held), fs);
    const verify = (pair: readonly [MailboxSource, MailboxSource] = sources, op = operation) =>
      run(verifyMailboxTransitionGuard(roots[0], ledger, pair, one, op));
    return {
      dir,
      roots,
      one,
      two,
      legacy,
      exact,
      marker,
      cursor,
      sources,
      operation,
      build,
      install,
      preflight,
      verify,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
};

const temporary = async (use: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) => {
  const f = await fixture();
  try {
    await use(f);
  } finally {
    f.cleanup();
  }
};

test("both unmarked sources pass a read-only preflight before either is fenced", () =>
  temporary(async (f) => {
    const readOnly = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => {
        const unexpectedWrite = () => {
          throw new Error("preflight attempted a filesystem write");
        };
        return FileSystem.FileSystem.of({
          ...fs,
          open: (path, options) =>
            options?.flag !== undefined && options.flag !== "r"
              ? unexpectedWrite()
              : fs.open(path, options),
          link: unexpectedWrite,
          makeDirectory: unexpectedWrite,
          remove: unexpectedWrite,
          rename: unexpectedWrite,
          writeFile: unexpectedWrite,
          writeFileString: unexpectedWrite,
        });
      })
    ).pipe(Layer.provide(BunFileSystem.layer));
    const files = f.roots.map((root) => {
      const exact = `${f.legacy(root)}.v2`;
      return readdirSync(exact)
        .sort()
        .map((name) => [name, readFileSync(join(exact, name)).toString("hex")] as const);
    });
    let holds = 0;
    const held = Effect.sync(() => {
      holds++;
    });
    const first = await f.preflight(held, f.sources, f.operation, readOnly);
    const second = await run(
      preflightMailboxTransitionGuard(f.roots[1], ledger, f.sources, f.two, f.operation, held),
      readOnly
    );
    expect(holds).toBe(4);
    expect(first).toEqual(await f.build());
    expect(second.installation).toBe(f.two);
    for (const [index, root] of f.roots.entries()) {
      const exact = `${f.legacy(root)}.v2`;
      const expected = files[index];
      if (expected === undefined) throw new Error("Missing disposable source snapshot.");
      expect(existsSync(join(exact, ".export-pending"))).toBe(false);
      expect(
        readdirSync(exact)
          .sort()
          .map((name) => [name, readFileSync(join(exact, name)).toString("hex")] as const)
      ).toEqual(expected);
    }
    expect(await f.install()).toEqual(first);
    const inode = lstatSync(f.marker).ino;
    const bytes = readFileSync(f.marker);
    await expect(f.preflight()).rejects.toThrow("already occupied");
    expect(lstatSync(f.marker).ino).toBe(inode);
    expect(readFileSync(f.marker)).toEqual(bytes);
    expect(await f.install()).toEqual(first);
    expect(lstatSync(f.marker).ino).toBe(inode);
  }));

test("preflight refuses a missing exact generation, missing manifest, or changed inventory", () =>
  temporary(async (f) => {
    const layout = join(f.exact, "layout");
    const original = readFileSync(layout);
    rmSync(layout);
    await expect(f.preflight()).rejects.toThrow();
    expect(existsSync(f.marker)).toBe(false);
    writeFileSync(layout, original);
    writeFileSync(f.cursor, JSON.stringify({ address: "address-0", cursor: 9 }));
    await expect(f.preflight()).rejects.toThrow("inventory");
    expect(existsSync(f.marker)).toBe(false);
    rmSync(f.exact, { recursive: true });
    await expect(f.preflight()).rejects.toThrow();
    expect(existsSync(f.marker)).toBe(false);
  }));

for (const kind of ["foreign", "truncated", "directory", "dangling symlink"] as const) {
  test(`preflight refuses an occupied ${kind} marker without modifying it`, () =>
    temporary(async (f) => {
      if (kind === "directory") mkdirSync(f.marker);
      else if (kind === "dangling symlink") symlinkSync(join(f.dir, "missing"), f.marker);
      else writeFileSync(f.marker, kind === "foreign" ? "foreign" : "{");
      const before = lstatSync(f.marker);
      await expect(f.preflight()).rejects.toThrow("already occupied");
      const after = lstatSync(f.marker);
      expect(after.ino).toBe(before.ino);
      expect(after.mode).toBe(before.mode);
      if (kind === "foreign" || kind === "truncated")
        expect(readFileSync(f.marker, "utf8")).toBe(kind === "foreign" ? "foreign" : "{");
      if (kind === "dangling symlink") expect(readlinkSync(f.marker)).toBe(join(f.dir, "missing"));
      expect(readdirSync(f.exact).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }));
}

test("preflight rechecks the hold and source without publishing when either changes", () =>
  temporary(async (f) => {
    let calls = 0;
    const lost = Effect.suspend(() =>
      ++calls === 1 ? Effect.void : Effect.fail(new LedgerError({ message: "hold lost" }))
    );
    await expect(f.preflight(lost)).rejects.toThrow("hold lost");
    expect(calls).toBe(2);
    expect(existsSync(f.marker)).toBe(false);
    calls = 0;
    const changed = Effect.sync(() => {
      if (++calls === 2)
        writeFileSync(f.cursor, JSON.stringify({ address: "address-0", cursor: 9 }));
    });
    await expect(f.preflight(changed)).rejects.toThrow("inventory");
    expect(calls).toBe(2);
    expect(existsSync(f.marker)).toBe(false);
  }));

test("preflight never replaces a marker appearing during the final hold check", () =>
  temporary(async (f) => {
    let calls = 0;
    const occupied = Effect.sync(() => {
      if (++calls === 2) writeFileSync(f.marker, "other writer");
    });
    await expect(f.preflight(occupied)).rejects.toThrow("already occupied");
    expect(calls).toBe(2);
    expect(readFileSync(f.marker, "utf8")).toBe("other writer");
    expect(readdirSync(f.exact).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }));

test("the canonical strict marker preserves the digest and is not an old export plan", () =>
  temporary(async (f) => {
    const before = await run(cursorImportSnapshot(f.legacy(f.roots[0])));
    const layoutBytes = readFileSync(join(f.exact, "layout"));
    const cursorBytes = readFileSync(f.cursor);
    const expected = await f.build();
    expect(await f.build([f.sources[1], f.sources[0]])).toEqual(expected);
    expect(expected.sources.map(({ installation }) => installation)).toEqual([f.one, f.two].sort());
    expect(await f.install()).toEqual(expected);
    const text = readFileSync(f.marker, "utf8");
    expect(text).toBe(JSON.stringify(expected));
    expect(readFileSync(join(f.exact, "layout"))).toEqual(layoutBytes);
    expect(readFileSync(f.cursor)).toEqual(cursorBytes);
    expect(await f.verify()).toEqual(expected);
    expect(
      (await run(cursorImportSnapshot(f.legacy(f.roots[0]), { expectedSentinel: expected }))).digest
    ).toBe(before.digest);
    await expect(run(cursorImportSnapshot(f.legacy(f.roots[0])))).rejects.toThrow();
    const oldPlan = Schema.fromJsonString(
      Schema.Struct({
        generation: Schema.String,
        operation: Schema.String,
        exact: Schema.String,
        original: Schema.String,
        exported: Schema.String,
      })
    );
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(oldPlan)(text))).rejects.toThrow();
    expect(await Effect.runPromise(verifyMailboxTransitionSentinelText(text, expected))).toEqual(
      expected
    );
    const inode = lstatSync(f.marker).ino;
    expect(await f.install()).toEqual(expected);
    expect(lstatSync(f.marker).ino).toBe(inode);
    expect(readFileSync(f.marker, "utf8")).toBe(text);
    expect(readdirSync(f.exact).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }));

test("expected and transferred markers require exact strict receipt-bound content", () =>
  temporary(async (f) => {
    const expected = await f.install();
    const text = readFileSync(f.marker, "utf8");
    const peer = await run(buildMailboxTransitionSentinel(ledger, f.sources, f.two, f.operation));
    const changed = await f.build(f.sources, Bun.randomUUIDv7());
    await expect(
      run(cursorImportSnapshot(f.legacy(f.roots[0]), { expectedSentinel: changed }))
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(verifyMailboxTransitionSentinelText(text, peer))
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        verifyMailboxTransitionSentinelText(`${text.slice(0, -1)},"extra":1}`, expected)
      )
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(verifyMailboxTransitionSentinelText(text.slice(0, -1), expected))
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(verifyMailboxTransitionSentinelText(` ${text}`, expected))
    ).rejects.toThrow();
    const excessive = { ...expected, generation: Bun.randomUUIDv7() };
    await expect(
      run(cursorImportSnapshot(f.legacy(f.roots[0]), { expectedSentinel: excessive }))
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(verifyMailboxTransitionSentinelText(text, excessive))
    ).rejects.toThrow();
    const remoteChanged: readonly [MailboxSource, MailboxSource] = [
      f.sources[0],
      { ...f.sources[1], capturedAt: f.sources[1].capturedAt + 1 },
    ];
    await expect(f.verify(remoteChanged)).rejects.toThrow();
    expect(readFileSync(f.marker, "utf8")).toBe(text);
  }));

test("a guarded snapshot rechecks its marker after reading the cursor files", () =>
  temporary(async (f) => {
    const expected = await f.install();
    let opens = 0;
    const changed = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) =>
        FileSystem.FileSystem.of({
          ...fs,
          open: (path, options) =>
            path === f.marker && ++opens === 2
              ? fs.writeFileString(path, "foreign").pipe(Effect.andThen(fs.open(path, options)))
              : fs.open(path, options),
        })
      )
    ).pipe(Layer.provide(BunFileSystem.layer));
    await expect(
      run(cursorImportSnapshot(f.legacy(f.roots[0]), { expectedSentinel: expected }), changed)
    ).rejects.toThrow();
    expect(opens).toBe(2);
    expect(readFileSync(f.marker, "utf8")).toBe("foreign");
  }));

for (const kind of ["truncated", "foreign", "old export", "symlink"] as const) {
  test(`an occupied ${kind} marker is never replaced`, () =>
    temporary(async (f) => {
      const expected = await f.build();
      const foreign = await f.build(f.sources, Bun.randomUUIDv7());
      const oldExport = JSON.stringify({
        generation: Bun.randomUUIDv7(),
        operation: Bun.randomUUIDv7(),
        exact: "a".repeat(64),
        original: "b".repeat(64),
        exported: "c".repeat(64),
      });
      const content =
        kind === "truncated"
          ? JSON.stringify(expected).slice(0, -1)
          : kind === "foreign"
            ? JSON.stringify(foreign)
            : oldExport;
      const target = join(f.dir, "marker-target");
      if (kind === "symlink") {
        writeFileSync(target, JSON.stringify(expected));
        symlinkSync(target, f.marker);
      } else {
        writeFileSync(f.marker, content);
      }
      const inode = lstatSync(f.marker).ino;
      await expect(f.install()).rejects.toThrow();
      await expect(f.verify()).rejects.toThrow();
      await expect(
        run(cursorImportSnapshot(f.legacy(f.roots[0]), { expectedSentinel: expected }))
      ).rejects.toThrow();
      await expect(run(cursorImportSnapshot(f.legacy(f.roots[0])))).rejects.toThrow();
      expect(lstatSync(f.marker).ino).toBe(inode);
      if (kind === "symlink") {
        expect(readlinkSync(f.marker)).toBe(target);
        expect(readFileSync(target, "utf8")).toBe(JSON.stringify(expected));
      } else {
        expect(readFileSync(f.marker, "utf8")).toBe(content);
      }
      expect(readdirSync(f.exact).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }));
}

test("missing marker and missing exact generation cannot satisfy guarded snapshots", () =>
  temporary(async (f) => {
    const expected = await f.build();
    await expect(f.verify()).rejects.toThrow();
    await expect(
      run(cursorImportSnapshot(f.legacy(f.roots[0]), { expectedSentinel: expected }))
    ).rejects.toThrow();
    rmSync(f.exact, { recursive: true });
    await expect(f.install()).rejects.toThrow();
    await expect(
      run(cursorImportSnapshot(f.legacy(f.roots[0]), { expectedSentinel: expected }))
    ).rejects.toThrow();
    expect(existsSync(f.marker)).toBe(false);
  }));

test("mismatched sources, cut, identity, operation, and inventory refuse before publication", () =>
  temporary(async (f) => {
    const first = f.sources[0];
    const second = f.sources[1];
    const badPairs: ReadonlyArray<readonly [MailboxSource, MailboxSource]> = [
      [first, { ...second, ledger: "different" }],
      [first, { ...second, cut: { ...cut, head: cut.head + 1 } }],
      [first, { ...second, cut: { ...cut, incarnation: "different" } }],
      [first, { ...second, installation: first.installation }],
      [{ ...first, digest: "a".repeat(64) }, second],
    ];
    for (const pair of badPairs) {
      await expect(f.preflight(Effect.void, pair)).rejects.toThrow();
      await expect(f.install(Effect.void, pair)).rejects.toThrow();
    }
    await expect(f.preflight(Effect.void, f.sources, "not-a-uuid-v7")).rejects.toThrow();
    await expect(f.install(Effect.void, f.sources, "not-a-uuid-v7")).rejects.toThrow();
    await expect(
      run(
        preflightMailboxTransitionGuard(
          f.roots[0],
          ledger,
          f.sources,
          f.two,
          f.operation,
          Effect.void
        )
      )
    ).rejects.toThrow();
    await expect(
      run(
        installMailboxTransitionGuard(
          f.roots[0],
          ledger,
          f.sources,
          f.two,
          f.operation,
          Effect.void
        )
      )
    ).rejects.toThrow();
    const unsafe: readonly [MailboxSource, MailboxSource] = [
      { ...first, cut: { ...cut, incarnation: "../outside" } },
      { ...second, cut: { ...cut, incarnation: "../outside" } },
    ];
    await expect(f.preflight(Effect.void, unsafe)).rejects.toThrow();
    await expect(f.install(Effect.void, unsafe)).rejects.toThrow();
    expect(existsSync(f.marker)).toBe(false);
  }));

test("a revoked hold or changed source after publication leaves the sentinel in place", () =>
  temporary(async (f) => {
    await expect(f.install(Effect.fail(new LedgerError({ message: "not held" })))).rejects.toThrow(
      "not held"
    );
    expect(existsSync(f.marker)).toBe(false);
    let calls = 0;
    const held = Effect.suspend(() =>
      ++calls === 1 ? Effect.void : Effect.fail(new LedgerError({ message: "hold lost" }))
    );
    await expect(f.install(held)).rejects.toThrow("hold lost");
    expect(calls).toBe(2);
    const text = readFileSync(f.marker, "utf8");
    expect(await f.verify()).toEqual(await f.build());
    writeFileSync(f.cursor, JSON.stringify({ address: "address-0", cursor: 9 }));
    await expect(f.verify()).rejects.toThrow();
    expect(readFileSync(f.marker, "utf8")).toBe(text);
  }));

for (const change of ["cursor", "installation", "marker"] as const) {
  test(`a ${change} changed during the final hold check fails closed`, () =>
    temporary(async (f) => {
      let calls = 0;
      const held = Effect.sync(() => {
        if (++calls !== 2) return;
        if (change === "cursor") {
          writeFileSync(f.cursor, JSON.stringify({ address: "address-0", cursor: 9 }));
        } else if (change === "installation") {
          writeFileSync(join(f.roots[0], "installation-id"), `${f.two}\n`);
        } else {
          writeFileSync(f.marker, "foreign");
        }
      });
      await expect(f.install(held)).rejects.toThrow();
      expect(calls).toBe(2);
      expect(existsSync(f.marker)).toBe(true);
      if (change === "marker") expect(readFileSync(f.marker, "utf8")).toBe("foreign");
      else expect(readFileSync(f.marker, "utf8")).toBe(JSON.stringify(await f.build()));
    }));
}

test("a failed publication reply does not remove a sentinel that was linked", () =>
  temporary(async (f) => {
    const interrupted = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) =>
        FileSystem.FileSystem.of({
          ...fs,
          link: (from, to) =>
            to === f.marker
              ? fs.link(from, to).pipe(Effect.andThen(fs.link(join(f.dir, "missing"), to)))
              : fs.link(from, to),
        })
      )
    ).pipe(Layer.provide(BunFileSystem.layer));
    await expect(f.install(Effect.void, f.sources, f.operation, interrupted)).rejects.toThrow();
    const text = readFileSync(f.marker, "utf8");
    expect(text).toBe(JSON.stringify(await f.build()));
    expect(await f.install()).toEqual(await f.build());
    expect(readFileSync(f.marker, "utf8")).toBe(text);
    expect(readdirSync(f.exact).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }));

test("a race to occupy the marker loses without replacing or deleting the other file", () =>
  temporary(async (f) => {
    const occupant = "foreign marker";
    const competing = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) =>
        FileSystem.FileSystem.of({
          ...fs,
          link: (from, to) =>
            to === f.marker
              ? fs
                  .writeFileString(to, occupant, { flag: "wx" })
                  .pipe(Effect.andThen(fs.link(from, to)))
              : fs.link(from, to),
        })
      )
    ).pipe(Layer.provide(BunFileSystem.layer));
    await expect(f.install(Effect.void, f.sources, f.operation, competing)).rejects.toThrow();
    expect(readFileSync(f.marker, "utf8")).toBe(occupant);
    expect(readdirSync(f.exact).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }));

test("symlinked cursor ancestors are refused without publishing outside the installation", () =>
  temporary(async (f) => {
    const cursors = join(f.roots[0], "fluree-cursors");
    const ledgerDir = join(cursors, encodeURIComponent(ledger));
    const outside = join(f.dir, "outside-ledger");
    const original = readFileSync(join(f.exact, "layout"));
    const outsideExact = join(outside, `${cut.incarnation}.v2`);
    mkdirSync(outsideExact, { recursive: true });
    writeFileSync(join(outsideExact, "layout"), original);
    rmSync(ledgerDir, { recursive: true });
    symlinkSync(outside, ledgerDir);
    await expect(f.preflight()).rejects.toThrow();
    await expect(f.install()).rejects.toThrow();
    expect(existsSync(join(outsideExact, ".export-pending"))).toBe(false);
    expect(readFileSync(join(outsideExact, "layout"))).toEqual(original);
  }));

for (const component of ["cursor parent", "exact generation"] as const) {
  test(`a symlinked ${component} is refused without publishing through it`, () =>
    temporary(async (f) => {
      const path = component === "cursor parent" ? join(f.roots[0], "fluree-cursors") : f.exact;
      const moved = join(f.dir, "moved-cursors");
      renameSync(path, moved);
      symlinkSync(moved, path);
      await expect(f.preflight()).rejects.toThrow();
      await expect(f.install()).rejects.toThrow();
      const movedExact =
        component === "cursor parent"
          ? join(moved, encodeURIComponent(ledger), `${cut.incarnation}.v2`)
          : moved;
      expect(existsSync(join(movedExact, ".export-pending"))).toBe(false);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    }));
}
