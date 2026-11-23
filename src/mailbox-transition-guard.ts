import { join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import {
  cursorImportSnapshot,
  type MailboxTransitionSentinel,
  validateMailboxTransitionSentinel,
  verifyMailboxTransitionSentinelFile,
} from "./cursor-layout.ts";
import { LedgerError } from "./domain.ts";
import { loadInstallation } from "./installation.ts";
import { type MailboxSource, MailboxSourceJson } from "./mailbox-import.ts";

const refused = (message: string) => new LedgerError({ message: `Mailbox transition: ${message}` });
const fileError = () => refused("could not inspect or publish the local restart sentinel.");

const decodeSource = (source: MailboxSource) =>
  Schema.decodeUnknownEffect(Schema.toType(MailboxSourceJson), { onExcessProperty: "error" })(
    source
  ).pipe(Effect.mapError(() => refused("invalid captured source receipt.")));

/** Construct identical evidence for either receipt order, without asserting that a peer is held. */
export const buildMailboxTransitionSentinel = (
  ledger: string,
  sources: readonly [MailboxSource, MailboxSource],
  installation: string,
  operation: string
) =>
  Effect.gen(function* () {
    const [a, b] = yield* Effect.all([decodeSource(sources[0]), decodeSource(sources[1])]);
    if (
      a.installation === b.installation ||
      a.ledger !== ledger ||
      b.ledger !== ledger ||
      a.cut.incarnation !== b.cut.incarnation ||
      a.cut.head !== b.cut.head ||
      (installation !== a.installation && installation !== b.installation)
    ) {
      return yield* refused("two distinct sources at the same configured ledger cut are required.");
    }
    const [one, two] = a.installation < b.installation ? [a, b] : [b, a];
    return yield* validateMailboxTransitionSentinel({
      version: 1,
      kind: "mailbox-transition-guard",
      operation,
      ledger,
      cut: one.cut,
      sources: [
        { installation: one.installation, digest: one.digest, capturedAt: one.capturedAt },
        { installation: two.installation, digest: two.digest, capturedAt: two.capturedAt },
      ],
      installation,
    });
  });

const infoAt = (fs: FileSystem.FileSystem, path: string) =>
  fs
    .lstat(path)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(fileError())
      )
    );

const localPath = (root: string, sentinel: MailboxTransitionSentinel) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const encoded = yield* Effect.try({
      try: () => encodeURIComponent(sentinel.ledger),
      catch: fileError,
    });
    if (encoded === "." || encoded === "..") return yield* fileError();
    const cursors = join(root, "fluree-cursors");
    const ledger = join(cursors, encoded);
    // The existing cursor store uses the raw incarnation, not an encoded component.
    const legacy = join(ledger, sentinel.cut.incarnation);
    for (const dir of [root, cursors, ledger, `${legacy}.v2`]) {
      if ((yield* infoAt(fs, dir))?.type !== "Directory") {
        return yield* refused("the local cursor path is missing or is not a real directory.");
      }
    }
    return legacy;
  });

const confirmInstallation = (root: string, installation: string) =>
  Effect.gen(function* () {
    const actual = yield* loadInstallation(root).pipe(Effect.mapError(fileError));
    if (actual !== installation) {
      return yield* refused("the local installation does not match the captured receipt.");
    }
  });

const confirmInventory = (legacy: string, sentinel: MailboxTransitionSentinel, guarded: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if ((yield* infoAt(fs, `${legacy}.v2`))?.type !== "Directory") {
      return yield* refused("the captured exact cursor generation is missing.");
    }
    const snapshot = yield* cursorImportSnapshot(
      legacy,
      guarded ? { expectedSentinel: sentinel } : undefined
    );
    const local =
      sentinel.sources[0].installation === sentinel.installation
        ? sentinel.sources[0]
        : sentinel.sources[1];
    if (snapshot.digest !== local.digest) {
      return yield* refused("the local cursor inventory does not match its captured receipt.");
    }
  });

