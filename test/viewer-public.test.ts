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
  projectThread,
  ThreadObservationSchema,
} from "../viewer/shared/public.ts";

const AT = "2026-01-02T03:04:05.000Z";
const MARK = "MARKER-private-7f3a9c";
const FAILED = "Public observation rejected";
const base = { limit: 50 };

const LEDGER = "ledger-incarnation";
const SNAPSHOT_T = 10_000;
// Each fixture gets the next commit, so commit order is the order fixtures are made in.
let commit = 0;
const message = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  t: ++commit,
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
  status: "joined",
  topics: [],
  t: ++commit,
  ...extra,
});

/** One bus_run_query page at SNAPSHOT_T, exhausted and not claimed complete unless overridden. */
const page = (rows: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "history",
  catalogueVersion: 1,
  ledger: LEDGER,
  t: SNAPSHOT_T,
  unit: "entry",
  args: {},
  rows,
  damage: "checked",
  damaged: 0,
  damagedTotal: 0,
  exhausted: true,
  complete: false,
  note: "note",
  ...extra,
});
const hist = (rows: unknown, extra: Record<string, unknown> = {}) => [page(rows, extra)];
const peerPages = (rows: unknown, extra: Record<string, unknown> = {}) => [
  page(rows, { name: "peers", unit: "address", ...extra }),
];
const SNAPSHOT = { ledger: LEDGER, t: SNAPSHOT_T };

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
  projectHistory(hist(messages), criteria, AT).messages.map((m) => m.id);

test("limits are the contracted constants", () => {
  expect(MAX_HISTORY_LIMIT).toBe(200);
  expect(DEFAULT_HISTORY_LIMIT).toBe(200);
});

