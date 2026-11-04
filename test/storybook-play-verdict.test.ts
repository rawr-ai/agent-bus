import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { abortCause, type PlayEvent, playVerdict } from "../scripts/storybook-play-verdict";

const id = "synthetic--story";
const success: PlayEvent[] = [
  { type: "storyRenderPhaseChanged", storyId: id, phase: "playing" },
  { type: "storyRenderPhaseChanged", storyId: id, phase: "played" },
  { type: "storyFinished", storyId: id, status: "success" },
];
describe("Storybook 10.6.3 play verdict", () => {
  test("requires ordered real play evidence", () => {
    expect(playVerdict(id, { events: success, end: "finished" }).ok).toBe(true);
    for (const events of [[], success.slice(1), [...success].reverse()])
      expect(playVerdict(id, { events, end: "finished" }).ok).toBe(false);
    for (const end of ["timeout", "no-play"] as const)
      expect(playVerdict(id, { events: success, end }).ok).toBe(false);
  });
  test("errors win even after terminal success", () => {
    for (const type of [
      "playFunctionThrewException",
      "unhandledErrorsWhilePlaying",
      "storyThrewException",
      "storyErrored",
    ])
      expect(playVerdict(id, { events: [...success, { type }], end: "finished" }).ok).toBe(false);
    for (const phase of ["errored", "aborted"])
      expect(
        playVerdict(id, {
          events: [...success, { type: "storyRenderPhaseChanged", phase }],
          end: "finished",
        }).ok
      ).toBe(false);
    expect(
      playVerdict(id, {
        events: [...success, { type: "storyFinished", status: "error" }],
        end: "finished",
      }).ok
    ).toBe(false);
  });
  test("another story cannot supply evidence or fail this story", () => {
    expect(
      playVerdict(id, {
        events: success.map((event) => ({ ...event, storyId: "other" })),
        end: "finished",
      }).ok
    ).toBe(false);
    expect(
      playVerdict(id, {
        events: [...success, { type: "storyErrored", storyId: "other" }],
        end: "finished",
      }).ok
    ).toBe(true);
  });
});

describe("an exception that escapes the play runner", () => {
  const secret = "http://127.0.0.1:1/?token=abc123 page text";
  const caught = (run: () => void) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected a throw");
  };
  const labels = new Set(["requested story exists"]);
  test("shows only the runner's own assertion labels", () => {
    expect(
      abortCause(
        caught(() => assert.ok(false, "requested story exists")),
        labels
      )
    ).toBe("AssertionError: requested story exists");
    expect(
      abortCause(
        caught(() => assert.equal(secret, "expected")),
        labels
      )
    ).toBe("AssertionError");
    // An explicit message is not provenance: a library or page can throw one too.
    expect(
      abortCause(
        caught(() => assert.ok(false, secret)),
        labels
      )
    ).toBe("AssertionError");
  });
  test("names a library timeout by its method and limit", () => {
    const timeout = Object.assign(new Error(secret), {
      name: "RPCResponseTimeoutError",
      method: "page.goto",
      timeoutMs: 10_000,
    });
    expect(abortCause(timeout, labels)).toBe("RPCResponseTimeoutError page.goto 10000ms");
  });
  test("never prints a message, a hostile name or a hostile method", () => {
    const named = (name: string, extra: object = {}) =>
      abortCause(Object.assign(new Error(secret), { name }, extra), labels);
    for (const cause of [
      abortCause(new Error(secret), labels),
      abortCause(new TypeError(secret), labels),
      named(secret),
      named("AssertionError"),
      named("Error", { method: secret, timeoutMs: 1 }),
      abortCause(secret, labels),
    ])
      expect(cause).not.toContain("token");
    expect(abortCause(new Error(secret), labels)).toBe("Error");
    expect(named(secret)).toBe("unnamed");
    expect(named("AssertionError")).toBe("AssertionError");
    expect(abortCause(secret, labels)).toBe("non-Error");
  });
});
