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

/**
 * What an exception that escaped the runner was, without its message: a raw message can carry
 * page or tool text. Assertion text is shown only when the runner wrote it, and a response
 * timeout names the library's own method and limit.
 */
export function abortCause(error: unknown): string {
  if (!(error instanceof Error)) return "non-Error";
  const name = /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "unnamed";
  if (name === "AssertionError" && Reflect.get(error, "generatedMessage") === false)
    return `${name}: ${error.message}`;
  const method = Reflect.get(error, "method");
  const timeoutMs = Reflect.get(error, "timeoutMs");
  if (typeof method === "string" && /^[A-Za-z.]{1,60}$/.test(method) && Number.isInteger(timeoutMs))
    return `${name} ${method} ${timeoutMs}ms`;
  return name;
}