describe("history projection", () => {
  test("keeps only named public fields at every level", () => {
    const result = projectHistory(
      hist(
        [
          {
            t: 1,
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
        { extra: MARK, session: MARK }
      ),
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
      snapshot: SNAPSHOT,
      window: "all",
      damaged: 0,
      complete: false,
    });
    expect(JSON.stringify(result)).not.toContain(MARK);
    expect(Schema.is(HistoryObservationSchema)(result)).toBe(true);
  });

  test("origin keeps exactly the fields it has", () => {
    const result = projectHistory(
      hist([message("a", { origin: { host: "h" } }), message("b", { origin: { host: "" } })]),
      base,
      AT
    );
    expect(result.messages.map((m) => m.origin)).toStrictEqual([{ host: "h" }, { host: "" }]);
  });

  test("permits optional fields and unvalidated public strings", () => {
    const result = projectHistory(
      hist([
        message("", {
          ts: "not a date",
          from: "",
          body: "",
          subject: "",
          replyTo: "",
          to: [],
        }),
      ]),
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
      const result = projectHistory(hist([message("m1", extra)]), base, AT);
      expect(result.messages).toStrictEqual([]);
      expect(result.omitted).toBe(1);
    });
  }

  for (const key of ["id", "ts", "from", "to", "kind", "body"]) {
    test(`omits a record missing ${key}`, () => {
      const record = message("m1");
      delete record[key];
      const result = projectHistory(hist([record]), base, AT);
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
    const result = projectHistory(hist(raw), base, AT);
    expect(result.messages.map((m) => m.id)).toStrictEqual(["a"]);
    expect(result.omitted).toBe(4);
  });

  test("mixes valid, unexpected-kind and malformed records with an exact count", () => {
    const result = projectHistory(
      hist([
        message("a"),
        message("p", { kind: "presence" }),
        message("b", { body: 1 }),
        message("c"),
      ]),
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
    const result = projectHistory(hist(raw), base, AT);
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
    const result = projectHistory(hist(raw), base, AT);
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
    const result = projectHistory(hist(raw), base, AT);
    expect(result.messages.map((m) => m.id)).toStrictEqual(["5"]);
    expect(result.omitted).toBe(4);
  });

  test("all omitted is success, distinct from empty", () => {
    const allOmitted = projectHistory(hist([null, message("a", { kind: "x" })]), base, AT);
    expect(allOmitted.messages).toStrictEqual([]);
    expect(allOmitted.omitted).toBe(2);
    const empty = projectHistory(hist([]), base, AT);
    expect(empty.messages).toStrictEqual([]);
    expect(empty.omitted).toBe(0);
  });

  test("orders by commit t, then id, without parsing dates", () => {
    const b = message("b", { ts: "9999-12-31" });
    const a = message("a", { ts: "not a date" });
    const c = message("c", { ts: "0001-01-01" });
    const d = message("d", { ts: "" });
    // Newest first, as history backward returns them; shown in commit order.
    expect(histIds([d, c, a, b])).toStrictEqual(["b", "a", "c", "d"]);
    // Entries sharing a commit order by id.
    expect(histIds([message("y", { t: 7 }), message("x", { t: 7 })])).toStrictEqual(["x", "y"]);
  });

  test("omits a row without a commit at or before the snapshot", () => {
    const result = projectHistory(
      hist([
        message("none", { t: undefined }),
        message("zero", { t: 0 }),
        message("text", { t: "5" }),
        message("later", { t: SNAPSHOT_T + 1 }),
        message("ok", { t: SNAPSHOT_T }),
      ]),
      base,
      AT
    );
    expect(result.messages.map((m) => m.id)).toStrictEqual(["ok"]);
    expect(result.omitted).toBe(4);
  });

  test("rejects anything but a list of well-formed pages", () => {
    const roots: unknown[] = [
      null,
      undefined,
      "text",
      5,
      [],
      {},
      page([]),
      [{ messages: [] }],
      [{ structuredContent: page([]) }],
      [{ content: [{ type: "text", text: JSON.stringify(page([])) }] }],
      [JSON.stringify(page([]))],
      new Array(1),
      Array.from({ length: 9 }, (_, i) =>
        page([], i < 8 ? { exhausted: false, next: `n${i}` } : {})
      ),
    ];
    for (const root of roots) expectGeneric(() => projectHistory(root, base, AT));
  });

  test("rejects a malformed page envelope", () => {
    const pages: Array<Record<string, unknown>> = [
      { ledger: undefined },
      { ledger: 5 },
      { t: 0 },
      { t: 1.5 },
      { t: "10000" },
      { currentHeadT: SNAPSHOT_T },
      { currentHeadT: 3 },
      { currentHeadT: "10001" },
      { rows: undefined },
      { rows: {} },
      { damagedTotal: -1 },
      { damagedTotal: undefined },
      { exhausted: "true" },
      { complete: undefined },
      { next: 5 },
      // A position and exhaustion must agree, and complete needs both exhaustion and no damage.
      { next: "n" },
      { exhausted: false },
      { exhausted: false, next: "n", complete: true },
      { complete: true, damagedTotal: 1 },
    ];
    for (const extra of pages) expectGeneric(() => projectHistory(hist([], extra), base, AT));
  });

  test("a traversal stays at one commit of one ledger, each page leading to the next", () => {
    const open = { exhausted: false, next: "n1" };
    const two = (first: Record<string, unknown>, second: Record<string, unknown>) =>
      projectHistory([page([message("a")], first), page([message("b")], second)], base, AT);
    expect(two(open, {}).messages.map((m) => m.id)).toStrictEqual(["a", "b"]);
    expectGeneric(() => two(open, { ledger: "another" }));
    expectGeneric(() => two(open, { t: SNAPSHOT_T - 1 }));
    expectGeneric(() => two({}, {}));
    expectGeneric(() => two({ ...open, damagedTotal: 2 }, { damagedTotal: 1 }));
    // The furthest head seen while reading is the one reported.
    expect(
      two({ ...open, currentHeadT: SNAPSHOT_T + 5 }, { currentHeadT: SNAPSHOT_T + 2 }).snapshot
    ).toStrictEqual({ ledger: LEDGER, t: SNAPSHOT_T, currentHeadT: SNAPSHOT_T + 5 });
  });

  test("labels the window from exhaustion and ranking, never from the row count", () => {
    const latest = projectHistory(
      hist([message("a"), message("b")], { exhausted: false, next: "n" }),
      { limit: 2 },
      AT
    );
    expect(latest.window).toBe("latest");
    expect(latest.complete).toBe(false);
    // Exactly limit rows, and the bus says nothing is left: all of them.
    const all = projectHistory(
      hist([message("a"), message("b")], { complete: true }),
      { limit: 2 },
      AT
    );
    expect(all.window).toBe("all");
    expect(all.complete).toBe(true);
    // Fewer rows than the limit but not exhausted (damaged entries took the page): still latest.
    const short = projectHistory(
      hist([message("a")], { exhausted: false, next: "n", damagedTotal: 3 }),
      base,
      AT
    );
    expect(short.window).toBe("latest");
    expect(short.damaged).toBe(3);
    const ranked = projectHistory(hist([message("a")]), { query: "q", limit: 5 }, AT);
    expect(ranked.window).toBe("ranked");
    expectGeneric(() => projectHistory(hist([], { complete: true }), { query: "q", limit: 5 }, AT));
  });

  test("a last page that overshoots the limit keeps the first rows and is never all", () => {
    const oldest = message("oldest");
    const middle = message("middle");
    const newest = message("newest");
    const result = projectHistory(
      [
        page([newest], { exhausted: false, next: "n1" }),
        page([middle, oldest], { complete: true, damagedTotal: 0 }),
      ],
      { limit: 2 },
      AT
    );
    expect(result.messages.map((m) => m.id)).toStrictEqual(["middle", "newest"]);
    expect(result.window).toBe("latest");
    expect(result.complete).toBe(false);
  });

  test("fails the whole observation when a page exceeds the requested bound", () => {
    const three = [message("a"), message("b"), message("c")];
    expectGeneric(() => projectHistory(hist(three), { limit: 2 }, AT));
    expectGeneric(() => projectHistory(hist([message("a"), null]), { limit: 1 }, AT));
    expect(histIds(three.slice(0, 2), { limit: 2 })).toStrictEqual(["a", "b"]);
  });

  test("copies criteria and records without mutating or aliasing input", () => {
    const criteria = Object.freeze({ query: " Q ", participant: " P", limit: 5 });
    const to = ["agent/b"];
    const origin = { host: "h", cwd: "/w" };
    const raw = hist([message("m1", { to, origin })]);
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
    expect(Object.hasOwn(projectHistory(hist([]), base, AT).criteria, "query")).toBe(false);
  });

  test("quarantined marker-bearing data never appears in the observation", () => {
    const result = projectHistory(
      hist([message("a", { body: { secret: MARK } }), message("b", { extra: MARK })]),
      base,
      AT
    );
    expect(result.messages.map((m) => m.id)).toStrictEqual(["b"]);
    expect(JSON.stringify(result)).not.toContain(MARK);
  });

  test("rejects a non-string observation time", () => {
    for (const at of [undefined, 5, null, { MARK }]) {
      expectGeneric(() => loose.history(hist([]), base, at));
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
      expect(() => loose.history(hist([]), input, AT)).not.toThrow();
    });
  });
  rejected.forEach((input, index) => {
    test(`rejects case ${index} natively and in the projector`, () => {
      expect("value" in validate(input)).toBe(false);
      expectGeneric(() => loose.history(hist([]), input, AT));
    });
  });

  test("preserves whitespace and case exactly", () => {
    const result = validate({ query: "  Mixed Case ", participant: " Agent/X\n", limit: 7 });
    expect("value" in result ? result.value : undefined).toStrictEqual({
      query: "  Mixed Case ",
      participant: " Agent/X\n",
      limit: 7,
    });
    const projected = projectHistory(hist([]), { query: " Q", limit: 1 }, AT);
    expect(projected.criteria).toStrictEqual({ query: " Q", limit: 1 });
  });
});

describe("peers projection", () => {
  test("keeps only named public fields and clones topics", () => {
    const topics = ["t1", "#t2"];
    const result = projectPeers(
      peerPages(
        [
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
        { extra: MARK }
      ),
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
      snapshot: SNAPSHOT,
      damaged: 0,
      complete: false,
    });
    expect(result.peers[0]?.topics).not.toBe(topics);
    topics.push("late");
    expect(result.peers[0]?.topics).toStrictEqual(["t1", "#t2"]);
    expect(JSON.stringify(result)).not.toContain(MARK);
    expect(Schema.is(PeersObservationSchema)(result)).toBe(true);
  });

  test("accepts exactly the four runtimes and empty optional strings", () => {
    const result = projectPeers(
      peerPages([
        peer("a", { runtime: "claude", host: "", note: "" }),
        peer("b", { runtime: "codex" }),
        peer("c", { runtime: "human" }),
        peer("d", { runtime: "other" }),
        peer("e", { runtime: "Claude" }),
        peer("f", { runtime: "bot" }),
        peer("g", { runtime: 5 }),
      ]),
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
      const result = projectPeers(peerPages([peer("a", extra)]), AT);
      expect(result.peers).toStrictEqual([]);
      expect(result.omitted).toBe(1);
    });
  }

  test("omits a peer missing a required field", () => {
    for (const key of ["address", "runtime", "topics"]) {
      const record = peer("a");
      delete record[key];
      const result = projectPeers(peerPages([record]), AT);
      expect(result.peers).toStrictEqual([]);
      expect(result.omitted).toBe(1);
    }
  });

  test("withholds every peer sharing an address, including malformed collisions", () => {
    const result = projectPeers(
      peerPages([
        peer("dup"),
        peer("dup", { note: "other" }),
        peer("bad", { runtime: "nope" }),
        peer("bad"),
        peer("7"),
        { ...peer("x"), address: 7 },
        { ...peer("y"), address: 7 },
        peer("ok"),
      ]),
      AT
    );
    expect(result.peers.map((p) => p.address)).toStrictEqual(["7", "ok"]);
    expect(result.omitted).toBe(6);
  });

  test("keeps upstream order, and distinguishes all omitted from empty", () => {
    const ordered = projectPeers(peerPages([peer("z"), peer("a"), peer("m")]), AT);
    expect(ordered.peers.map((p) => p.address)).toStrictEqual(["z", "a", "m"]);
    const allOmitted = projectPeers(peerPages([null, 3, "x"]), AT);
    expect(allOmitted.peers).toStrictEqual([]);
    expect(allOmitted.omitted).toBe(3);
    expect(projectPeers(peerPages([]), AT)).toStrictEqual({
      peers: [],
      observedAt: "2026-01-02T03:04:05.000Z",
      omitted: 0,
      snapshot: SNAPSHOT,
      damaged: 0,
      complete: false,
    });
  });

  test("rejects malformed roots, wrappers and unfinished traversals", () => {
    const roots: unknown[] = [
      null,
      "text",
      [],
      {},
      { peers: [] },
      [{ peers: [] }],
      [{ structuredContent: page([]) }],
      [JSON.stringify(page([]))],
      peerPages([], { exhausted: false, next: "n" }),
    ];
    for (const root of roots) expectGeneric(() => projectPeers(root, AT));
    expectGeneric(() => loose.peers(peerPages([]), 5));
  });

  test("enforces the 500 per page and 1000 peer bounds without truncating", () => {
    const make = (count: number, from = 0) =>
      Array.from({ length: count }, (_, i) => peer(`a/${from + i}`));
    const pages = (...counts: number[]) =>
      counts.map((count, index) =>
        page(make(count, index * 500), {
          name: "peers",
          ...(index < counts.length - 1 ? { exhausted: false, next: `n${index}` } : {}),
        })
      );
    const ok = projectPeers(pages(500, 500), AT);
    expect(ok.peers.length).toBe(1000);
    expect(ok.omitted).toBe(0);
    expectGeneric(() => projectPeers(pages(500, 500, 1), AT));
    expectGeneric(() => projectPeers(peerPages(make(501)), AT));
  });

  test("shows joined peers only", () => {
    const result = projectPeers(peerPages([peer("a"), peer("b", { status: "left" })]), AT);
    expect(result.peers.map((p) => p.address)).toStrictEqual(["a"]);
    expect(result.omitted).toBe(1);
  });
});

describe("thread projection", () => {
  const request = { id: "root", ledger: LEDGER, t: SNAPSHOT_T };
  const tree = (rows: unknown[], extra: Record<string, unknown> = {}) => [
    page(rows, { name: "thread", missingReplyTargets: [], ...extra }),
  ];

  test("keeps the tree in commit order with the bus's own missing reply targets", () => {
    const root = message("root", { replyTo: "gone" });
    const reply = message("reply", { replyTo: "root" });
    const result = projectThread(
      tree([reply, root], { missingReplyTargets: ["gone"], complete: false, damagedTotal: 1 }),
      request,
      AT
    );
    expect(result.messages.map((m) => m.id)).toStrictEqual(["root", "reply"]);
    expect(result.missingReplyTargets).toStrictEqual(["gone"]);
    expect(result.request).toStrictEqual(request);
    expect(result.snapshot).toStrictEqual(SNAPSHOT);
    expect(result.damaged).toBe(1);
    expect(result.exhausted).toBe(true);
    expect(Schema.is(ThreadObservationSchema)(result)).toBe(true);
  });

  test("a tree with more entries than one page says so", () => {
    const result = projectThread(
      tree([message("root")], { exhausted: false, next: "n" }),
      request,
      AT
    );
    expect(result.exhausted).toBe(false);
    expect(result.complete).toBe(false);
  });

  test("refuses a tree read at another commit or ledger than requested", () => {
    expectGeneric(() => projectThread(tree([]), { ...request, t: SNAPSHOT_T - 1 }, AT));
    expectGeneric(() => projectThread(tree([]), { ...request, ledger: "replaced" }, AT));
  });

  test("refuses malformed requests, targets and oversized pages", () => {
    const loosely = projectThread as (pages: unknown, request: unknown, at: unknown) => unknown;
    for (const bad of [
      {},
      { ...request, id: "" },
      { ...request, t: 0 },
      { ...request, ledger: 5 },
      { ...request, extra: MARK },
    ]) {
      expectGeneric(() => loosely(tree([]), bad, AT));
    }
    expectGeneric(() => loosely(tree([]), request, 5));
    expectGeneric(() => projectThread(tree([], { missingReplyTargets: undefined }), request, AT));
    expectGeneric(() => projectThread(tree([], { missingReplyTargets: [5] }), request, AT));
    const many = Array.from({ length: 201 }, (_, i) => message(`m${i}`));
    expectGeneric(() => projectThread(tree(many), request, AT));
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
    () => projectHistory(hist(MARK), base, AT),
    () => projectHistory({ content: [{ type: "text", text: MARK }] }, base, AT),
    () => projectHistory(hist(many), { limit: 2 }, AT),
    () => projectHistory(trap, base, AT),
    () => loose.history(hist([]), { limit: 1, [MARK]: MARK }, AT),
    () => loose.history(hist([]), { query: MARK, limit: 0 }, AT),
    () => loose.history(hist([]), base, { MARK }),
    () => projectPeers(MARK, AT),
    () => projectPeers(peerPages(Array.from({ length: 501 }, () => peer(MARK))), AT),
    () => loose.peers(peerPages([]), { MARK }),
  ];
  for (const run of cases) expectGeneric(run);
});
