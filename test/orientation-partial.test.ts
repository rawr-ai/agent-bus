import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { MAX_ENVELOPE_BYTES } from "../src/catalogue.ts";
import { LedgerError } from "../src/domain.ts";
import { messageIri, revisionIri, scopeIri, witnessIri } from "../src/Ledger.ts";
import { orient } from "../src/OrientationView.ts";
import {
  BULLETIN_BODY_BYTES,
  BULLETIN_UNIT_BYTES,
  type BulletinRecord,
  bulletinView,
  canonicalJson,
  DIRECTORY_BYTES,
  jsonBytes,
} from "../src/orientation-model.ts";
import { QueryGateway } from "../src/Query.ts";

const publishedAt = "2026-11-03T00:00:00.000Z";
const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const programmeRevision = uuid(1);
const programmeNotice = uuid(2);
const programmeScope = { kind: "programme" as const };
const programme: BulletinRecord = {
  kind: "bulletin",
  scope: programmeScope,
  action: "publish",
  body: "Programme remains visible.",
  publisher: "director",
  publishedAt,
  notification: programmeNotice,
  audience: ["*"],
};
const notice = (id: string, from = "director") =>
  JSON.stringify({
    id,
    ts: publishedAt,
    from,
    to: ["*"],
    kind: "message",
    body: "notice",
  });

type Mode =
  | "candidate-fault"
  | "candidate-damage"
  | "summary-fault"
  | "association-fault"
  | "programme-oversized"
  | "programme-oversized-expired"
  | "programme-oversized-withdrawn"
  | "large-candidates"
  | "pages";
