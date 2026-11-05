// Guarded presence writes across serves. A join or leave decides on the presence it read at a
// cut T and writes its presence only if no presence for the address was written after T; a
// refused write leaves the cursor as it was and re-decides against the presence that refused
// it, without writing. These cases stage the interleavings two serves on one Fluree ledger can
// produce (messaging rules 2, 4 and 8), including the join/leave-after-takeover race that was
// tracked here as `test.failing`.
//
// The seam is deterministic: serve A writes through a relay that, on A's next presence write,
// first runs an action to completion (usually serve B's competing call, made directly on the
// ledger), or answers with a fault. Each "machine" has its own cursor directory, read here as
// files, and ledger contents are read with literal queries independent of the bus's reads.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Message, MessageJson, Origin, Presence } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { Ledger, messageIri } from "../src/Ledger.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const address = "claude/held";
const holder = "session:holder";
const successor = "session:successor";
const cwd = process.cwd();
const encodeJson = Schema.encodeSync(MessageJson);
const TIMEOUT = 60_000;

type Config = Awaited<ReturnType<typeof freshLedger>>;
interface Failure {
  readonly _tag?: string;
  readonly message?: string;
}
type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: Failure };

/** One serve: its own runtime and cursor directory, on `url` (direct, or the relay). */
const machine = async (config: Config, url: string) => {
  const cursorDir = join(mkdtempSync(join(tmpdir(), "agent-bus-lifecycle-")), "cursors");
  const runtime = ManagedRuntime.make(
    Bus.layer.pipe(
      Layer.provideMerge(layerFluree({ ...config, url }).pipe(Layer.provide(platform))),
      Layer.provideMerge(Cursors.layerFiles(cursorDir)),
      Layer.provide(platform)
    )
  );
  await runtime.runPromise(Effect.void);
  const file = join(cursorDir, `${encodeURIComponent(address)}.json`);
  const outcome = <A, E>(effect: Effect.Effect<A, E, Bus.Bus | Ledger>): Promise<Outcome<A>> =>
    runtime.runPromise(
      Effect.match(effect, {
        onFailure: (error): Outcome<A> => ({ ok: false, error: error as Failure }),
        onSuccess: (value): Outcome<A> => ({ ok: true, value }),
      })
    );
  return {
    runtime,
    join: (session: string, extra: Partial<Bus.JoinInput> = {}) =>
      outcome(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({ address, runtime: "claude", session, cwd, ...extra })
        )
      ),
    leave: (session: string) =>
      outcome(Effect.flatMap(Bus.Bus, (bus) => bus.leave(address, session))),
    /** The address's current joined peer, as this serve reads it. */
    peer: () =>
      runtime.runPromise(
        Effect.map(
          Effect.flatMap(Bus.Bus, (bus) => bus.peers),
          (peers) => peers.find((peer) => peer.address === address)
        )
      ),
    head: () => runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.end)),
    append: (message: Message) =>
      runtime.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.append(message))),
    /** The cursor file's value, or undefined when there is no file. */
    cursor: (): number | undefined => {
      try {
        return (JSON.parse(readFileSync(file, "utf8")) as { cursor: number }).cursor;
      } catch {
        return undefined;
      }
    },
    /** The cursor file's inode: each write replaces the file, so a write changes it. */
    cursorInode: () => statSync(file).ino,
    setCursor: (cursor: number) => writeFileSync(file, JSON.stringify({ cursor })),
  };
};
type Machine = Awaited<ReturnType<typeof machine>>;

type Fault = "forwarded" | "unforwarded";
interface Plan {
  readonly before?: () => Promise<void>;
  readonly fault?: Fault;
}

/**
 * Forwards everything to Fluree; on the next presence write, first runs `before` to completion,
 * then forwards it, or applies `fault`: "forwarded" commits upstream and answers 504,
 * "unforwarded" answers 503 without sending. Records every presence write's entry id.
 */
