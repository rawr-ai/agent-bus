import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  DEFAULT_HISTORY_LIMIT,
  HistoryInputSchema,
  HistoryObservationSchema,
  MAX_HISTORY_LIMIT,
  PeersObservationSchema,
  projectHistory,
  projectPeers,
} from "../viewer/shared/public.ts";

const AT = "2026-01-02T03:04:05.000Z";
const MARK = "MARKER-private-7f3a9c";
const FAILED = "Public observation rejected";
const base = { limit: 50 };

const message = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  ts: "2026-01-01T00:00:00.000Z",
  from: "agent/a",
  to: ["agent/b"],
  kind: "message",
  body: `body ${id}`,
  ...extra,
});
const peer = (address: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  address,
  runtime: "other",
  topics: [],
  ...extra,
});

// Method signatures are bivariant, so hostile non-typed inputs reach the projectors uncast.
interface Loose {
  history(value: unknown, criteria: unknown, observedAt: unknown): unknown;
  peers(value: unknown, observedAt: unknown): unknown;
}
const loose: Loose = { history: projectHistory, peers: projectPeers };

const thrown = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected a generic Error");
};
const expectGeneric = (run: () => unknown) => {
  const error = thrown(run);
  expect(error.message).toBe(FAILED);
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  expect(Object.hasOwn(error, "cause")).toBe(false);
  for (const name of Object.getOwnPropertyNames(error)) {
    expect(String(Reflect.get(error, name))).not.toContain(MARK);
  }
};

const histIds = (messages: unknown[], criteria = base) =>
  projectHistory({ messages }, criteria, AT).messages.map((m) => m.id);

test("limits are the contracted constants", () => {
  expect(MAX_HISTORY_LIMIT).toBe(200);
  expect(DEFAULT_HISTORY_LIMIT).toBe(200);
});