const fixture = (mode: Mode) => {
  let incarnation = "synthetic-incarnation";
  let head = 10;
  let programmeReads = 0;
  const programmeCuts: Array<number> = [];
  let failDiscovery = false;
  const baseProgramme: BulletinRecord =
    mode === "large-candidates"
      ? { ...programme, body: "P".repeat(BULLETIN_BODY_BYTES) }
      : mode === "programme-oversized-withdrawn"
        ? {
            kind: "bulletin",
            scope: programmeScope,
            action: "withdraw",
            publisher: "director",
            publishedAt,
            notification: programmeNotice,
            audience: ["*"],
          }
        : mode === "programme-oversized-expired"
          ? { ...programme, expiresAt: "2020-01-01T00:00:00.000Z" }
          : programme;
  const emptyPublisher = { ...baseProgramme, publisher: "" };
  const selectedProgramme = mode.startsWith("programme-oversized")
    ? {
        ...emptyPublisher,
        publisher: "x".repeat(BULLETIN_UNIT_BYTES - jsonBytes(emptyPublisher)),
      }
    : baseProgramme;
  const many = mode === "pages" || mode === "large-candidates";
  const directories = Array.from({ length: mode === "pages" ? 21 : many ? 5 : 1 }, (_, index) => {
    const id = many ? `project-${String(index).padStart(2, "0")}` : "project";
    const revision = uuid(10 + index * 2);
    const notification = uuid(11 + index * 2);
    const scope = { kind: "directory" as const, directory: id };
    return {
      id,
      revision,
      notification,
      scope,
      record: {
        kind: "directory",
        directory: {
          id,
          name: mode === "large-candidates" ? "N".repeat(15_700) : id,
          aliases: ["/workspace/project"],
          concerns: many
            ? []
            : [
                { id: "one", name: "One", topic: "one" },
                { id: "two", name: "Two", topic: "two" },
              ],
        },
        publisher: "director",
        publishedAt,
        notification,
        audience: ["*"],
      },
    };
  });
  const failure = () => new LedgerError({ message: "sensitive upstream detail" });
  const gateway = Layer.succeed(
    QueryGateway,
    QueryGateway.of({
      pin: Effect.sync(() => ({ head, incarnation })),
      jsonld: (t, query) =>
        Effect.gen(function* () {
          if (JSON.stringify(query.selectDistinct) === '["?scope"]') {
            if (mode === "candidate-fault" || failDiscovery) return yield* failure();
            if (mode === "candidate-damage")
              return [
                [scopeIri({ kind: "directory", directory: "project" })],
                ["urn:agent-bus:orientation:directory:!"],
              ];
            const offset = typeof query.offset === "number" ? query.offset : 0;
            return directories.slice(offset, offset + 201).map(({ scope }) => [scopeIri(scope)]);
          }
          if (JSON.stringify(query.selectDistinct) === '["?m"]') {
            if (mode === "association-fault") return yield* failure();
            return [];
          }
          if (JSON.stringify(query.selectDistinct) === '["?t","?id","?json"]') return [];
          const where = query.where as Array<Record<string, unknown>> | Record<string, unknown>;
          const subject = (Array.isArray(where) ? where[0] : where)?.["@id"];
          const predicates = JSON.stringify(query.select) === '["?predicate"]';
          if (subject === scopeIri(programmeScope)) {
            programmeReads += 1;
            programmeCuts.push(t);
            return predicates ? [] : [["programme", null, null, programmeRevision]];
          }
          if (subject === revisionIri(programmeRevision))
            return [
              [
                scopeIri(programmeScope),
                JSON.stringify(selectedProgramme),
                messageIri(programmeNotice),
              ],
            ];
          if (subject === messageIri(programmeNotice))
            return [[notice(programmeNotice, selectedProgramme.publisher)]];
          if (subject === witnessIri(programmeRevision))
            return [
              [
                canonicalJson({
                  action: selectedProgramme.action,
                  scope: programmeScope,
                  expected: null,
                  publisher: selectedProgramme.publisher,
                  ...(selectedProgramme.body === undefined ? {} : { body: selectedProgramme.body }),
                  ...(selectedProgramme.expiresAt === undefined
                    ? {}
                    : { expiresAt: selectedProgramme.expiresAt }),
                  audience:
                    selectedProgramme.action === "withdraw"
                      ? { previous: true }
                      : { programme: true },
                }),
                programmeRevision,
                messageIri(programmeNotice),
              ],
            ];
          for (const entry of directories) {
            if (subject === scopeIri(entry.scope))
              return predicates ? [] : [["directory", entry.id, null, entry.revision]];
            if (subject === revisionIri(entry.revision))
              return [
                [
                  scopeIri(entry.scope),
                  JSON.stringify(entry.record),
                  messageIri(entry.notification),
                ],
              ];
            if (subject === messageIri(entry.notification)) return [[notice(entry.notification)]];
            if (subject === witnessIri(entry.revision))
              return [
                [
                  canonicalJson({
                    action: "replace",
                    scope: entry.scope,
                    expected: null,
                    directory: entry.record.directory,
                    audience: ["*"],
                    publisher: "director",
                  }),
                  entry.revision,
                  messageIri(entry.notification),
                ],
              ];
          }
          if (
            mode === "summary-fault" &&
            subject === scopeIri({ kind: "concern", directory: "project", concern: "two" })
          )
            return yield* failure();
          return [];
        }),
      sparql: () => Effect.die("unexpected sparql"),
    })
  );
  const run = (input: Parameters<typeof orient>[0], budget?: number) =>
    Effect.runPromise(orient(input, budget).pipe(Effect.provide(gateway)));
  return Object.assign(run, {
    programmeReads: () => programmeReads,
    programmeCuts: () => [...programmeCuts],
    replace: () => {
      incarnation = "replacement-incarnation";
    },
    advance: () => {
      head = 12;
    },
    failDiscovery: (value: boolean) => {
      failDiscovery = value;
    },
  });
};

test("a stored programme whose full projection exceeds the unit cap is unavailable", async () => {
  const base = { ...programme, publisher: "" };
  const oversized = { ...base, publisher: "x".repeat(BULLETIN_UNIT_BYTES - jsonBytes(base)) };
  expect(jsonBytes(oversized)).toBe(BULLETIN_UNIT_BYTES);
  expect(jsonBytes(bulletinView({ revision: programmeRevision, value: oversized }, 0, true))).toBe(
    BULLETIN_UNIT_BYTES + 2
  );
  for (const mode of [
    "programme-oversized",
    "programme-oversized-expired",
    "programme-oversized-withdrawn",
  ] as const) {
    const result = await fixture(mode)({});
    expect(result).toMatchObject({ status: "UNAVAILABLE", reason: "DAMAGE", section: "programme" });
    expect(result).not.toHaveProperty("programme");
  }
});

