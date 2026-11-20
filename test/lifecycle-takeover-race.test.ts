// Guarded presence writes and ordinary sends across serves. A join, leave or send bases its
// decision on a cut T and writes only if no presence for the acting address was written after T.
// These cases stage interleavings between two serves on one Fluree ledger (messaging rules 2, 4
// and 8) and verify delivery through a third serve for races that involve sends.
//
// The seam is deterministic: serve A writes through a relay that, on A's next selected write,
// first runs an action to completion (usually serve B's competing call, made directly on the
// ledger), or answers with a fault. Mailbox positions are read through serve B's direct handle at
// a fresh pin, and other ledger contents with literal queries independent of the bus's reads.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import { Message, MessageJson, Origin, Presence } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { Ledger, messageIri } from "../src/Ledger.ts";
import type { MailboxState } from "../src/mailbox-model.ts";
import { historyPreset } from "../src/mcp.ts";
import { MAX_INDEXED_FIELD_BYTES } from "../src/message-carrier.ts";
import { QueryGateway } from "../src/Query.ts";
import { startFileFlureeServer } from "./fluree-file-server.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const address = "claude/held";
const holder = "session:holder";
const successor = "session:successor";
const recipient = "claude/receiver";
const reader = "session:reader";
const cwd = process.cwd();
const encodeJson = Schema.encodeSync(MessageJson);
const TIMEOUT = 60_000;

type Config = Awaited<ReturnType<typeof freshLedger>>;
interface Failure {
  readonly _tag?: string;
  readonly code?: string;
  readonly message?: string;
}
type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: Failure };

/** One serve: its own runtime, on `url` (direct, or the relay). */
const machine = async (config: Config, url: string) => {
  const root = mkdtempSync(join(tmpdir(), "agent-bus-lifecycle-"));
  const runtime = ManagedRuntime.make(
    Bus.layer("test-installation").pipe(
      Layer.provideMerge(layerFluree({ ...config, url }).pipe(Layer.provide(platform))),
      Layer.provide(platform)
    )
  );
  const dispose = () =>
    runtime.dispose().finally(() => rmSync(root, { recursive: true, force: true }));
  try {
    await runtime.runPromise(Effect.void);
  } catch (error) {
    await dispose();
    throw error;
  }
  const outcome = <A, E>(effect: Effect.Effect<A, E, Bus.Bus | Ledger>): Promise<Outcome<A>> =>
    runtime.runPromise(
      Effect.match(effect, {
        onFailure: (error): Outcome<A> => ({ ok: false, error: error as Failure }),
        onSuccess: (value): Outcome<A> => ({ ok: true, value }),
      })
    );
  return {
    dispose,
    join: (session: string, extra: Partial<Bus.JoinInput> = {}) =>
      outcome(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({ address, runtime: "claude", session, cwd, ...extra })
        )
      ),
    leave: (session: string) =>
      outcome(Effect.flatMap(Bus.Bus, (bus) => bus.leave(address, session))),
    publish: (session: string, body: string, extra: Partial<Bus.PublishInput> = {}) =>
      outcome(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.publish({ from: address, session, to: [recipient], body, ...extra })
        )
      ),
    historyIds: (query: string) =>
      runtime.runPromise(
        historyPreset({ query }).pipe(Effect.map(({ messages }) => messages.map(({ id }) => id)))
      ),
    takeMessageIds: (inbox = recipient) =>
      runtime.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus
            .take(inbox, reader)
            .pipe(
              Effect.map((entries) =>
                entries.filter((entry) => entry.kind === "message").map((entry) => entry.id)
              )
            )
        )
      ),
    /** The address's current joined peer, as this serve reads it. */
    peer: (name = address) =>
      runtime.runPromise(
        Effect.map(
          Effect.flatMap(Bus.Bus, (bus) => bus.peers),
          (peers) => peers.find((peer) => peer.address === name)
        )
      ),
    head: () => runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.end)),
    /** The ledger's point read of one entry, as a retried send reads it. */
    entry: (id: string) =>
      runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.readEntry(id))),
    append: (message: Message) =>
      runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.append(message))),
    admit: (message: Message) =>
      outcome(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          return yield* ledger.admit(message, (yield* ledger.presenceAt()).cut);
        })
      ),
    /**
     * The address's mailbox at a fresh pin of the head. Pinned through the query gateway, since
     * past presence damage the presence read itself fails.
     */
    mailbox: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const pin = yield* Effect.flatMap(QueryGateway, (gateway) => gateway.pin);
          return yield* Effect.flatMap(Ledger, (ledger) => ledger.mailboxAt(address, pin));
        })
      ),
  };
};
type Machine = Awaited<ReturnType<typeof machine>>;

type Fault = "forwarded" | "unforwarded" | "unsettled";
interface Plan {
  readonly before?: () => Promise<void>;
  readonly fault?: Fault;
}

const writeNode = Schema.decodeUnknownOption(
  Schema.Struct({
    "@type": Schema.Literals(["bus:Presence", "bus:Message"]),
    "bus:id": Schema.Union([Schema.String, Schema.Struct({ "@value": Schema.String })]),
  })
);

/**
 * Runs `before` on the next write of the armed kind before forwarding it. A fault can lose
 * the response after forwarding, with or without blocking the subsequent settlement read.
 * The relay recognizes the inserted node, not the update's condition.
 */
