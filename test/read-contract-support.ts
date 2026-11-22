import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Ledger, type MailboxReceiptRead } from "../src/Ledger.ts";
import type { MailboxState } from "../src/mailbox-model.ts";
import type { QueryGateway } from "../src/Query.ts";

export const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
export const cwd = process.cwd();
export const inbox = "fixture/read-contract";
export const sender = "fixture/read-contract-sender";
export const owner = "session:read-owner";
export const successor = "session:read-successor";
export const publisher = "session:read-publisher";
export const READ_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface Hold {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  armed: boolean;
}

export const hold = (): Hold =>
  Effect.runSync(
    Effect.gen(function* () {
      return {
        reached: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
        armed: true,
      };
    })
  );

export const reached = (held: Hold) =>
  Effect.runPromise(Deferred.await(held.reached).pipe(Effect.timeout("20 seconds")));
export const release = (held: Hold) => Effect.runPromise(Deferred.succeed(held.release, undefined));

/** Faults and observations injected around the production Ledger, for the fixture inbox only. */
export interface Probe {
  /** Held once, after the read's receipt lookup and before its acknowledgement is written. */
  holdAck?: Hold;
  /** The next acknowledgement answers UNKNOWN: after writing it, or without sending it. */
  uncertainAck?: "committed" | "never-sent";
  /** How many following receipt lookups answer UNAVAILABLE. */
  unavailableLookups?: number;
  /** Rewrites a receipt lookup's answer. */
  forgeReceipt?: (found: MailboxReceiptRead, operation: string) => MailboxReceiptRead;
  /** Drops this message from pinned slices, as damage the raw slice no longer encodes. */
  hiddenId?: string;
  /** Every `from` a pinned slice was read from. */
  readonly reads?: Array<number>;
  /** Resolved at the first receipt lookup of this operation. */
  lookedUp?: { readonly operation: string; readonly seen: Deferred.Deferred<void> };
  /** Held once, at a receipt lookup for the inbox, before it is answered. */
  holdLookup?: Hold;
  /** Held once, after an acknowledgement for the inbox was written and before it is answered. */
  holdAfterAck?: Hold;
}

export type Store = Layer.Layer<Ledger | QueryGateway, unknown, never>;

/** One installation's Bus layer over a shared store, its ledger wrapped by `probe`. */
export const busLayer = (store: Store, root: string, installation: string, probe: Probe = {}) => {
  const observed = Layer.effect(Ledger)(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      return Ledger.of({
        ...ledger,
        appendMailboxAck: (record, basis) =>
          Effect.gen(function* () {
            const held = probe.holdAck;
            if (held?.armed === true && record.address === inbox) {
              held.armed = false;
              yield* Deferred.succeed(held.reached, undefined);
              yield* Deferred.await(held.release);
            }
            const uncertain = record.address === inbox ? probe.uncertainAck : undefined;
            if (uncertain !== undefined) delete probe.uncertainAck;
            if (uncertain === "never-sent") return { status: "UNKNOWN" as const };
            const outcome = yield* ledger.appendMailboxAck(record, basis);
            const after = probe.holdAfterAck;
            if (after?.armed === true && record.address === inbox) {
              after.armed = false;
              yield* Deferred.succeed(after.reached, undefined);
              yield* Deferred.await(after.release);
            }
            return uncertain === "committed" ? { status: "UNKNOWN" as const } : outcome;
          }),
        mailboxReceiptAt: (address, operation, cut) =>
          Effect.gen(function* () {
            const watched = probe.lookedUp;
            if (watched?.operation === operation) yield* Deferred.succeed(watched.seen, undefined);
            const held = probe.holdLookup;
            if (held?.armed === true && address === inbox) {
              held.armed = false;
              yield* Deferred.succeed(held.reached, undefined);
              yield* Deferred.await(held.release);
            }
            if (address === inbox && (probe.unavailableLookups ?? 0) > 0) {
              probe.unavailableLookups = (probe.unavailableLookups ?? 0) - 1;
              return { status: "UNAVAILABLE" as const };
            }
            const found = yield* ledger.mailboxReceiptAt(address, operation, cut);
            return probe.forgeReceipt === undefined ? found : probe.forgeReceipt(found, operation);
          }),
        readAt: (from, cut) =>
          Effect.sync(() => probe.reads?.push(from)).pipe(
            Effect.andThen(ledger.readAt(from, cut)),
            Effect.map((slice) => ({
              ...slice,
              entries: slice.entries.filter((entry) => entry.message.id !== probe.hiddenId),
            }))
          ),
      });
    })
  ).pipe(Layer.provideMerge(store));
  return Bus.layer(installation).pipe(
    Layer.provideMerge(observed),
    Layer.provideMerge(Cursors.layerFiles(join(root, installation))),
    Layer.provide(platform)
  );
};