const inspectLocalSource = (
  root: string,
  sentinel: MailboxTransitionSentinel,
  allowOccupied: boolean
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const legacy = yield* localPath(root, sentinel);
    const marker = join(`${legacy}.v2`, ".export-pending");
    yield* confirmInstallation(root, sentinel.installation);
    const occupied = (yield* infoAt(fs, marker)) !== undefined;
    if (occupied && !allowOccupied) {
      return yield* refused("the local restart sentinel is already occupied.");
    }
    yield* confirmInventory(legacy, sentinel, occupied);
    yield* confirmInstallation(root, sentinel.installation);
    yield* localPath(root, sentinel);
    if (!allowOccupied && (yield* infoAt(fs, marker)) !== undefined) {
      return yield* refused("the local restart sentinel is already occupied.");
    }
    return { legacy, occupied };
  });

const verifyMarker = (root: string, sentinel: MailboxTransitionSentinel) =>
  Effect.gen(function* () {
    const legacy = yield* localPath(root, sentinel);
    yield* verifyMailboxTransitionSentinelFile(legacy, sentinel);
  });

const verify = (root: string, sentinel: MailboxTransitionSentinel) =>
  Effect.gen(function* () {
    const legacy = yield* localPath(root, sentinel);
    yield* verifyMailboxTransitionSentinelFile(legacy, sentinel);
    yield* confirmInstallation(root, sentinel.installation);
    yield* confirmInventory(legacy, sentinel, true);
    yield* confirmInstallation(root, sentinel.installation);
    yield* confirmInventory(legacy, sentinel, true);
  }).pipe(Effect.onExit(() => verifyMarker(root, sentinel)));

/** Verify an existing local marker and its original receipt, without asserting current liveness. */
export const verifyMailboxTransitionGuard = (
  root: string,
  ledger: string,
  sources: readonly [MailboxSource, MailboxSource],
  installation: string,
  operation: string
) =>
  Effect.gen(function* () {
    const sentinel = yield* buildMailboxTransitionSentinel(
      ledger,
      sources,
      installation,
      operation
    );
    yield* verify(root, sentinel);
    return sentinel;
  });

const publish = (fs: FileSystem.FileSystem, exact: string, sentinel: MailboxTransitionSentinel) =>
  Effect.gen(function* () {
    const marker = join(exact, ".export-pending");
    const temp = `${marker}.json.${Bun.randomUUIDv7()}.tmp`;
    const file = yield* fs.open(temp, { flag: "wx", mode: 0o600 }).pipe(Effect.mapError(fileError));
    yield* file
      .writeAll(new TextEncoder().encode(JSON.stringify(sentinel)))
      .pipe(
        Effect.andThen(file.sync),
        Effect.mapError(fileError),
        Effect.andThen(
          fs
            .link(temp, marker)
            .pipe(
              Effect.catch((error) =>
                error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(fileError())
              )
            )
        ),
        Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore))
      );
  }).pipe(Effect.scoped);

/** Check the original local source without publishing or accepting a restart sentinel. */
export const preflightMailboxTransitionGuard = (
  root: string,
  ledger: string,
  sources: readonly [MailboxSource, MailboxSource],
  installation: string,
  operation: string,
  confirmHeld: Effect.Effect<void, LedgerError>
) =>
  Effect.gen(function* () {
    const sentinel = yield* buildMailboxTransitionSentinel(
      ledger,
      sources,
      installation,
      operation
    );
    yield* confirmHeld;
    yield* inspectLocalSource(root, sentinel, false);
    yield* confirmHeld;
    yield* inspectLocalSource(root, sentinel, false);
    return sentinel;
  });

/** Guard one held installation; this cannot stop a legacy process that is already running. */
export const installMailboxTransitionGuard = (
  root: string,
  ledger: string,
  sources: readonly [MailboxSource, MailboxSource],
  installation: string,
  operation: string,
  confirmHeld: Effect.Effect<void, LedgerError>
) =>
  Effect.gen(function* () {
    const sentinel = yield* buildMailboxTransitionSentinel(
      ledger,
      sources,
      installation,
      operation
    );
    const fs = yield* FileSystem.FileSystem;
    yield* confirmHeld;
    const { legacy, occupied } = yield* inspectLocalSource(root, sentinel, true);
    yield* (occupied ? Effect.void : publish(fs, `${legacy}.v2`, sentinel)).pipe(
      Effect.andThen(confirmHeld),
      Effect.onExit(() => verify(root, sentinel))
    );
    return sentinel;
  });