const writeRelay = (upstream: string) => {
  let nextPresence: Plan | undefined;
  let nextMessage: Plan | undefined;
  let settleUnavailable = false;
  let writes = 0;
  const attempts: Array<string | undefined> = [];
  /** Per presence attempt: whether its mailbox start travelled in the same request. */
  const starts: Array<boolean> = [];
  const messageAttempts: Array<string | undefined> = [];
  /** Every armed plan that actually ran, in order. */
  const fired: Array<{ readonly kind: "presence" | "message"; readonly plan: Plan }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.delete("host");
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const forward = () =>
        fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        });
      if (settleUnavailable && url.pathname.startsWith("/v1/fluree/show/")) {
        return new Response(null, { status: 503 });
      }
      if (
        body === undefined ||
        !["/v1/fluree/insert", "/v1/fluree/update"].includes(url.pathname)
      ) {
        return forward();
      }
      writes++;
      const payload: unknown = JSON.parse(new TextDecoder().decode(body));
      const inserted =
        url.pathname.endsWith("/update") &&
        typeof payload === "object" &&
        payload !== null &&
        "insert" in payload
          ? payload.insert
          : payload;
      // One logical write: a single entry node, or the unique entry node of an atomic insert
      // array beside its mailbox nodes. Receipt and mailbox nodes are never entries.
      const nodes = Array.isArray(inserted) ? inserted : [inserted];
      const entries = nodes.flatMap((item) => {
        const decoded = writeNode(item);
        return Option.isSome(decoded) ? [decoded.value] : [];
      });
      const node = entries.length === 1 ? entries[0] : undefined;
      if (node === undefined) return forward();
      const presence = node["@type"] === "bus:Presence";
      const id = node["bus:id"];
      (presence ? attempts : messageAttempts).push(typeof id === "string" ? id : id["@value"]);
      if (presence)
        starts.push(
          nodes.some(
            (item) => typeof item === "object" && item !== null && "bus:mailboxStart" in item
          )
        );
      const plan = presence ? nextPresence : nextMessage;
      if (presence) nextPresence = undefined;
      else nextMessage = undefined;
      if (plan !== undefined) fired.push({ kind: presence ? "presence" : "message", plan });
      if (plan?.before !== undefined) await plan.before();
      if (plan?.fault === "unforwarded") return new Response(null, { status: 503 });
      const response = await forward();
      if (plan?.fault === "forwarded" || plan?.fault === "unsettled") {
        await response.arrayBuffer();
        settleUnavailable = plan.fault === "unsettled";
        return new Response(null, { status: 504 });
      }
      return response;
    },
  });
  return {
    url: server.url.origin,
    arm: (plan: Plan) => {
      nextPresence = plan;
    },
    armMessage: (plan: Plan) => {
      nextMessage = plan;
    },
    /** Ends an `unsettled` fault, so a later call can read the ledger again. */
    settle: () => {
      settleUnavailable = false;
    },
    attempts,
    starts,
    messageAttempts,
    fired,
    writeCount: () => writes,
    stop: () => server.stop(true),
  };
};
type Relay = ReturnType<typeof writeRelay>;

