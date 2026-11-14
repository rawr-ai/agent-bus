import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { EventsProgram } from "mcp-openapi";
import {
  MAX_WAKE_OBSERVATION_BYTES,
  sameWakeBinding,
  WakeBinding,
  WakeCoverage,
} from "../wake-observation.ts";
import type { clerkPeerIdentity } from "./identity.ts";
import { type wakePort, wire } from "./peer.ts";

const EVENT = "mail.wake";
const Filter = Schema.Struct({
  address: Schema.String.check(Schema.isStartingWith("chatgpt/"), Schema.isMinLength(9)),
});
const decodeFilter = Schema.decodeUnknownSync(Filter, { onExcessProperty: "error" });
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

/** The host owns leases, pending notices and delivery; this adapter owns Bus authority and evidence. */
export const eventsProgram = (options: {
  readonly identity: ReturnType<typeof clerkPeerIdentity>;
  readonly wake: ReturnType<typeof wakePort>;
  readonly resource: string;
  readonly storage: {
    readonly path: string;
    readonly maxBytes: number;
    readonly encryptionKey: string;
  };
}): EventsProgram => ({
  namespace: "agent-bus-mail-wake-v1",
  storage: options.storage,
  limits: { maxCheckpointBytes: MAX_WAKE_OBSERVATION_BYTES },
  resolvePrincipal: options.identity.resolveAccount,
  canDiscover: (account, event, signal) =>
    event === EVENT && options.identity.checkAccountGrant(account.principal, signal),
  authorizeSubscription: async ({ account, event, arguments: input, invocation, signal }) => {
    try {
      if (signal.aborted || invocation.signal.aborted || event !== EVENT) return undefined;
      const { address } = decodeFilter(input);
      const actor = await options.identity.resolveAuthorized(invocation);
      if (signal.aborted || actor.principal !== account.principal || actor.session === undefined)
        return undefined;
      const observed = await options.wake.observe(
        { address, session: actor.session, maxResultBytes: MAX_WAKE_OBSERVATION_BYTES },
        signal
      );
      if (signal.aborted) return undefined;
      return { principal: actor.principal, resource: options.resource, binding: observed.binding };
    } catch {
      return undefined;
    }
  },
  authorizeDelivery: async (scope, context) => {
    try {
      if (context.signal.aborted || context.event !== EVENT || scope.resource !== options.resource)
        return { allowed: false };
      const { address } = decodeFilter(context.arguments);
      const binding = decodeBinding(scope.binding);
      if (
        binding.address !== address ||
        binding.runtime !== "other" ||
        !(await options.identity.checkAccountGrant(scope.principal, context.signal))
      )
        return { allowed: false };
      await options.wake.check(
        { address, session: binding.session, expectedBinding: binding },
        context.signal
      );
      return { allowed: !context.signal.aborted };
    } catch {
      return { allowed: false };
    }
  },
  definitions: [
    {
      name: EVENT,
      description: "A wake notice for unread eligible mail at the held address.",
      inputSchema: wire(Filter, []),
      payloadSchema: wire(Filter, []),
      source: {
        replay: "none",
        sample: async ({ principal, filter, checkpoint, revision, generation, waitMs, signal }) => {
          const { address } = decodeFilter(filter);
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
});
