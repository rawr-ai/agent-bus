// Storybook 10.6.3 event adapter, adapted from OPA website's play-verdict harness.
export interface PlayEvent {
  readonly type: string;
  readonly storyId?: string;
  readonly phase?: string;
  readonly status?: string;
}
export interface PlayObservation {
  readonly events: readonly PlayEvent[];
  readonly end: "finished" | "timeout" | "no-play";
}
const failures = new Set([
  "playFunctionThrewException",
  "unhandledErrorsWhilePlaying",
  "storyThrewException",
  "storyErrored",
]);
export function playVerdict(storyId: string, observation: PlayObservation) {
  const events = observation.events.filter((event) => !event.storyId || event.storyId === storyId);
  if (
    events.some(
      (event) =>
        failures.has(event.type) ||
        event.phase === "errored" ||
        event.phase === "aborted" ||
        (event.type === "storyFinished" && event.status !== "success")
    )
  )
    return { ok: false, reason: "Storybook reported an error" };
  if (observation.end !== "finished")
    return {
      ok: false,
      reason: observation.end === "no-play" ? "render-only story has no play" : "play deadline",
    };
  const playing = events.findIndex((event) => event.phase === "playing");
  const played = events.findIndex((event, index) => index > playing && event.phase === "played");
  const finished = events.findIndex(
    (event, index) => index > played && event.type === "storyFinished" && event.status === "success"
  );
  return playing >= 0 && played > playing && finished > played
    ? { ok: true, reason: "play completed successfully" }
    : { ok: false, reason: "missing ordered playing, played, success evidence" };
}
