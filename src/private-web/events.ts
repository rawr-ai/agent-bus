import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { DirectTool, EventsProgram } from "mcp-openapi";
import {
  MAX_WAKE_OBSERVATION_BYTES,
  sameWakeBinding,
  WakeBinding,
  WakeCoverage,
} from "../wake-observation.ts";
import type { clerkPeerIdentity, PeerActor } from "./identity.ts";
import { type wakePort, wire } from "./peer.ts";
import type { WatchAuthority } from "./watch-authority.ts";

const EVENT = "mail.wake";
const Filter = Schema.Struct({
  address: Schema.String.check(Schema.isStartingWith("chatgpt/"), Schema.isMinLength(9)),
});
const SubscriptionInput = Schema.Struct({
  ...Filter.fields,
  ticket: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)).annotate({
    description:
      "Private watch ticket returned by bus_prepare_watch. Copy it unchanged; never publish or log it. It authorizes this watch only, never inbox reads or other tools.",
  }),
});
const decodeFilter = Schema.decodeUnknownSync(Filter, { onExcessProperty: "error" });
const decodeInput = Schema.decodeUnknownSync(SubscriptionInput, { onExcessProperty: "error" });
const decodeBinding = Schema.decodeUnknownSync(WakeBinding, { onExcessProperty: "error" });
const decodeCoverage = Schema.decodeUnknownSync(WakeCoverage, { onExcessProperty: "error" });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bindingKey = (binding: WakeBinding) => [
  binding.address,
  binding.session,
  binding.runtime,
  binding.installation,
  binding.incarnation,
  binding.run,
];

type AuthorizationOutcome =
  | ["account", "allowed" | "refused"]
  | [
      "subscription",
      (
        | "input_refused"
        | "context_refused"
        | "account_mismatch"
        | "watch_authority_refused"
        | "correlation_mismatch"
        | "native_observation_failed"
        | "scope_returned"
        | "cancelled"
      ),
    ]
  | [
      "delivery",
      "scope_refused" | "grant_refused" | "native_binding_failed" | "allowed" | "cancelled",
    ];
export type AuthorizationDiagnosticObserver = (...outcome: AuthorizationOutcome) => void;

const diagnosticLimits = { account: 8, subscription: 8, delivery: 32, maxRecords: 52 } as const;
const diagnosticPrefix = "[agent-bus] authorization-diagnostic ";

/** A synchronous writer and per-callback budget keep diagnostics bounded and behavior-inert. */
export const authorizationDiagnostics = (
  enabled: boolean | undefined,
  writer: (line: string) => void = (line) => console.error(line)
): AuthorizationDiagnosticObserver | undefined => {
  if (enabled !== true) return undefined;
  const counts = { account: 0, subscription: 0, delivery: 0 };
  const write = (record: Record<string, string | number>) => {
    try {
      const line =
        diagnosticPrefix + JSON.stringify({ ...record, timestamp: new Date().toISOString() });
      if (Buffer.byteLength(line, "utf8") <= 256) writer(line);
    } catch {
      // Diagnostics must not influence authorization, including when the writer fails.
    }
  };
  write({ type: "enabled", maxRecords: diagnosticLimits.maxRecords });
  return (callback, outcome) => {
    const count = counts[callback]++;
    if (count < diagnosticLimits[callback]) write({ type: "authorization", callback, outcome });
    else if (count === diagnosticLimits[callback]) write({ type: "exhausted", callback });
  };
};

