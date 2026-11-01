import { ORPCError, os } from "@orpc/server";
import { Cause, Effect, Exit, type ManagedRuntime, Schema } from "effect";
import {
  HistoryInputSchema,
  HistoryObservationSchema,
  PeersObservationSchema,
} from "../shared/public.ts";
import { ObservationReader, ObservationTimeout, ObservationUnavailable } from "./reader.ts";

export type ViewerRuntime = ManagedRuntime.ManagedRuntime<ObservationReader, never>;

const unavailable = () =>
  new ORPCError("UPSTREAM_UNAVAILABLE", { status: 503, message: "Observation unavailable" });

/** Preserve defects and finalizer failures instead of selecting a convenient first error. */
const runObservation = async <A>(
  runtime: ViewerRuntime,
  effect: Effect.Effect<A, ObservationUnavailable | ObservationTimeout, ObservationReader>,
  signal?: AbortSignal
): Promise<A> => {
  const exit = await runtime.runPromiseExit(effect, signal === undefined ? undefined : { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new ORPCError("OBSERVATION_CANCELLED", { status: 499, message: "Observation cancelled" });
  }
  const reasons = exit.cause.reasons;
  if (
    reasons.length > 0 &&
    reasons.every(
      (reason) => Cause.isFailReason(reason) && reason.error instanceof ObservationTimeout
    )
  ) {
    throw new ORPCError("OBSERVATION_TIMEOUT", { status: 504, message: "Observation timed out" });
  }
  if (
    reasons.length > 0 &&
    reasons.every(
      (reason) => Cause.isFailReason(reason) && reason.error instanceof ObservationUnavailable
    )
  ) {
    throw unavailable();
  }
  throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Observation failed" });
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
});

export type ViewerRouter = ReturnType<typeof createRouter>;
