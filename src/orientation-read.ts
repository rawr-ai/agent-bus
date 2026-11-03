import { Context, Effect, Schema } from "effect";
import { LedgerError, MessageJson } from "./domain.ts";
import { type DesignationScope, messageIri, revisionIri, scopeIri } from "./Ledger.ts";
import {
  BULLETIN_BODY_BYTES,
  BULLETIN_UNIT_BYTES,
  type BulletinRecord,
  BulletinRecord as BulletinRecordSchema,
  type BulletinScope,
  canonicalJson,
  DIRECTORY_METADATA_BYTES,
  type DirectoryRecord,
  DirectoryRecord as DirectoryRecordSchema,
  jsonBytes,
  normalizeAudience,
  normalizeDirectory,
  OperationId,
  textBytes,
  utcInstant,
} from "./orientation-model.ts";
import { QueryGateway } from "./Query.ts";

type Gateway = Context.Service.Shape<typeof QueryGateway>;
type RecordValue = DirectoryRecord | BulletinRecord;

export interface Revision<A extends RecordValue> {
  readonly revision: string;
  readonly value: A;
}

export const DAMAGE_MESSAGE = "Orientation data is damaged at this cut.";
const damaged = () => new LedgerError({ message: DAMAGE_MESSAGE });
const SomeStrings = Schema.Array(Schema.Tuple([Schema.String]));
const ScopeRows = Schema.Array(
  Schema.Tuple([
    Schema.String,
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
  ])
);
const RevisionRows = Schema.Array(
  Schema.Tuple([Schema.NullOr(Schema.String), Schema.String, Schema.NullOr(Schema.String)])
);
const StoredRecord = Schema.fromJsonString(
  Schema.Union([DirectoryRecordSchema, BulletinRecordSchema])
);
const decodeRecord = Schema.decodeUnknownEffect(StoredRecord, { onExcessProperty: "error" });
const validOperation = Schema.is(OperationId);

/** Read the current pointer once, refusing a partially damaged scope instead of guessing absence. */
const pointerAt = (gateway: Gateway, t: number, scope: DesignationScope) =>
  Effect.gen(function* () {
    const id = scopeIri(scope);
    const values = yield* gateway
      .jsonld(t, {
        select: ["?kind", "?directory", "?concern", "?revision"],
        where: [
          { "@id": id, "bus:scopeKind": "?kind" },
          ["optional", { "@id": id, "bus:directory": "?directory" }],
          ["optional", { "@id": id, "bus:concern": "?concern" }],
          ["optional", { "@id": id, "bus:currentRevision": "?revision" }],
        ],
      })
      .pipe(
        Effect.flatMap((rows) =>
          Schema.decodeUnknownEffect(ScopeRows)(rows).pipe(Effect.mapError(damaged))
        )
      );
    if (values.length > 1) return yield* damaged();
    if (values.length === 1) {
      const [kind, directory, concern, revision] = values[0] ?? [];
      if (
        kind !== scope.kind ||
        directory !== (scope.kind === "programme" ? null : scope.directory) ||
        concern !== (scope.kind === "concern" ? scope.concern : null) ||
        revision === undefined ||
        revision === null ||
        !validOperation(revision) ||
        revision !== revision.toLowerCase()
      ) {
        return yield* damaged();
      }
      return revision;
    }
    const any = yield* gateway.jsonld(t, {
      select: ["?predicate"],
      where: { "@id": id, "?predicate": "?object" },
      limit: 1,
    });
    if (!Array.isArray(any) || any.length > 0) return yield* damaged();
    return undefined;
  });

