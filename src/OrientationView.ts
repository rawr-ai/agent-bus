import { Clock, Effect, Schema } from "effect";
import { byName, CATALOGUE_VERSION, MAX_ENVELOPE_BYTES } from "./catalogue.ts";
import { InvalidQuery, LedgerError } from "./domain.ts";
import {
  type BulletinRecord,
  jsonBytes,
  type OrientationRecovery,
  OrientationRecovery as OrientationRecoverySchema,
  type OrientRequest,
} from "./orientation-model.ts";
import { bulletinAt, DAMAGE_MESSAGE, directoryAt, type Revision } from "./orientation-read.ts";
import { QueryGateway } from "./Query.ts";

const Candidates = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, revision: Schema.String })
);
const ORIENT_DEADLINE = "20 seconds";
const invalid = (message: string) => new InvalidQuery({ message });
class OrientationUnavailable extends Schema.TaggedError<OrientationUnavailable>()(
  "OrientationUnavailable",
  {
    reason: Schema.Literals(["DAMAGE", "INADMISSIBLE", "FAULT"]),
    message: Schema.String,
    recovery: Schema.optionalKey(OrientationRecoverySchema),
  }
) {}
const unavailable = (
  reason: "DAMAGE" | "INADMISSIBLE" | "FAULT",
  message: string,
  recovery?: OrientationRecovery
) =>
  new OrientationUnavailable({ reason, message, ...(recovery === undefined ? {} : { recovery }) });

/** Expiry is evaluated at read time; it never changes the designated revision. */
const bulletinView = (
  revision: Revision<BulletinRecord> | undefined,
  time: number,
  full: boolean
) => {
  if (revision === undefined) return { state: "MISSING" as const };
  const { value } = revision;
  const state =
    value.action === "withdraw"
      ? ("WITHDRAWN" as const)
      : value.expiresAt !== undefined && time >= Date.parse(value.expiresAt)
        ? ("EXPIRED" as const)
        : ("CURRENT" as const);
  if (!full) {
    return {
      state,
      revision: revision.revision,
      ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    };
  }
  return {
    state,
    revision: revision.revision,
    publisher: value.publisher,
    publishedAt: value.publishedAt,
    notification: value.notification,
    audience: value.audience,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    ...(value.body === undefined ? {} : { body: value.body }),
  };
};

