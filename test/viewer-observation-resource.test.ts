import { expect, test } from "bun:test";
import { createObservationResource } from "../viewer/src/observation-resource.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  await Promise.resolve();
};
const fixture = () => {
  const calls: Array<{ input: string; signal: AbortSignal } & ReturnType<typeof deferred<string>>> =
    [];
  const deadlines = new Set<() => void>();
  const delays: number[] = [];
  const resource = createObservationResource({
    input: "latest",
    keyOf: (value) => value,
    load: (input, signal) => {
      const result = deferred<string>();
      calls.push({ input, signal, ...result });
      return result.promise;
    },
    schedule: (run, millis) => {
      deadlines.add(run);
      delays.push(millis);
      return () => {
        deadlines.delete(run);
      };
    },
  });
  const expire = () => {
    for (const run of [...deadlines]) run();
  };
  return { resource, calls, deadlines, delays, expire };
};

test("starts idle, refreshes explicitly and retains actual successful input/key", async () => {
  const f = fixture();
  expect(f.calls).toEqual([]);
  expect(f.resource.getSnapshot()).toEqual({
    input: "latest",
    key: "latest",
    observation: null,
    loading: false,
    error: null,
  });
  const initial = f.resource.getSnapshot();
  expect(f.resource.getSnapshot()).toBe(initial);
  f.resource.refresh();
  expect(f.delays).toEqual([12_000]);
  expect(f.resource.getSnapshot().loading).toBe(true);
  f.calls[0]?.resolve("first");
  await flush();
  expect(f.resource.getSnapshot().observation).toEqual({
    input: "latest",
    key: "latest",
    value: "first",
  });
  expect(f.deadlines.size).toBe(0);
  f.resource.dispose();
});

test("changed criteria replace pending, same key does not fetch, late ignored-abort success cannot win", async () => {
  const f = fixture();
  f.resource.refresh();
  f.resource.setInput("search");
  f.resource.setInput("search");
  expect(f.calls.map((call) => call.input)).toEqual(["latest", "search"]);
  expect(f.calls[0]?.signal.aborted).toBe(true);
  f.calls[1]?.resolve("matches");
  await flush();
  f.calls[0]?.resolve("stale");
  await flush();
  expect(f.resource.getSnapshot()).toEqual({
    input: "search",
    key: "search",
    observation: { input: "search", key: "search", value: "matches" },
    loading: false,
    error: null,
  });
  f.resource.dispose();
});

test("manual refresh replaces same-key pending while automatic refresh can skip it", async () => {
  const f = fixture();
  f.resource.refresh();
  const snapshot = f.resource.getSnapshot();
  f.resource.refresh({ replacePending: false });
  expect(f.calls).toHaveLength(1);
  expect(f.resource.getSnapshot()).toBe(snapshot);
  f.resource.refresh();
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]?.signal.aborted).toBe(true);
  f.calls[0]?.reject(new Error("private stale failure"));
  await flush();
  expect(f.resource.getSnapshot().error).toBeNull();
  expect(f.resource.getSnapshot().loading).toBe(true);
  f.calls[1]?.resolve("new");
  await flush();
  expect(f.resource.getSnapshot().observation?.value).toBe("new");
  f.resource.dispose();
});

test("failed changed criteria keep last-good criteria/value rather than empty success", async () => {
  const f = fixture();
  f.resource.refresh();
  f.calls[0]?.resolve("previous data");
  await flush();
  f.resource.setInput("other");
  expect(f.resource.getSnapshot().observation?.key).toBe("latest");
  f.calls[1]?.reject(new Error("private failure"));
  await flush();
  expect(f.resource.getSnapshot()).toEqual({
    input: "other",
    key: "other",
    observation: { input: "latest", key: "latest", value: "previous data" },
    loading: false,
    error: "unavailable",
  });
  expect(f.deadlines.size).toBe(0);
  f.resource.dispose();
});

test("deadline aborts a noncooperating loader, ends loading and ignores later settlement", async () => {
  const f = fixture();
  f.resource.refresh();
  f.calls[0]?.resolve("last good");
  await flush();
  f.resource.setInput("slow");
  f.expire();
  expect(f.calls[1]?.signal.aborted).toBe(true);
  expect(f.resource.getSnapshot().error).toBe("timeout");
  expect(f.resource.getSnapshot().loading).toBe(false);
  expect(f.resource.getSnapshot().observation?.value).toBe("last good");
  const timedOut = f.resource.getSnapshot();
  f.calls[1]?.resolve("too late");
  await flush();
  expect(f.resource.getSnapshot()).toBe(timedOut);
  f.resource.refresh({ replacePending: false });
  expect(f.calls).toHaveLength(3);
  f.calls[2]?.resolve("recovered");
  await flush();
  expect(f.resource.getSnapshot().error).toBeNull();
  expect(f.resource.getSnapshot().observation?.key).toBe("slow");
  f.resource.dispose();
});

test("cancel is silent and old rejecting promises cannot create an error", async () => {
  const f = fixture();
  f.resource.refresh();
  f.resource.cancel();
  expect(f.calls[0]?.signal.aborted).toBe(true);
  expect(f.deadlines.size).toBe(0);
  expect(f.resource.getSnapshot().loading).toBe(false);
  f.calls[0]?.reject(new Error("late abort rejection"));
  await flush();
  expect(f.resource.getSnapshot().error).toBeNull();
  f.resource.refresh();
  expect(f.calls).toHaveLength(2);
  f.resource.dispose();
});

test("subscription cleanup and disposal prevent later work or publication", async () => {
  const f = fixture();
  let events = 0;
  const unsubscribe = f.resource.subscribe(() => {
    events++;
  });
  f.resource.refresh();
  expect(events).toBe(1);
  unsubscribe();
  f.calls[0]?.resolve("first");
  await flush();
  expect(events).toBe(1);
  f.resource.subscribe(() => {
    events++;
  });
  f.resource.refresh();
  expect(events).toBe(2);
  f.resource.dispose();
  f.resource.dispose();
  const disposed = f.resource.getSnapshot();
  f.resource.refresh();
  f.resource.setInput("ignored");
  f.resource.cancel();
  f.resource.subscribe(() => {
    events++;
  });
  f.calls[1]?.resolve("late");
  await flush();
  expect(events).toBe(2);
  expect(f.calls).toHaveLength(2);
  expect(f.deadlines.size).toBe(0);
  expect(f.resource.getSnapshot()).toBe(disposed);
});

test("synchronous loader throws are generic unavailable state", () => {
  const resource = createObservationResource<string, string>({
    input: "latest",
    keyOf: (input) => input,
    load: () => {
      throw new Error("private diagnostic");
    },
    schedule: () => () => {},
  });
  resource.refresh();
  expect(resource.getSnapshot().error).toBe("unavailable");
  expect(resource.getSnapshot().loading).toBe(false);
  expect(resource.getSnapshot().observation).toBeNull();
  resource.dispose();
});

test("two independent resources do not share freshness, errors or cancellation", async () => {
  const history = fixture();
  const peers = fixture();
  history.resource.refresh();
  peers.resource.refresh();
  history.calls[0]?.resolve("history");
  peers.expire();
  await flush();
  expect(history.resource.getSnapshot().observation?.value).toBe("history");
  expect(history.resource.getSnapshot().error).toBeNull();
  expect(history.calls[0]?.signal.aborted).toBe(false);
  expect(peers.resource.getSnapshot().error).toBe("timeout");
  expect(peers.resource.getSnapshot().observation).toBeNull();
  history.resource.dispose();
  peers.resource.dispose();
});
