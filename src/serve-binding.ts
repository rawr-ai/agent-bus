import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { LedgerError } from "./domain.ts";
import { Ledger } from "./Ledger.ts";
import {
  type MailboxBootstrapTarget,
  readPrivateInstallationRecord,
  syncInstallationDirectory,
  validBootstrapTarget,
} from "./mailbox-bootstrap.ts";
import { QueryGateway } from "./Query.ts";

const file = ".serve-binding-v1";
export const serveBindingCapability = "serve-binding-v1";
const cid = Schema.String.check(Schema.isPattern(/^b[a-z2-7]{1,255}$/));
const height = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Binding = Schema.Struct({
  version: Schema.Literal(1),
  installation: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  ),
  url: Schema.String,
  ledger: Schema.String,
  incarnation: cid,
  era: height,
  anchor: Schema.Struct({ head: height, commit: cid }),
});
export type ServeBinding = typeof Binding.Type;
const refused = () =>
  new LedgerError({
    message:
      "Cannot verify the serving binding to this installation and ledger history. Keep serve stopped and recover the original binding and store.",
  });

const encode = (value: ServeBinding) => JSON.stringify(value);
const decode = (text: string) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Binding), {
      onExcessProperty: "error",
    })(text).pipe(Effect.mapError(refused));
    if (
      encode(value) !== text ||
      !validBootstrapTarget(value) ||
      value.era > value.anchor.head ||
      (value.anchor.head === 1 && value.anchor.commit !== value.incarnation)
    )
      return yield* refused();
    return value;
  });

export const readServeBinding = (
  root: string,
  installation: string,
  target: MailboxBootstrapTarget
) =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: async () => {
        if (!(await lstat(root)).isDirectory()) throw new Error();
        return await readPrivateInstallationRecord(join(root, file));
      },
      catch: refused,
    });
    if (text === undefined) return undefined;
    const value = yield* decode(text);
    if (
      value.installation !== installation ||
      value.url !== target.url ||
      value.ledger !== target.ledger
    )
      return yield* refused();
    return value;
  });

/** Publish a complete immutable record; the same bytes are safe to retry, different bytes are not. */
export const persistServeBinding = (root: string, binding: ServeBinding) =>
  Effect.gen(function* () {
    const bytes = encode(binding);
    yield* decode(bytes);
    yield* Effect.tryPromise({
      try: async () => {
        if (!(await lstat(root)).isDirectory()) throw new Error();
        const temporary = await mkdtemp(join(root, ".serve-binding-"));
        try {
          const staged = join(temporary, "binding");
          const handle = await open(
            staged,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600
          );
          try {
            await handle.chmod(0o600);
            await handle.writeFile(bytes, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          try {
            await link(staged, join(root, file));
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
              throw error;
          }
          if ((await readPrivateInstallationRecord(join(root, file))) !== bytes) throw new Error();
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
      catch: refused,
    });
    yield* syncInstallationDirectory(root).pipe(Effect.mapError(refused));
  });

export const sameServeBinding = (actual: ServeBinding | undefined, expected: ServeBinding) =>
  actual !== undefined && encode(actual) === encode(expected);

export const verifyServeHistory = (binding: ServeBinding, recovery?: ServeBinding["anchor"]) =>
  Effect.gen(function* () {
    // A read-only preflight must reject every value that exclusive publication would reject.
    yield* decode(encode(binding));
    const ledger = yield* Ledger;
    const gateway = yield* QueryGateway;
    const before = yield* gateway.pin;
    if (
      ledger.instance !== binding.incarnation ||
      before.incarnation !== binding.incarnation ||
      before.head < binding.anchor.head ||
      (yield* ledger.ownershipEraAt(before)) !== binding.era ||
      (yield* ledger.sourceCommitAt({
        incarnation: binding.incarnation,
        head: binding.anchor.head,
      })) !== binding.anchor.commit
    )
      return yield* refused();
    if (
      recovery !== undefined &&
      (!Number.isSafeInteger(recovery.head) ||
        recovery.head < binding.anchor.head ||
        recovery.head > before.head ||
        !Schema.is(cid)(recovery.commit) ||
        (yield* ledger.sourceCommitAt({
          incarnation: binding.incarnation,
          head: recovery.head,
        })) !== recovery.commit)
    )
      return yield* new LedgerError({
        message: "The restored ledger does not establish the independently known recovery cut.",
      });
    const after = yield* gateway.pin;
    if (after.incarnation !== before.incarnation || after.head < before.head)
      return yield* refused();
  });