/** One installation's Bus over a shared store, its ledger wrapped by `probe`. */
export const machine = (store: Store, root: string, installation: string, probe: Probe = {}) =>
  ManagedRuntime.make(busLayer(store, root, installation, probe));
export type Machine = ReturnType<typeof machine>;

export const bus = <A, E>(
  runtime: Machine,
  f: (service: Bus.Bus["Service"]) => Effect.Effect<A, E>
) => runtime.runPromise(Effect.flatMap(Bus.Bus, f));

export const read = (runtime: Machine, input: Partial<Bus.ReadInput> = {}) =>
  bus(runtime, (service) => service.read({ address: inbox, session: owner, ...input }));
export const wait = (runtime: Machine, input: Partial<Bus.WaitInput> = {}) =>
  bus(runtime, (service) => service.wait({ address: inbox, session: owner, ...input }));
export const ack = (runtime: Machine, receipt: Bus.AckInput["receipt"], session = owner) =>
  bus(runtime, (service) => service.ack({ address: inbox, session, receipt }));
export const joinInbox = (runtime: Machine, input: Partial<Bus.JoinInput> = {}) =>
  bus(runtime, (service) =>
    service.join({ address: inbox, runtime: "other", session: owner, cwd, ...input })
  );
export const leaveInbox = (runtime: Machine, session = owner) =>
  bus(runtime, (service) => service.leave(inbox, session));
export const joinSender = (runtime: Machine) =>
  bus(runtime, (service) =>
    service.join({ address: sender, runtime: "other", session: publisher, cwd })
  );
export const send = (runtime: Machine, to: string, body: string) =>
  bus(runtime, (service) =>
    service.publish({ from: sender, session: publisher, to: [to], body })
  ).then(({ message }) => message);
export const holdingOf = async (runtime: Machine) => {
  const found = (await bus(runtime, (service) => service.peers)).find(
    (peer) => peer.address === inbox
  );
  if (found === undefined) throw new Error("The fixture holding was not observed.");
  return found;
};

export const head = (runtime: Machine) =>
  runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.end));
export const cut = (runtime: Machine) =>
  runtime.runPromise(
    Effect.flatMap(Ledger, (ledger) => Effect.map(ledger.presenceAt(), ({ cut }) => cut))
  );
export const mailbox = (runtime: Machine, address = inbox): Promise<MailboxState> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      return yield* ledger.mailboxAt(address, (yield* ledger.presenceAt()).cut);
    })
  );
export const position = async (runtime: Machine) => {
  const state = await mailbox(runtime);
  if (state.status !== "FOUND") throw new Error("The fixture mailbox has no position.");
  return state.position;
};
export const receiptOf = (runtime: Machine, operation: string, address = inbox) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      return yield* ledger.mailboxReceiptAt(address, operation, (yield* ledger.presenceAt()).cut);
    })
  );
/** Every acknowledgement recorded for the inbox. */
export const acks = async (runtime: Machine) => {
  const state = await mailbox(runtime);
  return state.status === "ABSENT"
    ? []
    : state.records.flatMap(({ record }) => (record.kind === "ack" ? [record] : []));
};
/** A receipt as its replay returns it. */
export const replayedReceipt = <R extends { readonly replayed: boolean }>(
  receipt: R | undefined
) => (receipt === undefined ? undefined : { ...receipt, replayed: true });
export const ids = (outcome: { readonly messages: ReadonlyArray<{ readonly id: string }> }) =>
  outcome.messages.map(({ id }) => id);
export const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("The call was expected to be refused.");
    },
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
