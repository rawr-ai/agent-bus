import { join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";

export class InstallationError extends Schema.TaggedError<InstallationError>()(
  "InstallationError",
  {
    message: Schema.String,
  }
) {}

const fileName = "installation-id";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const missing = () =>
  new InstallationError({
    message:
      "Missing installation-id. For a first install or upgrade, run agent-bus initialize-installation. If an established identity is missing, restore it from this installation's backup.",
  });
const invalid = () =>
  new InstallationError({
    message:
      "Cannot read a valid installation-id. Check access or restore it from this installation's backup; it was not replaced.",
  });
const cannotCreate = () =>
  new InstallationError({ message: "Could not initialize installation-id." });

const read = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = join(dir, fileName);
    const stat = yield* fs
      .lstat(file)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(invalid())
        )
      );
    if (stat === undefined) return undefined;
    if (stat.type !== "File") return yield* invalid();
    const id = (yield* fs.readFileString(file).pipe(Effect.mapError(invalid))).trim();
    if (!uuid.test(id)) return yield* invalid();
    return id;
  });

/** Starting a serve never seeds or replaces its delivery identity. */
export const loadInstallation = (dir: string) =>
  read(dir).pipe(
    Effect.flatMap((id) => (id === undefined ? Effect.fail(missing()) : Effect.succeed(id)))
  );

/** Publish a complete ID once, even if two operators initialize concurrently. */
export const initializeInstallation = (dir: string) =>
  Effect.gen(function* () {
    if ((yield* read(dir)) !== undefined) return;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(cannotCreate));
    const temporary = yield* fs
      .makeTempFileScoped({ directory: dir, prefix: ".installation-" })
      .pipe(Effect.mapError(cannotCreate));
    yield* fs.chmod(temporary, 0o600).pipe(Effect.mapError(cannotCreate));
    yield* fs
      .writeFileString(temporary, `${crypto.randomUUID()}\n`)
      .pipe(Effect.mapError(cannotCreate));
    yield* fs
      .link(temporary, join(dir, fileName))
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists"
            ? Effect.asVoid(loadInstallation(dir))
            : Effect.fail(cannotCreate())
        )
      );
  }).pipe(Effect.scoped);