/** Read an immutable revision, including its scope and original notification link. */
export const revisionAt = (
  gateway: Gateway,
  t: number,
  scope: DesignationScope,
  revision: string
) =>
  Effect.gen(function* () {
    const id = revisionIri(revision);
    const rows = yield* gateway
      .jsonld(t, {
        select: ["?scope", "?record", "?notification"],
        where: [
          { "@id": id, "bus:record": "?record" },
          ["optional", { "@id": id, "bus:scope": "?scope" }],
          ["optional", { "@id": id, "bus:notification": "?notification" }],
        ],
      })
      .pipe(
        Effect.flatMap((rows) =>
          Schema.decodeUnknownEffect(RevisionRows)(rows).pipe(Effect.mapError(damaged))
        )
      );
    if (rows.length === 0) {
      const any = yield* gateway.jsonld(t, {
        select: ["?predicate"],
        where: { "@id": id, "?predicate": "?object" },
        limit: 1,
      });
      if (Array.isArray(any) && any.length === 0) return undefined;
      return yield* damaged();
    }
    if (rows.length !== 1) return yield* damaged();
    const [storedScope, json, notification] = rows[0] ?? [];
    if (storedScope !== scopeIri(scope) || json === undefined) return yield* damaged();
    const record = yield* decodeRecord(json).pipe(Effect.mapError(damaged));
    if (notification !== messageIri(record.notification) || !utcInstant(record.publishedAt)) {
      return yield* damaged();
    }
    const messages = yield* gateway
      .jsonld(t, {
        select: ["?json"],
        where: { "@id": messageIri(record.notification), "bus:json": "?json" },
      })
      .pipe(
        Effect.flatMap((rows) =>
          Schema.decodeUnknownEffect(SomeStrings)(rows).pipe(Effect.mapError(damaged))
        )
      );
    if (messages.length !== 1) return yield* damaged();
    const message = yield* Schema.decodeUnknownEffect(MessageJson)(messages[0]?.[0]).pipe(
      Effect.mapError(damaged)
    );
    if (
      message.kind !== "message" ||
      message.id !== record.notification ||
      message.from !== record.publisher ||
      message.ts !== record.publishedAt ||
      canonicalJson(message.to) !== canonicalJson(record.audience)
    ) {
      return yield* damaged();
    }
    const audience = yield* normalizeAudience(record.audience).pipe(Effect.mapError(damaged));
    if (canonicalJson(audience) !== canonicalJson(record.audience)) return yield* damaged();
    if (record.kind === "directory") {
      if (scope.kind !== "directory" || record.directory.id !== scope.directory)
        return yield* damaged();
      const normalized = yield* normalizeDirectory(record.directory).pipe(Effect.mapError(damaged));
      if (canonicalJson(record.directory) !== canonicalJson(normalized)) return yield* damaged();
      if (
        audience.length === 0 ||
        jsonBytes({
          publisher: record.publisher,
          publishedAt: record.publishedAt,
          notification: record.notification,
          audience,
        }) > DIRECTORY_METADATA_BYTES
      ) {
        return yield* damaged();
      }
    } else {
      if (scope.kind === "directory" || canonicalJson(record.scope) !== canonicalJson(scope)) {
        return yield* damaged();
      }
      if (
        (scope.kind === "programme" && canonicalJson(audience) !== canonicalJson(["*"])) ||
        jsonBytes(record) > BULLETIN_UNIT_BYTES ||
        (record.action === "publish" &&
          (record.body === undefined || textBytes(record.body) > BULLETIN_BODY_BYTES)) ||
        (record.action === "withdraw" &&
          (record.body !== undefined || record.expiresAt !== undefined)) ||
        (record.expiresAt !== undefined && !utcInstant(record.expiresAt))
      ) {
        return yield* damaged();
      }
    }
    return { revision, value: record };
  });

export const directoryAt = (gateway: Gateway, t: number, directory: string) =>
  Effect.gen(function* () {
    const scope = { kind: "directory" as const, directory };
    const pointer = yield* pointerAt(gateway, t, scope);
    if (pointer === undefined) return undefined;
    const record = yield* revisionAt(gateway, t, scope, pointer);
    if (record === undefined || record.value.kind !== "directory") return yield* damaged();
    return { revision: record.revision, value: record.value } satisfies Revision<DirectoryRecord>;
  });

export const bulletinAt = (gateway: Gateway, t: number, scope: BulletinScope) =>
  Effect.gen(function* () {
    const pointer = yield* pointerAt(gateway, t, scope);
    if (pointer === undefined) return undefined;
    const record = yield* revisionAt(gateway, t, scope, pointer);
    if (record === undefined || record.value.kind !== "bulletin") return yield* damaged();
    return { revision: record.revision, value: record.value } satisfies Revision<BulletinRecord>;
  });
