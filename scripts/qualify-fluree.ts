#!/usr/bin/env bun
/**
 * Qualifies the installed Fluree CLI as the bus store, on a durable
 * (file-backed) server in a temporary directory. Rerun after upgrading Fluree.
 *
 * 1. Restart and catch-up: a cursor taken before a server restart reads every
 *    message committed after it, and a waiting reader is woken through the
 *    reconnected event stream.
 * 2. Search across the index boundary: with background indexing held back,
 *    full-text search finds both indexed messages and a fresh unindexed canary,
 *    and finds the same messages once the index catches up.
 * 3. Snapshot resume: a saved-query traversal pinned at one commit, interrupted
 *    by a server restart and by later appends, resumes from its cursor with
 *    exactly the rows a single uninterrupted read at that commit returns.
 * 4. Guarded replacement, on a ledger of its own: a write that moves a scope's
 *    current-revision pointer only while the pointer still names the revision
 *    the writer read, and in the same commit records an immutable witness and
 *    one ordinary notification. Fluree 4.2.4's source evaluates the condition
 *    in transaction staging and restages when the head moves, so two writers
 *    cannot both match (fluree/db v4.2.4: routes/transact.rs, tx_builder.rs,
 *    commit.rs, consensus/local.rs). The run checks what a client can see: a
 *    stale writer writes nothing, a success status or a later t is not
 *    evidence of applying and the operation's own witness is, an operation id
 *    that already has a witness can't be reused for another request, a lost
 *    acknowledgement stays unknown until its witness is found, and an
 *    identical replay never notifies twice. Its races overlap at the client;
 *    they cannot show that the two writes overlapped inside Fluree.
 * 5. Guarded presence, on the same ledger, through the production Ledger: a
 *    join, takeover or leave lands only if no presence for its address was
 *    asserted after the commit its decision read. A stale attempt writes
 *    nothing, another address's presence doesn't block, an admitted id is never
 *    stored twice, and of two attempts on one basis exactly one lands.
 *
 * The server requires a token, as the installed one does. It runs under a supervisor, so a
 * run killed before its cleanup still stops it ([supervised](../test/supervised.ts)).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Fiber, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import * as Catalogue from "../src/catalogue.ts";
import { Message, MessageJson, Origin, Presence } from "../src/domain.ts";
import * as Fluree from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import type { QueryGateway } from "../src/Query.ts";
import * as Selections from "../src/RankedSelections.ts";
import { boundary, type Forwarded } from "../test/fluree-boundary.ts";
import { type Supervised, spawnSupervised } from "../test/supervised.ts";

const fluree = Bun.which("fluree");
if (fluree === null) throw new Error("fluree is not on PATH");

const dir = mkdtempSync(join(tmpdir(), "agent-bus-qualify-"));
const port = 18_900 + Math.floor(Math.random() * 90);
const command = (args: ReadonlyArray<string>, stdin?: string) => {
  const result = Bun.spawnSync([...args], {
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stderr: "ignore",
  });
  if (!result.success) throw new Error(`${args.slice(0, 3).join(" ")} failed`);
  return result.stdout.toString().trim();
};
const key = JSON.parse(command([fluree, "token", "keygen", "--format", "json"])) as {
  readonly privateKey: { readonly hex: string };
  readonly did: string;
};
const token = command(
  [fluree, "token", "create", "--private-key", "@-", "--all", "--read-all", "--write-all"],
  key.privateKey.hex
);
const AUTH = ["data", "admin"].flatMap((scope) => [
  `--${scope}-auth-mode`,
  "required",
  `--${scope}-auth-trusted-issuer`,
  key.did,
]);
const config = { url: `http://127.0.0.1:${port}`, ledger: "agent-bus-qualify:main", token };
const api = `${config.url}/v1/fluree`;
// Novelty this large is never indexed during the run, holding the index back.
const HOLD_INDEX = ["--reindex-min-bytes", "1000000000", "--reindex-max-bytes", "2000000000"];

Bun.spawnSync([fluree, "init"], { cwd: dir, stdout: "ignore" });

let server: Supervised | undefined;

const start = async (extra: ReadonlyArray<string> = []) => {
  server = spawnSupervised(
    [
      fluree,
      "server",
      "run",
      "--config",
      join(dir, ".fluree", "config.toml"),
      "--storage-path",
      join(dir, "storage"),
      "--listen-addr",
      `127.0.0.1:${port}`,
      "--",
      ...AUTH,
      ...extra,
    ],
    { cwd: dir, stdout: "ignore", stderr: "ignore" }
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await fetch(`${config.url}/health`).then(
        (r) => r.ok,
        () => false
      )
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error("fluree server did not start");
};

const stop = async () => {
  server?.kill();
  await server?.exited;
};

const indexLag = async () => {
  const info = (await fetch(`${api}/info/${encodeURIComponent(config.ledger)}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())) as { ledger: { "commit-t": number; "index-t": number } };
  return info.ledger["commit-t"] - info.ledger["index-t"];
};

const waitForIndex = async () => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await indexLag()) === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("background index did not catch up");
};

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const busLayer = (store: Fluree.FlureeConfig = config) =>
  Bus.layer("qualification-installation").pipe(
    Layer.provideMerge(Fluree.layerFluree(store)),
    Layer.provide(Cursors.layerFiles(join(dir, "cursors", encodeURIComponent(store.ledger)))),
    Layer.provide(platform)
  );
const withBus = <A, E>(
  effect: Effect.Effect<A, E, Bus.Bus | QueryGateway | Ledger>,
  store: Fluree.FlureeConfig = config
) => Effect.runPromise(Effect.provide(effect, busLayer(store)));

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const search = (text: string) =>
  withBus(
    Catalogue.search
      .run({ text, limit: 10 }, {}, undefined)
      .pipe(
        Effect.provideServiceEffect(
          Selections.RankedSelections,
          Selections.make(Selections.PROCESS_POLICY)
        )
      )
  ).then((page) => page.rows);

/** One history page at `t`, or the page after `cursor`. */
const historyPage = (input: { readonly t?: number; readonly cursor?: string }) =>
  withBus(Catalogue.history.run({ kinds: ["message"], limit: 7 }, input, undefined));

