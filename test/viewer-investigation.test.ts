import { expect, test } from "bun:test";
import type { HistoryInput } from "../viewer/shared/public";
import { createAutoRefreshScheduler } from "../viewer/src/auto-refresh";
import { canonicalHistoryInput, historyInputKey } from "../viewer/src/history-criteria";
import { createObservationResource } from "../viewer/src/observation-resource";

const clock = () => {
  let now = 0;
  const jobs: Array<{ due: number; active: boolean; run: () => void }> = [];
  return {
    jobs,
    count: () => jobs.filter((job) => job.active).length,
    schedule: (run: () => void, millis: number) => {
      const job = { due: now + millis, active: true, run };
      jobs.push(job);
      return () => {
        job.active = false;
      };
    },
    advance: (millis: number) => {
      const until = now + millis;
      for (;;) {
        const next = jobs
          .filter((job) => job.active && job.due <= until)
          .sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        next.active = false;
        next.run();
      }
      now = until;
    },
  };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => Promise.resolve();

test("criteria key includes every exact literal and only empty fields become absent", () => {
  const original = Object.freeze({ limit: 200, query: " MiXeD #a ", participant: " Peer/A " });
  expect(canonicalHistoryInput(original)).toEqual(original);
  expect(historyInputKey(original)).toBe('[200," MiXeD #a "," Peer/A "]');
  expect(canonicalHistoryInput({ limit: 200, query: "", participant: "" })).toEqual({ limit: 200 });
  expect(historyInputKey({ limit: 200, query: "" })).toBe(historyInputKey({ limit: 200 }));
  for (const other of [
    { ...original, limit: 199 },
    { ...original, query: " mixed #a " },
    { ...original, query: "MiXeD #a" },
    { ...original, participant: "Peer/A" },
    { ...original, participant: " Peer/a " },
    { ...original, participant: "\u202e" },
  ])
    expect(historyInputKey(other)).not.toBe(historyInputKey(original));
  expect(historyInputKey({ limit: 1, query: "a,b", participant: "c" })).not.toBe(
    historyInputKey({ limit: 1, query: "a", participant: "b,c" })
  );
  expect(canonicalHistoryInput({ limit: 1, query: " " })).toEqual({ limit: 1, query: " " });
  expect(original.query).toBe(" MiXeD #a ");
});

test("automatic refresh starts explicitly, owns one 15-second timer, and is replay-safe", () => {
  const c = clock();
  let calls = 0;
  const scheduler = createAutoRefreshScheduler({
    refresh: () => {
      calls++;
    },
    schedule: c.schedule,
  });
  expect(c.count()).toBe(0);
  scheduler.start();
  scheduler.start();
  expect(c.count()).toBe(1);
  c.advance(14_999);
  expect(calls).toBe(0);
  c.advance(1);
  expect(calls).toBe(1);
  expect(c.count()).toBe(1);
  const abandoned = c.jobs.find((job) => job.active);
  scheduler.stop();
  abandoned?.run();
  expect(calls).toBe(1);
  expect(c.count()).toBe(0);
  scheduler.start();
  c.advance(15_000);
  expect(calls).toBe(2);
  scheduler.stop();
});

test("hidden/pause suppress work, visible/resume read once, and no catch-up queue forms", () => {
  const c = clock();
  let calls = 0;
  const scheduler = createAutoRefreshScheduler({
    refresh: () => {
      calls++;
    },
    schedule: c.schedule,
  });
  scheduler.start();
  scheduler.setVisible(false);
  c.advance(90_000);
  expect(calls).toBe(0);
  expect(c.count()).toBe(0);
  scheduler.setVisible(true);
  scheduler.setVisible(true);
  expect(calls).toBe(1);
  expect(c.count()).toBe(1);
  scheduler.setEnabled(false);
  c.advance(90_000);
  scheduler.setVisible(false);
  scheduler.setEnabled(true);
  expect(calls).toBe(1);
  expect(c.count()).toBe(0);
  scheduler.setVisible(true);
  expect(calls).toBe(2);
  c.advance(15_000);
  expect(calls).toBe(3);
  scheduler.setEnabled(false);
  scheduler.setEnabled(true);
  expect(calls).toBe(4);
  expect(c.count()).toBe(1);
  scheduler.stop();
  scheduler.setVisible(false);
  scheduler.setVisible(true);
  expect(calls).toBe(4);
  expect(c.count()).toBe(0);
});

test("hidden initial mount has no timer and invalid intervals are refused", () => {
  const c = clock();
  let calls = 0;
  const scheduler = createAutoRefreshScheduler({
    visible: false,
    refresh: () => {
      calls++;
    },
    schedule: c.schedule,
  });
  scheduler.start();
  expect(c.count()).toBe(0);
  scheduler.setVisible(true);
  expect(calls).toBe(1);
  scheduler.stop();
  for (const intervalMillis of [0, -1, NaN, Infinity])
    expect(() => createAutoRefreshScheduler({ refresh: () => {}, intervalMillis })).toThrow();
});

test("automatic ticks skip pending resources independently; manual criteria replace and retain true last-good scope", async () => {
  const c = clock();
  type Value = { criteria: HistoryInput; token: string };
  const calls: Array<
    { input: HistoryInput; signal: AbortSignal } & ReturnType<typeof deferred<Value>>
  > = [];
  const history = createObservationResource<HistoryInput, Value>({
    input: { limit: 200 },
    keyOf: historyInputKey,
    timeoutMillis: 40_000,
    schedule: c.schedule,
    load: (input, signal) => {
      const pending = deferred<Value>();
      calls.push({ input, signal, ...pending });
      return pending.promise;
    },
  });
  let peerCalls = 0;
  const peers = createObservationResource({
    input: {},
    keyOf: () => "peers",
    schedule: c.schedule,
    load: async () => ++peerCalls,
  });
  history.refresh();
  peers.refresh();
  calls[0]?.resolve({ criteria: { limit: 200 }, token: "last good" });
  await flush();
  const scheduler = createAutoRefreshScheduler({
    schedule: c.schedule,
    refresh: () => {
      history.refresh({ replacePending: false });
      peers.refresh({ replacePending: false });
    },
  });
  scheduler.start();
  history.refresh();
  c.advance(15_000);
  await flush();
  expect(calls).toHaveLength(2);
  expect(peerCalls).toBe(2);
  const applied = canonicalHistoryInput({ limit: 200, query: " Mixed ", participant: " Peer/A " });
  history.setInput(applied);
  expect(calls[1]?.signal.aborted).toBe(true);
  expect(calls[2]?.input).toEqual(applied);
  calls[2]?.reject(new Error("private failure"));
  await flush();
  calls[1]?.resolve({ criteria: { limit: 200 }, token: "stale ignored abort" });
  await flush();
  expect(history.getSnapshot().input).toEqual(applied);
  expect(history.getSnapshot().observation?.value).toEqual({
    criteria: { limit: 200 },
    token: "last good",
  });
  expect(history.getSnapshot().error).toBe("unavailable");
  expect(peers.getSnapshot().error).toBeNull();
  c.advance(15_000);
  expect(calls[3]?.input).toEqual(applied);
  calls[3]?.resolve({ criteria: applied, token: "recovered" });
  await flush();
  expect(history.getSnapshot().observation?.value.criteria).toEqual(applied);
  expect(history.getSnapshot().error).toBeNull();
  history.setInput({ limit: 200 });
  expect(calls[4]?.input).toEqual({ limit: 200 });
  expect(history.getSnapshot().observation?.value.token).toBe("recovered");
  scheduler.stop();
  history.dispose();
  peers.dispose();
  expect(c.count()).toBe(0);
});

test("StrictMode-like cancel/restart preserves a usable resource and ignores the cancelled generation", async () => {
  const c = clock();
  const calls: Array<ReturnType<typeof deferred<string>>> = [];
  const resource = createObservationResource({
    input: "literal",
    keyOf: (input) => input,
    schedule: c.schedule,
    load: () => {
      const pending = deferred<string>();
      calls.push(pending);
      return pending.promise;
    },
  });
  resource.refresh();
  resource.cancel();
  resource.refresh();
  calls[1]?.resolve("current");
  await flush();
  calls[0]?.resolve("old");
  await flush();
  expect(resource.getSnapshot().observation?.value).toBe("current");
  resource.cancel();
  resource.refresh();
  calls[2]?.reject(new Error("current failure"));
  await flush();
  expect(resource.getSnapshot().observation?.value).toBe("current");
  expect(resource.getSnapshot().error).toBe("unavailable");
  resource.dispose();
});
