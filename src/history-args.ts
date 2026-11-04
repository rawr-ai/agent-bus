import { Schema } from "effect";

/**
 * The saved-query argument primitives and the `history` arguments, with their pure checks and
 * normalisation. The catalogue and the viewer both import this module, so they cannot disagree
 * about what a valid `history` argument is. It depends on nothing but Effect Schema.
 */

const Int = Schema.Int;
const Text = Schema.String;

export const Limit = (fallback: number, maximum: number) =>
  Schema.optionalKey(
    Int.check(Schema.isBetween({ minimum: 1, maximum })).annotate({
      description: `Page size, 1 to ${maximum}; defaults to ${fallback}.`,
    })
  );
export const Token = Text.check(Schema.isMinLength(1)).check(Schema.isMaxLength(512));
export const Tokens = (description: string, maximum = 50) =>
  Schema.Array(Token)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(maximum))
    .annotate({ description });
const Instant = Text.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/)
).annotate({ description: "A UTC instant, e.g. 2026-11-01T09:00:00Z." });
export const Participants = Schema.optionalKey(
  Tokens(
    "1 to 50 literal tokens (addresses, #topic, *); an entry matches when its sender or any recorded recipient equals one."
  )
);
export const Window = {
  fromTs: Schema.optionalKey(
    Instant.annotate({ description: "Only entries with ts at or after this." })
  ),
  toTs: Schema.optionalKey(Instant.annotate({ description: "Only entries with ts before this." })),
};

export const HistoryArgs = Schema.Struct({
  participants: Participants,
  ...Window,
  kinds: Schema.optionalKey(
    Schema.Array(Schema.Literals(["message", "presence"]))
      .check(Schema.isMinLength(1))
      .annotate({ description: 'Entry kinds; defaults to ["message"].' })
  ),
  direction: Schema.optionalKey(
    Schema.Literals(["forward", "backward"]).annotate({
      description: "forward from the oldest entry, backward from the newest; defaults to forward.",
    })
  ),
  limit: Limit(50, 200),
});
export type HistoryArgs = typeof HistoryArgs.Type;

/** The problem with a list that must not repeat a value, if any. */
export const duplicatesProblem = (name: string, values: ReadonlyArray<string> | undefined) =>
  values === undefined || new Set(values).size === values.length
    ? undefined
    : `${name} has duplicates.`;

/** An Instant padded to nanoseconds, so equal instants compare equal whatever their spelling. */
const instantKey = (value: string) => {
  const [seconds, fraction = ""] = value.slice(0, -1).split(".");
  return `${seconds}.${fraction.padEnd(9, "0")}`;
};
/** A real calendar instant: Date.parse rolls T24:00 and February 30 into the next day. */
const realInstant = (value: string) => {
  const millis = Date.parse(value);
  return (
    Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19)
  );
};

/** The problem with a `fromTs`/`toTs` window, if any. */
export const windowProblem = (window: {
  fromTs?: string | undefined;
  toTs?: string | undefined;
}) => {
  for (const value of [window.fromTs, window.toTs]) {
    if (value !== undefined && !realInstant(value)) return `${value} is not a valid instant.`;
  }
  return window.fromTs !== undefined &&
    window.toTs !== undefined &&
    instantKey(window.fromTs) >= instantKey(window.toTs)
    ? "fromTs must be before toTs."
    : undefined;
};

const sorted = <A extends string>(values: ReadonlyArray<A>) => [...values].sort();

/**
 * Decoded `history` arguments in the form the bus runs and echoes: participants and kinds
 * sorted, defaults filled. The problem, when the arguments are refused.
 */
export const normalizeHistoryArgs = (
  args: HistoryArgs
): { readonly args: HistoryArgs } | { readonly problem: string } => {
  const problem =
    duplicatesProblem("participants", args.participants) ??
    duplicatesProblem("kinds", args.kinds) ??
    windowProblem(args);
  if (problem !== undefined) return { problem };
  return {
    args: {
      ...(args.participants === undefined ? {} : { participants: sorted(args.participants) }),
      ...(args.fromTs === undefined ? {} : { fromTs: args.fromTs }),
      ...(args.toTs === undefined ? {} : { toTs: args.toTs }),
      kinds: sorted(args.kinds ?? ["message"]),
      direction: args.direction ?? "forward",
      limit: args.limit ?? 50,
    },
  };
};
