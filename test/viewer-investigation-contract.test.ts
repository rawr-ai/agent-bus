// The pinned investigation's shared contract: which references are accepted, and how one bus
// page is checked against its reference. Traversal across pages, the server procedure and the
// real bus are covered where they are built.
import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { history } from "../src/catalogue.ts";
import { HistoryArgs } from "../src/history-args.ts";
import { QueryGateway } from "../src/Query.ts";
import {
  checkReference,
  IDENTITY_FIELDS,
  INVESTIGATION_PAGE_SIZE,
  type InvestigationEntry,
  InvestigationPageInputSchema,
  InvestigationPageSchema,
  type InvestigationReference,
  isSupportedContinuation,
  MAX_CONTINUATION_LENGTH,
  projectInvestigationPage,
} from "../viewer/shared/public.ts";

const FAILED = "Public observation rejected";

/** Criteria as the bus echoes them: participants sorted, defaults present, no limit. */
const criteria = {
  participants: ["#review", "claude/lead"],
  fromTs: "2026-11-01T00:00:00Z",
  toTs: "2026-11-02T00:00:00.5Z",
  kinds: ["message"],
  direction: "forward",
};
const reference = {
  name: "history",
  catalogueVersion: 1,
  ledger: "incarnation-a",
  t: 3014,
  criteria,
};
const accepted = (): InvestigationReference => {
  const result = checkReference(reference);
  if (!("reference" in result)) throw new Error("fixture reference refused");
  return result.reference;
};
const refusal = (value: unknown) => {
  const result = checkReference(value);
  return "refused" in result ? result.refused : "accepted";
};

const entry = (
  id: string,
  t: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  t,
  id,
  ts: "2026-11-01T09:00:00Z",
  from: "claude/lead",
  to: ["#review"],
  kind: "message",
  body: `body ${id}`,
  ...extra,
});
/** One `history` page as the bus returns it for `reference` at page size 200. */
const page = (rows: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "history",
  catalogueVersion: 1,
  ledger: "incarnation-a",
  t: 3014,
  unit: "entry",
  args: { ...criteria, limit: INVESTIGATION_PAGE_SIZE },
  rows,
  damage: "checked",
  damaged: 0,
  damagedTotal: 0,
  exhausted: true,
  complete: true,
  note: "note",
  ...extra,
});
const projected = (raw: unknown) => {
  const result = projectInvestigationPage(raw, accepted());
  if (!("page" in result)) throw new Error(`unexpected mismatch on ${result.mismatch}`);
  return result.page;
};
const mismatch = (raw: unknown) => {
  const result = projectInvestigationPage(raw, accepted());
  return "mismatch" in result ? result.mismatch : undefined;
};

describe("references", () => {
  test("an agent's echoed history args, without limit, are accepted as given", () => {
    expect<unknown>(accepted()).toStrictEqual(reference);
    const minimal = { ...reference, criteria: { kinds: ["message"], direction: "forward" } };
    expect(refusal(minimal)).toBe("accepted");
  });

  test("valid history criteria for other kinds or backward order are unsupported", () => {
    for (const changed of [
      { kinds: ["presence"] },
      { kinds: ["message", "presence"] },
      { direction: "backward" },
    ]) {
      expect(refusal({ ...reference, criteria: { ...criteria, ...changed } })).toBe("unsupported");
    }
  });

  test("anything but the bus's own echoed form is invalid", () => {
    const { kinds: _, ...noKinds } = criteria;
    const { direction: __, ...noDirection } = criteria;
    for (const value of [
      undefined,
      "history",
      { ...reference, name: "search" },
      { ...reference, extra: 1 },
      { ...reference, name: "search", criteria: { ...criteria, direction: "backward" } },
      { ...reference, t: 0 },
      { ...reference, t: 1.5 },
      { ...reference, t: "3014" },
      { catalogueVersion: 1, ledger: "incarnation-a", t: 3014, criteria },
      { ...reference, criteria: { ...criteria, kinds: ["message", "message"] } },
      // Unsorted kinds are not an echo, whatever they ask for.
      { ...reference, criteria: { ...criteria, kinds: ["presence", "message"] } },
      { ...reference, catalogueVersion: 0 },
      { ...reference, ledger: "" },
      { ...reference, criteria: { ...criteria, limit: 200 } },
      { ...reference, criteria: { ...criteria, text: "x" } },
      // The bus always echoes its defaults, so a reference without them was not copied from it.
      { ...reference, criteria: noKinds },
      { ...reference, criteria: noDirection },
      // The shared definition's own refusals and normalisation.
      { ...reference, criteria: { ...criteria, participants: ["claude/lead", "#review"] } },
      { ...reference, criteria: { ...criteria, participants: ["#review", "#review"] } },
      { ...reference, criteria: { ...criteria, participants: [] } },
      { ...reference, criteria: { ...criteria, fromTs: "2026-11-02T00:00:00.500Z" } },
      { ...reference, criteria: { ...criteria, toTs: "2026-02-30T00:00:00Z" } },
      { ...reference, criteria: { ...criteria, toTs: "2026-11-02" } },
    ]) {
      expect(refusal(value)).toBe("invalid");
    }
  });

  test("a throwing getter is refused with the generic failure, never its own error", () => {
    const hostile = {
      ...reference,
      get criteria() {
        throw new Error("private detail");
      },
    };
    expect(() => checkReference(hostile)).toThrow(FAILED);
  });
});