/** Literal queries on the ledger, independent of the bus's own reads. */
const literal = async (config: Config, body: Record<string, unknown>) => {
  const response = await fetch(`${config.url}/v1/fluree/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      from: config.ledger,
      ...body,
    }),
  });
  if (!response.ok) throw new Error(`independent query failed: HTTP ${response.status}`);
  return (await response.json()) as Array<unknown>;
};
/** Every presence node at head, sorted. */
const presenceNodes = async (config: Config) =>
  (
    (await literal(config, {
      select: "?m",
      where: { "@id": "?m", "@type": "bus:Presence" },
    })) as Array<string>
  ).sort();
/** The stored encodings of entry `id` at head: empty when it was never written. */
const stored = (config: Config, id: string | undefined, t?: number) => {
  if (id === undefined) throw new Error("the relay saw no entry id in the write");
  return literal(config, {
    ...(t === undefined ? {} : { from: `${config.ledger}@t:${t}` }),
    select: "?json",
    where: { "@id": `urn:agent-bus:message:${id}`, "bus:json": "?json" },
  });
};

interface Stage {
  readonly config: Config;
  readonly relay: Relay;
  readonly a: Machine;
  readonly b: Machine;
}

/** Serve A through the relay, serve B direct, on one fresh ledger. */
const staged = async (name: string, run: (stage: Stage) => Promise<void>, config?: Config) => {
  config ??= await freshLedger(name);
  const relay = writeRelay(config.url);
  let a: Machine | undefined;
  let b: Machine | undefined;
  try {
    a = await machine(config, relay.url);
    b = await machine(config, config.url);
    await run({ config, relay, a, b });
  } finally {
    try {
      await Promise.all([a?.dispose(), b?.dispose()]);
    } finally {
      relay.stop();
    }
  }
};

/**
 * Runs `call` as the relay's action on A's next presence write. Its result is kept so each
 * test checks the interleaving was actually staged.
 */
const during = <A>(relay: Relay, call: () => Promise<A>) => {
  const box: { value?: A } = {};
  relay.arm({
    before: async () => {
      box.value = await call();
    },
  });
  return box;
};

const presenceEntry = (from: string, session: string) =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from,
    to: ["*"],
    kind: "presence",
    body: `${from} joined`,
    origin: new Origin({ host: "fixture", cwd: "/work" }),
    presence: new Presence({ runtime: "claude", status: "joined", topics: [], session }),
  });

const expectRefused = (outcome: Outcome<unknown>, tag: string, text: string): void => {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.error._tag).toBe(tag);
  expect(outcome.error.message).toContain(text);
};

/**
 * A mailbox as tests compare it: its position and the identity of each start that set one. The
 * only place this file reads stored records; change it here when the storage shape changes.
 */
const positionView = (state: MailboxState) => {
  if (state.status === "UNRESOLVED") throw new Error("Fixture position unexpectedly unresolved.");
  if (state.status === "ABSENT") return { status: "ABSENT" as const };
  return {
    status: "FOUND" as const,
    position: state.position,
    starts: state.records.flatMap(({ record, t }) =>
      record.kind === "start" ? [{ operation: record.operation, position: record.position, t }] : []
    ),
  };
};

/**
 * The whole expected state after a competitor won: everything there was before, plus exactly one
 * new start, the winner's join at the head its decision read, which is now the position.
 */
const expectOneNewStart = (
  before: MailboxState,
  after: MailboxState,
  winner: string | undefined,
  readHead: number | undefined
) => {
  const earlier = positionView(before);
  expect<unknown>(positionView(after)).toEqual({
    status: "FOUND",
    position: readHead,
    starts: [
      ...(earlier.status === "FOUND" ? earlier.starts : []),
      { operation: winner, position: readHead, t: expect.any(Number) },
    ],
  });
};

/** A real earlier holding of the address, by another session, that has left. */
const leftHolding = async (b: Machine) => {
  expect((await b.join("session:earlier")).ok).toBe(true);
  expect((await b.leave("session:earlier")).ok).toBe(true);
  const prior = await b.mailbox();
  expect(prior.status).toBe("FOUND");
  return prior;
};

/** An independent commit oracle for a particular attempted message id. */
const commitsOf = (config: Config, id: string | undefined) => {
  if (id === undefined) throw new Error("the relay saw no message write");
  return literal(config, {
    select: "?t",
    where: {
      "@id": `urn:agent-bus:message:${id}`,
      "bus:json": { "@value": "?json", "@t": "?t" },
    },
  });
};

const commitEnvelope = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    t: Schema.Int,
    parents: Schema.optionalKey(Schema.Array(Schema.String)),
    flakes: Schema.Array(Schema.Array(Schema.Unknown)),
  })
);

const entryIdentity = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.String, from: Schema.String, kind: Schema.String })
  )
);

const readCommit = async (config: Config, t: number) => {
  const response = await fetch(
    `${config.url}/v1/fluree/show/${encodeURIComponent(config.ledger)}?commit=t:${t}`,
    { headers: { authorization: `Bearer ${config.token}` } }
  );
  if (!response.ok) throw new Error(`commit t=${t} was not readable: HTTP ${response.status}`);
  return commitEnvelope(await response.json());
};

/** The physical assertions in one commit, without a query or its transaction-metadata bindings. */
const commitAt = async (config: Config, t: number) => {
  const { flakes, ...summary } = await readCommit(config, t);
  const entries = flakes.flatMap(([subject, predicate, value, , asserted]) => {
    const entry = entryIdentity(value);
    return asserted === true && Option.isSome(entry)
      ? [{ subject, predicate, ...entry.value }]
      : [];
  });
  return { ...summary, entries };
};

const projectedText = async (config: Config, t: number, id: string) => {
  const namespace = "https://rawr.ai/ns/agent-bus#";
  const text = ["from", "to", "body", "subject"].map((name) => `${namespace}${name}`);
  return (await readCommit(config, t)).flakes
    .filter(
      ([subject, predicate, , , asserted]) =>
        subject === `urn:agent-bus:message:${id}` &&
        typeof predicate === "string" &&
        text.includes(predicate) &&
        asserted === true
    )
    .map(([, predicate, value, datatype]) => [predicate, value, datatype])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
};

const ledgerIndex = Schema.decodeUnknownSync(
  Schema.Struct({ ledger: Schema.Struct({ "index-t": Schema.Int }) })
);

const waitForIndex = async (config: Config, at: number) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(
      `${config.url}/v1/fluree/info/${encodeURIComponent(config.ledger)}`,
      { headers: { authorization: `Bearer ${config.token}` } }
    );
    if (!response.ok) throw new Error(`index state was not readable: HTTP ${response.status}`);
    const t = ledgerIndex(await response.json()).ledger["index-t"];
    if (t >= at) return t;
    await Bun.sleep(100);
  }
  throw new Error(`index did not reach t=${at}`);
};

const published = (result: Outcome<Bus.Posted | Bus.NotSent>) => {
  if (!result.ok) throw new Error(`publish failed: ${result.error.message}`);
  if (!("message" in result.value)) throw new Error("publish returned a preview");
  return result.value.message;
};

const stagedSend = async (
  name: string,
  run: (stage: Stage, receiver: Machine) => Promise<void>,
  fileBacked = false
) => {
  const durable = fileBacked ? await startFileFlureeServer() : undefined;
  try {
    await staged(
      name,
      async (stage) => {
        const receiver = await machine(stage.config, stage.config.url);
        try {
          expect((await receiver.join(reader, { address: recipient, topics: ["watch"] })).ok).toBe(
            true
          );
          expect((await stage.a.join(holder)).ok).toBe(true);
          await run(stage, receiver);
        } finally {
          await receiver.dispose();
        }
      },
      durable?.freshLedger(name)
    );
  } finally {
    await durable?.stop();
  }
};

describe("guarded publish across serves", () => {
  test(
    "guarded ledger size refusal is definite and sends no insert or update",
    () =>
      stagedSend("publish-pre-dispatch-bound", async ({ config, relay, a, b }, receiver) => {
        const before = await b.head();
        const writes = relay.writeCount();
        const id = Bun.randomUUIDv7();
        const error = await a.admit(
          new Message({
            id,
            ts: new Date().toISOString(),
            from: address,
            to: [recipient],
            kind: "message",
            body: "a".repeat(MAX_INDEXED_FIELD_BYTES + 1),
          })
        );
        expectRefused(error, "InvalidQuery", "Nothing was sent or written");
        expect(relay.writeCount()).toBe(writes);
        expect(await b.head()).toBe(before);
        expect(await commitsOf(config, id)).toEqual([]);
        const sent = published(await a.publish(holder, "admissible control"));
        expect(relay.writeCount()).toBe(writes + 1);
        expect(await receiver.takeMessageIds()).toEqual([sent.id]);
      }),
    TIMEOUT
  );

  for (const mode of ["ordinary", "named pierce", "confirmed pierce", "indexed ledger"] as const) {
    test(
      `${mode}: a held message write cannot land after takeover and the successor's send`,
      () =>
        stagedSend(
          "publish-takeover",
          async ({ config, relay, a, b }, receiver) => {
            const before = await b.head();
            const oldJoin = (await b.peer())?.joinId;
            let extra: Partial<Bus.PublishInput> =
              mode === "named pierce" ? { to: ["#watch"], pierce: [recipient] } : {};
            if (mode === "confirmed pierce") {
              extra = { to: ["#watch"], pierce: "all" };
              const preview = await a.publish(holder, "old", extra);
              if (!preview.ok || !("status" in preview.value)) throw new Error("no pierce preview");
              expect(preview.value.status).toBe("NOT_SENT");
              expect(await b.head()).toBe(before);
              expect(relay.messageAttempts).toHaveLength(0);
              extra = { ...extra, confirm: preview.value.digest };
            }

            let observed:
              | {
                  successorJoin: string;
                  takeoverT: number;
                  successorId: string;
                  sendT: number;
                  indexedAt?: number;
                }
              | undefined;
            const searchWord = "sentinelfencing";
            relay.armMessage({
              ...(mode === "indexed ledger" ? { fault: "forwarded" } : {}),
              before: async () => {
                const joined = await b.join(successor, { takeover: oldJoin });
                if (!joined.ok) throw new Error(`takeover failed: ${joined.error.message}`);
                const successorJoin = (await b.peer())?.joinId;
                if (successorJoin === undefined) throw new Error("takeover left no current join");
                const takeoverT = await b.head();
                const successorId = published(await b.publish(successor, searchWord)).id;
                const sendT = await b.head();
                const indexedAt =
                  mode === "indexed ledger" ? await waitForIndex(config, sendT) : undefined;
                observed = {
                  successorJoin,
                  takeoverT,
                  successorId,
                  sendT,
                  ...(indexedAt === undefined ? {} : { indexedAt }),
                };
              },
            });
            const result = await a.publish(holder, "old", extra);

            if (observed === undefined)
              throw new Error("the relay did not stage the competing writes");
            const { takeoverT, sendT, successorJoin, successorId } = observed;
            const id = relay.messageAttempts[0];
            const after = await b.head();
            const delivered = await receiver.takeMessageIds();
            const staleJson = await stored(config, id);
            const staleJsonAtSuccessor = await stored(config, id, sendT);
            const staleCommits = await commitsOf(config, id);
            const takeover = await commitAt(config, takeoverT);
            const sent = await commitAt(config, sendT);
            const later = [];
            for (let t = sendT + 1; t <= after; t++) later.push(await commitAt(config, t));
            expect(takeoverT).toBeGreaterThan(before);
            expect(sendT).toBeGreaterThan(takeoverT);
            expect(takeover).toMatchObject({
              t: takeoverT,
              entries: [{ id: successorJoin, from: address, kind: "presence" }],
            });
            expect(sent).toMatchObject({
              t: sendT,
              parents: [takeover.id],
              entries: [{ id: successorId, from: address, kind: "message" }],
            });
            expect(relay.messageAttempts).toHaveLength(1);
            expect(staleJsonAtSuccessor).toHaveLength(0);
            expect(staleJson).toHaveLength(0);
            expect(staleCommits).toEqual([]);
            expect(delivered).toEqual([successorId]);
            expect(later).toEqual([]);
            expect(after).toBe(sendT);
            if (mode === "indexed ledger") {
              expectRefused(result, "LedgerError", "it may have committed");
            } else {
              expectRefused(result, "NotOwner", "belongs to another session");
            }
            expectRefused(
              await a.publish(holder, "fresh stale request"),
              "NotOwner",
              "belongs to another session"
            );
            expect(relay.messageAttempts).toHaveLength(1);
            if (mode === "indexed ledger") {
              expect(observed.indexedAt).toBeGreaterThanOrEqual(sendT);
              const legacyId = Bun.randomUUIDv7();
              await b.append(
                new Message({
                  id: legacyId,
                  ts: new Date().toISOString(),
                  from: address,
                  to: [recipient],
                  kind: "message",
                  body: searchWord,
                  origin: new Origin({ host: "fixture", cwd: "/work" }),
                })
              );
              await waitForIndex(config, await b.head());
              expect((await b.historyIds(searchWord)).sort()).toEqual(
                [successorId, legacyId].sort()
              );
            }
          },
          mode === "indexed ledger"
        ),
      TIMEOUT
    );
  }

  for (const pierced of [false, true]) {
    test(
      `${pierced ? "pierced" : "ordinary"} publish: question-mark literals survive the guarded update`,
      () =>
        stagedSend(
          "publish-literal",
          async ({ config, a, b }, receiver) => {
            const text = {
              from: address,
              to: [pierced ? "#watch" : recipient, "?recipient"],
              body: "?guardliteralquestion",
              subject: "?guardliteralsubject",
              ...(pierced ? { pierce: [recipient] } : {}),
            };
            const legacy = new Message({
              ...text,
              id: Bun.randomUUIDv7(),
              ts: new Date().toISOString(),
              kind: "message",
              origin: new Origin({ host: "fixture", cwd: "/work" }),
            });
            await b.append(legacy);
            const baseline = await projectedText(config, await b.head(), legacy.id);
            expect(baseline.map(([, value]) => value).sort()).toEqual(
              [text.from, ...text.to, text.body, text.subject].sort()
            );

            const sent = published(await a.publish(holder, text.body, text));
            const cut = await b.head();
            const encoded = await stored(config, sent.id);
            expect(encoded).toHaveLength(1);
            expect(Schema.decodeUnknownSync(MessageJson)(encoded[0])).toMatchObject(text);
            expect(await projectedText(config, cut, sent.id)).toEqual(baseline);
            expect(await receiver.takeMessageIds()).toEqual([legacy.id, sent.id]);

            await waitForIndex(config, cut);
            for (const query of ["guardliteralquestion", "guardliteralsubject"]) {
              expect((await b.historyIds(query)).sort()).toEqual([legacy.id, sent.id].sort());
            }
          },
          true
        ),
      TIMEOUT
    );
  }

  test.each(["?owner", "?sender", "?otherT"])(
    "the sender %s is matched literally in its ownership guard",
    (from) =>
      stagedSend("publish-literal-owner", async ({ config, relay, a, b }, receiver) => {
        const inbox = "?recipient";
        expect((await receiver.join(reader, { address: inbox })).ok).toBe(true);
        expect((await a.join(holder, { address: from })).ok).toBe(true);
        const current = await b.peer(from);
        if (current === undefined) throw new Error("the literal sender did not join");

        relay.armMessage({
          before: async () => {
            const joined = await b.join("session:unrelated", { address: "claude/other" });
            if (!joined.ok) throw new Error(`unrelated join failed: ${joined.error.message}`);
          },
        });
        const sent = published(await a.publish(holder, "?question", { from, to: [inbox] }));
        const projected = await projectedText(config, await b.head(), sent.id);
        expect(projected.map(([, value]) => value).sort()).toEqual(
          [from, inbox, "?question"].sort()
        );

        relay.armMessage({
          before: async () => {
            const joined = await b.join(successor, { address: from, takeover: current.joinId });
            if (!joined.ok) throw new Error(`takeover failed: ${joined.error.message}`);
          },
        });
        const stale = await a.publish(holder, "?old", { from, to: [inbox] });
        expectRefused(stale, "NotOwner", "belongs to another session");
        expect(relay.messageAttempts).toHaveLength(2);
        expect(await stored(config, relay.messageAttempts[1])).toEqual([]);
        const next = published(await b.publish(successor, "?new", { from, to: [inbox] }));
        expect(await receiver.takeMessageIds(inbox)).toEqual([sent.id, next.id]);
      }),
    TIMEOUT
  );

  test(
    "a same-holder renewal refuses one attempt without claiming the holder changed",
    () =>
      stagedSend("publish-renewal", async ({ config, relay, a, b }, receiver) => {
        const oldJoin = (await b.peer())?.joinId;
        relay.armMessage({
          before: async () => {
            const renewed = await b.join(holder);
            if (!renewed.ok) throw new Error(`renewal failed: ${renewed.error.message}`);
          },
        });
        const result = await a.publish(holder, "old basis");
        const current = await b.peer();

        expect(current?.joinId).not.toBe(oldJoin);
        expect(current?.presence.session).toBe(holder);
        expectRefused(result, "PresenceConflict", "nothing was written");
        expect(relay.messageAttempts).toHaveLength(1);
        expect(await commitsOf(config, relay.messageAttempts[0])).toEqual([]);
        const sent = published(await a.publish(holder, "fresh basis"));
        expect(relay.messageAttempts).toHaveLength(2);
        expect(await receiver.takeMessageIds()).toEqual([sent.id]);
      }),
    TIMEOUT
  );

  test(
    "a presence for an unrelated address does not block the sender",
    () =>
      stagedSend("publish-unrelated", async ({ config, relay, a, b }, receiver) => {
        const before = await b.head();
        let unrelatedT: number | undefined;
        relay.armMessage({
          before: async () => {
            const joined = await b.join("session:unrelated", { address: "claude/unrelated" });
            if (!joined.ok) throw new Error(`unrelated join failed: ${joined.error.message}`);
            unrelatedT = await b.head();
          },
        });
        const sent = published(await a.publish(holder, "still the owner"));

        expect(unrelatedT).toBeGreaterThan(before);
        const sentT = await b.head();
        expect(sentT).toBeGreaterThan(unrelatedT ?? before);
        expect(relay.messageAttempts).toEqual([sent.id]);
        expect(await commitsOf(config, sent.id)).toEqual([sentT]);
        expect(await receiver.takeMessageIds()).toEqual([sent.id]);
      }),
    TIMEOUT
  );

  for (const fault of ["forwarded", "unsettled", "unforwarded"] as const) {
    test(
      `response loss (${fault}): settle by exact id or report uncertainty, never write again`,
      () =>
        stagedSend("publish-response-loss", async ({ config, relay, a, b }, receiver) => {
          const before = await b.head();
          relay.armMessage({ fault });
          const result = await a.publish(holder, "maybe sent");

          expect(relay.messageAttempts).toHaveLength(1);
          const id = relay.messageAttempts[0];
          if (id === undefined) throw new Error("the relay saw no message write");
          const after = await b.head();
          const delivered = await receiver.takeMessageIds();
          if (fault === "unforwarded") {
            expect(after).toBe(before);
            expect(await commitsOf(config, id)).toEqual([]);
            expect(delivered).toEqual([]);
          } else {
            expect(after).toBeGreaterThan(before);
            expect(await commitsOf(config, id)).toEqual([after]);
            expect(delivered).toEqual([id]);
          }
          if (fault === "forwarded") {
            expect(published(result).id).toBe(id);
          } else {
            expectRefused(result, "LedgerError", "it may have committed");
            if (!result.ok) {
              expect(result.error.message).toContain(
                `Retry the identical call with operation ${id}`
              );
            }
          }
        }),
      TIMEOUT
    );
  }
});

