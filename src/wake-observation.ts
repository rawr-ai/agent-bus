import { Schema } from "effect";
import { Runtime } from "./domain.ts";
import { MAX_WAIT_SECONDS } from "./timing.ts";

/** Bounds complete input arguments and the duplicated MCP result carrier, never a prefix. */
export const MAX_WAKE_OBSERVATION_BYTES = 65_536;
export const MAX_WAKE_COVERAGE_IDS = 1024;

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Identity = Schema.String.check(Schema.isMinLength(1));

/** Native holding identity; unrelated to any external subscription principal. */
export const WakeBinding = Schema.Struct({
  address: Identity.annotate({ description: "The exact currently held address." }),
  session: Identity.annotate({
    description: "Its current native owner session, never an external account principal.",
  }),
  runtime: Runtime.annotate({ description: "The runtime recorded by this holding." }),
  installation: Identity.annotate({ description: "The local installation recorded by its join." }),
  incarnation: Identity.annotate({
    description:
      "The ledger history this binding belongs to; never reinterpret positions across histories.",
  }),
  run: Identity.annotate({
    description:
      "The first join id of this run, preserved only by ordinary same-runtime owner renewal.",
  }),
});
export type WakeBinding = typeof WakeBinding.Type;

/** Caller-retained evidence of captured wakes, scoped to exactly one native holding. */
export const WakeCoverage = Schema.Struct({
  binding: WakeBinding.annotate({ description: "The exact native holding this evidence covers." }),
  cursor: Position.annotate({
    description: "The mailbox read position when this evidence was captured, not an Events cursor.",
  }),
  rung: Schema.Array(Identity).check(Schema.isMaxLength(MAX_WAKE_COVERAGE_IDS)).annotate({
    description: "Every captured eligible message id still unread, unique, with no truncation.",
  }),
});
export type WakeCoverage = typeof WakeCoverage.Type;

export const CheckWakeBindingRequest = Schema.Struct({
  address: Identity.annotate({
    description: "The exact address whose captured holding is being checked.",
  }),
  session: Schema.optionalKey(
    Schema.String.annotate({
      description: "Its native owner session; missing, blank or placeholder values refuse.",
    })
  ),
  expectedBinding: WakeBinding.annotate({
    description:
      "The complete captured holding to validate, never permission to adopt a successor.",
  }),
});
export type CheckWakeBindingRequest = typeof CheckWakeBindingRequest.Type;

export const ObserveWakeRequest = Schema.Struct({
  address: Identity.annotate({
    description:
      "The exact address to observe, owned by session and joined from this installation.",
  }),
  session: Schema.optionalKey(
    Schema.String.annotate({
      description: "The native owner session; missing, blank or placeholder values refuse.",
    })
  ),
  expectedBinding: Schema.optionalKey(
    WakeBinding.annotate({
      description: "Refuse rather than silently rebind when any native holding identity changed.",
    })
  ),
  previousCoverage: Schema.optionalKey(
    WakeCoverage.annotate({
      description:
        "Previously captured complete caller-retained coverage; not advanced by this call.",
    })
  ),
  maxResultBytes: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 128, maximum: MAX_WAKE_OBSERVATION_BYTES })
    ).annotate({
      description:
        "Optional smaller complete UTF-8 MCP result-carrier budget, including text and structured channels, excluding JSON-RPC framing. Overflow refuses; never truncates coverage.",
    })
  ),
  timeoutSeconds: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_SECONDS })).annotate({
      description: `Bounded wait for eligible news, 0 to ${MAX_WAIT_SECONDS} seconds; default 0. Expiry performs a fresh observation because ordinary reads emit no ledger change.`,
    })
  ),
});
export type ObserveWakeRequest = typeof ObserveWakeRequest.Type;

export const WakeBindingCheck = Schema.Struct({
  binding: WakeBinding.annotate({
    description: "The validated native holding at this cut.",
  }),
  observationCut: Schema.Struct({
    head: Position.annotate({ description: "The head of the complete presence observation." }),
    incarnation: Identity.annotate({ description: "The ledger history observed." }),
  }).annotate({
    description:
      "The complete presence cut establishing this holding; not a lease or lasting delivery authority.",
  }),
});
export type WakeBindingCheck = typeof WakeBindingCheck.Type;

export const WakeObservation = Schema.Struct({
  ...WakeBindingCheck.fields,
  observationCut: WakeBindingCheck.fields.observationCut.annotate({
    description:
      "One cut for routing, unread messages and wake eligibility; not lasting delivery authority.",
  }),
  ready: Schema.Boolean.annotate({ description: "Eligible unread mail existed at this cut." }),
  news: Schema.Boolean.annotate({
    description:
      "Eligible mail or the read position differs from the supplied coverage. Capture only when ready and news are both true.",
  }),
  latestEligibleAt: Schema.optionalKey(Schema.String).annotate({
    description:
      "Latest eligible message timestamp at this cut, normalized to UTC; absent when not ready.",
  }),
  nextCoverage: Schema.optionalKey(WakeCoverage).annotate({
    description:
      "Complete proposed coverage, not committed by this call. Empty or suppressed observations preserve previousCoverage, including its absence.",
  }),
});
export type WakeObservation = typeof WakeObservation.Type;

export const sameWakeBinding = (a: WakeBinding, b: WakeBinding) =>
  a.address === b.address &&
  a.session === b.session &&
  a.runtime === b.runtime &&
  a.installation === b.installation &&
  a.incarnation === b.incarnation &&
  a.run === b.run;

/** Includes escaping and both structured and compatibility text channels; not JSON-RPC framing. */
export const wakeObservationCarrierBytes = (
  structuredContent: WakeObservation | WakeBindingCheck
) =>
  Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    }),
    "utf8"
  );
