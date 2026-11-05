import { Clock, Context, Effect } from "effect";
import { Bus, originFor } from "./Bus.ts";
import { InvalidQuery, Message } from "./domain.ts";
import { type DesignationResult, type DesignationScope, Ledger } from "./Ledger.ts";
import {
  BULLETIN_BODY_BYTES,
  BULLETIN_UNIT_BYTES,
  type BulletinRecord,
  type BulletinScope,
  type BulletinUpdate,
  bulletinFits,
  canonicalJson,
  DIRECTORY_METADATA_BYTES,
  type DirectoryRecord,
  type DirectoryUpdate,
  jsonBytes,
  normalizeAudience,
  normalizeDirectory,
  textBytes,
  utcInstant,
} from "./orientation-model.ts";
import { directoryAt, revisionAt } from "./orientation-read.ts";
import { type Pin, QueryGateway } from "./Query.ts";

type Gateway = Context.Service.Shape<typeof QueryGateway>;
type Store = Context.Service.Shape<typeof Ledger>;
const invalid = (message: string) => new InvalidQuery({ message });

const directoryScope = (directory: string): DesignationScope => ({ kind: "directory", directory });
const cutFor = (gateway: Gateway) => gateway.pin;

const receipt = (message: Message) =>
  message.kind !== "message"
    ? undefined
    : {
        id: message.id,
        ts: message.ts,
        from: message.from,
        to: [...message.to],
        kind: "message" as const,
        body: message.body,
        ...(message.subject === undefined ? {} : { subject: message.subject }),
        ...(message.origin === undefined
          ? {}
          : {
              origin: {
                host: message.origin.host,
                ...(message.origin.cwd === undefined ? {} : { cwd: message.origin.cwd }),
                ...(message.origin.repo === undefined ? {} : { repo: message.origin.repo }),
                ...(message.origin.branch === undefined ? {} : { branch: message.origin.branch }),
              },
            }),
      };

const publicOutcome = (result: DesignationResult, operation: string, expected: string | null) => {
  if (result.status !== "APPLIED") return { ...result, operation, expected };
  const notification = receipt(result.notification);
  return notification === undefined
    ? { status: "UNKNOWN" as const, operation, expected }
    : { ...result, notification, operation, expected };
};

const replay = (store: Store, operation: string, intent: string) =>
  Effect.gen(function* () {
    const witness = yield* store.readWitness(operation);
    switch (witness.status) {
      case "FOUND":
        if (witness.intent !== intent)
          return { status: "IDENTITY_MISMATCH" as const, cut: witness.cut };
        const notification = receipt(witness.notification);
        return notification === undefined
          ? { status: "UNKNOWN" as const }
          : {
              status: "APPLIED" as const,
              revision: witness.revision,
              notification,
              cut: witness.cut,
            };
      case "ABSENT":
        return undefined;
      case "MALFORMED":
      case "UNAVAILABLE":
        return { status: "UNKNOWN" as const };
    }
  });

const prepare = (operation: string, expected: string | null) => ({
  operation: operation.toLowerCase(),
  expected: expected?.toLowerCase() ?? null,
});

const liveDirectory = (gateway: Gateway, pin: Pin, scope: BulletinScope) =>
  Effect.gen(function* () {
    if (scope.kind === "programme") return undefined;
    const directory = yield* directoryAt(gateway, pin.head, scope.directory);
    const concern = directory?.value.directory.concerns.find((entry) => entry.id === scope.concern);
    if (directory === undefined || concern === undefined) {
      return yield* invalid(
        "The concern is not registered in the current directory; nothing was written."
      );
    }
    return { directory, concern };
  });

/** Register or replace a directory under the publisher's existing ownership lock. */
export const updateDirectory = (input: DirectoryUpdate) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    const store = yield* Ledger;
    const { operation, expected } = prepare(input.operation, input.expected);
    return yield* bus.withOwner(input.from, input.session, (owner) =>
      Effect.gen(function* () {
        const directory = yield* normalizeDirectory(input.directory);
        const audience = yield* normalizeAudience(input.audience);
        if (audience.length === 0)
          return yield* invalid("A directory update requires a nonempty audience.");
        const scope = directoryScope(directory.id);
        const intent = canonicalJson({
          action: "replace",
          scope,
          expected,
          directory,
          audience,
          publisher: input.from,
        });
        const prior = yield* replay(store, operation, intent);
        if (prior !== undefined) return { ...prior, operation, expected };
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        const notification = new Message({
          id: Bun.randomUUIDv7(),
          ts: now,
          from: input.from,
          to: audience,
          kind: "message",
          subject: `Directory ${directory.id} updated`,
          body: `Directory ${directory.id} has a new designated revision. Read it with bus_orient.`,
          origin: yield* originFor(owner.cwd),
        });
        const record: DirectoryRecord = {
          kind: "directory",
          directory,
          publisher: input.from,
          publishedAt: now,
          notification: notification.id,
          audience,
        };
        if (
          jsonBytes({
            publisher: record.publisher,
            publishedAt: record.publishedAt,
            notification: record.notification,
            audience,
          }) > DIRECTORY_METADATA_BYTES
        ) {
          return yield* invalid(
            `Directory publication metadata exceeds ${DIRECTORY_METADATA_BYTES} UTF-8 bytes.`
          );
        }
        const result = yield* store.designate({
          scope,
          operation,
          expected,
          intent,
          record: JSON.stringify(record),
          notification,
        });
        return publicOutcome(result, operation, expected);
      })
    );
  });

