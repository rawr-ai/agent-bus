import { Clock, Effect, Schema } from "effect";
import {
  CATALOGUE_VERSION,
  MAX_ENVELOPE_BYTES,
  orientationAssociations,
  orientationDirectories,
} from "./catalogue.ts";
import { InvalidQuery, LedgerError, type QueryCapacity } from "./domain.ts";
import {
  bulletinView,
  jsonBytes,
  type OrientationRecovery,
  OrientationRecovery as OrientationRecoverySchema,
  type OrientRequest,
} from "./orientation-model.ts";
import { bulletinAt, DAMAGE_MESSAGE, directoryAt } from "./orientation-read.ts";
import { QueryGateway } from "./Query.ts";

const Candidates = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, revision: Schema.String })
);
export const ORIENT_DEADLINE = "20 seconds";
type Section =
  | "query"
  | "programme"
  | "candidates"
  | "directory"
  | "concern"
  | "summaries"
  | "associations"
  | "result";
const invalid = (message: string) => new InvalidQuery({ message });
class OrientationUnavailable extends Schema.TaggedError<OrientationUnavailable>()(
  "OrientationUnavailable",
  {
    reason: Schema.Literals(["DAMAGE", "INADMISSIBLE", "FAULT"]),
    section: Schema.Literals([
      "query",
      "programme",
      "candidates",
      "directory",
      "concern",
      "summaries",
      "associations",
      "result",
    ]),
    message: Schema.String,
    recovery: Schema.optionalKey(OrientationRecoverySchema),
  }
) {}
const unavailable = (
  reason: "DAMAGE" | "INADMISSIBLE" | "FAULT",
  section: Section,
  message: string,
  recovery?: OrientationRecovery
) =>
  new OrientationUnavailable({
    reason,
    section,
    message,
    ...(recovery === undefined ? {} : { recovery }),
  });

const sectionError =
  (section: Section, message: string, recovery?: OrientationRecovery) =>
  (error: LedgerError | InvalidQuery | QueryCapacity) =>
    unavailable(
      error instanceof InvalidQuery
        ? "INADMISSIBLE"
        : error.message === DAMAGE_MESSAGE
          ? "DAMAGE"
          : "FAULT",
      section,
      message,
      recovery
    );