describe("shared definition", () => {
  test("the catalogue runs history with the shared argument schema itself", () => {
    expect(history.Args).toBe(HistoryArgs);
  });

  // The bus side refuses invalid args before it reads; valid args reach the gateway, which
  // here refuses every read. So the bus's own verdict is visible without a ledger.
  const busVerdict = (criteria: Record<string, unknown>) => {
    const exit = Effect.runSyncExit(
      history
        .invoke({ ...criteria, limit: INVESTIGATION_PAGE_SIZE }, {}, undefined)
        .pipe(Effect.provide(QueryGateway.layerUnavailable))
    );
    if (Exit.isSuccess(exit)) throw new Error("the stub gateway cannot succeed");
    return JSON.stringify(exit.cause).includes("Queries need the Fluree ledger.")
      ? "accepted"
      : "refused";
  };

  test("the viewer and the bus agree on which forward message criteria are valid", () => {
    const valid = [
      criteria,
      { ...criteria, fromTs: "2026-11-01T00:00:00.123456789Z" },
      { kinds: ["message"], direction: "forward" },
    ];
    const invalid = [
      { ...criteria, participants: [] },
      { ...criteria, participants: ["x".repeat(513)] },
      { ...criteria, participants: Array.from({ length: 51 }, (_, i) => `p${i}`) },
      { ...criteria, participants: ["#review", "#review"] },
      { ...criteria, fromTs: "2026-11-01" },
      { ...criteria, toTs: "2026-02-30T00:00:00Z" },
      { ...criteria, fromTs: "2026-11-02T00:00:00.5Z" },
      { ...criteria, surprise: true },
    ];
    for (const value of valid) {
      expect([busVerdict(value), refusal({ ...reference, criteria: value })]).toEqual([
        "accepted",
        "accepted",
      ]);
    }
    for (const value of invalid) {
      expect(busVerdict(value)).toBe("refused");
      expect(refusal({ ...reference, criteria: value })).toBe("invalid");
    }
  });
});

describe("page input", () => {
  const decode = Schema.decodeUnknownSync(InvestigationPageInputSchema);

  test("a continuation is sent only within the bus's 1,024-character cursor alphabet", () => {
    const longest = `bq1.${"Az09_-".repeat(MAX_CONTINUATION_LENGTH)}`.slice(
      0,
      MAX_CONTINUATION_LENGTH
    );
    expect(isSupportedContinuation(longest)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(longest)).byteLength).toBe(
      MAX_CONTINUATION_LENGTH + 2
    );
    expect(decode({ reference, cursor: longest }).cursor).toBe(longest);
    // Printable ASCII that JSON escapes would serialize larger than its length.
    for (const cursor of [`${longest}c`, "", "bq1.é", "bq1.\n", 'bq1."', "bq1.\\", "bq1. x"]) {
      expect(isSupportedContinuation(cursor)).toBe(false);
      expect(() => decode({ reference, cursor })).toThrow();
    }
  });
});