for (const [mode, reason] of [
  ["candidate-fault", "FAULT"],
  ["candidate-damage", "DAMAGE"],
] as const) {
  test(`candidate ${mode} retains the same-cut programme with a useful recovery`, async () => {
    const result = await fixture(mode)({ cwd: "/workspace/project/src" });
    expect(result).toMatchObject({
      status: "UNAVAILABLE",
      reason,
      section: "candidates",
      cut: { head: 10 },
      programme: { state: "CURRENT", body: "Programme remains visible." },
      selection: { state: "UNRESOLVED", basis: "alias" },
      recovery: { tool: "bus_run_query", input: { name: "orientation_directories", t: 10 } },
    });
    expect(JSON.stringify(result)).toContain("select it explicitly");
    expect(JSON.stringify(result)).not.toContain("sensitive upstream detail");
    expect(result).not.toHaveProperty("summaries");
    if (mode === "candidate-damage") {
      expect(result).toMatchObject({
        candidates: { rows: [{ id: "project" }], damagedTotal: 1, complete: false },
      });
    }
  });
}

test("a failed concern summary preserves programme and resolved directory", async () => {
  const result = await fixture("summary-fault")({ directory: "project", concern: "one" });
  expect(result).toMatchObject({
    status: "UNAVAILABLE",
    reason: "FAULT",
    section: "summaries",
    cut: { head: 10 },
    programme: { state: "CURRENT", body: "Programme remains visible." },
    selection: { state: "SELECTED", directory: "project" },
    directory: { value: { directory: { id: "project" } } },
    concern: { id: "one", state: "REGISTERED", bulletin: { state: "MISSING" } },
    recovery: { tool: "bus_orient", input: { directory: "project", concern: "two", t: 10 } },
  });
  expect(result).not.toHaveProperty("summaries");
  expect(JSON.stringify(result)).not.toContain("sensitive upstream detail");
});

test("an association fault preserves programme without claiming empty membership", async () => {
  const result = await fixture("association-fault")({ directory: "project" });
  expect(result).toMatchObject({
    status: "UNAVAILABLE",
    reason: "FAULT",
    section: "associations",
    programme: { state: "CURRENT", body: "Programme remains visible." },
    selection: { state: "SELECTED", directory: "project" },
    recovery: { tool: "bus_run_query", input: { name: "orientation_associations", t: 10 } },
  });
  expect(result).not.toHaveProperty("members");
  expect(JSON.stringify(result)).not.toContain("sensitive upstream detail");
});

test("a constrained result keeps the complete programme when that whole unit fits", async () => {
  const result = await fixture("summary-fault")({ directory: "project", concern: "one" }, 700);
  expect(result).toMatchObject({
    status: "UNAVAILABLE",
    reason: "INADMISSIBLE",
    section: "result",
    programme: { state: "CURRENT", body: "Programme remains visible." },
  });
  expect(jsonBytes(result)).toBeLessThanOrEqual(700);
  expect(result).not.toHaveProperty("members");
});

test("whole candidate rows use the remaining programme budget and continue without loss", async () => {
  const body = "P".repeat(BULLETIN_BODY_BYTES);
  const name = "N".repeat(15_700);
  expect(
    jsonBytes({ id: "project-00", name, aliases: ["/workspace/project"], concerns: [] })
  ).toBeLessThanOrEqual(DIRECTORY_BYTES);
  const run = fixture("large-candidates");
  const first = await run({ cwd: "/workspace/project/src" });
  expect(first.status).toBe("INCOMPLETE");
  expect(first).toMatchObject({
    status: "INCOMPLETE",
    cut: { head: 10 },
    programme: { state: "CURRENT", body },
    selection: { state: "AMBIGUOUS", basis: "alias" },
    candidates: { complete: false },
  });
  expect(jsonBytes(first)).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
  const page = (
    first as unknown as { candidates: { rows: Array<{ id: string; name: string }>; next: string } }
  ).candidates;
  expect(page.rows.map(({ id }) => id)).toEqual(["project-00", "project-01", "project-02"]);
  expect(page.rows.every((row) => row.name === name)).toBe(true);
  expect(page.next).toBeString();
  run.advance();
  const last = await run({ cwd: "/workspace/project/src", candidateCursor: page.next });
  expect(last).toMatchObject({
    status: "COMPLETE",
    cut: { head: 10 },
    currentHeadT: 12,
    programme: { state: "CURRENT", body },
    candidates: {
      complete: true,
      rows: [
        { id: "project-03", name },
        { id: "project-04", name },
      ],
    },
  });
  expect(run.programmeCuts()).toEqual([10, 10]);
  expect(jsonBytes(last)).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
});