/** Only a normal owning tool invocation can mint or replace explicit watch authority. */
export const prepareWatchTool = (options: {
  readonly identity: ReturnType<typeof clerkPeerIdentity>;
  readonly wake: ReturnType<typeof wakePort>;
  readonly authority: Pick<WatchAuthority, "prepare">;
}): DirectTool<PeerActor> => ({
  name: "bus_prepare_watch",
  description:
    "Prepare mail.wake for an address this conversation already owns. Uses normal conversation metadata and a fresh nonconsuming ownership observation. Returns private Events arguments containing a stable ticket for this exact holding; use them unchanged for subscription and refresh. Never send the ticket in Bus messages or use it as tool identity. It cannot read, publish, join or take over. An accepted subscription and actual idle wake are separate outcomes.",
  annotations: {
    openWorldHint: false,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  timeoutMs: 10_000,
  parameters: wire(Filter, []),
  outputSchema: wire(
    Schema.Struct({ event: Schema.Literal(EVENT), arguments: SubscriptionInput }),
    []
  ),
  execute: async (input, invocation) => {
    try {
      const { address } = decodeFilter(input);
      const actor = await options.identity.resolveAuthorized(invocation);
      if (invocation.signal.aborted || actor.session === undefined)
        throw new Error("Watch preparation refused.");
      const session = actor.session;
      const { ticket } = await options.authority.prepare(
        { address, principal: actor.principal, session },
        async (signal) =>
          (
            await options.wake.observe(
              { address, session, maxResultBytes: MAX_WAKE_OBSERVATION_BYTES },
              signal
            )
          ).binding,
        invocation.signal
      );
      const result = { event: EVENT, arguments: { address, ticket } };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch {
      return {
        isError: true,
        content: [
          { type: "text", text: "Watch preparation refused; no watching authority was returned." },
        ],
      };
    }
  },
});

/** The host owns leases, pending notices and delivery; this adapter owns Bus authority and evidence. */
export const eventsProgram = (options: {
  readonly identity: ReturnType<typeof clerkPeerIdentity>;
  readonly wake: ReturnType<typeof wakePort>;
  readonly resource: string;
  readonly authority: Pick<WatchAuthority, "resolve">;
  readonly diagnostics?: AuthorizationDiagnosticObserver | undefined;
  readonly storage: {
    readonly path: string;
    readonly maxBytes: number;
    readonly encryptionKey: string;
  };
}): EventsProgram => {
  const record: AuthorizationDiagnosticObserver = (...outcome) => {
    try {
      options.diagnostics?.(...outcome);
    } catch {
      // A supplied observer is also best-effort and cannot change a decision.
    }
  };
  return {
    namespace: "agent-bus-mail-wake-v1",
    storage: options.storage,
    limits: { maxCheckpointBytes: MAX_WAKE_OBSERVATION_BYTES },
    resolvePrincipal:
      options.diagnostics === undefined
        ? options.identity.resolveAccount
        : async (invocation) => {
            try {
              const account = await options.identity.resolveAccount(invocation);
              record("account", "allowed");
              return account;
            } catch (error) {
              record("account", "refused");
              throw error;
            }
          },
    canDiscover: (account, event, signal) =>
      event === EVENT && options.identity.checkAccountGrant(account.principal, signal),
    authorizeSubscription: async ({ account, event, arguments: input, invocation, signal }) => {
      let failure:
        | "input_refused"
        | "context_refused"
        | "watch_authority_refused"
        | "native_observation_failed" = "input_refused";
      try {
        if (signal.aborted || invocation.signal.aborted) {
          record("subscription", "cancelled");
          return undefined;
        }
        if (event !== EVENT) {
          record("subscription", "input_refused");
          return undefined;
        }
        const { address, ticket } = decodeInput(input);
        failure = "context_refused";
        const actor = await options.identity.resolveAuthorized(invocation);
        if (signal.aborted) {
          record("subscription", "cancelled");
          return undefined;
        }
        if (actor.principal !== account.principal) {
          record("subscription", "account_mismatch");
          return undefined;
        }
        failure = "watch_authority_refused";
        const binding = await options.authority.resolve(
          { address, ticket, principal: actor.principal },
          signal
        );
        if (actor.session !== undefined && actor.session !== binding.session) {
          record("subscription", "correlation_mismatch");
          return undefined;
        }
        failure = "native_observation_failed";
        const observed = await options.wake.observe(
          {
            address,
            session: binding.session,
            expectedBinding: binding,
            maxResultBytes: MAX_WAKE_OBSERVATION_BYTES,
          },
          signal
        );
        if (signal.aborted) {
          record("subscription", "cancelled");
          return undefined;
        }
        const scope = {
          principal: actor.principal,
          resource: options.resource,
          binding: observed.binding,
        };
        record("subscription", "scope_returned");
        return scope;
      } catch {
        if (options.diagnostics !== undefined) {
          try {
            if (signal.aborted || invocation.signal.aborted) {
              record("subscription", "cancelled");
              return undefined;
            }
          } catch {
            // Classification itself is best-effort.
          }
          record("subscription", failure);
        }
        return undefined;
      }
    },
    authorizeDelivery: async (scope, context) => {
      let failure: "scope_refused" | "grant_refused" | "native_binding_failed" = "scope_refused";
      try {
        if (context.signal.aborted) {
          record("delivery", "cancelled");
          return { allowed: false };
        }
        if (context.event !== EVENT || scope.resource !== options.resource) {
          record("delivery", "scope_refused");
          return { allowed: false };
        }
        const { address } = decodeInput(context.arguments);
        const binding = decodeBinding(scope.binding);
        if (binding.address !== address || binding.runtime !== "other") {
          record("delivery", "scope_refused");
          return { allowed: false };
        }
        failure = "grant_refused";
        if (!(await options.identity.checkAccountGrant(scope.principal, context.signal))) {
          if (options.diagnostics !== undefined && context.signal.aborted)
            record("delivery", "cancelled");
          else record("delivery", "grant_refused");
          return { allowed: false };
        }
        failure = "native_binding_failed";
        await options.wake.check(
          { address, session: binding.session, expectedBinding: binding },
          context.signal
        );
        const allowed = !context.signal.aborted;
        record("delivery", allowed ? "allowed" : "cancelled");
        return { allowed };
      } catch {
        if (options.diagnostics !== undefined) {
          try {
            if (context.signal.aborted) {
              record("delivery", "cancelled");
              return { allowed: false };
            }
          } catch {
            // Classification itself is best-effort.
          }
          record("delivery", failure);
        }
        return { allowed: false };
      }
    },
    definitions: [
      {
        name: EVENT,
        description: "A wake notice for unread eligible mail at the held address.",
        inputSchema: wire(SubscriptionInput, []),
        payloadSchema: wire(Filter, []),
        source: {
          replay: "none",
          sample: async ({
            principal,
            filter,
            checkpoint,
            revision,
            generation,
            waitMs,
            signal,
          }) => {
            const { address } = decodeInput(filter);
            const binding = decodeBinding(principal.binding);
            if (
              signal.aborted ||
              principal.resource !== options.resource ||
              binding.address !== address ||
              binding.runtime !== "other" ||
              !Number.isFinite(waitMs) ||
              waitMs < 0 ||
              !(await options.identity.checkAccountGrant(principal.principal, signal))
            )
              throw new Error("Wake observation denied.");
            const previous = checkpoint === undefined ? undefined : decodeCoverage(checkpoint);
            if (
              previous !== undefined &&
              (!sameWakeBinding(previous.binding, binding) ||
                new Set(previous.rung).size !== previous.rung.length ||
                !Number.isSafeInteger(previous.cursor) ||
                Buffer.byteLength(JSON.stringify(previous), "utf8") > MAX_WAKE_OBSERVATION_BYTES)
            )
              throw new Error("Invalid wake checkpoint.");
            const observed = await options.wake.observe(
              {
                address,
                session: binding.session,
                expectedBinding: binding,
                ...(previous === undefined ? {} : { previousCoverage: previous }),
                maxResultBytes: MAX_WAKE_OBSERVATION_BYTES,
                timeoutSeconds: Math.min(waitMs / 1000, 50),
              },
              signal
            );
            if (!observed.ready || !observed.news) return { kind: "idle" };
            if (observed.nextCoverage === undefined || observed.latestEligibleAt === undefined)
              throw new Error("Incomplete wake observation.");
            const coverage = observed.nextCoverage;
            return {
              kind: "occurrence",
              occurrence: {
                source: EVENT,
                partition: hash(bindingKey(binding)),
                id: hash([
                  bindingKey(binding),
                  coverage.cursor,
                  [...coverage.rung].sort(),
                  observed.latestEligibleAt,
                ]),
                timestamp: observed.latestEligibleAt,
                data: { address },
              },
              nextCheckpoint: coverage,
              expectedRevision: revision,
              expectedGeneration: generation,
            };
          },
        },
      },
    ],
  };
};