/** The qualification's two sessions. */
const READER = "qualify-reader";
const SENDER = "qualify-sender";

const bodies = (messages: ReadonlyArray<{ readonly body: string }>) =>
  messages.map((message) => message.body).sort();

/** Qualification 4's ledger, reader and scopes. */
const GUARDED = { ...config, ledger: "agent-bus-qualify-guard:main" };
const GUARD_READER = "codex/guard-reader";
const JSON_AUTH = { "content-type": "application/json", authorization: `Bearer ${token}` };
const BUS_CONTEXT = {
  bus: "https://rawr.ai/ns/agent-bus#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};
const scopeIri = (scope: string) => `urn:agent-bus:scope:${scope}`;
const revisionIri = (op: string) => `urn:agent-bus:revision:${op}`;
const messageIri = (id: string) => `urn:agent-bus:message:${id}`;

/** One intended replacement. Its operation id names the new revision, its witness and its notification. */
interface Replacement {
  readonly op: string;
  readonly scope: string;
  /** The revision the writer read, or null when it read no pointer. */
  readonly expected: string | null;
  readonly message: Message;
}

const replacement = (
  scope: string,
  expected: string | null,
  op = Bun.randomUUIDv7(),
  body = `${scope} is now ${op}`
): Replacement => {
  return {
    op,
    scope,
    expected,
    message: new Message({
      id: op,
      ts: new Date().toISOString(),
      from: "qualify/setter",
      to: [GUARD_READER],
      kind: "message",
      body,
    }),
  };
};

const encodeMessage = Schema.encodeSync(MessageJson);

/**
 * How much of the write's condition to send. `full` is the candidate: the pointer still names
 * the expected revision and the operation has no witness yet. The others are controls.
 */
type Guard = "full" | "pointer" | "none";

/**
 * The candidate write. Fluree adds to a node that already exists, so without the witness
 * condition a reused operation id would move the pointer back to its old revision and
 * assert its notification a second time.
 */
const writeBody = (r: Replacement, guard: Guard) => {
  const { "@context": _, ...notification } = Fluree.toNode(r.message, encodeMessage(r.message));
  const current = { "@id": scopeIri(r.scope), "bus:revision": r.expected };
  const where =
    r.expected === null
      ? [
          ["optional", { "@id": scopeIri(r.scope), "bus:revision": "?current" }],
          ["filter", "(not (bound ?current))"],
        ]
      : [current];
  const unwitnessed = [
    ["optional", { "@id": revisionIri(r.op), "bus:entry": "?witnessed" }],
    ["filter", "(not (bound ?witnessed))"],
  ];
  return {
    "@context": BUS_CONTEXT,
    ...(guard === "none" ? {} : { where: guard === "full" ? [...where, ...unwitnessed] : where }),
    ...(r.expected === null ? {} : { delete: current }),
    insert: [
      { "@id": scopeIri(r.scope), "bus:revision": r.op },
      {
        "@id": revisionIri(r.op),
        "@type": "bus:Revision",
        "bus:scope": r.scope,
        ...(r.expected === null ? {} : { "bus:supersedes": r.expected }),
        "bus:entry": { "@id": messageIri(r.op) },
      },
      notification,
    ],
  };
};

const guardedQuery = async (body: object) =>
  (await fetch(`${api}/query`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ "@context": BUS_CONTEXT, ...body }),
  }).then((r) => r.json())) as ReadonlyArray<unknown>;