describe("page identity", () => {
  test("a page read for the reference is projected in source order with its commits", () => {
    const result = projected(page([entry("b", 12), entry("a", 12), entry("c", 40)]));
    expect(result.entries.map((kept) => [kept.t, kept.message.id])).toEqual([
      [12, "b"],
      [12, "a"],
      [40, "c"],
    ]);
    expect(result.omitted).toBe(0);
    expect(Schema.decodeUnknownSync(InvestigationPageSchema)(result)).toEqual(result);
  });

  test("the echo matches whatever its key order", () => {
    const reordered = {
      limit: 200,
      direction: "forward",
      toTs: criteria.toTs,
      kinds: ["message"],
      fromTs: criteria.fromTs,
      participants: criteria.participants,
    };
    expect(mismatch(page([], { args: reordered }))).toBeUndefined();
  });

  test("each identity field that differs is named, checked in a fixed order", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["name", { name: "search" }],
      ["catalogueVersion", { catalogueVersion: 2 }],
      ["ledger", { ledger: "incarnation-b" }],
      ["t", { t: 3015 }],
      ["criteria", { args: { ...criteria, participants: ["#review"], limit: 200 } }],
      ["criteria", { args: { ...criteria, kinds: ["message", "presence"], limit: 200 } }],
      ["criteria", { args: { ...criteria, toTs: "2026-11-02T00:00:00.500Z", limit: 200 } }],
      ["criteria", { args: { ...criteria, extra: true, limit: 200 } }],
      ["limit", { args: { ...criteria, limit: 50 } }],
      ["limit", { args: { ...criteria } }],
    ];
    for (const [field, change] of cases)
      expect<string | undefined>(mismatch(page([], change))).toBe(field);
    expect(new Set(cases.map(([field]) => field))).toEqual(new Set<string>(IDENTITY_FIELDS));
    expect(mismatch(page([], { ledger: "incarnation-b", t: 1 }))).toBe("ledger");
  });

  test("a page that is not a valid history result is rejected", () => {
    for (const change of [
      { args: undefined },
      { damage: "not-checked" },
      { rows: undefined },
      { rows: Array.from({ length: INVESTIGATION_PAGE_SIZE + 1 }, (_, i) => entry(`m${i}`, 1)) },
      { damaged: -1 },
      { damaged: 2, damagedTotal: 1 },
      { exhausted: "yes" },
      { complete: true, exhausted: false, next: "bq1.x" },
      { complete: true, damaged: 1, damagedTotal: 1 },
      { next: 7, exhausted: false, complete: false },
      { currentHeadT: 3014 },
    ]) {
      expect(() => projectInvestigationPage(page([], change), accepted())).toThrow(FAILED);
    }
  });

  test("traversal claims pass through unjudged for the browser's traversal", () => {
    const claims = projected(
      page([], { exhausted: true, complete: false, next: "bq1.x", currentHeadT: 3020 })
    );
    expect(claims).toMatchObject({ exhausted: true, next: "bq1.x", currentHeadT: 3020 });
  });

  test("a continuation the investigation cannot send still delivers its page's rows", () => {
    for (const next of [`bq1.${"c".repeat(MAX_CONTINUATION_LENGTH)}`, "bq1.é"]) {
      const result = projected(page([entry("a", 1)], { exhausted: false, complete: false, next }));
      expect(result.entries.map((kept) => kept.message.id)).toEqual(["a"]);
      expect(result.next).toBe(next);
    }
  });

  test("omissions and bus damage are counted apart", () => {
    const result = projected(
      page([entry("a", 1), { id: "broken" }], { damaged: 1, damagedTotal: 1, complete: false })
    );
    expect([result.omitted, result.damaged]).toEqual([1, 1]);
  });

  test("rows that fail projection or share an id are omitted, never repaired", () => {
    const result = projected(
      page([
        entry("kept", 5),
        entry("twin", 6),
        entry("twin", 7),
        entry("future", 3015),
        entry("presence", 8, { kind: "presence" }),
        { ...entry("no-body", 9), body: undefined },
      ])
    );
    expect(result.entries.map((kept) => kept.message.id)).toEqual(["kept"]);
    expect(result.omitted).toBe(5);
  });
});

describe("evidence comparison", () => {
  // Two readings are the same evidence only if their projected entries are strictly equal in
  // order: an absent field never equals a present one.
  const evidence = (rows: unknown[]): ReadonlyArray<InvestigationEntry> =>
    projected(page(rows)).entries;
  const differs = (a: unknown[], b: unknown[]) => {
    expect(evidence(a)).not.toStrictEqual(evidence(b));
    expect(evidence(b)).not.toStrictEqual(evidence(a));
  };
  const first = entry("a", 1, { subject: "s", replyTo: "z" });
  const second = entry("b", 2, { to: ["claude/lead", "#review"] });
  const original = [first, second];

  test("the projection keeps every field that makes content differ under unchanged ids", () => {
    expect(evidence(original)).toStrictEqual(evidence(structuredClone(original)));
    const { replyTo: _, ...noReply } = first;
    const { subject: __, ...noSubject } = first;
    for (const variant of [
      [{ ...first, body: "changed" }, second],
      [{ ...first, body: "cafe\u0301" }, { ...second }],
      [noReply, second],
      [{ ...first, replyTo: "y" }, second],
      [noSubject, second],
      [{ ...first, subject: "" }, second],
      [{ ...first, t: 3 }, second],
      [{ ...first, ts: "2026-11-01T09:00:01Z" }, second],
      [first, { ...second, to: ["#review", "claude/lead"] }],
      [first, { ...second, to: ["Claude/lead", "#review"] }],
      [first, { ...second, from: "codex/other" }],
      [second, first],
      [first],
    ]) {
      differs(variant, original);
    }
    differs([{ ...first, body: "caf\u00e9" }], [{ ...first, body: "cafe\u0301" }]);
  });
});
