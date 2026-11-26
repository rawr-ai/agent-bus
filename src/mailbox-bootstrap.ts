import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { LedgerError } from "./domain.ts";

export const MAILBOX_BOOTSTRAP_GRANT_FILE = ".mailbox-bootstrap-grant-v1";
export const MAILBOX_BOOTSTRAP_INIT_FILE = ".mailbox-bootstrap-init-v1";
export const MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE = ".mailbox-bootstrap-identity-complete-v1";
export const MAILBOX_BOOTSTRAP_SPENT_FILE = ".mailbox-bootstrap-spent-v1";
export const MAILBOX_BOOTSTRAP_COMPLETE_FILE = ".mailbox-bootstrap-complete-v1";
const limit = 8192;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface MailboxBootstrapTarget {
  readonly url: string;
  readonly ledger: string;
}

const Base = {
  version: Schema.Literal(1),
  installation: Schema.String.check(Schema.isPattern(uuidV4)),
  url: Schema.String,
  ledger: Schema.String,
};
const Grant = Schema.Struct({ ...Base, kind: Schema.Literals(["grant", "first-create-grant"]) });
const TargetedInitializing = Schema.Struct({ ...Base, kind: Schema.Literal("initializing") });
const IdentityOnlyInitializing = Schema.Struct({
  version: Schema.Literal(1),
  installation: Schema.String.check(Schema.isPattern(uuidV4)),
  kind: Schema.Literal("identity-only-initializing"),
});
const Initializing = Schema.Union([TargetedInitializing, IdentityOnlyInitializing]);
const IdentityComplete = Schema.Struct({
  version: Schema.Literal(1),
  installation: Schema.String.check(Schema.isPattern(uuidV4)),
  kind: Schema.Literals(["identity-only-complete", "attachment-identity-complete"]),
});
const Spent = Schema.Struct({
  ...Base,
  kind: Schema.Literal("spent"),
  observed: Schema.Literals(["present", "absent", "attachment"]),
});
const Complete = Schema.Struct({
  ...Base,
  kind: Schema.Literal("complete"),
  origin: Schema.Literals(["grant", "existing"]),
  incarnation: Schema.String.check(Schema.isMinLength(1)),
});
type Grant = typeof Grant.Type;
type Initializing = typeof Initializing.Type;
type IdentityComplete = typeof IdentityComplete.Type;
type Spent = typeof Spent.Type;
type Complete = typeof Complete.Type;

export type MailboxBootstrapState =
  | { readonly kind: "ungranted" }
  | { readonly kind: "identity-only" }
  | { readonly kind: "attachment-spent" }
  | { readonly kind: "unspent" }
  | { readonly kind: "complete"; readonly incarnation: string };

const refused = () =>
  new LedgerError({
    message:
      "Mailbox bootstrap evidence is missing, invalid, incomplete, or bound to another installation or store; operator recovery is required.",
  });