describe("history projection", () => {
  test("keeps only named public fields at every level", () => {
    const result = projectHistory(
      {
        messages: [
          {
            id: "m1",
            ts: "2026-01-01T00:00:00.000Z",
            from: "agent/a",
            to: ["agent/b", "#topic", "*"],
            kind: "message",
            body: "hello",
            subject: "s",
            replyTo: "m0",
            origin: { host: "h", cwd: "/w", repo: "/r", branch: "b", internal: { secret: MARK } },
            presence: { session: MARK },
            internal: { secret: MARK },
          },
        ],
        extra: MARK,
        session: MARK,
      },
      base,
      AT
    );
    expect(result).toStrictEqual({
      messages: [
        {
          id: "m1",
          ts: "2026-01-01T00:00:00.000Z",
          from: "agent/a",
          to: ["agent/b", "#topic", "*"],
          kind: "message",
          body: "hello",
          subject: "s",
          replyTo: "m0",
          origin: { host: "h", cwd: "/w", repo: "/r", branch: "b" },
        },
      ],
      criteria: { limit: 50 },
      observedAt: "2026-01-02T03:04:05.000Z",
      omitted: 0,
    });
    expect(JSON.stringify(result)).not.toContain(MARK);
    expect(Schema.is(HistoryObservationSchema)(result)).toBe(true);
  });

  test("origin keeps exactly the fields it has", () => {
    const result = projectHistory(
      {
        messages: [message("a", { origin: { host: "h" } }), message("b", { origin: { host: "" } })],
      },
      base,
      AT
    );
    expect(result.messages.map((m) => m.origin)).toStrictEqual([{ host: "h" }, { host: "" }]);
  });

  test("permits optional fields and unvalidated public strings", () => {
    const result = projectHistory(
      {
        messages: [
          message("", {
            ts: "not a date",
            from: "",
            body: "",
            subject: "",
            replyTo: "",
            to: [],
          }),
        ],
      },
      base,
      AT
    );
    expect(result.messages).toStrictEqual([
      {
        id: "",
        ts: "not a date",
        from: "",
        to: [],
        kind: "message",
        body: "",
        subject: "",
        replyTo: "",
      },
    ]);
    expect(result.omitted).toBe(0);
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["subject type", { subject: 5 }],
    ["subject undefined", { subject: undefined }],
    ["replyTo null", { replyTo: null }],
    ["origin null", { origin: null }],
    ["origin array", { origin: [] }],
    ["origin without host", { origin: { cwd: "/w" } }],
    ["origin host type", { origin: { host: 1 } }],
    ["origin cwd type", { origin: { host: "h", cwd: 5 } }],
    ["origin repo type", { origin: { host: "h", repo: null } }],
    ["origin branch type", { origin: { host: "h", branch: [] } }],
    ["to string", { to: "agent/b" }],
    ["to member", { to: ["agent/b", 1] }],
    ["to sparse", { to: new Array(1) }],
    ["ts type", { ts: 5 }],
    ["from type", { from: null }],
    ["body type", { body: 5 }],
    ["kind presence", { kind: "presence", presence: { session: MARK } }],
    ["kind casing", { kind: "Message" }],
    ["kind undefined", { kind: undefined }],
  ];
  for (const [name, extra] of invalid) {
    test(`omits a record with invalid ${name}`, () => {
      const result = projectHistory({ messages: [message("m1", extra)] }, base, AT);
      expect(result.messages).toStrictEqual([]);
      expect(result.omitted).toBe(1);
    });
  }

  for (const key of ["id", "ts", "from", "to", "kind", "body"]) {
    test(`omits a record missing ${key}`, () => {
      const record = message("m1");
      delete record[key];
      const result = projectHistory({ messages: [record] }, base, AT);
      expect(result.messages).toStrictEqual([]);
      expect(result.omitted).toBe(1);
    });
  }

  test("counts every non-record and hole once", () => {
    const raw: unknown[] = new Array(5);
    raw[0] = message("a");
    raw[2] = null;
    raw[3] = "text";
    raw[4] = [message("nested")];
    const result = projectHistory({ messages: raw }, base, AT);
    expect(result.messages.map((m) => m.id)).toStrictEqual(["a"]);
    expect(result.omitted).toBe(4);
  });

  test("mixes valid, unexpected-kind and malformed records with an exact count", () => {
    const result = projectHistory(
      {
        messages: [
          message("a"),
          message("p", { kind: "presence" }),
          message("b", { body: 1 }),
          message("c"),
        ],
      },
      base,
      AT
    );
    expect(result.messages.map((m) => m.id)).toStrictEqual(["a", "c"]);
    expect(result.omitted).toBe(2);
  });

  test("withholds every record sharing an id, same or different body", () => {
    const raw = [
      message("d"),
      message("d"),
      message("e", { body: "one" }),
      message("e", { body: "two" }),
      message("f"),
    ];
    const result = projectHistory({ messages: raw }, base, AT);
    expect(result.messages.map((m) => m.id)).toStrictEqual(["f"]);
    expect(result.omitted).toBe(4);
  });

  test("a malformed or unexpected-kind record withholds a valid one with the same id", () => {
    const raw = [
      message("x", { body: 5 }),
      message("x"),
      message("y", { kind: "presence" }),
      message("y"),
      message("z"),
    ];
    const result = projectHistory({ messages: raw }, base, AT);
    expect(result.messages.map((m) => m.id)).toStrictEqual(["z"]);
    expect(result.omitted).toBe(4);
  });

  test("non-string and absent ids are invalid and never collide", () => {
    const noId = message("n");
    delete noId.id;
    const raw = [
      message("5"),
      { ...message("p"), id: 5 },
      { ...message("q"), id: 5 },
      noId,
      { ...noId },
    ];
    const result = projectHistory({ messages: raw }, base, AT);
    expect(result.messages.map((m) => m.id)).toStrictEqual(["5"]);
    expect(result.omitted).toBe(4);
  });

  test("all omitted is success, distinct from empty", () => {
    const allOmitted = projectHistory({ messages: [null, message("a", { kind: "x" })] }, base, AT);
    expect(allOmitted.messages).toStrictEqual([]);
    expect(allOmitted.omitted).toBe(2);
    const empty = projectHistory({ messages: [] }, base, AT);
    expect(empty.messages).toStrictEqual([]);
    expect(empty.omitted).toBe(0);
  });

  test("keeps upstream order without parsing dates", () => {
    const raw = [
      message("b", { ts: "9999-12-31" }),
      message("a", { ts: "not a date" }),
      message("c", { ts: "0001-01-01" }),
      message("d", { ts: "" }),
    ];
    expect(histIds(raw)).toStrictEqual(["b", "a", "c", "d"]);
  });

  test("rejects roots that are not the bare collection", () => {
    const roots: unknown[] = [
      null,
      undefined,
      "text",
      5,
      [],
      [{ messages: [] }],
      {},
      { messages: "x" },
      { messages: {} },
      { messages: null },
      { peers: [] },
      { result: { messages: [] } },
      { structuredContent: { messages: [] } },
      { content: [{ type: "text", text: '{"messages":[]}' }] },
      { results: '{"messages":[]}' },
      '{"messages":[]}',
    ];
    for (const root of roots) expectGeneric(() => projectHistory(root, base, AT));
  });

  test("fails the whole observation above the requested bound, never truncating", () => {
    const three = [message("a"), message("b"), message("c")];
    expectGeneric(() => projectHistory({ messages: three }, { limit: 2 }, AT));
    expectGeneric(() => projectHistory({ messages: [message("a"), null] }, { limit: 1 }, AT));
    expect(histIds(three.slice(0, 2), { limit: 2 })).toStrictEqual(["a", "b"]);
  });

  test("copies criteria and records without mutating or aliasing input", () => {
    const criteria = Object.freeze({ query: " Q ", participant: " P", limit: 5 });
    const to = ["agent/b"];
    const origin = { host: "h", cwd: "/w" };
    const raw = { messages: [message("m1", { to, origin })] };
    const before = JSON.stringify(raw);
    const result = projectHistory(raw, criteria, AT);
    expect(JSON.stringify(raw)).toBe(before);
    expect(result.criteria).toStrictEqual({ query: " Q ", participant: " P", limit: 5 });
    expect(result.criteria).not.toBe(criteria);
    expect(result.messages[0]?.to).not.toBe(to);
    expect(result.messages[0]?.origin).not.toBe(origin);
    to.push("late");
    origin.cwd = "/changed";
    expect(result.messages[0]?.to).toStrictEqual(["agent/b"]);
    expect(result.messages[0]?.origin).toStrictEqual({ host: "h", cwd: "/w" });
    expect(Object.hasOwn(projectHistory({ messages: [] }, base, AT).criteria, "query")).toBe(false);
  });

  test("quarantined marker-bearing data never appears in the observation", () => {
    const result = projectHistory(
      { messages: [message("a", { body: { secret: MARK } }), message("b", { extra: MARK })] },
      base,
      AT
    );
    expect(result.messages.map((m) => m.id)).toStrictEqual(["b"]);
    expect(JSON.stringify(result)).not.toContain(MARK);
  });

  test("rejects a non-string observation time", () => {
    for (const at of [undefined, 5, null, { MARK }]) {
      expectGeneric(() => loose.history({ messages: [] }, base, at));
    }
  });
});

describe("history input contract", () => {
  const standard = Schema.toStandardSchemaV1(HistoryInputSchema, {
    parseOptions: { onExcessProperty: "error" },
  });
  const validate = (input: unknown) => {
    const result = standard["~standard"].validate(input);
    if (result instanceof Promise) throw new Error("expected synchronous validation");
    return result;
  };

  const accepted: unknown[] = [
    { limit: 1 },
    { limit: 200 },
    { query: "q", participant: "p", limit: 50 },
    { query: "x".repeat(256), limit: 1 },
    { participant: "y".repeat(512), limit: 1 },
    { query: " ", participant: " ", limit: 1 },
  ];
  const rejected: unknown[] = [
    {},
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { limit: "5" },
    { limit: Number.NaN },
    { limit: Number.POSITIVE_INFINITY },
    { limit: null },
    { query: "", limit: 1 },
    { query: "x".repeat(257), limit: 1 },
    { query: 5, limit: 1 },
    { participant: "", limit: 1 },
    { participant: "y".repeat(513), limit: 1 },
    { participant: null, limit: 1 },
    { limit: 1, extra: true },
    null,
    [],
    "limit",
  ];

  accepted.forEach((input, index) => {
    test(`accepts case ${index} natively and in the projector`, () => {
      expect("value" in validate(input)).toBe(true);
      expect(() => loose.history({ messages: [] }, input, AT)).not.toThrow();
    });
  });
  rejected.forEach((input, index) => {
    test(`rejects case ${index} natively and in the projector`, () => {
      expect("value" in validate(input)).toBe(false);
      expectGeneric(() => loose.history({ messages: [] }, input, AT));
    });
  });

  test("preserves whitespace and case exactly", () => {
    const result = validate({ query: "  Mixed Case ", participant: " Agent/X\n", limit: 7 });
    expect("value" in result ? result.value : undefined).toStrictEqual({
      query: "  Mixed Case ",
      participant: " Agent/X\n",
      limit: 7,
    });
    const projected = projectHistory({ messages: [] }, { query: " Q", limit: 1 }, AT);
    expect(projected.criteria).toStrictEqual({ query: " Q", limit: 1 });
  });
});

describe("peers projection", () => {
  test("keeps only named public fields and clones topics", () => {
    const topics = ["t1", "#t2"];
    const result = projectPeers(
      {
        peers: [
          peer("claude/a", {
            runtime: "claude",
            topics,
            host: "h",
            note: "working",
            session: MARK,
            codexThreadId: MARK,
            presence: { secret: MARK },
          }),
          peer("codex/b", { runtime: "codex" }),
        ],
        extra: MARK,
      },
      AT
    );
    expect(result).toStrictEqual({
      peers: [
        {
          address: "claude/a",
          runtime: "claude",
          topics: ["t1", "#t2"],
          host: "h",
          note: "working",
        },
        { address: "codex/b", runtime: "codex", topics: [] },
      ],
      observedAt: "2026-01-02T03:04:05.000Z",
      omitted: 0,
    });
    expect(result.peers[0]?.topics).not.toBe(topics);
    topics.push("late");
    expect(result.peers[0]?.topics).toStrictEqual(["t1", "#t2"]);
    expect(JSON.stringify(result)).not.toContain(MARK);
    expect(Schema.is(PeersObservationSchema)(result)).toBe(true);
  });

  test("accepts exactly the four runtimes and empty optional strings", () => {
    const result = projectPeers(
      {
        peers: [
          peer("a", { runtime: "claude", host: "", note: "" }),
          peer("b", { runtime: "codex" }),
          peer("c", { runtime: "human" }),
          peer("d", { runtime: "other" }),
          peer("e", { runtime: "Claude" }),
          peer("f", { runtime: "bot" }),
          peer("g", { runtime: 5 }),
        ],
      },
      AT
    );
    expect(result.peers.map((p) => `${p.address}:${p.runtime}`)).toStrictEqual([
      "a:claude",
      "b:codex",
      "c:human",
      "d:other",
    ]);
    expect(result.peers[0]).toStrictEqual({
      address: "a",
      runtime: "claude",
      topics: [],
      host: "",
      note: "",
    });
    expect(result.omitted).toBe(3);
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["topics string", { topics: "t" }],
    ["topics member", { topics: ["t", 1] }],
    ["host type", { host: 5 }],
    ["host undefined", { host: undefined }],
    ["note null", { note: null }],
    ["address type", { address: 5 }],
  ];
  for (const [name, extra] of invalid) {
    test(`omits a peer with invalid ${name}`, () => {
      const result = projectPeers({ peers: [peer("a", extra)] }, AT);
      expect(result.peers).toStrictEqual([]);
      expect(result.omitted).toBe(1);
    });
  }

  test("omits a peer missing a required field", () => {
    for (const key of ["address", "runtime", "topics"]) {
      const record = peer("a");
      delete record[key];
      const result = projectPeers({ peers: [record] }, AT);
      expect(result.peers).toStrictEqual([]);
      expect(result.omitted).toBe(1);
    }
  });

  test("withholds every peer sharing an address, including malformed collisions", () => {
    const result = projectPeers(
      {
        peers: [
          peer("dup"),
          peer("dup", { note: "other" }),
          peer("bad", { runtime: "nope" }),
          peer("bad"),
          peer("7"),
          { ...peer("x"), address: 7 },
          { ...peer("y"), address: 7 },
          peer("ok"),
        ],
      },
      AT
    );
    expect(result.peers.map((p) => p.address)).toStrictEqual(["7", "ok"]);
    expect(result.omitted).toBe(6);
  });

  test("keeps upstream order, and distinguishes all omitted from empty", () => {
    const ordered = projectPeers({ peers: [peer("z"), peer("a"), peer("m")] }, AT);
    expect(ordered.peers.map((p) => p.address)).toStrictEqual(["z", "a", "m"]);
    const allOmitted = projectPeers({ peers: [null, 3, "x"] }, AT);
    expect(allOmitted.peers).toStrictEqual([]);
    expect(allOmitted.omitted).toBe(3);
    expect(projectPeers({ peers: [] }, AT)).toStrictEqual({
      peers: [],
      observedAt: "2026-01-02T03:04:05.000Z",
      omitted: 0,
    });
  });

  test("rejects malformed roots and wrappers", () => {
    const roots: unknown[] = [
      null,
      "text",
      [],
      {},
      { peers: {} },
      { peers: "x" },
      { messages: [] },
      { structuredContent: { peers: [] } },
      { content: [{ type: "text", text: '{"peers":[]}' }] },
      '{"peers":[]}',
    ];
    for (const root of roots) expectGeneric(() => projectPeers(root, AT));
    expectGeneric(() => loose.peers({ peers: [] }, 5));
  });

  test("enforces the 1000 peer bound without truncating", () => {
    const make = (count: number) => Array.from({ length: count }, (_, i) => peer(`a/${i}`));
    const ok = projectPeers({ peers: make(1000) }, AT);
    expect(ok.peers.length).toBe(1000);
    expect(ok.omitted).toBe(0);
    expectGeneric(() => projectPeers({ peers: make(1001) }, AT));
  });
});

test("failures are generic and never carry input, schema or causes", () => {
  const trap = {};
  Object.defineProperty(trap, "messages", {
    enumerable: true,
    get: () => {
      throw new Error(MARK);
    },
  });
  const many = Array.from({ length: 3 }, (_, i) => message(`${MARK}-${i}`, { body: MARK }));
  const cases: Array<() => unknown> = [
    () => projectHistory(MARK, base, AT),
    () => projectHistory({ messages: MARK }, base, AT),
    () => projectHistory({ content: [{ type: "text", text: MARK }] }, base, AT),
    () => projectHistory({ messages: many }, { limit: 2 }, AT),
    () => projectHistory(trap, base, AT),
    () => loose.history({ messages: [] }, { limit: 1, [MARK]: MARK }, AT),
    () => loose.history({ messages: [] }, { query: MARK, limit: 0 }, AT),
    () => loose.history({ messages: [] }, base, { MARK }),
    () => projectPeers(MARK, AT),
    () => projectPeers({ peers: Array.from({ length: 1001 }, () => peer(MARK)) }, AT),
    () => loose.peers({ peers: [] }, { MARK }),
  ];
  for (const run of cases) expectGeneric(run);
});
