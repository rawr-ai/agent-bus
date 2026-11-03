import { expect, test } from "bun:test";
import { createAnnouncer } from "../viewer/src/announcements.ts";
import type { ObservationSnapshot } from "../viewer/src/observation-resource.ts";

type Value = { readonly ids: ReadonlyArray<string>; readonly omitted: number };
const snapshot = (
  state: Partial<Omit<ObservationSnapshot<string, Value>, "observation">> & {
    readonly observation?: ObservationSnapshot<string, Value>["observation"];
  } = {}
): ObservationSnapshot<string, Value> => ({
  input: state.key ?? "latest",
  key: state.key ?? "latest",
  observation: state.observation ?? null,
  loading: state.loading ?? false,
  error: state.error ?? null,
});
const observed = (ids: ReadonlyArray<string>, key = "latest", omitted = 0) => ({
  input: key,
  key,
  value: { ids, omitted },
});
const history = () =>
  createAnnouncer<string, Value>({
    name: "History",
    noun: ["message", "messages"],
    identities: (value) => value.ids,
    omitted: (value) => value.omitted,
  });

test("periodic refresh is silent unless records arrive", () => {
  const announce = history();
  expect(announce(snapshot({ loading: true }))).toBeNull();
  const first = observed(["a", "b"]);
  expect(announce(snapshot({ observation: first }))).toBe("History observed: 2 messages.");
  // Loading, a re-render of the same observation and a new observation of the same records stay silent.
  expect(announce(snapshot({ observation: first, loading: true }))).toBeNull();
  expect(announce(snapshot({ observation: first }))).toBeNull();
  expect(announce(snapshot({ observation: observed(["a", "b"]) }))).toBeNull();
  expect(announce(snapshot({ observation: observed(["b", "c"]) }))).toBe("History: 1 new message.");
  expect(announce(snapshot({ observation: observed(["c", "d", "e"]) }))).toBe(
    "History: 2 new messages."
  );
});

test("a failure is announced once per kind, and a recovery once", () => {
  const announce = history();
  expect(announce(snapshot({ error: "unavailable" }))).toBe("History unavailable.");
  expect(announce(snapshot({ loading: true }))).toBeNull();
  expect(announce(snapshot({ error: "unavailable" }))).toBeNull();
  expect(announce(snapshot({ error: "timeout" }))).toBe("History timed out.");
  const first = observed(["a"]);
  expect(announce(snapshot({ observation: first }))).toBe("History observed: 1 message.");
  expect(announce(snapshot({ observation: first, error: "unavailable" }))).toBe(
    "History refresh failed; showing the last observation."
  );
  expect(announce(snapshot({ observation: first, loading: true }))).toBeNull();
  expect(announce(snapshot({ observation: first, error: "unavailable" }))).toBeNull();
  expect(announce(snapshot({ observation: first, error: "timeout" }))).toBe(
    "History refresh timed out; showing the last observation."
  );
  // Cancellation clears the error without a new observation: nothing to say.
  expect(announce(snapshot({ observation: first }))).toBeNull();
  expect(announce(snapshot({ observation: observed(["a"]) }))).toBe("History observed again.");
  expect(announce(snapshot({ observation: first, error: "timeout" }))).toBe(
    "History refresh timed out; showing the last observation."
  );
  expect(announce(snapshot({ observation: observed(["a", "b"]) }))).toBe(
    "History observed again: 1 new message."
  );
});

test("applied criteria announce the replacement selection, not arrivals", () => {
  const announce = history();
  announce(snapshot({ observation: observed(["a", "b", "c"]) }));
  expect(announce(snapshot({ key: "query", observation: observed(["b"], "query") }))).toBe(
    "History observed for the applied criteria: 1 message."
  );
});

test("current peers also report departures", () => {
  const announce = createAnnouncer<string, Value>({
    name: "Current peers",
    noun: ["peer", "peers"],
    identities: (value) => value.ids,
    omitted: (value) => value.omitted,
    reportDepartures: true,
  });
  expect(announce(snapshot({ observation: observed([]) }))).toBe(
    "Current peers observed: 0 peers."
  );
  expect(announce(snapshot({ observation: observed(["a", "b"]) }))).toBe(
    "Current peers: 2 new peers."
  );
  expect(announce(snapshot({ observation: observed(["b", "c"]) }))).toBe(
    "Current peers: 1 new peer, 1 peer no longer listed."
  );
  expect(announce(snapshot({ observation: observed(["c"]) }))).toBe(
    "Current peers: 1 peer no longer listed."
  );
});

test("omitted records are announced first, and again only when their count changes", () => {
  const announce = history();
  // An observation whose every record is omitted is not announced as an empty one.
  expect(announce(snapshot({ observation: observed([], "latest", 2) }))).toBe(
    "History observed: 0 messages, 2 records omitted."
  );
  expect(announce(snapshot({ observation: observed([], "latest", 2) }))).toBeNull();
  expect(announce(snapshot({ observation: observed([], "latest", 3) }))).toBe(
    "History: 3 records omitted."
  );
  expect(announce(snapshot({ observation: observed(["a"], "latest", 1) }))).toBe(
    "History: 1 new message, 1 record omitted."
  );
  expect(announce(snapshot({ observation: observed(["a"], "latest", 1) }))).toBeNull();
  expect(announce(snapshot({ observation: observed(["a"]) }))).toBe("History: no records omitted.");
  expect(announce(snapshot({ key: "query", observation: observed(["b"], "query", 4) }))).toBe(
    "History observed for the applied criteria: 1 message, 4 records omitted."
  );
  expect(announce(snapshot({ observation: observed(["b"], "query", 4), error: "timeout" }))).toBe(
    "History refresh timed out; showing the last observation."
  );
  expect(announce(snapshot({ observation: observed(["b"], "query", 5) }))).toBe(
    "History observed again: 5 records omitted."
  );
});

test("current peers announce omitted records too", () => {
  const announce = createAnnouncer<string, Value>({
    name: "Current peers",
    noun: ["peer", "peers"],
    identities: (value) => value.ids,
    omitted: (value) => value.omitted,
    reportDepartures: true,
  });
  expect(announce(snapshot({ observation: observed(["a"], "latest", 1) }))).toBe(
    "Current peers observed: 1 peer, 1 record omitted."
  );
  expect(announce(snapshot({ observation: observed(["a"], "latest", 1) }))).toBeNull();
  expect(announce(snapshot({ observation: observed([], "latest", 2) }))).toBe(
    "Current peers: 1 peer no longer listed, 2 records omitted."
  );
});
