import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  BULLETIN_BODY_BYTES,
  BULLETIN_UNIT_BYTES,
  canonicalJson,
  checkoutMatches,
  DIRECTORY_BYTES,
  Directory,
  jsonBytes,
  normalizeAudience,
  normalizeDirectory,
  OperationId,
  textBytes,
  utcInstant,
} from "../src/orientation-model.ts";

test("representative public handoff fits proposed logical units without truncation", () => {
  const directory = Schema.decodeUnknownSync(Directory)({
    id: "agent-bus",
    name: "Agent Bus",
    aliases: ["/workspace/agent-bus", "/workspace/worktrees/wt-agent-sample"],
    description: "Repository and delivery coordination for the bus.",
    concerns: [
      {
        id: "orientation",
        topic: "bus-orientation",
        name: "Composed orientation",
        description: "Implement and qualify newcomer and returning-agent orientation.",
        references: [{ label: "Accepted frame", target: "docs/frames/composed-orientation.md" }],
      },
      {
        id: "viewer",
        topic: "bus-viewer",
        name: "Viewer",
        references: [{ label: "Viewer runbook", target: "docs/runbooks/viewer.md" }],
      },
    ],
  });
  const body =
    'Frame: docs/frames/composed-orientation.md. Accepted source: reviewed orientation frame, branch codex/bus-orientation-frame at the approved commit; work in /workspace/worktrees/wt-agent-sample. Boundary: implement and qualify; do not merge, deploy, change the live service, or access credentials. Phase: implementation and integrated qualification. Next owner: delivery lead. Preserve exact source identity; notify the director on a material blocker. Unicode and escaping probe: café; 日本語; "quoted". TAIL-SENTINEL.';
  const bulletin = {
    scope: { kind: "programme" },
    body,
    revision: "0198a111-1111-7111-8111-111111111111",
    publishedAt: "2026-11-02T00:00:00.000Z",
    publisher: "human/director",
    audience: ["*"],
    status: "current",
  };
  const envelope = {
    directory,
    programme: bulletin,
    selectedConcern: {
      ...bulletin,
      scope: { kind: "concern", directory: "agent-bus", concern: "orientation" },
    },
    candidates: [],
    members: [],
    ledger: "urn:synthetic",
    t: 100,
    evaluatedAt: "2026-11-02T00:00:00.000Z",
  };
  expect(jsonBytes(directory)).toBeLessThan(DIRECTORY_BYTES);
  expect(textBytes(body)).toBeLessThan(BULLETIN_BODY_BYTES);
  expect(jsonBytes(bulletin)).toBeLessThan(BULLETIN_UNIT_BYTES);
  expect(jsonBytes(envelope)).toBeLessThan(65_536);
  expect(JSON.stringify(envelope)).toContain("TAIL-SENTINEL");
});

test("directory sets are canonical without erasing ordered references or omission", async () => {
  const input = Schema.decodeUnknownSync(Directory)({
    id: "project",
    name: "Project",
    aliases: ["/z/", "/a/./", "/z", "/"],
    concerns: [
      { id: "z", name: "Z", topic: "#z", references: [] },
      { id: "a", name: "A", topic: "a" },
    ],
  });
  const normalized = await Effect.runPromise(normalizeDirectory(input));
  expect(normalized.aliases).toEqual(["/", "/a", "/z"]);
  expect(normalized.concerns.map(({ id, topic }) => [id, topic])).toEqual([
    ["a", "a"],
    ["z", "z"],
  ]);
  expect(normalized.concerns[1]).not.toHaveProperty("references");
  expect(canonicalJson({ a: 1, b: ["x", "y"] })).toBe(canonicalJson({ b: ["x", "y"], a: 1 }));
  const withoutEmptyReferences = {
    ...input,
    concerns: input.concerns.map(({ references: _, ...concern }) => concern),
  };
  expect(await Effect.runPromise(normalizeDirectory(withoutEmptyReferences))).toEqual(normalized);
  expect(await Effect.runPromise(normalizeAudience(["b", "a", "b"]))).toEqual(["a", "b"]);
  expect(await Effect.runPromise(Effect.isFailure(normalizeAudience(["#team"], true)))).toBe(true);
});

test("operation ids, dates and byte bounds are not inferred from character counts", async () => {
  expect(Schema.is(OperationId)("0198a111-1111-7111-8111-111111111111")).toBe(true);
  expect(Schema.is(OperationId)("0198a111-1111-4111-8111-111111111111")).toBe(false);
  expect(utcInstant("2026-11-02T00:00:00Z")).toBe(true);
  expect(utcInstant("2026-02-30T00:00:00Z")).toBe(false);
  expect(textBytes("é".repeat(2_049))).toBeGreaterThan(BULLETIN_BODY_BYTES);
  const oversized = Schema.decodeUnknownSync(Directory)({
    id: "project",
    name: "Project",
    aliases: [],
    concerns: [],
    description: "é".repeat(9_000),
  });
  expect(await Effect.runPromise(Effect.isFailure(normalizeDirectory(oversized)))).toBe(true);
});

test("checkout aliases match lexical descendants without sibling-prefix or symlink inference", () => {
  expect(checkoutMatches("/workspace/repo/", "/workspace/repo")).toBe(true);
  expect(checkoutMatches("/workspace/repo", "/workspace/repo/src/component")).toBe(true);
  expect(checkoutMatches("/workspace/repo", "/workspace/repo-other")).toBe(false);
  expect(checkoutMatches("/workspace/repo", "/workspace/repo/../elsewhere")).toBe(false);
  expect(checkoutMatches("/", "/workspace/repo")).toBe(true);
  expect(checkoutMatches("relative", "/workspace/repo")).toBe(false);
});
