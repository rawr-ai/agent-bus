// The pinned investigation link: the fragment an agent hands over, read back exactly, and the
// narrowed window a reader opens from it. checkReference's own cases live with the contract.
import { expect, test } from "bun:test";
import type { InvestigationReference } from "../viewer/shared/public.ts";
import { referenceFits } from "../viewer/shared/request-size.ts";
import {
  investigationHash,
  narrowedReference,
  parseInvestigationFragment,
} from "../viewer/src/features/pinned/reference.ts";

const reference: InvestigationReference = {
  name: "history",
  catalogueVersion: 1,
  ledger: "fixture-ledger",
  t: 9,
  criteria: {
    participants: ["#a b", "#a+b", "#k&v=1", "#x#y", "#100%", "#ünï", "#\ud800"].sort(),
    fromTs: "2026-11-01T10:00:00.500Z",
    kinds: ["message"],
    direction: "forward",
  },
};
const PREFIX = "#investigation=";

test("a link's fragment reads back as exactly the reference it was made from", () => {
  const hash = investigationHash(reference);
  expect(hash.startsWith(PREFIX)).toBe(true);
  expect(parseInvestigationFragment(hash)).toEqual({ kind: "reference", reference });
});

test("a hand-built link keeps a raw + as a +, and a browser's own escaping reads back", () => {
  const json = JSON.stringify(reference);
  const raw = parseInvestigationFragment(PREFIX + encodeURIComponent(json).replaceAll("%2B", "+"));
  expect(raw).toEqual({ kind: "reference", reference });
  // A raw JSON link as a browser carries it: quotes and spaces escaped, the rest left as typed.
  const plain = { ...reference, criteria: { ...reference.criteria, participants: ["#a b"] } };
  const pasted = `${PREFIX}${JSON.stringify(plain).replaceAll('"', "%22").replaceAll(" ", "%20")}`;
  expect(parseInvestigationFragment(pasted)).toEqual({ kind: "reference", reference: plain });
});

test("only a fragment that starts with the investigation key names an investigation", () => {
  for (const hash of ["", "#", "#context=all&page=contexts", "#investigation", "#page=thread"]) {
    expect(parseInvestigationFragment(hash)).toEqual({ kind: "none" });
  }
});

test("an unreadable or invalid value is refused as invalid; another kind or order as unsupported", () => {
  const invalid = { kind: "refused", reason: "invalid" } as const;
  for (const value of ["", "not json", "%E0%A4%A", "null", "[]", "{}"]) {
    expect(parseInvestigationFragment(PREFIX + value)).toEqual(invalid);
  }
  const withLimit = { ...reference, criteria: { ...reference.criteria, limit: 50 } };
  expect(parseInvestigationFragment(investigationHash(withLimit as never))).toEqual(invalid);
  const backward = { ...reference, criteria: { ...reference.criteria, direction: "backward" } };
  expect(parseInvestigationFragment(investigationHash(backward as never))).toEqual({
    kind: "refused",
    reason: "unsupported",
  });
});

test("a narrowed window keeps every other field and the typed instants exactly", () => {
  const narrowed = narrowedReference(
    reference,
    "2026-11-01T10:30:00.250000Z",
    "2026-11-01T11:00:00Z"
  );
  expect(narrowed).toEqual({
    reference: {
      ...reference,
      criteria: {
        ...reference.criteria,
        fromTs: "2026-11-01T10:30:00.250000Z",
        toTs: "2026-11-01T11:00:00Z",
      },
    },
  });
  // An emptied field leaves that bound unset rather than empty.
  const { fromTs: _, ...open } = reference.criteria;
  expect(narrowedReference(reference, "", "")).toEqual({
    reference: { ...reference, criteria: open },
  });
});

test("a window the bus would not echo unchanged is refused, never rewritten", () => {
  for (const [fromTs, toTs] of [
    ["2026-11-01T10:30", ""],
    ["2026-11-01 10:30:00Z", ""],
    ["2026-11-01T10:30:00+01:00", ""],
    [" 2026-11-01T10:30:00Z", ""],
    ["2026-11-01T11:00:00Z", "2026-11-01T11:00:00Z"],
    ["2026-11-01T12:00:00Z", "2026-11-01T11:00:00Z"],
  ] as const) {
    expect(narrowedReference(reference, fromTs, toTs)).toEqual({ problem: "window" });
  }
});

test("a window that would make the reference too large to send is refused as too large", () => {
  const sized = (padding: number): InvestigationReference => ({
    ...reference,
    criteria: {
      kinds: ["message"],
      direction: "forward",
      participants: [
        ...Array.from({ length: 5 }, (_, index) => `#${index}${"f".repeat(500)}`),
        `~${"p".repeat(padding)}`,
      ],
    },
  });
  let padding = 0;
  while (referenceFits(sized(padding + 1))) padding++;
  const edge = sized(padding);
  expect(referenceFits(edge)).toBe(true);
  expect(narrowedReference(edge, "2026-11-01T10:00:00Z", "")).toEqual({ problem: "too-large" });
});