const at = (t?: number) => (t === undefined ? GUARDED.ledger : `${GUARDED.ledger}@t:${t}`);
const guardedHead = async () =>
  (
    (await fetch(`${api}/info/${encodeURIComponent(GUARDED.ledger)}`, {
      headers: JSON_AUTH,
    }).then((r) => r.json())) as { ledger: { t: number } }
  ).ledger.t;
const pointerAt = async (scope: string, t?: number) =>
  [
    ...((await guardedQuery({
      from: at(t),
      select: "?r",
      where: { "@id": scopeIri(scope), "bus:revision": "?r" },
    })) as ReadonlyArray<string>),
  ].sort();
const witnessedAt = async (op: string, t?: number) =>
  (
    await guardedQuery({
      from: at(t),
      select: "?e",
      where: { "@id": revisionIri(op), "bus:entry": "?e" },
    })
  ).length === 1;
/** Whether the operation's witness at `t` is there, and whether it records this very request. */
const witnessOf = async (r: Replacement, t?: number) => {
  const rows = (await guardedQuery({
    from: at(t),
    select: ["?scope", "?supersedes", "?json"],
    where: [
      { "@id": revisionIri(r.op), "bus:scope": "?scope", "bus:entry": "?entry" },
      ["optional", { "@id": revisionIri(r.op), "bus:supersedes": "?supersedes" }],
      { "@id": "?entry", "bus:json": "?json" },
    ],
  })) as ReadonlyArray<readonly [string, string | null, string]>;
  const [row] = rows;
  if (row === undefined) return "absent";
  return rows.length === 1 &&
    row[0] === r.scope &&
    (row[1] ?? null) === r.expected &&
    row[2] === encodeMessage(r.message)
    ? "matches"
    : "differs";
};
/**
 * How many commits asserted an entry's stored JSON, read from history rather than from any
 * classifier. The entry is bound through `values` as an IRI, as the catalogue binds a focus:
 * a bare string there is a literal and silently matches nothing.
 */
const assertions = async (id: string) =>
  (
    await guardedQuery({
      from: at(1),
      to: at(await guardedHead()),
      select: ["?t"],
      values: [["?m"], [[{ "@type": "@id", "@value": messageIri(id) }]]],
      where: [{ "@id": "?m", "bus:json": { "@value": "?json", "@t": "?t", "@op": true } }],
    })
  ).length;

const joined = (from: string, session: string) =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from,
    to: ["*"],
    kind: "presence",
    body: `${from} joined`,
    origin: new Origin({ host: "qualify", cwd: dir }),
    presence: new Presence({ runtime: "claude", status: "joined", topics: [], session }),
  });