test("an unresolved requested concern does not hide the programme or imply a directory", async () => {
  const run = fixture("pages");
  const unresolved = await run({ concern: "one" });
  expect(unresolved).toMatchObject({
    status: "COMPLETE",
    cut: { head: 10 },
    programme: { state: "CURRENT", body: "Programme remains visible." },
    selection: { state: "UNRESOLVED", basis: "none" },
    concern: { id: "one", state: "UNRESOLVED" },
  });
  expect(unresolved).not.toHaveProperty("summaries");
  expect(unresolved).not.toHaveProperty("members");
  const ambiguous = await run({ cwd: "/workspace/project/src", concern: "one" });
  expect(ambiguous).toMatchObject({
    status: "INCOMPLETE",
    programme: { state: "CURRENT" },
    selection: { state: "AMBIGUOUS", basis: "alias" },
    concern: { id: "one", state: "UNRESOLVED" },
  });
  expect(ambiguous).not.toHaveProperty("directory");
  expect(ambiguous).not.toHaveProperty("members");
});

test("incomplete discovery preserves programme and continuation remains bound to cwd and cut", async () => {
  const run = fixture("pages");
  const first = await run({ cwd: "/workspace/project/src" });
  expect(first).toMatchObject({
    status: "INCOMPLETE",
    cut: { head: 10 },
    programme: { state: "CURRENT", body: "Programme remains visible." },
    selection: { state: "AMBIGUOUS", basis: "alias" },
    candidates: { complete: false },
  });
  const next = (first as unknown as { candidates: { next: string } }).candidates.next;
  expect(next).toBeString();
  run.advance();
  run.failDiscovery(true);
  const failedPage = await run({ cwd: "/workspace/project/src", candidateCursor: next });
  expect(failedPage).toMatchObject({
    status: "UNAVAILABLE",
    section: "candidates",
    cut: { head: 10 },
    currentHeadT: 12,
    programme: { state: "CURRENT", body: "Programme remains visible." },
    selection: { state: "UNRESOLVED", basis: "alias" },
    recovery: { tool: "bus_run_query", input: { t: 10, cursor: next } },
  });
  run.failDiscovery(false);
  const last = await run({ cwd: "/workspace/project/src", candidateCursor: next });
  expect(last).toMatchObject({
    status: "COMPLETE",
    cut: { head: 10 },
    programme: { state: "CURRENT" },
    selection: { state: "UNRESOLVED", basis: "alias" },
    candidates: { complete: true, rows: [{ id: "project-20" }] },
  });
  expect(run.programmeCuts()).toEqual([10, 10, 10]);
  const reads = run.programmeReads();
  await expect(run({ cwd: "/workspace/elsewhere", candidateCursor: next })).rejects.toThrow(
    "different args"
  );
  await expect(
    run({ cwd: "/workspace/project/src", candidateCursor: "not-a-cursor" })
  ).rejects.toThrow();
  const decoded = JSON.parse(Buffer.from(next.slice(4), "base64url").toString("utf8"));
  const wrongOperation = `bq1.${Buffer.from(JSON.stringify({ ...decoded, op: "history" })).toString("base64url")}`;
  await expect(
    run({ cwd: "/workspace/project/src", candidateCursor: wrongOperation })
  ).rejects.toThrow("belongs to history");
  run.replace();
  await expect(run({ cwd: "/workspace/project/src", candidateCursor: next })).rejects.toThrow(
    "ledger was replaced"
  );
  expect(run.programmeReads()).toBe(reads);
});