const presenceRelay = (upstream: string) => {
  let next: Plan | undefined;
  const attempts: Array<string | undefined> = [];
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
      const text = body === undefined ? "" : new TextDecoder().decode(body);
      const forward = () =>
        fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        });
      const write =
        body !== undefined &&
        !url.pathname.startsWith("/v1/fluree/query") &&
        (text.includes('"bus:Presence"') || text.includes("agent-bus#Presence"));
      if (!write) return forward();
      attempts.push(/"bus:id"\s*:\s*"([^"]+)"/.exec(text)?.[1]);
      const plan = next;
      next = undefined;
      if (plan?.before !== undefined) await plan.before();
      if (plan?.fault === "unforwarded") return new Response(null, { status: 503 });
      const response = await forward();
      if (plan?.fault === "forwarded") {
        await response.arrayBuffer();
        return new Response(null, { status: 504 });
      }
      return response;
    },
  });
  return {
    url: server.url.origin,
    arm: (plan: Plan) => {
      next = plan;
    },
    attempts,
    stop: () => server.stop(true),
  };
};
type Relay = ReturnType<typeof presenceRelay>;

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
const stored = (config: Config, id: string | undefined) => {
  if (id === undefined) throw new Error("the relay saw no entry id in the presence write");
  return literal(config, {
    select: "?json",
    where: { "@id": messageIri(id), "bus:json": "?json" },
  });
};

interface Stage {
  readonly config: Config;
  readonly relay: Relay;
  readonly a: Machine;
  readonly b: Machine;
}