const prepareMailboxIdentity = (path: string, identity: string) =>
  Effect.tryPromise({
    try: async () => {
      const original = await lstat(path);
      if (!original.isFile() || original.size !== 0) throw new Error();
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const found = await file.stat();
        if (
          !found.isFile() ||
          found.size !== 0 ||
          found.ino !== original.ino ||
          found.dev !== original.dev
        )
          throw new Error();
        await file.chmod(0o600);
        await file.writeFile(`${identity}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    },
    catch: refused,
  });

export const syncInstallationDirectory = (root: string) =>
  Effect.tryPromise({
    try: async () => {
      const directory = await open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        if (!(await directory.stat()).isDirectory()) throw new Error();
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
    catch: refused,
  });

export const validBootstrapTarget = (target: MailboxBootstrapTarget) => {
  if (target.url.length > 2048 || target.ledger.length === 0 || target.ledger.length > 1024)
    return false;
  try {
    const url = new URL(target.url);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

const sameTarget = (
  record: { readonly installation: string; readonly url: string; readonly ledger: string },
  installation: string,
  target: MailboxBootstrapTarget
) =>
  record.installation === installation &&
  record.url === target.url &&
  record.ledger === target.ledger;

const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const info = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
};

/** Reads only a stable, bounded, private regular file; no following the final component. */
export const readPrivateInstallationRecord = async (path: string) => {
  const original = await info(path);
  if (original === undefined) return undefined;
  if (!original.isFile() || (original.mode & 0o777) !== 0o600 || original.size > limit)
    throw new Error();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > limit ||
      before.ino !== original.ino ||
      before.dev !== original.dev
    )
      throw new Error();
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, null);
      if (part.bytesRead === 0) break;
      size += part.bytesRead;
    }
    const after = await file.stat();
    if (
      size > limit ||
      size !== before.size ||
      after.size !== size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    await file.close();
  }
};

const read = readPrivateInstallationRecord;
const validTarget = validBootstrapTarget;

const publish = async (root: string, name: string, bytes: string) => {
  if (Buffer.byteLength(bytes) > limit || !(await lstat(root)).isDirectory()) throw new Error();
  const file = await open(
    join(root, name),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(bytes, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string
) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
      onExcessProperty: "error",
    })(text).pipe(Effect.mapError(refused));
    if (JSON.stringify(value) !== text) return yield* refused();
    return value;
  });

const records = (root: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!(await lstat(root)).isDirectory()) throw new Error();
      return {
        initializing: await read(join(root, MAILBOX_BOOTSTRAP_INIT_FILE)),
        identityComplete: await read(join(root, MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE)),
        grant: await read(join(root, MAILBOX_BOOTSTRAP_GRANT_FILE)),
        spent: await read(join(root, MAILBOX_BOOTSTRAP_SPENT_FILE)),
        complete: await read(join(root, MAILBOX_BOOTSTRAP_COMPLETE_FILE)),
      };
    },
    catch: refused,
  });

const decodedRecords = (root: string, installation: string, target: MailboxBootstrapTarget) =>
  Effect.gen(function* () {
    if (!uuidV4.test(installation) || !validTarget(target)) return yield* refused();
    const raw = yield* records(root);
    const initializing: Initializing | undefined =
      raw.initializing === undefined ? undefined : yield* decode(Initializing, raw.initializing);
    const identityComplete: IdentityComplete | undefined =
      raw.identityComplete === undefined
        ? undefined
        : yield* decode(IdentityComplete, raw.identityComplete);
    const grant: Grant | undefined =
      raw.grant === undefined ? undefined : yield* decode(Grant, raw.grant);
    const spent: Spent | undefined =
      raw.spent === undefined ? undefined : yield* decode(Spent, raw.spent);
    const complete: Complete | undefined =
      raw.complete === undefined ? undefined : yield* decode(Complete, raw.complete);
    if (initializing !== undefined && initializing.installation !== installation)
      return yield* refused();
    if (identityComplete !== undefined && identityComplete.installation !== installation)
      return yield* refused();
    if (initializing?.kind === "initializing" && !sameTarget(initializing, installation, target))
      return yield* refused();
    for (const record of [grant, spent, complete]) {
      if (record !== undefined && !sameTarget(record, installation, target))
        return yield* refused();
    }
    return { initializing, identityComplete, grant, spent, complete };
  });

/** Reserve the exact target and future identity before linking that identity into place. */
export const reserveMailboxBootstrap = (
  root: string,
  installation: string,
  target: MailboxBootstrapTarget
) =>
  Effect.gen(function* () {
    if (!uuidV4.test(installation) || !validTarget(target)) return yield* refused();
    yield* Effect.tryPromise({
      try: async () => {
        if (!(await lstat(root)).isDirectory()) throw new Error();
        if ((await readdir(root)).length !== 0) throw new Error();
        await publish(
          root,
          MAILBOX_BOOTSTRAP_INIT_FILE,
          JSON.stringify({
            version: 1,
            installation,
            url: target.url,
            ledger: target.ledger,
            kind: "initializing",
          })
        );
      },
      catch: refused,
    });
    const saved = yield* decodedRecords(root, installation, target);
    if (
      saved.initializing?.kind !== "initializing" ||
      saved.identityComplete !== undefined ||
      saved.grant !== undefined ||
      saved.spent !== undefined ||
      saved.complete !== undefined
    )
      return yield* refused();
  });

/** Only the exclusive winner creating the installation ID may call this. */
const publishMailboxBootstrapGrant = (
  root: string,
  installation: string,
  target: MailboxBootstrapTarget,
  temporary: string
) =>
  Effect.gen(function* () {
    if (!uuidV4.test(installation) || !validTarget(target)) return yield* refused();
    const prior = yield* decodedRecords(root, installation, target);
    if (
      prior.initializing?.kind !== "initializing" ||
      prior.identityComplete !== undefined ||
      prior.grant !== undefined ||
      prior.spent !== undefined ||
      prior.complete !== undefined
    )
      return yield* refused();
    yield* Effect.tryPromise({
      try: async () => {
        if (!(await lstat(root)).isDirectory()) throw new Error();
        if ((await read(join(root, "installation-id"))) !== `${installation}\n`) throw new Error();
        const identity = await lstat(join(root, "installation-id"));
        const tempDir = dirname(temporary);
        if (
          resolve(dirname(tempDir)) !== resolve(root) ||
          !basename(tempDir).startsWith(".installation-")
        )
          throw new Error();
        let foundTemporary = false;
        for (const name of await readdir(root)) {
          if (name === "installation-id" || name === MAILBOX_BOOTSTRAP_INIT_FILE) continue;
          if (name !== basename(tempDir)) throw new Error();
          if (!(await lstat(tempDir)).isDirectory()) throw new Error();
          const children = await readdir(tempDir);
          if (children.length !== 1 || children[0] !== basename(temporary)) throw new Error();
          const entry = await lstat(temporary);
          if (!entry.isFile() || entry.ino !== identity.ino || entry.dev !== identity.dev)
            throw new Error();
          foundTemporary = true;
        }
        if (!foundTemporary) throw new Error();
        await publish(
          root,
          MAILBOX_BOOTSTRAP_GRANT_FILE,
          JSON.stringify({
            version: 1,
            installation,
            url: target.url,
            ledger: target.ledger,
            kind: "first-create-grant",
          })
        );
      },
      catch: refused,
    });
    const saved = yield* inspectMailboxBootstrap(root, installation, target);
    if (saved.kind !== "unspent") return yield* refused();
  });

/** The reservation and identity link belong to one invocation; a crash is never a grant retry. */
export const initializeTargetedMailboxIdentity = (root: string, target: MailboxBootstrapTarget) =>
  Effect.gen(function* () {
    const identity = crypto.randomUUID();
    yield* reserveMailboxBootstrap(root, identity, target);
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs
      .makeTempFileScoped({ directory: root, prefix: ".installation-" })
      .pipe(Effect.mapError(refused));
    yield* prepareMailboxIdentity(temporary, identity);
    yield* fs.link(temporary, join(root, "installation-id")).pipe(Effect.mapError(refused));
    yield* syncInstallationDirectory(root);
    yield* publishMailboxBootstrapGrant(root, identity, target, temporary);
  }).pipe(Effect.scoped);

/** Both initialization modes contend for the same permanent exclusive slot. */
export const initializeIdentityOnly = (root: string) =>
  Effect.gen(function* () {
    const identity = crypto.randomUUID();
    yield* Effect.tryPromise({
      try: async () => {
        if (!(await lstat(root)).isDirectory() || (await readdir(root)).length !== 0)
          throw new Error();
        await publish(
          root,
          MAILBOX_BOOTSTRAP_INIT_FILE,
          JSON.stringify({
            version: 1,
            installation: identity,
            kind: "identity-only-initializing",
          })
        );
      },
      catch: refused,
    });
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs
      .makeTempFileScoped({ directory: root, prefix: ".installation-" })
      .pipe(Effect.mapError(refused));
    yield* prepareMailboxIdentity(temporary, identity);
    yield* fs.link(temporary, join(root, "installation-id")).pipe(Effect.mapError(refused));
    yield* syncInstallationDirectory(root);
    yield* Effect.tryPromise({
      try: async () => {
        if ((await read(join(root, "installation-id"))) !== `${identity}\n`) throw new Error();
        await publish(
          root,
          MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE,
          JSON.stringify({
            version: 1,
            installation: identity,
            kind: "attachment-identity-complete",
          })
        );
      },
      catch: refused,
    });
    const state = yield* inspectMailboxBootstrap(root, identity, {
      url: "http://127.0.0.1",
      ledger: "identity-only",
    });
    if (state.kind !== "identity-only") return yield* refused();
  }).pipe(Effect.scoped);

/** A spent grant without its completion is never retried automatically. */
export const inspectMailboxBootstrap = (
  root: string,
  installation: string,
  target: MailboxBootstrapTarget
) =>
  Effect.gen(function* () {
    const { initializing, identityComplete, grant, spent, complete } = yield* decodedRecords(
      root,
      installation,
      target
    );
    if (initializing?.kind === "identity-only-initializing") {
      if (identityComplete === undefined || grant !== undefined) return yield* refused();
      if (spent !== undefined) {
        if (
          identityComplete.kind !== "attachment-identity-complete" ||
          spent.observed !== "attachment" ||
          complete !== undefined
        )
          return yield* refused();
        return { kind: "attachment-spent" } as const;
      }
    } else if (initializing?.kind === "initializing") {
      if (identityComplete !== undefined || grant === undefined || spent?.observed === "attachment")
        return yield* refused();
    } else if (identityComplete !== undefined || grant !== undefined || spent !== undefined) {
      return yield* refused();
    }
    if (complete === undefined) {
      if (spent !== undefined) return yield* refused();
      if (initializing?.kind === "initializing") {
        // R1 could accept paired admission without spending an older reservation.
        if (grant?.kind !== "first-create-grant") return yield* refused();
        return { kind: "unspent" } as const;
      }
      return identityComplete?.kind === "attachment-identity-complete"
        ? ({ kind: "identity-only" } as const)
        : ({ kind: "ungranted" } as const);
    }
    if (
      complete.origin === "grant"
        ? initializing?.kind !== "initializing" || grant === undefined || spent === undefined
        : grant !== undefined ||
          spent !== undefined ||
          identityComplete?.kind === "attachment-identity-complete"
    ) {
      return yield* refused();
    }
    return { kind: "complete", incarnation: complete.incarnation } as const;
  });

/** An existing identity never gains a grant, and an incomplete reservation is not repaired. */
export const checkExistingMailboxBootstrap = (
  root: string,
  installation: string,
  target?: MailboxBootstrapTarget
) =>
  Effect.gen(function* () {
    const raw = yield* records(root);
    const initializing =
      raw.initializing === undefined ? undefined : yield* decode(Initializing, raw.initializing);
    if (
      initializing?.kind === "identity-only-initializing" &&
      raw.grant === undefined &&
      raw.spent === undefined &&
      raw.complete === undefined
    ) {
      yield* inspectMailboxBootstrap(
        root,
        installation,
        target ?? { url: "http://127.0.0.1", ledger: "identity-only" }
      );
      return;
    }
    const first =
      initializing?.kind === "initializing"
        ? initializing
        : raw.grant !== undefined
          ? yield* decode(Grant, raw.grant)
          : raw.spent !== undefined
            ? yield* decode(Spent, raw.spent)
            : raw.complete !== undefined
              ? yield* decode(Complete, raw.complete)
              : undefined;
    if (first === undefined) {
      if (initializing !== undefined || raw.identityComplete !== undefined) return yield* refused();
      if (target !== undefined && !validTarget(target)) return yield* refused();
      return;
    }
    const recorded = { url: first.url, ledger: first.ledger };
    if (
      target !== undefined &&
      (target.url !== recorded.url || target.ledger !== recorded.ledger)
    ) {
      return yield* refused();
    }
    yield* inspectMailboxBootstrap(root, installation, recorded);
  });

/** The caller must have made the authoritative positive existence observation first. */
export const spendMailboxBootstrap = (
  root: string,
  installation: string,
  target: MailboxBootstrapTarget,
  exists: boolean
) =>
  Effect.gen(function* () {
    const state = yield* inspectMailboxBootstrap(root, installation, target);
    if (state.kind !== "unspent") return yield* refused();
    yield* Effect.tryPromise({
      try: () =>
        publish(
          root,
          MAILBOX_BOOTSTRAP_SPENT_FILE,
          JSON.stringify({
            version: 1,
            installation,
            url: target.url,
            ledger: target.ledger,
            kind: "spent",
            observed: exists ? "present" : "absent",
          })
        ),
      catch: refused,
    });
    const saved = yield* decodedRecords(root, installation, target);
    if (
      saved.initializing?.kind !== "initializing" ||
      saved.identityComplete !== undefined ||
      saved.grant === undefined ||
      saved.spent === undefined ||
      saved.complete !== undefined ||
      saved.spent.observed !== (exists ? "present" : "absent")
    )
      return yield* refused();
  });

/** A lost binding is restored, never an opportunity to attach this identity to another history. */
export const spendExistingAttachment = (
  root: string,
  installation: string,
  target: MailboxBootstrapTarget
) =>
  Effect.gen(function* () {
    if ((yield* inspectMailboxBootstrap(root, installation, target)).kind !== "identity-only")
      return yield* refused();
    yield* Effect.tryPromise({
      try: () =>
        publish(
          root,
          MAILBOX_BOOTSTRAP_SPENT_FILE,
          JSON.stringify({
            version: 1,
            installation,
            url: target.url,
            ledger: target.ledger,
            kind: "spent",
            observed: "attachment",
          })
        ),
      catch: refused,
    });
    if ((yield* inspectMailboxBootstrap(root, installation, target)).kind !== "attachment-spent")
      return yield* refused();
  });

/** Record the exact incarnation only after a single authorized create verifies era 1. */
export const completeMailboxBootstrap = (
  root: string,
  installation: string,
  target: MailboxBootstrapTarget,
  incarnation: string
) =>
  Effect.gen(function* () {
    if (incarnation.length === 0 || incarnation.length > 2048) return yield* refused();
    const { initializing, identityComplete, grant, spent, complete } = yield* decodedRecords(
      root,
      installation,
      target
    );
    if (
      complete !== undefined ||
      initializing?.kind !== "initializing" ||
      identityComplete !== undefined ||
      grant?.kind !== "first-create-grant" ||
      spent?.observed !== "absent"
    ) {
      return yield* refused();
    }
    yield* Effect.tryPromise({
      try: () =>
        publish(
          root,
          MAILBOX_BOOTSTRAP_COMPLETE_FILE,
          JSON.stringify({
            version: 1,
            installation,
            url: target.url,
            ledger: target.ledger,
            kind: "complete",
            origin: "grant",
            incarnation,
          })
        ),
      catch: refused,
    });
    const state = yield* inspectMailboxBootstrap(root, installation, target);
    if (state.kind !== "complete" || state.incarnation !== incarnation) return yield* refused();
  });
