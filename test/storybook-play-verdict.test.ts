import { describe, expect, test } from "bun:test";
import { type PlayEvent, playVerdict } from "../scripts/storybook-play-verdict";

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
