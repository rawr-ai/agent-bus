import { ORPCError, os } from "@orpc/server";
import { Cause, Effect, Exit, type ManagedRuntime, Schema } from "effect";
import {
  checkReference,
  HistoryInputSchema,
  HistoryObservationSchema,
  IDENTITY_FIELDS,
  InvestigationPageInputSchema,
  InvestigationPageSchema,
  PeersObservationSchema,
  ThreadInputSchema,
  ThreadObservationSchema,
} from "../shared/public.ts";
import {
  BusError,
  IdentityMismatch,
  type InvestigationFailure,
  ObservationReader,
  ObservationTimeout,
  ObservationUnavailable,
  PageRejected,
} from "./reader.ts";

export type ViewerRuntime = ManagedRuntime.ManagedRuntime<ObservationReader, never>;

const unavailable = () =>
  new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, message: "Observation unavailable" });

/** Preserve defects and finalizer failures instead of selecting a convenient first error. */
const runObservation = async <A>(
  runtime: ViewerRuntime,
  effect: Effect.Effect<A, InvestigationFailure, ObservationReader>,
  signal?: AbortSignal
): Promise<A> => {
  const exit = await runtime.runPromiseExit(effect, signal === undefined ? undefined : { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new ORPCError("OBSERVATION_CANCELLED", { status: 499, message: "Observation cancelled" });
  }
  const reasons = exit.cause.reasons;
  const first = reasons[0];
  const failure = first !== undefined && Cause.isFailReason(first) ? first.error : undefined;
  // One kind of expected failure only: a mixed cause is not reported as any one of them.
  const all = (kind: abstract new (...args: never) => unknown) =>
    failure instanceof kind &&
    reasons.every((reason) => Cause.isFailReason(reason) && reason.error instanceof kind);
  if (all(ObservationTimeout)) {
    throw new ORPCError("OBSERVATION_TIMEOUT", { status: 504, message: "Observation timed out" });
  }
  if (all(ObservationUnavailable)) throw unavailable();
  if (all(BusError)) throw new ORPCError("BUS_ERROR", investigationErrors.BUS_ERROR);
  if (all(PageRejected)) throw new ORPCError("PAGE_REJECTED", investigationErrors.PAGE_REJECTED);
  if (failure instanceof IdentityMismatch && all(IdentityMismatch)) {
    throw new ORPCError("IDENTITY_MISMATCH", {
      ...investigationErrors.IDENTITY_MISMATCH,
      data: { field: failure.field },
    });
  }
  throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Observation failed" });
};

/** Declared on the investigation page only, so the live procedures' errors are unchanged. */
const investigationErrors = {
  BAD_REQUEST: { status: 400, message: "Not a pinned history reference" },
  BUS_ERROR: { status: 502, message: "The bus answered this page with an error" },
  PAGE_REJECTED: { status: 502, message: "Investigation page rejected" },
  IDENTITY_MISMATCH: {
    status: 502,
    message: "Investigation identity mismatch",
    data: Schema.toStandardSchemaV1(Schema.Struct({ field: Schema.Literals(IDENTITY_FIELDS) })),
  },
};

const base = os.errors({
  UPSTREAM_UNAVAILABLE: { status: 503, message: "Observation unavailable" },
  OBSERVATION_TIMEOUT: { status: 504, message: "Observation timed out" },
  OBSERVATION_CANCELLED: { status: 499, message: "Observation cancelled" },
});

export const createRouter = (runtime: ViewerRuntime) => ({
  history: base
    .input(
      Schema.toStandardSchemaV1(HistoryInputSchema, {
        parseOptions: { onExcessProperty: "error" },
      })
    )
    .output(Schema.toStandardSchemaV1(HistoryObservationSchema))
    .handler(({ input, signal }) =>
      runObservation(
        runtime,
        Effect.flatMap(ObservationReader, (reader) => reader.history(input)),
        signal
      )
    ),
  peers: base
    .input(
      Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Never), {
        parseOptions: { onExcessProperty: "error" },
      })
    )
    .output(Schema.toStandardSchemaV1(PeersObservationSchema))
    .handler(({ signal }) =>
      runObservation(
        runtime,
        Effect.flatMap(ObservationReader, (reader) => reader.peers()),
        signal
      )
    ),
  thread: base
    .input(
      Schema.toStandardSchemaV1(ThreadInputSchema, {
        parseOptions: { onExcessProperty: "error" },
      })
    )
    .output(Schema.toStandardSchemaV1(ThreadObservationSchema))
    .handler(({ input, signal }) =>
      runObservation(
        runtime,
        Effect.flatMap(ObservationReader, (reader) => reader.thread(input)),
        signal
      )
    ),
  investigationPage: base
    .errors(investigationErrors)
    .input(
      Schema.toStandardSchemaV1(InvestigationPageInputSchema, {
        parseOptions: { onExcessProperty: "error" },
      })
    )
    .output(Schema.toStandardSchemaV1(InvestigationPageSchema))
    .handler(({ input, signal }) => {
      // Only the bus's own echoed form is read: the bus would normalise anything else and the
      // page would then fail its identity check.
      if (!("reference" in checkReference(input.reference))) {
        throw new ORPCError("BAD_REQUEST", investigationErrors.BAD_REQUEST);
      }
      return runObservation(
        runtime,
        Effect.flatMap(ObservationReader, (reader) => reader.investigationPage(input)),
        signal
      );
    }),
});

export type ViewerRouter = ReturnType<typeof createRouter>;
