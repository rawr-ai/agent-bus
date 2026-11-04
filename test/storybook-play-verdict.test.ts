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
  test("shows the runner's own assertion text and never a generated one", () => {
    expect(abortCause(caught(() => assert.ok(false, "requested story exists")))).toBe(
      "AssertionError: requested story exists"
    );
    const generated = abortCause(caught(() => assert.equal(secret, "expected")));
    expect(generated).toBe("AssertionError");
  });
  test("names a library timeout by its method and limit", () => {
    const timeout = Object.assign(new Error(secret), {
      name: "RPCResponseTimeoutError",
      method: "page.goto",
      timeoutMs: 10_000,
    });
    expect(abortCause(timeout)).toBe("RPCResponseTimeoutError page.goto 10000ms");
  });
  test("never prints a message, a hostile name or a hostile method", () => {
    const named = (name: string, extra: object = {}) =>
      abortCause(Object.assign(new Error(secret), { name }, extra));
    for (const cause of [
      abortCause(new Error(secret)),
      abortCause(new TypeError(secret)),
      named(secret),
      named("AssertionError"),
      named("Error", { method: secret, timeoutMs: 1 }),
      abortCause(secret),
    ])
      expect(cause).not.toContain("token");
    expect(abortCause(new Error(secret))).toBe("Error");
    expect(named(secret)).toBe("unnamed");
    expect(named("AssertionError")).toBe("AssertionError");
    expect(abortCause(secret)).toBe("non-Error");
  });
});