describe("guarded presence: a competing claim committed after the cut", () => {
  for (const prior of [false, true] as const) {
    test(
      `two free claims: the loser is refused naming the winner and writes nothing; only the winner's start is added${prior ? " to an earlier holding's" : ""}`,
      () =>
        staged("free-claims", async ({ config, relay, a, b }) => {
          const earlier = prior ? await leftHolding(b) : await b.mailbox();
          const before = await presenceNodes(config);
          let readHead: number | undefined;
          const winner = during(relay, async () => {
            readHead = await b.head();
            return b.join("session:b");
          });
          const loser = await a.join("session:a");

          expect(winner.value?.ok).toBe(true);
          const held = await b.peer();
          expect(held?.presence.session).toBe("session:b");
          expectRefused(loser, "NotOwner", `"${held?.joinId}"`);
          expect(relay.attempts).toHaveLength(1);
          expect(await stored(config, relay.attempts[0])).toEqual([]);
          expect(await presenceNodes(config)).toEqual(
            [...before, messageIri(held?.joinId ?? "")].sort()
          );
          // The loser's start travelled with its presence, and neither was stored.
          expect(relay.starts).toEqual([true]);
          expectOneNewStart(earlier, await b.mailbox(), held?.joinId, readHead);
        }),
      TIMEOUT
    );
  }

  test(
    "a mixed old writer: an unconditional presence append after the cut refuses the guarded join",
    () =>
      staged("old-writer", async ({ config, relay, a, b }) => {
        const legacy = presenceEntry(address, "session:legacy");
        const appended = during(relay, async () => {
          await b.append(legacy);
          return true;
        });
        const result = await a.join("session:a");

        expect(appended.value).toBe(true);
        expectRefused(result, "NotOwner", `"${legacy.id}"`);
        expect((await b.peer())?.joinId).toBe(legacy.id);
        expect(await stored(config, relay.attempts.at(-1))).toEqual([]);
        expect(relay.starts.at(-1)).toBe(true);
        // The unconditional append carries no start, and the refused join stored none.
        expect(positionView(await b.mailbox())).toEqual({ status: "ABSENT" });
      }),
    TIMEOUT
  );
});