const qualifyGuardedPresence = async () => {
  const x = "claude/presence-x";
  const outcome = await withBus(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const basis = (yield* ledger.presenceAt()).cut;
      const first = joined(x, "first");
      const admitted = yield* ledger.admit(first, basis);
      // Decided at the same basis, so it is stale once the first lands.
      const stale = joined(x, "stale");
      const refused = yield* ledger.admit(stale, basis);
      const after = admitted.status === "ADMITTED" ? admitted.cut : basis;
      const other = yield* ledger.admit(joined("claude/presence-y", "other"), after);
      const unblocked = joined(x, "unblocked");
      const notBlocked = yield* ledger.admit(unblocked, after);
      const replayBasis = notBlocked.status === "ADMITTED" ? notBlocked.cut : after;
      const replay = yield* ledger.admit(unblocked, replayBasis);
      const raceBasis = (yield* ledger.presenceAt()).cut;
      const racers = [joined("claude/presence-z", "a"), joined("claude/presence-z", "b")];
      const raced = yield* Effect.all(
        racers.map((racer) => ledger.admit(racer, raceBasis)),
        { concurrency: "unbounded" }
      );
      return {
        first,
        admitted,
        stale,
        refused,
        other,
        unblocked,
        notBlocked,
        replay,
        racers,
        raced,
      };
    }),
    GUARDED
  );
  check(
    "a free presence lands at a commit past its basis",
    outcome.admitted.status === "ADMITTED" && (await assertions(outcome.first.id)) === 1
  );
  check(
    "a stale presence is refused and writes nothing",
    outcome.refused.status === "REFUSED" && (await assertions(outcome.stale.id)) === 0,
    outcome.refused.status
  );
  check(
    "another address's presence does not block",
    outcome.other.status === "ADMITTED" && outcome.notBlocked.status === "ADMITTED"
  );
  check(
    "an admitted id replayed from its own commit is refused and stored once",
    outcome.replay.status === "REFUSED" && (await assertions(outcome.unblocked.id)) === 1,
    outcome.replay.status
  );
  const landed = await Promise.all(outcome.racers.map((racer) => assertions(racer.id)));
  check(
    "of two presences on one basis exactly one lands, and the other writes nothing",
    outcome.raced.filter((r) => r.status === "ADMITTED").length === 1 &&
      outcome.raced.filter((r) => r.status === "REFUSED").length === 1 &&
      [...landed].sort().join() === "0,1",
    outcome.raced.map((r) => r.status).join(" ")
  );
};

type Outcome = "applied" | "not applied" | "identity mismatch" | "unknown";
interface Sent {
  readonly outcome: Outcome;
  /** The response's t, when Fluree answered. */
  readonly t?: number;
  readonly started: number;
  readonly ended: number;
}

/**
 * Sends a write and classifies it by its witness at the response's t: applied only when the
 * witness records this request, an identity mismatch when it records another. No response,
 * or any status but success, is unknown: the write may still have applied.
 */