/** Serve A through the relay, serve B direct, on one fresh ledger. */
const staged = async (name: string, run: (stage: Stage) => Promise<void>) => {
  const config = await freshLedger(name);
  const relay = presenceRelay(config.url);
  let a: Machine | undefined;
  let b: Machine | undefined;
  try {
    a = await machine(config, relay.url);
    b = await machine(config, config.url);
    await run({ config, relay, a, b });
  } finally {
    await a?.runtime.dispose();
    await b?.runtime.dispose();
    relay.stop();
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

describe("guarded presence: a competing claim committed after the cut", () => {
  for (const prior of [undefined, 7] as const) {
    test(
      `two free claims: the loser is refused naming the winner, writes nothing, and its cursor is ${prior === undefined ? "absent" : "its prior value"} again`,
      () =>
        staged("free-claims", async ({ config, relay, a, b }) => {
          if (prior !== undefined) a.setCursor(prior);
          const before = await presenceNodes(config);
          const winner = during(relay, () => b.join("session:b"));
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
          expect(a.cursor()).toBe(prior);
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
        expect(a.cursor()).toBeUndefined();
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
      `stale ${replay ? "replay " : ""}rejoin: refused naming the successor's join; the holder's cursor keeps its prior value`,
      () =>
        staged("stale-rejoin", async (stage) => {
          let prior: number | undefined;
          const { result, successorJoin } = await takenOverDuring(stage, () => {
            prior = stage.a.cursor();
            return stage.a.join(holder, { replay });
          });
          // A replay would have moved it to 0, so a prior value above 0 shows the restore.
          expect(prior).toBeGreaterThan(0);
          expectRefused(result, "NotOwner", `"${successorJoin}"`);
          expect(stage.a.cursor()).toBe(prior);
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
        const rejoined = during(relay, () => b.join(holder));
        const result = await a.join(successor, { takeover: j1 });

        expect(rejoined.value?.ok).toBe(true);
        const current = await b.peer();
        expect(current?.presence.session).toBe(holder);
        expect(current?.joinId).not.toBe(j1);
        expectRefused(result, "NotOwner", `"${current?.joinId}"`);
        expect(a.cursor()).toBeUndefined();
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
        const other = during(relay, () => b.join(session));
        const result = await a.join(session);

        expect(other.value?.ok).toBe(true);
        const won = await b.peer();
        expectRefused(
          result,
          "PresenceConflict",
          `${address} changed while this call was deciding, so nothing was written. Call again`
        );
        expect(await stored(config, relay.attempts.at(-1))).toEqual([]);
        expect(a.cursor()).toBeUndefined();
        expect((await a.peer())?.joinId).toBe(won?.joinId);

        expect((await a.join(session)).ok).toBe(true);
        const renewed = await a.peer();
        expect(renewed?.joinId).not.toBe(won?.joinId);
        expect(renewed?.presence.rejoinOf).toBe(won?.joinId);
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

describe("guarded presence: cursor law", () => {
  test(
    "a rejoin by the holder with an existing cursor writes no cursor",
    () =>
      staged("rejoin-cursor", async ({ a }) => {
        expect((await a.join(holder)).ok).toBe(true);
        const value = a.cursor();
        const inode = a.cursorInode();
        expect((await a.join(holder)).ok).toBe(true);
        expect(a.cursor()).toBe(value);
        expect(a.cursorInode()).toBe(inode);
      }),
    TIMEOUT
  );
});

describe("guarded presence: an unconfirmed write", () => {
  test(
    "a write that committed but whose response failed is the call's success",
    () =>
      staged("unknown-committed", async ({ config, relay, a }) => {
        const head = await a.head();
        relay.arm({ fault: "forwarded" });
        const result = await a.join(holder);

        expect(result.ok).toBe(true);
        expect(relay.attempts).toHaveLength(1);
        expect((await a.peer())?.joinId).toBe(relay.attempts[0]);
        expect(await stored(config, relay.attempts[0])).toHaveLength(1);
        expect(a.cursor()).toBe(head);
      }),
    TIMEOUT
  );

  test(
    "an unsent join reports it could not confirm, keeps the new cursor, writes nothing; a later join decides honestly",
    () =>
      staged("unknown-join", async ({ config, relay, a }) => {
        const head = await a.head();
        const before = await presenceNodes(config);
        relay.arm({ fault: "unforwarded" });
        const result = await a.join(holder);

        expectRefused(
          result,
          "LedgerError",
          `The bus could not confirm whether this join of ${address} was recorded`
        );
        expect(relay.attempts).toHaveLength(1);
        expect(a.cursor()).toBe(head);
        expect(await presenceNodes(config)).toEqual(before);

        expect((await a.join(holder)).ok).toBe(true);
        expect((await a.peer())?.presence.session).toBe(holder);
        expect(relay.attempts).toHaveLength(2);
      }),
    TIMEOUT
  );

  test(
    "an unsent leave reports it could not confirm and changes nothing; a later leave decides honestly",
    () =>
      staged("unknown-leave", async ({ config, relay, a }) => {
        expect((await a.join(holder)).ok).toBe(true);
        const joined = await a.peer();
        const cursor = a.cursor();
        const before = await presenceNodes(config);
        relay.arm({ fault: "unforwarded" });
        const result = await a.leave(holder);

        expectRefused(
          result,
          "LedgerError",
          `The bus could not confirm whether this leave of ${address} was recorded`
        );
        expect(await presenceNodes(config)).toEqual(before);
        expect((await a.peer())?.joinId).toBe(joined?.joinId);
        expect(a.cursor()).toBe(cursor);

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
      `${kind} presence in history at the cut: a decode error, no cursor, nothing attempted`,
      () =>
        staged("damage-at-cut", async ({ config, relay, a }) => {
          await insertRaw(config, node());
          const before = await presenceNodes(config);
          const result = await a.join(holder);

          expectRefused(result, "LedgerError", "could not be decoded");
          expect(relay.attempts).toHaveLength(0);
          expect(a.cursor()).toBeUndefined();
          expect(await presenceNodes(config)).toEqual(before);
        }),
      TIMEOUT
    );
  }

  test(
    "damage for the address committed after the cut: refused, the re-read fails, the cursor is restored",
    () =>
      staged("damage-after-cut", async ({ config, relay, a }) => {
        a.setCursor(3);
        const inserted = during(relay, async () => {
          await insertRaw(config, damage.undecodable?.());
          return true;
        });
        const result = await a.join(holder);

        expect(inserted.value).toBe(true);
        expectRefused(result, "LedgerError", "could not be decoded");
        expect(relay.attempts).toHaveLength(1);
        expect(await stored(config, relay.attempts[0])).toEqual([]);
        expect(a.cursor()).toBe(3);
      }),
    TIMEOUT
  );
});