describe("guarded presence: the old holder's call committed after a takeover", () => {
  /** A joins `holder`; B takes the address over for `successor` during A's next presence write. */
  const takenOverDuring = async ({ relay, a, b }: Stage, call: () => Promise<Outcome<unknown>>) => {
    expect((await a.join(holder)).ok).toBe(true);
    const tookOver = during(relay, async () => {
      const current = await b.peer();
      return b.join(successor, { takeover: current?.joinId });
    });
    const result = await call();
    expect(tookOver.value?.ok).toBe(true);
    const after = await b.peer();
    expect(after?.presence.session).toBe(successor);
    expect(after?.presence.status).toBe("joined");
    return { result, successorJoin: after?.joinId };
  };

  test(
    "stale leave: refused as no longer the owner, in one write; the successor still holds",
    () =>
      staged("stale-leave", async (stage) => {
        const { result } = await takenOverDuring(stage, () => stage.a.leave(holder));
        expectRefused(result, "NotOwner", "belongs to another session");
        // The join, then the leave's one attempt: a refused write is never resent.
        expect(stage.relay.attempts).toHaveLength(2);
        expect(await stored(stage.config, stage.relay.attempts.at(-1))).toEqual([]);
      }),
    TIMEOUT
  );

  for (const replay of [false, true]) {
    test(
      `stale ${replay ? "replay " : ""}rejoin: refused naming the successor's join; the address keeps its prior position`,
      () =>
        staged("stale-rejoin", async (stage) => {
          let prior: MailboxState | undefined;
          const { result, successorJoin } = await takenOverDuring(stage, async () => {
            prior = await stage.b.mailbox();
            return stage.a.join(holder, { replay });
          });
          // A replay would have started at 0, so a prior position above 0 shows nothing moved it.
          if (prior?.status !== "FOUND") throw new Error("The holder has no position.");
          expect(prior.position).toBeGreaterThan(0);
          expectRefused(result, "NotOwner", `"${successorJoin}"`);
          // Only a replay carries a start; the takeover between writes no position.
          expect(stage.relay.starts.at(-1)).toBe(replay);
          expect(positionView(await stage.b.mailbox())).toEqual(positionView(prior));
          expect(await stored(stage.config, stage.relay.attempts.at(-1))).toEqual([]);
        }),
      TIMEOUT
    );
  }

  test(
    "takeover against a rejoin: a takeover naming J1, held until the holder's rejoin J1' commits, is refused naming J1'",
    () =>
      staged("takeover-rejoin", async ({ config, relay, a, b }) => {
        // Here the taker writes through the relay, and the holder rejoins directly.
        expect((await b.join(holder)).ok).toBe(true);
        const j1 = (await a.peer())?.joinId;
        const before = await b.mailbox();
        expect(before.status).toBe("FOUND");
        const rejoined = during(relay, () => b.join(holder));
        const result = await a.join(successor, { takeover: j1 });

        expect(rejoined.value?.ok).toBe(true);
        const current = await b.peer();
        expect(current?.presence.session).toBe(holder);
        expect(current?.joinId).not.toBe(j1);
        expectRefused(result, "NotOwner", `"${current?.joinId}"`);
        // Neither the takeover nor the rejoin carries a start: the holder's position stands.
        expect(relay.starts.at(-1)).toBe(false);
        expect(positionView(await b.mailbox())).toEqual(positionView(before));
        expect(await stored(config, relay.attempts.at(-1))).toEqual([]);
      }),
    TIMEOUT
  );
});

