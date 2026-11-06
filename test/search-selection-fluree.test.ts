// Search's one ranking evaluation and its hydration on the real query engine: how Fluree groups
// an entry's typed nodes, and whether each node's identity survives into a later call at t.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { history, search } from "../src/catalogue.ts";
import { Message, MessageJson, Origin } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { QueryGateway } from "../src/Query.ts";
import {
  PROCESS_POLICY,
  RankedSelections,
  make as selectionStore,
} from "../src/RankedSelections.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const encodeJson = Schema.encodeSync(MessageJson);
let n = 0;
const message = (body: string, extra: Partial<{ subject: string }> = {}) =>
  new Message({
    id: `q-${String(++n).padStart(4, "0")}`,
    ts: new Date(Date.parse("2026-11-01T09:00:00Z") + n * 60_000).toISOString(),
    from: "claude/a",
    to: ["codex/b"],
    kind: "message",
    body,
    ...extra,
    origin: new Origin({ host: "h", cwd: "/w" }),
  });

type Json = Record<string, unknown>;
type Ranked = [number, string, number, ReadonlyArray<string>];

/** A node without its context, to sit in a graph with others. */
const bare = (node: Json) => {
  const { "@context": _, ...rest } = node;
  return rest;
};

test("one grouped evaluation keeps every node of an entry, and hydration reads each back at t", async () => {
  const config = await freshLedger("search-selection");
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      layerFluree(config).pipe(Layer.provide(platform)),
      Layer.effect(RankedSelections, selectionStore(PROCESS_POLICY))
    )
  );
  const gateway = await runtime.runPromise(QueryGateway);
  // The first pin creates the ledger.
  await runtime.runPromise(gateway.pin);
  const insert = (node: unknown) => insertRaw(config, node);
  const context = toNode(message("unused"), "")["@context"];
  /** The entry's canonical node, and a second node of the same entry under `iri`. */
  const twin = (m: Message, json: string | undefined, iri: string, body = m.body) => {
    stored(m, canonical(m), encodeJson(m));
    stored(m, iri, json ?? null);
    const { "bus:json": _json, ...second } = bare(toNode(m, ""));
    return insert({
      "@context": context,
      "@graph": [
        bare(toNode(m, encodeJson(m))),
        {
          ...second,
          ...(json === undefined ? {} : { "bus:json": json }),
          "@id": iri,
          "bus:body": body,
        },
      ],
    });
  };

  const valid: Array<Message> = [];
  const damaged: Array<Message> = [];
  /** Each entry's nodes and their stored encodings, as inserted; a blank node is named "_:". */
  const nodes = new Map<string, Array<[string, string | null]>>();
  const stored = (m: Message, iri: string, ...json: Array<string | null>) =>
    nodes.set(m.id, [
      ...(nodes.get(m.id) ?? []),
      ...json.map((j): [string, string | null] => [iri, j]),
    ]);
  const canonical = (m: Message) => `urn:agent-bus:message:${m.id}`;
  const clean = message("kiwi clean");
  await insert(toNode(clean, encodeJson(clean)));
  stored(clean, canonical(clean), encodeJson(clean));
  valid.push(clean);
  const copies = message("kiwi copies");
  await insert({
    ...toNode(copies, encodeJson(copies)),
    "bus:json": [encodeJson(copies), `${encodeJson(copies)} `],
  });
  stored(copies, canonical(copies), encodeJson(copies), `${encodeJson(copies)} `);
  damaged.push(copies);
  const same = message("kiwi same json on two nodes");
  await twin(same, encodeJson(same), `urn:agent-bus:alt:${same.id}`);
  valid.push(same);
  const differing = message("kiwi differing json on two nodes");
  await twin(differing, `${encodeJson(differing)} `, `urn:agent-bus:alt:${differing.id}`);
  damaged.push(differing);
  const missing = message("kiwi second node without json");
  await twin(missing, undefined, `urn:agent-bus:alt:${missing.id}`);
  damaged.push(missing);
  const compact = message("kiwi alias in the bus namespace");
  // Inserted under the compact form; it is stored, and read back, in the bus namespace.
  await twin(compact, encodeJson(compact), `bus:alias-${compact.id}`);
  valid.push(compact);
  const other = message("kiwi only a non-canonical node");
  await insert({ ...toNode(other, encodeJson(other)), "@id": `urn:other:${other.id}` });
  stored(other, `urn:other:${other.id}`, encodeJson(other));
  valid.push(other);
  const blank = message("kiwi blank node");
  const { "@id": _id, ...blankNode } = toNode(blank, encodeJson(blank));
  await insert(blankNode);
  stored(blank, "_:", encodeJson(blank));
  valid.push(blank);
  // The conflicting encoding sits only on the entry's lower-scoring node.
  const split = message("kiwi kiwi kiwi split entry", { subject: "unrelated words" });
  await twin(
    split,
    `${encodeJson(split)}  `,
    `urn:agent-bus:alt:${split.id}`,
    "kiwi words and more words"
  );
  damaged.push(split);
  const entries = valid.length + damaged.length;

  const select = (t: number, limit: number) =>
    runtime.runPromise(
      gateway.jsonld(t, {
        select: ["?t", "?id", "(as (max ?score) ?best)", "(as (collect-distinct ?m) ?subjects)"],
        values: [["?q"], [["kiwi"]]],
        where: [
          { "@id": "?m", "@type": "bus:Message" },
          { "@id": "?m", "bus:id": { "@value": "?id", "@t": "?t" } },
          ["union", { "@id": "?m", "bus:body": "?text" }, { "@id": "?m", "bus:subject": "?text" }],
          ["bind", "?score", "(fulltext ?text ?q)"],
          ["filter", "(> ?score 0)"],
        ],
        groupBy: ["?t", "?id"],
        orderBy: [["desc", "?best"], "?t", "?id"],
        limit,
      })
    ) as Promise<Array<Ranked>>;
  // A new ledger's index can briefly find nothing.
  const { head } = await runtime.runPromise(gateway.pin);
  let ranked: Array<Ranked> = [];
  const everyId = [...valid, ...damaged].map((m) => m.id).sort();
  const idsOf = (rows: ReadonlyArray<Ranked>) => rows.map(([, id]) => id).sort();
  for (let attempt = 0; attempt < 60 && ranked.length < entries; attempt++) {
    ranked = await select(head, 100);
    if (ranked.length < entries) await Bun.sleep(100);
  }
  expect(idsOf(ranked)).toEqual(everyId);
  for (const row of ranked) expect(Array.isArray(row[3])).toBe(true);
  const subjectsOf = (rows: ReadonlyArray<Ranked>, m: Message) =>
    [...(rows.find(([, id]) => id === m.id)?.[3] ?? [])].sort();
  // Subjects come back as an array even when single, a bus-namespace IRI compacted, and a blank
  // node as its label.
  expect(subjectsOf(ranked, clean)).toEqual([`urn:agent-bus:message:${clean.id}`]);
  expect(subjectsOf(ranked, compact)).toEqual(
    [`bus:alias-${compact.id}`, `urn:agent-bus:message:${compact.id}`].sort()
  );
  expect(subjectsOf(ranked, blank)).toEqual([expect.stringMatching(/^_:/)]);

  // The split entry's alias scores lower than its canonical node, yet positively.
  const perNode = (await runtime.runPromise(
    gateway.jsonld(head, {
      select: ["?m", "(as (max ?score) ?best)"],
      values: [["?q"], [["kiwi"]]],
      where: [
        { "@id": "?m", "bus:id": split.id },
        ["union", { "@id": "?m", "bus:body": "?text" }, { "@id": "?m", "bus:subject": "?text" }],
        ["bind", "?score", "(fulltext ?text ?q)"],
        ["filter", "(> ?score 0)"],
      ],
      groupBy: ["?m"],
    })
  )) as Array<[string, number]>;
  const scoreOf = (iri: string) => perNode.find(([m]) => m === iri)?.[1] ?? 0;
  expect(scoreOf(`urn:agent-bus:alt:${split.id}`)).toBeGreaterThan(0);
  expect(scoreOf(`urn:agent-bus:alt:${split.id}`)).toBeLessThan(scoreOf(canonical(split)));
  // The limit counts whole entries: at the cut the split entry is last with both nodes, and one
  // more is exactly the next entry of the full ranking.
  const cutAt = ranked.findIndex(([, id]) => id === split.id) + 1;
  expect(cutAt).toBeLessThan(entries);
  const sorted = (rows: ReadonlyArray<Ranked>) =>
    rows.map(([t, id, score, subjects]) => [t, id, score, [...subjects].sort()]);
  for (const limit of [cutAt, cutAt + 1]) {
    const cut = await select(head, limit);
    expect(sorted(cut)).toEqual(sorted(ranked.slice(0, limit)));
    expect(subjectsOf(cut, split)).toEqual(
      [`urn:agent-bus:alt:${split.id}`, canonical(split)].sort()
    );
  }

  // Hydration through the captured subjects reads back exactly the stored relation: each node's
  // own (t, id) and every encoding, a missing one as null.
  const tOf = new Map(ranked.map(([t, id]) => [id, t]));
  const subjects = ranked.flatMap(([, , , s]) => s);
  const hydrated = (await runtime.runPromise(
    gateway.jsonld(head, {
      selectDistinct: ["?m", "?t", "?id", "?json"],
      values: [["?m"], subjects.map((subject) => [{ "@type": "@id", "@value": subject }])],
      where: [
        { "@id": "?m", "bus:id": { "@value": "?id", "@t": "?t" } },
        ["optional", { "@id": "?m", "bus:json": "?json" }],
      ],
    })
  )) as Array<[string, number, string, string | null]>;
  const named = (iri: string) => (iri.startsWith("_:") ? "_:" : iri);
  const expected = [...nodes].flatMap(([id, list]) =>
    list.map(([iri, json]) => [iri, tOf.get(id), id, json])
  );
  const key = (row: ReadonlyArray<unknown>) => JSON.stringify(row);
  expect(hydrated.map(([m, t, id, json]) => key([named(m), t, id, json])).sort()).toEqual(
    expected.map(key).sort()
  );

  // Through the operation: each valid entry is one row and each damaged one is counted once.
  const whole = await runtime.runPromise(
    search.run({ text: "kiwi", limit: 50 }, { t: head }, undefined)
  );
  expect(whole.rows.map((row) => row.id).sort()).toEqual(valid.map((m) => m.id).sort());
  expect(whole).toMatchObject({ damaged: damaged.length, exhausted: true });

  // Pages of one are the same traversal, and writes after t neither leak into nor damage it:
  // another copy of a valid entry, and a new match.
  const paged: Array<string> = [];
  let page = await runtime.runPromise(
    search.run({ text: "kiwi", limit: 1 }, { t: head }, undefined)
  );
  paged.push(...page.rows.map((row) => row.id));
  await insert(toNode(clean, `${encodeJson(clean)}   `));
  const late = message("kiwi written after the traversal began");
  await insert(toNode(late, encodeJson(late)));
  while (page.next !== undefined) {
    page = await runtime.runPromise(
      search.run({ text: "kiwi", limit: 1 }, { cursor: page.next }, undefined)
    );
    paged.push(...page.rows.map((row) => row.id));
  }
  expect(paged.sort()).toEqual(valid.map((m) => m.id).sort());
  expect(page).toMatchObject({ damagedTotal: damaged.length, exhausted: true });

  // Other operations keep their cursors: one built by hand in the format issued before kept
  // rankings, with no revision or handle, continues history exactly as the issued one does.
  // At the blank node's commit, the newest two entries (it and the non-canonical one) are valid.
  const at = tOf.get(blank.id) as number;
  const latest = await runtime.runPromise(
    history.run({ direction: "backward", limit: 2 }, { t: at }, undefined)
  );
  expect(latest.rows.map((row) => row.id)).toEqual([blank.id, other.id]);
  const last = latest.rows.at(-1);
  const { limit: _limit, ...hashed } = latest.args as Json;
  const sortedJson = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(sortedJson).join(",")}]`
      : typeof value === "object" && value !== null
        ? `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${sortedJson((value as Json)[key])}`)
            .join(",")}}`
        : JSON.stringify(value);
  const handBuilt = {
    v: 1,
    cv: 1,
    op: "history",
    h: createHash("sha256")
      .update(sortedJson(hashed))
      .digest()
      .subarray(0, 16)
      .toString("base64url"),
    i: latest.ledger,
    t: at,
    n: 2,
    p: { before: [last?.t, last?.id] },
    u: 0,
  };
  const issued = JSON.parse(Buffer.from((latest.next as string).slice(4), "base64url").toString());
  expect(issued).toEqual(handBuilt);
  const continued = (cursor: string) =>
    runtime.runPromise(history.run({ direction: "backward", limit: 2 }, { cursor }, undefined));
  expect(
    (await continued(`bq1.${Buffer.from(JSON.stringify(handBuilt)).toString("base64url")}`)).rows
  ).toEqual((await continued(latest.next as string)).rows);
  await runtime.dispose();
});