/** One independent read. It never joins, subscribes, advances a cursor or sends a message. */
const readOrient = (input: OrientRequest, budget: number) =>
  Effect.gen(function* () {
    if (jsonBytes(input) > 16_384) {
      return yield* invalid("The orientation request exceeds 16,384 UTF-8 bytes.");
    }
    const gateway = yield* QueryGateway;
    const first = yield* gateway.pin;
    if (
      input.t !== undefined &&
      (!Number.isInteger(input.t) || input.t < 1 || input.t > first.head)
    ) {
      return yield* invalid(`t must be a commit from 1 to ${first.head}.`);
    }
    if (input.directory !== undefined && input.candidateCursor !== undefined) {
      return yield* invalid("A candidate cursor cannot be combined with an explicit directory.");
    }
    if (input.candidateCursor !== undefined && input.cwd === undefined) {
      return yield* invalid("A candidate cursor requires its original cwd.");
    }
    if (input.cwd !== undefined && !input.cwd.startsWith("/")) {
      return yield* invalid("cwd must be an absolute path.");
    }
    const time = yield* Clock.currentTimeMillis;
    const candidateOperation = byName("orientation_directories");
    const candidates =
      input.directory !== undefined || input.cwd === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            if (candidateOperation === undefined) {
              return yield* unavailable("FAULT", "Directory candidate discovery is unavailable.");
            }
            return yield* candidateOperation.invoke(
              { cwd: input.cwd, limit: 20 },
              { t: input.t, cursor: input.candidateCursor },
              MAX_ENVELOPE_BYTES
            );
          });
    const t = candidates?.t ?? input.t ?? first.head;
    const cut = { head: t, incarnation: candidates?.ledger ?? first.incarnation };
    if (cut.incarnation !== first.incarnation) {
      return yield* unavailable("FAULT", "The ledger was replaced while orientation began.");
    }
    return yield* Effect.gen(function* () {
      const programme = bulletinView(
        yield* bulletinAt(gateway, t, { kind: "programme" }),
        time,
        true
      );
      if (candidates !== undefined && candidates.damagedTotal > 0) {
        return yield* unavailable(
          "DAMAGE",
          "Directory candidate discovery encountered damaged data."
        );
      }
      const candidateRows =
        candidates === undefined
          ? []
          : yield* Schema.decodeUnknownEffect(Candidates)(candidates.rows).pipe(
              Effect.mapError(() => unavailable("DAMAGE", "Directory candidate data is damaged."))
            );
      const automatic =
        input.directory === undefined &&
        input.candidateCursor === undefined &&
        candidates?.complete === true &&
        candidateRows.length === 1
          ? candidateRows[0]?.id
          : undefined;
      const selected = input.directory ?? automatic;
      const directory =
        selected === undefined ? undefined : yield* directoryAt(gateway, t, selected);
      if (automatic !== undefined && directory === undefined) {
        return yield* unavailable("DAMAGE", "A discovered directory is missing at the same cut.");
      }
      const selection =
        selected === undefined
          ? {
              state: candidateRows.length > 1 ? ("AMBIGUOUS" as const) : ("UNRESOLVED" as const),
              basis: input.cwd === undefined ? ("none" as const) : ("alias" as const),
            }
          : directory === undefined
            ? { state: "MISSING" as const, basis: "explicit" as const, directory: selected }
            : {
                state: "SELECTED" as const,
                basis: input.directory === undefined ? ("alias" as const) : ("explicit" as const),
                directory: selected,
              };
      if (input.concern !== undefined && selected === undefined) {
        return yield* invalid("Select a directory before selecting one of its concerns.");
      }
      const concern = directory?.value.directory.concerns.find(({ id }) => id === input.concern);
      const summaries = [];
      let selectedBulletin = bulletinView(undefined, time, true);
      if (directory !== undefined && selected !== undefined) {
        for (const definition of directory.value.directory.concerns) {
          const current = yield* bulletinAt(gateway, t, {
            kind: "concern",
            directory: selected,
            concern: definition.id,
          });
          if (definition.id === input.concern) selectedBulletin = bulletinView(current, time, true);
          else {
            summaries.push({
              concern: definition.id,
              bulletin: bulletinView(current, time, false),
              route: { directory: selected, concern: definition.id, t },
            });
          }
        }
      }
      const base = {
        status: "COMPLETE" as "COMPLETE" | "INCOMPLETE",
        cut,
        evaluatedAt: new Date(time).toISOString(),
        catalogueVersion: CATALOGUE_VERSION,
        programme,
        selection,
        ...(directory === undefined ? {} : { directory }),
        ...(input.concern === undefined
          ? {}
          : {
              concern:
                concern === undefined
                  ? { id: input.concern, state: "UNRESOLVED" as const }
                  : { id: input.concern, state: "REGISTERED" as const, bulletin: selectedBulletin },
            }),
        summaries,
        ...(directory === undefined
          ? {}
          : {
              subscriptions: {
                state: "SEPARATE_QUERY" as const,
                query: "peers" as const,
                t,
              },
            }),
      };
      if (jsonBytes(base) > budget) {
        return yield* unavailable(
          "INADMISSIBLE",
          "Required orientation units exceed the logical result limit."
        );
      }
      let candidatePage = candidates;
      if (candidatePage !== undefined && candidateOperation !== undefined) {
        const pageBudget = Math.max(0, budget - jsonBytes(base) - 1_024);
        if (jsonBytes(candidatePage) > pageBudget) {
          candidatePage = yield* candidateOperation
            .invoke({ cwd: input.cwd, limit: 20 }, { t, cursor: input.candidateCursor }, pageBudget)
            .pipe(
              Effect.mapError((error) =>
                error instanceof InvalidQuery
                  ? unavailable("INADMISSIBLE", "A directory candidate cannot fit at this cut.", {
                      tool: "bus_run_query",
                      input: {
                        name: "orientation_directories",
                        args: { cwd: input.cwd, limit: 20 },
                        t,
                        ...(input.candidateCursor === undefined
                          ? {}
                          : { cursor: input.candidateCursor }),
                      },
                    })
                  : error
              )
            );
        }
      }
      let memberPage;
      if (selected !== undefined) {
        const associations = byName("orientation_associations");
        if (associations === undefined) {
          return yield* unavailable("FAULT", "Association discovery is unavailable.");
        }
        const pageBudget = Math.max(
          0,
          budget - jsonBytes({ ...base, candidates: candidatePage }) - 1_024
        );
        const args = {
          directory: selected,
          ...(input.concern === undefined ? {} : { concern: input.concern }),
          projection: "membership",
          limit: 50,
        };
        memberPage = yield* associations.invoke(args, { t }, pageBudget).pipe(
          Effect.mapError((error) =>
            error instanceof InvalidQuery
              ? unavailable("INADMISSIBLE", "A required membership unit cannot fit at this cut.", {
                  tool: "bus_run_query",
                  input: { name: "orientation_associations", args, t },
                })
              : error
          )
        );
        if (memberPage.damagedTotal > 0) {
          return yield* unavailable(
            "DAMAGE",
            "Membership cannot be determined because a presence is damaged."
          );
        }
      }
      const after = yield* gateway.pin;
      if (after.incarnation !== cut.incarnation) {
        return yield* unavailable("FAULT", "The ledger was replaced during orientation.");
      }
      const result = {
        ...base,
        status:
          (candidatePage !== undefined && !candidatePage.complete) ||
          (memberPage !== undefined && !memberPage.complete)
            ? ("INCOMPLETE" as const)
            : ("COMPLETE" as const),
        ...(after.head > t ? { currentHeadT: after.head } : {}),
        ...(candidatePage === undefined ? {} : { candidates: candidatePage }),
        ...(memberPage === undefined
          ? {}
          : directory === undefined || (input.concern !== undefined && concern === undefined)
            ? { unresolvedAssociations: memberPage }
            : { members: memberPage }),
      };
      if (jsonBytes(result) > budget) {
        return yield* unavailable(
          "INADMISSIBLE",
          "The orientation result exceeds the logical byte limit."
        );
      }
      return result;
    }).pipe(
      Effect.catchTags({
        LedgerError: (error) =>
          Effect.succeed({
            status: "UNAVAILABLE" as const,
            cut,
            evaluatedAt: new Date(time).toISOString(),
            catalogueVersion: CATALOGUE_VERSION,
            reason: error.message === DAMAGE_MESSAGE ? ("DAMAGE" as const) : ("FAULT" as const),
            recovery: { tool: "bus_orient" as const, input: { ...input, t } },
          }),
        OrientationUnavailable: (error) =>
          Effect.succeed({
            status: "UNAVAILABLE" as const,
            cut,
            evaluatedAt: new Date(time).toISOString(),
            catalogueVersion: CATALOGUE_VERSION,
            reason: error.reason,
            recovery: error.recovery ?? { tool: "bus_orient" as const, input: { ...input, t } },
          }),
      })
    );
  });

export const orient = (input: OrientRequest, budget = MAX_ENVELOPE_BYTES) =>
  readOrient(input, Math.max(0, Math.min(budget, MAX_ENVELOPE_BYTES))).pipe(
    Effect.catchTags({
      LedgerError: () =>
        Effect.succeed({
          status: "UNAVAILABLE" as const,
          reason: "FAULT" as const,
          recovery: { tool: "bus_orient" as const, input },
        }),
      OrientationUnavailable: (error) =>
        Effect.succeed({
          status: "UNAVAILABLE" as const,
          reason: error.reason,
          recovery: error.recovery ?? { tool: "bus_orient" as const, input },
        }),
    }),
    Effect.timeoutOrElse({
      duration: ORIENT_DEADLINE,
      orElse: () =>
        Effect.succeed({
          status: "UNAVAILABLE" as const,
          reason: "FAULT" as const,
          recovery: { tool: "bus_orient" as const, input },
        }),
    })
  );
