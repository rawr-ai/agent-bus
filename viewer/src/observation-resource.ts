export interface ObservationSnapshot<I, T> {
  readonly input: I;
  readonly key: string;
  readonly observation: { readonly input: I; readonly key: string; readonly value: T } | null;
  readonly loading: boolean;
  readonly error: null | "unavailable" | "timeout";
}

export interface ObservationResource<I, T> {
  readonly getSnapshot: () => ObservationSnapshot<I, T>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setInput: (input: I) => void;
  readonly refresh: (options?: { readonly replacePending?: boolean }) => void;
  readonly cancel: () => void;
  readonly dispose: () => void;
}

const scheduleDeadline = (run: () => void, millis: number): (() => void) => {
  const timer = setTimeout(run, millis);
  return () => clearTimeout(timer);
};

/** Inputs are immutable request values; keyOf must include every request-relevant field. */
export const createObservationResource = <I, T>(options: {
  readonly input: I;
  readonly keyOf: (input: I) => string;
  readonly load: (input: I, signal: AbortSignal) => Promise<T>;
  readonly timeoutMillis?: number;
  readonly schedule?: (run: () => void, millis: number) => () => void;
}): ObservationResource<I, T> => {
  const timeout = options.timeoutMillis ?? 12_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid observation deadline");
  const schedule = options.schedule ?? scheduleDeadline;
  const listeners = new Set<() => void>();
  let snapshot: ObservationSnapshot<I, T> = {
    input: options.input,
    key: options.keyOf(options.input),
    observation: null,
    loading: false,
    error: null,
  };
  let disposed = false;
  let generation = 0;
  let pending:
    | {
        readonly generation: number;
        readonly input: I;
        readonly key: string;
        readonly controller: AbortController;
        cancelDeadline: () => void;
      }
    | undefined;

  const notify = () => {
    for (const listener of [...listeners]) {
      if (disposed) break;
      if (listeners.has(listener)) listener();
    }
  };
  const stopPending = () => {
    generation++;
    const previous = pending;
    pending = undefined;
    previous?.cancelDeadline();
    previous?.controller.abort();
  };

  const refresh = (refreshOptions?: { readonly replacePending?: boolean }) => {
    if (disposed || (pending !== undefined && refreshOptions?.replacePending === false)) return;
    stopPending();
    const request = {
      generation,
      input: snapshot.input,
      key: snapshot.key,
      controller: new AbortController(),
      cancelDeadline: () => {},
    };
    pending = request;
    snapshot = { ...snapshot, loading: true, error: null };
    const current = () => !disposed && pending === request && generation === request.generation;
    const unavailable = () => {
      if (!current()) return;
      pending = undefined;
      request.cancelDeadline();
      snapshot = { ...snapshot, loading: false, error: "unavailable" };
      notify();
    };
    try {
      request.cancelDeadline = schedule(() => {
        if (!current()) return;
        pending = undefined;
        request.cancelDeadline();
        snapshot = { ...snapshot, loading: false, error: "timeout" };
        request.controller.abort();
        notify();
      }, timeout);
      if (!current()) {
        request.cancelDeadline();
        return;
      }
      const result = options.load(request.input, request.controller.signal);
      void result.then((value) => {
        if (!current()) return;
        pending = undefined;
        request.cancelDeadline();
        snapshot = {
          ...snapshot,
          observation: { input: request.input, key: request.key, value },
          loading: false,
          error: null,
        };
        notify();
      }, unavailable);
    } catch {
      unavailable();
      return;
    }
    notify();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setInput: (input) => {
      if (disposed) return;
      const key = options.keyOf(input);
      if (key === snapshot.key) {
        if (Object.is(input, snapshot.input)) return;
        snapshot = { ...snapshot, input };
        notify();
        return;
      }
      snapshot = { ...snapshot, input, key };
      refresh();
    },
    refresh,
    cancel: () => {
      if (disposed) return;
      stopPending();
      if (!snapshot.loading && snapshot.error === null) return;
      snapshot = { ...snapshot, loading: false, error: null };
      notify();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      stopPending();
      snapshot = { ...snapshot, loading: false, error: null };
    },
  };
};