const send = async (
  r: Replacement,
  options: { readonly origin?: string; readonly guard?: Guard } = {}
): Promise<Sent> => {
  const started = performance.now();
  const url = `${options.origin ?? config.url}/v1/fluree/update?ledger=${encodeURIComponent(GUARDED.ledger)}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(writeBody(r, options.guard ?? "full")),
    });
    const ended = performance.now();
    if (!response.ok) return { outcome: "unknown", started, ended };
    const { t } = (await response.json()) as { t: number };
    const witness = await witnessOf(r, t);
    const outcome =
      witness === "matches"
        ? "applied"
        : witness === "differs"
          ? "identity mismatch"
          : "not applied";
    return { outcome, t, started, ended };
  } catch {
    return { outcome: "unknown", started, ended: performance.now() };
  }
};

/** One bounded reconciliation: the request's witness at a fresh cut proves it applied; absence proves nothing. */
const reconcile = async (r: Replacement): Promise<Outcome> => {
  const witness = await witnessOf(r);
  return witness === "matches"
    ? "applied"
    : witness === "differs"
      ? "identity mismatch"
      : "unknown";
};

const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  JSON.stringify(a) === JSON.stringify(b);

const qualifyGuardedReplacement = async () => {
  const version = command([fluree, "--version"]);
  check("source citation matches the installed fluree", version.endsWith(" 4.2.4"), version);

  // The production layer creates the ledger, joins the reader and writes one ordinary entry,
  // which calibrates the history oracle before a zero from it is read as absence.
  const ordinary = await withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      yield* bus.join({ address: GUARD_READER, runtime: "codex", session: READER, cwd: dir });
      yield* bus.join({ address: "claude/a", runtime: "claude", session: SENDER, cwd: dir });
      return (yield* bus.publish({
        from: "claude/a",
        session: SENDER,
        to: [GUARD_READER],
        body: "ordinary",
      })).message;
    }),
    GUARDED
  );
  const calibrated =
    (await assertions(ordinary.id)) === 1 && (await assertions("never-written")) === 0;
  check("history oracle counts a known ordinary entry once", calibrated);
  if (!calibrated) return;
  /** Entries the reader should receive, by id. */
  const notified = [ordinary.id];

  // First set; a late first set finds the pointer and writes nothing; so does a mismatch.
  const first = replacement("a", null);
  const firstSent = await send(first);
  notified.push(first.op);
  check(
    "first set applies",
    firstSent.outcome === "applied" &&
      same(await pointerAt("a"), [first.op]) &&
      (await assertions(first.op)) === 1
  );
  const head = await guardedHead();
  const late = replacement("a", null);
  const lateSent = await send(late);
  const mismatch = replacement("a", "never-a-revision");
  const mismatchSent = await send(mismatch);
  check(
    "late first set and mismatched revision are successful no-ops",
    lateSent.outcome === "not applied" &&
      mismatchSent.outcome === "not applied" &&
      lateSent.t === head &&
      mismatchSent.t === head &&
      (await guardedHead()) === head &&
      (await assertions(late.op)) + (await assertions(mismatch.op)) === 0,
    `head stays ${head}`
  );

  // Scope b is set once and never moves with scope a.
  const other = replacement("b", null);
  await send(other);
  notified.push(other.op);

  // An unrelated commit does not stop a replacement; a writer that read the replaced
  // revision then writes nothing, although its response's t is past what it read.
  const read = await guardedHead();
  const unrelated = replacement("c", null);
  await send(unrelated);
  notified.push(unrelated.op);
  const toS = replacement("a", first.op);
  const sentS = await send(toS);
  notified.push(toS.op);
  check("replacement applies after an unrelated commit", sentS.outcome === "applied");
  const toT = replacement("a", toS.op);
  const sentT = await send(toT);
  notified.push(toT.op);
  const stale = replacement("a", toS.op);
  const staleSent = await send(stale);
  check(
    "stale writer writes nothing",
    sentT.outcome === "applied" &&
      staleSent.outcome === "not applied" &&
      same(await pointerAt("a"), [toT.op]) &&
      !(await witnessedAt(stale.op)) &&
      (await assertions(stale.op)) === 0
  );
  check(
    "control: classifying by t advancement calls the stale write applied",
    staleSent.t !== undefined && staleSent.t > read,
    `read at ${read}, answered at ${staleSent.t}`
  );

  // Each transition is visible exactly from its own commit; witnesses are never retracted.
  const tS = sentS.t ?? 0;
  const tT = sentT.t ?? 0;
  check(
    "historical cuts",
    same(await pointerAt("a", tS - 1), [first.op]) &&
      same(await pointerAt("a", tS), [toS.op]) &&
      same(await pointerAt("a", tT - 1), [toS.op]) &&
      same(await pointerAt("a", tT), [toT.op]) &&
      !(await witnessedAt(toS.op, tS - 1)) &&
      (await witnessedAt(toS.op, tS)) &&
      (await witnessedAt(toS.op)),
    `t ${tS - 1} -> ${tS} -> ${tT}`
  );
  check("other scope unchanged", same(await pointerAt("b"), [other.op]));

  // A request that reuses an already witnessed operation id changes nothing and is an identity
  // mismatch. The control drops only the witness condition.
  const reuse = async (scope: string, guard: Guard) => {
    const base = replacement(scope, null);
    await send(base);
    const next = replacement(scope, base.op);
    await send(next);
    notified.push(base.op, next.op);
    const conflicting = replacement(scope, next.op, base.op, "another request");
    return { base, next, sent: await send(conflicting, { guard }) };
  };
  const reused = await reuse("reuse", "full");
  check(
    "reusing a witnessed operation id is an identity mismatch and changes nothing",
    reused.sent.outcome === "identity mismatch" &&
      same(await pointerAt("reuse"), [reused.next.op]) &&
      (await assertions(reused.base.op)) === 1
  );
  const pointerOnly = await reuse("reuse-control", "pointer");
  notified.push(pointerOnly.base.op);
  check(
    "control: without the witness condition, reuse restores an old revision and notifies twice",
    same(await pointerAt("reuse-control"), [pointerOnly.base.op]) &&
      (await assertions(pointerOnly.base.op)) === 2,
    `classified ${pointerOnly.sent.outcome}`
  );

  // Control: without its condition the same stale write lands and the pointer forks.
  const unguarded = replacement("a", toS.op);
  const unguardedSent = await send(unguarded, { guard: "none" });
  notified.push(unguarded.op);
  check(
    "control: dropping the condition lets the stale write land",
    unguardedSent.outcome === "applied" && (await pointerAt("a")).length === 2
  );

  // Two writers that read the same revision; exactly one may apply. Client overlap only.
  const TRIALS = 20;
  let single = 0;
  let overlapped = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const scope = `race-${trial}`;
    const base = replacement(scope, null);
    await send(base);
    notified.push(base.op);
    const writers = [replacement(scope, base.op), replacement(scope, base.op)];
    const sent = await Promise.all(writers.map((writer) => send(writer)));
    if (Math.min(...sent.map((s) => s.ended)) > Math.max(...sent.map((s) => s.started)))
      overlapped += 1;
    const winners = writers.filter((_, i) => sent[i]?.outcome === "applied");
    notified.push(...winners.map((winner) => winner.op));
    const counts = await Promise.all(writers.map((writer) => assertions(writer.op)));
    if (
      winners.length === 1 &&
      sent.every((s) => s.outcome !== "unknown") &&
      same(await pointerAt(scope), [winners[0]?.op ?? ""]) &&
      counts.reduce((a, b) => a + b, 0) === 1
    )
      single += 1;
  }
  check(
    "one writer applies in each race",
    single === TRIALS,
    `${single}/${TRIALS}; overlapping at the client in ${overlapped}`
  );

  // The update reaches Fluree and its acknowledgement is lost.
  const relay = boundary(config.url);
  try {
    const before = replacement("lost", null);
    await send(before);
    notified.push(before.op);
    const lost = replacement("lost", before.op);
    const forwarded = relay.loseNextUpdate();
    const lostSent = await send(lost, { origin: relay.url });
    // The client can fail before the boundary takes the update, so the wait is bounded too.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      forwarded,
      new Promise<Forwarded>((settle) => {
        timer = setTimeout(() => settle({ failed: "the boundary never took the update" }), 35_000);
      }),
    ]);
    clearTimeout(timer);
    const status = "status" in outcome ? String(outcome.status) : `no response: ${outcome.failed}`;
    const reconciled = await reconcile(lost);
    const replayed = await send(lost);
    notified.push(lost.op);
    check(
      "lost acknowledgement is unknown, its witness reconciles it, and replay does not notify twice",
      "status" in outcome &&
        outcome.status === 200 &&
        lostSent.outcome === "unknown" &&
        reconciled === "applied" &&
        replayed.outcome === "applied" &&
        (await assertions(lost.op)) === 1 &&
        same(await pointerAt("lost"), [lost.op]),
      `Fluree answered ${status}; client saw ${lostSent.outcome}, reconciled ${reconciled}, replay ${replayed.outcome}`
    );
  } finally {
    relay.stop();
  }

  // A request that never reached Fluree has no witness, and reconciling it stays unknown:
  // absence alone is not evidence that the write failed, and looking changes nothing.
  const unsent = replacement("unsent", null);
  const unsentHead = await guardedHead();
  const unsentReconciled = await reconcile(unsent);
  check(
    "reconciling a write with no witness stays unknown and changes nothing",
    unsentReconciled === "unknown" &&
      (await pointerAt("unsent")).length === 0 &&
      (await assertions(unsent.op)) === 0 &&
      (await guardedHead()) === unsentHead,
    `reconciled ${unsentReconciled}`
  );

  // The production read path delivers each applied write's notification once, and nothing else.
  const received = await withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      return yield* bus.take(GUARD_READER, READER);
    }),
    GUARDED
  );
  check(
    "reader receives one notification per applied write",
    same(received.map((m) => m.id).sort(), [...notified].sort()),
    `${received.length} of ${notified.length}`
  );
};

try {
  await start();
  const corpus = Array.from({ length: 50 }, (_, i) => `routine status update ${i}`);
  await withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      yield* bus.join({
        address: "codex/reader",
        runtime: "codex",
        session: READER,
        cwd: process.cwd(),
      });
      yield* bus.join({
        address: "claude/a",
        runtime: "claude",
        session: SENDER,
        cwd: process.cwd(),
      });
      yield* bus.publish({
        from: "claude/a",
        session: SENDER,
        to: ["*"],
        body: "indexed: deploying the adapters",
      });
      for (const body of corpus)
        yield* bus.publish({ from: "claude/a", session: SENDER, to: ["*"], body });
    })
  );
  await waitForIndex();
  check("corpus indexed", (await indexLag()) === 0);

  // Restart with indexing held back; the reader's cursor predates the restart.
  await stop();
  await start(HOLD_INDEX);
  await withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      yield* bus.publish({
        from: "claude/a",
        session: SENDER,
        to: ["*"],
        body: "canary: redeployed adapter",
      });
    })
  );
  const lag = await indexLag();
  check("canary is unindexed novelty", lag > 0, `commit-t minus index-t = ${lag}`);

  const searchHeld = await search("deploy adapters");
  const expected = ["canary: redeployed adapter", "indexed: deploying the adapters"];
  check(
    "search spans indexed and novelty",
    JSON.stringify(bodies(searchHeld)) === JSON.stringify(expected),
    bodies(searchHeld).join(" | ")
  );

  const caughtUp = await withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      return yield* bus.take("codex/reader", READER);
    })
  );
  check(
    "cursor catches up across restart",
    caughtUp.length === corpus.length + 2,
    `${caughtUp.length} messages`
  );

  // A waiting reader survives the server restarting underneath its event stream.
  const woken = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const bus = yield* Bus.Bus;
        const waiting = yield* Effect.forkChild(bus.wait("codex/reader", READER, 60));
        yield* Effect.sleep("500 millis");
        yield* Effect.promise(stop);
        yield* Effect.promise(() => start());
        const sent = Date.now();
        yield* bus.publish({
          from: "claude/a",
          session: SENDER,
          to: ["codex/reader"],
          body: "after restart",
        });
        const messages = yield* Fiber.join(waiting);
        return { messages, ms: Date.now() - sent };
      }),
      busLayer()
    )
  );
  check(
    "waiting reader woken after restart",
    bodies(woken.messages).join() === "after restart",
    `${woken.ms} ms`
  );

  await waitForIndex();
  const searchIndexed = await search("deploy adapters");
  check(
    "same matches once indexed",
    JSON.stringify(bodies(searchIndexed)) === JSON.stringify(expected),
    bodies(searchIndexed).join(" | ")
  );

  // A pinned traversal survives a restart and later appends, resuming at its own t.
  const first = await historyPage({});
  const pinned = first.t;
  const whole = await withBus(
    Catalogue.history.run({ kinds: ["message"], limit: 200 }, { t: pinned }, undefined)
  );
  await stop();
  await start();
  await withBus(
    Effect.gen(function* () {
      const bus = yield* Bus.Bus;
      yield* bus.publish({ from: "claude/a", session: SENDER, to: ["*"], body: "after the pin" });
    })
  );
  const resumed = [...first.rows];
  let next = first.next;
  let last = first;
  while (next !== undefined) {
    last = await historyPage({ cursor: next });
    resumed.push(...last.rows);
    next = last.next;
  }
  const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id).join();
  check(
    "cursor resumes across restart at its snapshot",
    ids(resumed) === ids(whole.rows) && whole.complete && last.complete && last.t === pinned,
    `${resumed.length} rows at t=${pinned}, head now ${last.currentHeadT ?? pinned}`
  );

  await qualifyGuardedReplacement();
  await qualifyGuardedPresence();
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