describe("guarded presence: the same session on two serves", () => {
  const session = "session:both";

  test(
    "two joins: one succeeds, the other is a PresenceConflict that writes nothing; calling again renews",
    () =>
      staged("same-session-joins", async ({ config, relay, a, b }) => {
        const earlier = await b.mailbox();
        let readHead: number | undefined;
        const other = during(relay, async () => {
          readHead = await b.head();
          return b.join(session);
        });
        const result = await a.join(session);

        expect(other.value?.ok).toBe(true);
        const won = await b.peer();
        expectRefused(
          result,
          "PresenceConflict",
          `${address} changed while this call was deciding, so nothing was written. Call again`
        );
        expect(await stored(config, relay.attempts.at(-1))).toEqual([]);
        expect(relay.starts.at(-1)).toBe(true);
        const afterRace = await b.mailbox();
        expectOneNewStart(earlier, afterRace, won?.joinId, readHead);
        expect((await a.peer())?.joinId).toBe(won?.joinId);

        expect((await a.join(session)).ok).toBe(true);
        const renewed = await a.peer();
        expect(renewed?.joinId).not.toBe(won?.joinId);
        expect(renewed?.presence.rejoinOf).toBe(won?.joinId);
        // A renewal continues the run and adds no start.
        expect(positionView(await b.mailbox())).toEqual(positionView(afterRace));
      }),
    TIMEOUT
  );

  test(
    "a leave racing a rejoin is a PresenceConflict; the rejoin stands",
    () =>
      staged("leave-rejoin", async ({ config, relay, a, b }) => {
        expect((await a.join(session)).ok).toBe(true);
        const rejoin = during(relay, () => b.join(session));
        const result = await a.leave(session);

        expect(rejoin.value?.ok).toBe(true);
        expectRefused(
          result,
          "PresenceConflict",
          `${address} changed while this call was deciding`
        );
        const current = await b.peer();
        expect(current?.presence.session).toBe(session);
        expect(current?.presence.status).toBe("joined");
        expect(await stored(config, relay.attempts.at(-1))).toEqual([]);
      }),
    TIMEOUT
  );
});

