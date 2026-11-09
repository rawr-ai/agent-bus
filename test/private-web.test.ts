import { expect, test } from "bun:test";
import { cursorCodec } from "../src/private-web/cursor.ts";
import { evidenceTools } from "../src/private-web/tools.ts";

test("evidence cursors conceal native positions and reject mutation and a different key", () => {
  const reader = cursorCodec(new Uint8Array(32).fill(1));
  const restarted = cursorCodec(new Uint8Array(32).fill(2));
  const position = "bq1.withheld-position-canary";
  const token = reader.seal(position);
  expect(reader.open(token)).toBe(position);
  expect(reader.seal(position)).not.toBe(token);
  expect(Buffer.from(token.slice(3), "base64url").includes(position)).toBe(false);
  expect(reader.open(`v1.${token[3] === "A" ? "B" : "A"}${token.slice(4)}`)).toBeUndefined();
  expect(reader.open(`${token}=`)).toBeUndefined();
  expect(reader.open(position)).toBeUndefined();
  expect(restarted.open(token)).toBeUndefined();
});

test("private evidence inputs report known fields without echoing rejected data", () => {
  const [history, search, thread, messages] = evidenceTools(async () => ({
    refusal: "UNAVAILABLE",
  }));
  const snapshot = { ledger: "fixture-ledger", t: 5 };
  const rejected = "REJECTED_VALUE_CANARY";
  const reversed = history.parameters["~standard"].validate({
    fromTs: "2026-11-09T13:00:00Z",
    toTs: "2026-11-09T12:00:00Z",
  });
  expect(reversed).toEqual({
    issues: [{ path: ["toTs"], message: "Set toTs after fromTs (the end is exclusive)." }],
  });
  expect(history.parameters["~standard"].validate({ participants: [rejected, rejected] })).toEqual({
    issues: [{ path: ["participants"], message: "Remove duplicate values." }],
  });
  expect(
    search.parameters["~standard"].validate({ text: "needle", participants: [rejected, rejected] })
  ).toHaveProperty("issues");
  expect(
    messages.parameters["~standard"].validate({ ids: [rejected, rejected], snapshot })
  ).toEqual({
    issues: [{ path: ["ids"], message: "Remove duplicate values." }],
  });
  const invalid = thread.parameters["~standard"].validate({
    id: "m1",
    snapshot: { ...snapshot, [rejected]: true },
  });
  expect(invalid).toHaveProperty("issues");
  expect(JSON.stringify(invalid)).not.toContain(rejected);
  expect(messages.parameters["~standard"].validate({ ids: ["m1"], snapshot })).toEqual({
    value: { ids: ["m1"], snapshot },
  });
});

test("private evidence refusals carry a fixed code and repair without a partial page", async () => {
  for (const [refusal, hint] of [
    ["CAPACITY", "capacity is busy"],
    ["SEARCH_TOO_BROAD", "Narrow the words or participants"],
    ["INVALID_REQUEST", "Check the operation, supplied fields and snapshot"],
    ["INVALID_CURSOR", "Restart the traversal at its saved snapshot"],
    ["EVIDENCE_TOO_LARGE", "This continuation was not consumed"],
  ] as const) {
    const [history] = evidenceTools(async () => ({ refusal }));
    const result = await history.execute({}, { signal: new AbortController().signal });
    expect(result).not.toHaveProperty("structuredContent");
    expect(result).toMatchObject({ isError: true, content: [{ type: "text" }] });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      code: refusal,
      message: expect.stringContaining(hint),
    });
  }
});