/** Publish or withdraw one programme or registered-concern bulletin. */
export const updateBulletin = (input: BulletinUpdate) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    const store = yield* Ledger;
    const gateway = yield* QueryGateway;
    const { operation, expected } = prepare(input.operation, input.expected);
    return yield* bus.withOwner(input.from, input.session, (owner) =>
      Effect.gen(function* () {
        if (input.action === "withdraw") {
          if (
            expected === null ||
            input.body !== undefined ||
            input.expiresAt !== undefined ||
            input.recipients !== undefined
          ) {
            return yield* invalid(
              "Withdrawal requires a revision and no replacement body, expiry or recipients."
            );
          }
        } else if (
          input.body === undefined ||
          textBytes(input.body) > BULLETIN_BODY_BYTES ||
          (input.expiresAt !== undefined && !utcInstant(input.expiresAt))
        ) {
          return yield* invalid(
            `Publication needs a body of at most ${BULLETIN_BODY_BYTES} UTF-8 bytes and a valid UTC expiry.`
          );
        }
        if (input.scope.kind === "programme" && input.recipients !== undefined) {
          return yield* invalid("Programme bulletins always notify *; do not specify recipients.");
        }
        const recipients =
          input.recipients === undefined
            ? undefined
            : yield* normalizeAudience(input.recipients, true);
        const expiresAt =
          input.expiresAt === undefined ? undefined : new Date(input.expiresAt).toISOString();
        const intent = canonicalJson({
          action: input.action,
          scope: input.scope,
          expected,
          publisher: input.from,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          audience:
            input.action === "withdraw"
              ? { previous: true }
              : input.scope.kind === "programme"
                ? { programme: true }
                : { concernTopic: true, recipients: recipients ?? [] },
        });
        const prior = yield* replay(store, operation, intent);
        if (prior !== undefined) return { ...prior, operation, expected };
        const pin = yield* cutFor(gateway);
        const parent =
          input.action === "publish" ? yield* liveDirectory(gateway, pin, input.scope) : undefined;
        let audience: ReadonlyArray<string>;
        if (input.action === "withdraw") {
          if (expected === null) return yield* invalid("Withdrawal needs an expected revision.");
          const previous = yield* revisionAt(gateway, pin.head, input.scope, expected);
          if (
            previous === undefined ||
            previous.value.kind !== "bulletin" ||
            previous.value.action !== "publish"
          ) {
            return yield* invalid("The expected revision is not a published bulletin.");
          }
          audience = previous.value.audience;
        } else {
          if (input.scope.kind === "programme") audience = ["*"];
          else {
            if (parent === undefined) return yield* invalid("The concern is not registered.");
            audience = yield* normalizeAudience([
              `#${parent.concern.topic}`,
              ...(recipients ?? []),
            ]);
          }
        }
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        const notification = new Message({
          id: Bun.randomUUIDv7(),
          ts: now,
          from: input.from,
          to: audience,
          kind: "message",
          subject:
            input.scope.kind === "programme"
              ? "Programme bulletin updated"
              : `Concern ${input.scope.concern} bulletin updated`,
          body: `A ${input.scope.kind} bulletin was ${input.action === "publish" ? "published" : "withdrawn"}. Read its designated state with bus_orient.`,
          origin: yield* originFor(owner.cwd),
        });
        const record: BulletinRecord = {
          kind: "bulletin",
          scope: input.scope,
          action: input.action,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          publisher: input.from,
          publishedAt: now,
          notification: notification.id,
          audience,
        };
        if (!bulletinFits(record, operation, Date.parse(now)))
          return yield* invalid(
            `The projected bulletin exceeds ${BULLETIN_UNIT_BYTES} UTF-8 bytes.`
          );
        const result = yield* store.designate({
          scope: input.scope,
          expected,
          operation,
          intent,
          record: JSON.stringify(record),
          notification,
          ...(parent === undefined ? {} : { directoryRevision: parent.directory.revision }),
        });
        return publicOutcome(result, operation, expected);
      })
    );
  });