describe("guarded presence: position law", () => {
  test(
    "a rejoin by the holder with an existing position writes no position",
    () =>
      staged("rejoin-cursor", async ({ relay, a, b }) => {
        expect((await a.join(holder)).ok).toBe(true);
        const before = await b.mailbox();
        expect(before.status).toBe("FOUND");
        expect((await a.join(holder)).ok).toBe(true);
        expect(relay.starts).toEqual([true, false]);
        expect(positionView(await b.mailbox())).toEqual(positionView(before));
      }),
    TIMEOUT
  );
});

describe("guarded presence: an unconfirmed write", () => {
  test(
    "a write that committed but whose response failed is the call's success",
    () =>
      staged("unknown-committed", async ({ config, relay, a, b }) => {
        const head = await a.head();
        relay.arm({ fault: "forwarded" });
        const result = await a.join(holder);

        expect(relay.fired.map(({ plan }) => plan.fault)).toEqual(["forwarded"]);
        expect(relay.starts).toEqual([true]);
        expect(result.ok).toBe(true);
        expect(relay.attempts).toHaveLength(1);
        expect((await a.peer())?.joinId).toBe(relay.attempts[0]);
        expect(await stored(config, relay.attempts[0])).toHaveLength(1);
        expect<unknown>(positionView(await b.mailbox())).toEqual({
          status: "FOUND",
          position: head,
          starts: [{ operation: relay.attempts[0], position: head, t: expect.any(Number) }],
        });
      }),
    TIMEOUT
  );

  test(
    "an unsent join reports it could not confirm and stores neither presence nor start; a later join decides honestly",
    () =>
      staged("unknown-join", async ({ config, relay, a, b }) => {
        const before = await presenceNodes(config);
        relay.arm({ fault: "unforwarded" });
        const result = await a.join(holder);

        expectRefused(
          result,
          "LedgerError",
          `The bus could not confirm whether this join of ${address} was recorded`
        );
        expect(relay.fired.map(({ plan }) => plan.fault)).toEqual(["unforwarded"]);
        expect(relay.attempts).toHaveLength(1);
        expect(relay.starts).toEqual([true]);
        // Read independently, not from the ambiguous answer: no presence and no start were stored.
        expect(await stored(config, relay.attempts[0])).toEqual([]);
        expect(await presenceNodes(config)).toEqual(before);
        expect(positionView(await b.mailbox())).toEqual({ status: "ABSENT" });

        const head = await a.head();
        expect((await a.join(holder)).ok).toBe(true);
        expect((await a.peer())?.presence.session).toBe(holder);
        expect(relay.attempts).toHaveLength(2);
        expect<unknown>(positionView(await b.mailbox())).toEqual({
          status: "FOUND",
          position: head,
          starts: [{ operation: relay.attempts[1], position: head, t: expect.any(Number) }],
        });
      }),
    TIMEOUT
  );

  test(
    "an unsent leave reports it could not confirm and changes nothing; a later leave decides honestly",
    () =>
      staged("unknown-leave", async ({ config, relay, a, b }) => {
        expect((await a.join(holder)).ok).toBe(true);
        const joined = await a.peer();
        const position = await b.mailbox();
        expect(position.status).toBe("FOUND");
        const before = await presenceNodes(config);
        relay.arm({ fault: "unforwarded" });
        const result = await a.leave(holder);

        expectRefused(
          result,
          "LedgerError",
          `The bus could not confirm whether this leave of ${address} was recorded`
        );
        expect(await presenceNodes(config)).toEqual(before);
        expect(relay.fired.map(({ plan }) => plan.fault)).toEqual(["unforwarded"]);
        expect((await a.peer())?.joinId).toBe(joined?.joinId);
        expect(positionView(await b.mailbox())).toEqual(positionView(position));

        expect((await a.leave(holder)).ok).toBe(true);
        expect(await a.peer()).toBeUndefined();
      }),
    TIMEOUT
  );
});

describe("guarded presence: damaged presence", () => {
  /** Session-bearing presence nodes for the address that a guard keyed on `bus:from` could miss. */
  const damage: Record<string, () => Record<string, unknown>> = {
    undecodable: () => {
      const id = Bun.randomUUIDv7();
      return {
        ...toNode(presenceEntry(address, "session:d"), "{not json"),
        "@id": messageIri(id),
        "bus:id": id,
      };
    },
    "divergent sender": () => {
      const elsewhere = presenceEntry("claude/elsewhere", "session:d");
      return { ...toNode(elsewhere, encodeJson(elsewhere)), "bus:from": address };
    },
    "another node's entry": () => {
      const entry = presenceEntry(address, "session:d");
      return { ...toNode(entry, encodeJson(entry)), "@id": messageIri(Bun.randomUUIDv7()) };
    },
    "two encodings": () => {
      const entry = presenceEntry(address, "session:d");
      const forged = new Message({ ...entry, to: [...entry.to], body: "forged" });
      return {
        ...toNode(entry, encodeJson(entry)),
        "bus:json": [encodeJson(entry), encodeJson(forged)],
      };
    },
  };

  for (const [kind, node] of Object.entries(damage)) {
    test(
      `${kind} presence in history at the cut: a decode error, no position, nothing attempted`,
      () =>
        staged("damage-at-cut", async ({ config, relay, a, b }) => {
          await insertRaw(config, node());
          const before = await presenceNodes(config);
          const result = await a.join(holder);

          expectRefused(result, "LedgerError", "could not be decoded");
          expect(relay.attempts).toHaveLength(0);
          expect(positionView(await b.mailbox())).toEqual({ status: "ABSENT" });
          expect(await presenceNodes(config)).toEqual(before);
        }),
      TIMEOUT
    );
  }

  test(
    "damage for the address committed after the cut: refused, the re-read fails, the earlier position stands",
    () =>
      staged("damage-after-cut", async ({ config, relay, a, b }) => {
        const prior = await leftHolding(b);
        const inserted = during(relay, async () => {
          await insertRaw(config, damage.undecodable?.());
          return true;
        });
        const result = await a.join(holder);

        expect(inserted.value).toBe(true);
        expectRefused(result, "LedgerError", "could not be decoded");
        expect(relay.attempts).toHaveLength(1);
        expect(relay.starts).toEqual([true]);
        expect(await stored(config, relay.attempts[0])).toEqual([]);
        expect(positionView(await b.mailbox())).toEqual(positionView(prior));
      }),
    TIMEOUT
  );
});