/** One independent read. It never joins, subscribes, advances a cursor or sends a message. */
const readOrient = (input: OrientRequest, budget: number) =>
  Effect.gen(function* () {
    if (jsonBytes(input) > 16_384) {
      return yield* invalid("The orientation request exceeds 16,384 UTF-8 bytes.");
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
    const gateway = yield* QueryGateway;
    const first = yield* gateway.pin;
    if (
      input.t !== undefined &&
      (!Number.isInteger(input.t) || input.t < 1 || input.t > first.head)
    ) {
      return yield* invalid(`t must be a commit from 1 to ${first.head}.`);
    }
    // The saved query owns cursor validation, including argument binding and incarnation.
    const candidateCut =
      input.directory === undefined && input.cwd !== undefined
        ? yield* orientationDirectories.resolveCut(
            { cwd: input.cwd, limit: 20 },
            { t: input.t, cursor: input.candidateCursor }
          )
        : undefined;
    const cut = candidateCut ?? { head: input.t ?? first.head, incarnation: first.incarnation };
    if (cut.incarnation !== first.incarnation) {
      return yield* unavailable("FAULT", "query", "The ledger changed while orientation began.");
    }
    const t = cut.head;
    const time = yield* Clock.currentTimeMillis;
    const evaluatedAt = new Date(time).toISOString();
    const retry: OrientationRecovery = { tool: "bus_orient", input: { ...input, t } };
    const partial: Record<string, unknown> = {};
    const outcome = yield* Effect.gen(function* () {
      const programme = bulletinView(
        yield* bulletinAt(gateway, t, { kind: "programme" }).pipe(
          Effect.mapError(
            sectionError("programme", "Programme guidance is unavailable at this cut.", retry)
          )
        ),
        time,
        true
      );
      partial.programme = programme;
      let candidatePage;
      if (input.directory === undefined && input.cwd !== undefined) {
        partial.selection = { state: "UNRESOLVED", basis: "alias" };
        const message =
          "Directory discovery is unavailable. If you know a directory id, select it explicitly at this cut.";
        const recovery: OrientationRecovery = {
          tool: "bus_run_query",
          input: {
            name: "orientation_directories",
            args: { cwd: input.cwd, limit: 20 },
            t,
            ...(input.candidateCursor === undefined ? {} : { cursor: input.candidateCursor }),
          },
        };
        candidatePage = yield* orientationDirectories
          .invoke(
            { cwd: input.cwd, limit: 20 },
            { t, cursor: input.candidateCursor },
            MAX_ENVELOPE_BYTES
          )
          .pipe(Effect.mapError(sectionError("candidates", message, recovery)));
        partial.candidates = candidatePage;
        if (candidatePage.damagedTotal > 0) {
          return yield* unavailable("DAMAGE", "candidates", message, recovery);
        }
      }
      const candidateRows =
        candidatePage === undefined
          ? []
          : yield* Schema.decodeUnknownEffect(Candidates)(candidatePage.rows).pipe(
              Effect.mapError(() =>
                unavailable(
                  "DAMAGE",
                  "candidates",
                  "Directory candidate data is damaged; select a known directory id at this cut.",
                  retry
                )
              )
            );
      const automatic =
        input.directory === undefined &&
        input.candidateCursor === undefined &&
        candidatePage?.complete === true &&
        candidateRows.length === 1
          ? candidateRows[0]?.id
          : undefined;
      const selected = input.directory ?? automatic;
      if (selected !== undefined) {
        partial.selection = {
          state: "UNRESOLVED",
          basis: input.directory === undefined ? "alias" : "explicit",
          directory: selected,
        };
      }
      const directory =
        selected === undefined
          ? undefined
          : yield* directoryAt(gateway, t, selected).pipe(
              Effect.mapError(
                sectionError(
                  "directory",
                  "The selected directory is unavailable at this cut.",
                  retry
                )
              )
            );
      if (automatic !== undefined && directory === undefined) {
        return yield* unavailable(
          "DAMAGE",
          "directory",
          "A discovered directory is missing at the same cut.",
          retry
        );
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
      partial.selection = selection;
      if (directory !== undefined) partial.directory = directory;
      const concern = directory?.value.directory.concerns.find(({ id }) => id === input.concern);
      if (input.concern !== undefined) {
        partial.concern = {
          id: input.concern,
          state: concern === undefined ? "UNRESOLVED" : "REGISTERED",
        };
      }
      if (directory !== undefined) {
        partial.subscriptions = { state: "SEPARATE_QUERY", query: "peers", t };
      }
      const summaries = [];
      if (directory !== undefined && selected !== undefined) {
        for (const definition of directory.value.directory.concerns) {
          const selectedConcern = definition.id === input.concern;
          const recovery: OrientationRecovery = {
            tool: "bus_orient",
            input: { directory: selected, concern: definition.id, t },
          };
          const current = yield* bulletinAt(gateway, t, {
            kind: "concern",
            directory: selected,
            concern: definition.id,
          }).pipe(
            Effect.mapError(
              sectionError(
                selectedConcern ? "concern" : "summaries",
                "A concern bulletin is unavailable at this cut.",
                recovery
              )
            )
          );
          if (selectedConcern) {
            partial.concern = {
              id: definition.id,
              state: "REGISTERED",
              bulletin: bulletinView(current, time, true),
            };
          } else {
            summaries.push({
              concern: definition.id,
              bulletin: bulletinView(current, time, false),
              route: { directory: selected, concern: definition.id, t },
            });
          }
        }
        partial.summaries = summaries;
      }
      const { candidates: _candidates, ...required } = partial;
      const base = {
        status: "COMPLETE",
        cut,
        evaluatedAt,
        catalogueVersion: CATALOGUE_VERSION,
        ...required,
      };
      if (jsonBytes(base) > budget) {
        return yield* unavailable(
          "INADMISSIBLE",
          "result",
          "Required orientation units exceed the logical result limit.",
          retry
        );
      }
      if (candidatePage !== undefined) {
        const pageBudget = Math.max(0, budget - jsonBytes(base) - 1_024);
        if (jsonBytes(candidatePage) > pageBudget) {
          const recovery: OrientationRecovery = {
            tool: "bus_run_query",
            input: {
              name: "orientation_directories",
              args: { cwd: input.cwd, limit: 20 },
              t,
              ...(input.candidateCursor === undefined ? {} : { cursor: input.candidateCursor }),
            },
          };
          candidatePage = yield* orientationDirectories
            .invoke({ cwd: input.cwd, limit: 20 }, { t, cursor: input.candidateCursor }, pageBudget)
            .pipe(
              Effect.mapError(
                sectionError(
                  "candidates",
                  "A directory candidate cannot fit at this cut.",
                  recovery
                )
              )
            );
        }
        partial.candidates = candidatePage;
      }
      let memberPage;
      if (selected !== undefined) {
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
        const recovery: OrientationRecovery = {
          tool: "bus_run_query",
          input: { name: "orientation_associations", args, t },
        };
        memberPage = yield* orientationAssociations
          .invoke(args, { t }, pageBudget)
          .pipe(
            Effect.mapError(
              sectionError(
                "associations",
                "Association discovery is unavailable at this cut.",
                recovery
              )
            )
          );
        if (memberPage.damagedTotal > 0) {
          return yield* unavailable(
            "DAMAGE",
            "associations",
            "Membership cannot be determined because a presence is damaged.",
            recovery
          );
        }
        if (directory === undefined || (input.concern !== undefined && concern === undefined)) {
          partial.unresolvedAssociations = memberPage;
        } else partial.members = memberPage;
      }
      return {
        complete:
          (candidatePage === undefined || candidatePage.complete) &&
          (memberPage === undefined || memberPage.complete),
      };
    }).pipe(
      Effect.map((value) => ({ value })),
      Effect.catchTag("OrientationUnavailable", (failure) => Effect.succeed({ failure }))
    );
    // A partial result is still tied to the original incarnation, not a replacement ledger.
    const after = yield* gateway.pin;
    if (after.incarnation !== cut.incarnation) {
      return yield* unavailable("FAULT", "query", "The ledger changed during orientation.");
    }
    const shared = {
      cut,
      evaluatedAt,
      catalogueVersion: CATALOGUE_VERSION,
      ...(after.head > t ? { currentHeadT: after.head } : {}),
    };
    const result =
      "failure" in outcome
        ? {
            status: "UNAVAILABLE" as const,
            ...shared,
            ...partial,
            reason: outcome.failure.reason,
            section: outcome.failure.section,
            message: outcome.failure.message,
            recovery: outcome.failure.recovery ?? retry,
          }
        : {
            status: outcome.value.complete ? ("COMPLETE" as const) : ("INCOMPLETE" as const),
            ...shared,
            ...partial,
          };
    if (jsonBytes(result) <= budget) return result;
    const minimal = {
      status: "UNAVAILABLE" as const,
      ...shared,
      reason: "INADMISSIBLE" as const,
      section: "result" as const,
      message: "The orientation result exceeds the logical byte limit.",
      recovery: retry,
    };
    const withProgramme = {
      ...minimal,
      ...(partial.programme === undefined ? {} : { programme: partial.programme }),
    };
    return jsonBytes(withProgramme) <= budget ? withProgramme : minimal;
  });

export const orient = (input: OrientRequest, budget = MAX_ENVELOPE_BYTES) =>
  readOrient(input, Math.max(0, Math.min(budget, MAX_ENVELOPE_BYTES))).pipe(
    Effect.catchTags({
      LedgerError: () =>
        Effect.succeed({
          status: "UNAVAILABLE" as const,
          reason: "FAULT" as const,
          section: "query" as const,
          message: "Orientation could not establish a reliable ledger cut.",
          recovery: { tool: "bus_orient" as const, input },
        }),
      OrientationUnavailable: (error) =>
        Effect.succeed({
          status: "UNAVAILABLE" as const,
          reason: error.reason,
          section: error.section,
          message: error.message,
          recovery: error.recovery ?? { tool: "bus_orient" as const, input },
        }),
    }),
    Effect.timeoutOrElse({
      duration: ORIENT_DEADLINE,
      orElse: () =>
        Effect.succeed({
          status: "UNAVAILABLE" as const,
          reason: "FAULT" as const,
          section: "query" as const,
          message: "Orientation did not finish within its deadline.",
          recovery: { tool: "bus_orient" as const, input },
        }),
    })
  );