describe("publish with an operation across serves", () => {
  /** A body Fluree must keep byte for byte, or every retry would be a mismatch. */
  const awkward = "line one\r\nline two \u00e9 e\u0301 \u{1f680}  ";

  for (const fault of ["forwarded", "unsettled", "unforwarded"] as const) {
    test(
      `response loss (${fault}) then a retry with the operation: stored once`,
      () =>
        stagedSend("publish-op-loss", async ({ config, relay, a }, receiver) => {
          const operation = Bun.randomUUIDv7();
          relay.armMessage({ fault });
          const result = await a.publish(holder, awkward, { operation });
          relay.settle();
          expect(relay.messageAttempts).toEqual([operation]);
          if (fault === "forwarded") {
            const first = published(result);
            expect(first.id).toBe(operation);
          } else {
            expectRefused(result, "LedgerError", "it may have committed");
          }
          const retry = await a.publish(holder, awkward, { operation });
          if (!retry.ok || !("message" in retry.value)) throw new Error("the retry failed");
          expect(retry.value.message.id).toBe(operation);
          // The retry wrote again only if the first attempt never reached the ledger.
          expect(retry.value.replayed).toBe(fault === "unforwarded" ? undefined : true);
          expect(relay.messageAttempts).toEqual(
            fault === "unforwarded" ? [operation, operation] : [operation]
          );
          expect(await commitsOf(config, operation)).toHaveLength(1);
          expect(await stored(config, operation)).toHaveLength(1);
          expect(await receiver.takeMessageIds()).toEqual([operation]);
        }),
      TIMEOUT
    );
  }

  for (const same of [true, false]) {
    test(
      `a racing attempt commits the operation first: ${same ? "the same send replays" : "another send is a mismatch"}`,
      () =>
        stagedSend("publish-op-race", async ({ config, relay, a, b }, receiver) => {
          const operation = Bun.randomUUIDv7();
          let racer: Bus.Posted | undefined;
          relay.armMessage({
            before: async () => {
              const raced = await b.publish(holder, same ? "raced" : "the other send", {
                operation,
              });
              if (!raced.ok || !("message" in raced.value)) throw new Error("the racer failed");
              racer = raced.value;
              // A later attempt carries a later time, so it can't pass for the racer's entry.
              await Bun.sleep(2);
            },
          });
          const result = await a.publish(holder, "raced", { operation });
          if (racer === undefined) throw new Error("the relay did not stage the race");
          expect(racer.replayed).toBeUndefined();
          // A's insert was forwarded, found the id taken and committed nothing.
          expect(relay.messageAttempts).toEqual([operation]);
          expect(await commitsOf(config, operation)).toHaveLength(1);
          const kept = await stored(config, operation);
          expect(kept).toHaveLength(1);
          expect(Schema.decodeUnknownSync(MessageJson)(kept[0]).body).toBe(
            same ? "raced" : "the other send"
          );
          if (same) {
            if (!result.ok || !("message" in result.value)) throw new Error("A failed");
            expect(result.value.replayed).toBe(true);
            expect(result.value.message.id).toBe(operation);
            expect(result.value.message.ts).toBe(racer.message.ts);
          } else {
            expectRefused(result, "InvalidQuery", "Nothing was written");
            if (!result.ok) expect(result.error.code).toBe("IDENTITY_MISMATCH");
          }
          expect(await receiver.takeMessageIds()).toEqual([operation]);
        }),
      TIMEOUT
    );
  }

  test(
    "the point read returns the entry at its own commit, a presence, absence and damage",
    () =>
      stagedSend("publish-op-entry", async ({ config, a, b }) => {
        const operation = Bun.randomUUIDv7();
        published(await a.publish(holder, awkward, { operation }));
        const found = await b.entry(operation);
        if (found.status !== "FOUND") throw new Error(`entry was ${found.status}`);
        expect([found.t]).toEqual((await commitsOf(config, operation)) as Array<number>);
        expect(found.message.body).toBe(awkward);

        const joinId = (await b.peer())?.joinId;
        if (joinId === undefined) throw new Error("the holder has no join id");
        const presence = await b.entry(joinId);
        expect(presence.status === "FOUND" && presence.message.kind).toBe("presence");
        expect((await b.entry(Bun.randomUUIDv7())).status).toBe("ABSENT");

        const damaged = Bun.randomUUIDv7();
        await insertRaw(config, {
          "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
          "@id": messageIri(damaged),
          "@type": "bus:Message",
          "bus:json": "not an entry",
        });
        expect((await b.entry(damaged)).status).toBe("MALFORMED");
        const refused = await a.publish(holder, "over damage", { operation: damaged });
        expectRefused(refused, "LedgerError", "nothing was sent");
      }),
    TIMEOUT
  );
});
