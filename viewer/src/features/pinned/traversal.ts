import { MAX_INVESTIGATION_ENTRIES } from "../../../shared/limits";
import {
  IDENTITY_FIELDS,
  type IdentityField,
  type InvestigationEntry,
  type InvestigationPage,
  type InvestigationPageInput,
  type InvestigationReference,
  isSupportedContinuation,
} from "../../../shared/public";
import { pageFits, referenceFits } from "../../../shared/request-size";

/** A page shape the bus never returns for a forward history reading; its rows are not kept. */
export type Fault =
  | "continuation-after-end"
  | "missing-continuation"
  | "repeated-continuation"
  | "repeated-entry"
  | "out-of-order"
  | "stalled"
  | "damage-count"
  | "unclaimed-end";

/**
 * How a reading ended. Only `complete` is the answer; every other end leaves the entries read
 * so far on screen as the earliest part of the window, labelled with its reason.
 */
export type TraversalEnd =
  | { readonly kind: "complete" }
  | { readonly kind: "bound" }
  | { readonly kind: "damaged" }
  | { readonly kind: "omitted" }
  | { readonly kind: "transport" }
  | { readonly kind: "deadline" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "fault"; readonly fault: Fault }
  | { readonly kind: "bus-error" }
  | { readonly kind: "identity"; readonly field: IdentityField | undefined }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" };

/** What the reading has kept, and the claims of the pages it kept in full. */
export interface Progress {
  readonly entries: ReadonlyArray<InvestigationEntry>;
  readonly ids: ReadonlySet<string>;
  readonly continuations: ReadonlySet<string>;
  readonly pages: number;
  readonly omitted: number;
  readonly damaged: number;
  readonly damagedTotal: number;
}

export const emptyProgress: Progress = {
  entries: [],
  ids: new Set(),
  continuations: new Set(),
  pages: 0,
  omitted: 0,
  damaged: 0,
  damagedTotal: 0,
};

export type Step =
  | { readonly progress: Progress; readonly cursor: string }
  | { readonly progress: Progress; readonly end: TraversalEnd };

const fault = (progress: Progress, which: Fault): Step => ({
  progress,
  end: { kind: "fault", fault: which },
});

/**
 * The page's shape fault, if any. Ids within one commit are the provider's order, not judged.
 * Every row of the page is checked, those past the bound included.
 */
const faultOf = (progress: Progress, page: InvestigationPage): Fault | undefined => {
  if (page.exhausted && page.next !== undefined) return "continuation-after-end";
  if (!page.exhausted && page.next === undefined) return "missing-continuation";
  if (page.next !== undefined && progress.continuations.has(page.next)) {
    return "repeated-continuation";
  }
  let lastT = progress.entries.at(-1)?.t ?? 0;
  for (const entry of page.entries) {
    if (progress.ids.has(entry.message.id)) return "repeated-entry";
    if (entry.t < lastT) return "out-of-order";
    lastT = entry.t;
  }
  if (page.damaged === 0 && page.omitted === 0 && !page.exhausted && page.entries.length === 0) {
    return "stalled";
  }
  // The bus carries its damage total forward through the cursor: this page's own plus the last.
  if (page.damagedTotal !== progress.damagedTotal + page.damaged) return "damage-count";
  // The bus claims complete exactly when it has exhausted the window and met no damage.
  if (page.exhausted && page.damagedTotal === 0 && !page.complete) return "unclaimed-end";
  return undefined;
};

/**
 * One validated page joined to a forward reading, or the reading's end. Pure: the caller
 * owns requests, and passes the returned cursor back unchanged.
 */
export const acceptPage = (progress: Progress, page: InvestigationPage): Step => {
  const shape = faultOf(progress, page);
  if (shape !== undefined) return fault(progress, shape);
  const room = MAX_INVESTIGATION_ENTRIES - progress.entries.length;
  const kept = page.entries.slice(0, room);
  const joined: Progress = {
    entries: [...progress.entries, ...kept],
    ids: new Set([...progress.ids, ...kept.map((entry) => entry.message.id)]),
    continuations:
      page.next === undefined
        ? progress.continuations
        : new Set([...progress.continuations, page.next]),
    pages: progress.pages + 1,
    omitted: progress.omitted + page.omitted,
    damaged: progress.damaged + page.damaged,
    damagedTotal: page.damagedTotal,
  };
  // A page cut at the bound lends none of its claims: they describe rows the reading dropped.
  // The bus places damage only by commit, so damage anywhere on it stops as damaged. Its
  // omissions may lie in the dropped tail: they were met while reading, not among the kept.
  if (kept.length < page.entries.length) {
    if (page.damaged > 0 || page.damagedTotal > 0) {
      return { progress: joined, end: { kind: "damaged" } };
    }
    if (page.omitted > 0) return { progress: joined, end: { kind: "omitted" } };
    return { progress: joined, end: { kind: "bound" } };
  }
  if (page.damaged > 0 || page.damagedTotal > 0) {
    return { progress: joined, end: { kind: "damaged" } };
  }
  if (joined.omitted > 0) return { progress: joined, end: { kind: "omitted" } };
  if (page.exhausted && page.complete) return { progress: joined, end: { kind: "complete" } };
  if (joined.entries.length >= MAX_INVESTIGATION_ENTRIES) {
    return { progress: joined, end: { kind: "bound" } };
  }
  const next = page.next ?? "";
  if (!isSupportedContinuation(next)) return { progress: joined, end: { kind: "transport" } };
  return { progress: joined, cursor: next };
};

/** A failed page request named from its status and code, never its text. */
export type Rejection = { readonly kind: "busy" } | TraversalEnd;

export const classifyRejection = (cause: unknown): Rejection => {
  const field = (key: string): unknown =>
    typeof cause === "object" && cause !== null ? Reflect.get(cause, key) : undefined;
  const status = field("status");
  const code = field("code");
  if (status === 429) return { kind: "busy" };
  if (status === 504) return { kind: "deadline" };
  if (status === 413) return { kind: "transport" };
  if (code === "BUS_ERROR") return { kind: "bus-error" };
  if (code === "PAGE_REJECTED") return { kind: "rejected" };
  if (code === "IDENTITY_MISMATCH") {
    const data = field("data");
    const named =
      typeof data === "object" && data !== null ? Reflect.get(data, "field") : undefined;
    return {
      kind: "identity",
      field: IDENTITY_FIELDS.find((known) => known === named),
    };
  }
  return { kind: "unavailable" };
};

export type TraversalPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "reading" }
  /** Refused as busy: retried after a pause; not a stop and not a page call. */
  | { readonly kind: "busy" }
  /** Refused before any page: the reference cannot fit the host with a continuation. */
  | { readonly kind: "too-large" }
  | { readonly kind: "ended"; readonly end: TraversalEnd };

export interface TraversalSnapshot {
  readonly reference: InvestigationReference;
  readonly phase: TraversalPhase;
  readonly progress: Progress;
  /** Page requests answered, kept or failed; busy refusals and a cancelled page are not counted. */
  readonly calls: number;
}

export interface PinnedTraversal {
  readonly getSnapshot: () => TraversalSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly cancel: () => void;
  readonly dispose: () => void;
}

const scheduleTimer = (run: () => void, millis: number): (() => void) => {
  const timer = setTimeout(run, millis);
  return () => clearTimeout(timer);
};

/** One reading of one reference. A rerun is a new traversal. */
export const createPinnedTraversal = (options: {
  readonly reference: InvestigationReference;
  readonly readPage: (
    input: InvestigationPageInput,
    signal: AbortSignal
  ) => Promise<InvestigationPage>;
  readonly busyRetryMillis?: number;
  /** The browser's own limit on one page, past the host's 10-second deadline. */
  readonly pageDeadlineMillis?: number;
  readonly schedule?: (run: () => void, millis: number) => () => void;
}): PinnedTraversal => {
  const { reference } = options;
  const schedule = options.schedule ?? scheduleTimer;
  const busyRetry = options.busyRetryMillis ?? 750;
  const pageDeadline = options.pageDeadlineMillis ?? 12_000;
  const listeners = new Set<() => void>();
  const controller = new AbortController();
  let snapshot: TraversalSnapshot = {
    reference,
    phase: { kind: "idle" },
    progress: emptyProgress,
    calls: 0,
  };
  // The pending busy retry and the current page's deadline: whoever ends the reading retires both.
  let cancelRetry: (() => void) | undefined;
  let cancelDeadline: (() => void) | undefined;
  let disposed = false;

  const retire = () => {
    cancelRetry?.();
    cancelRetry = undefined;
    cancelDeadline?.();
    cancelDeadline = undefined;
  };
  const update = (next: Partial<TraversalSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) {
      if (disposed) break;
      if (listeners.has(listener)) listener();
    }
  };
  const ended = () => snapshot.phase.kind === "ended" || snapshot.phase.kind === "too-large";
  /** Whether the reading still runs: a listener may cancel or dispose during any notification. */
  const live = () => !disposed && !controller.signal.aborted && !ended();
  const end = (value: TraversalEnd, progress = snapshot.progress) =>
    update({ phase: { kind: "ended", end: value }, progress });

  const send = (cursor: string | undefined) => {
    if (!live()) return;
    const input: InvestigationPageInput =
      cursor === undefined ? { reference } : { reference, cursor };
    if (!pageFits(input)) return end({ kind: "transport" });
    if (snapshot.phase.kind !== "reading") {
      update({ phase: { kind: "reading" } });
      if (!live()) return;
    }
    // A page whose handler never settles still ends the reading, as a deadline stop.
    cancelDeadline = schedule(() => {
      cancelDeadline = undefined;
      if (!live()) return;
      controller.abort();
      end({ kind: "deadline" });
    }, pageDeadline);
    const settled = () => {
      cancelDeadline?.();
      cancelDeadline = undefined;
      return live();
    };
    // Started in a promise, so a synchronous throw is a rejected page, not a stranded reading.
    Promise.resolve()
      .then(() => options.readPage(input, controller.signal))
      .then(
        (page) => {
          if (!settled()) return;
          snapshot = { ...snapshot, calls: snapshot.calls + 1 };
          const step = acceptPage(snapshot.progress, page);
          if ("end" in step) return end(step.end, step.progress);
          update({ progress: step.progress });
          send(step.cursor);
        },
        (cause: unknown) => {
          if (!settled()) return;
          const rejection = classifyRejection(cause);
          if (rejection.kind === "busy") {
            update({ phase: { kind: "busy" } });
            if (!live()) return;
            cancelRetry = schedule(() => {
              cancelRetry = undefined;
              send(cursor);
            }, busyRetry);
            return;
          }
          snapshot = { ...snapshot, calls: snapshot.calls + 1 };
          end(rejection);
        }
      )
      .catch(() => {
        if (live()) end({ kind: "unavailable" });
      });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (snapshot.phase.kind !== "idle" || disposed) return;
      if (!referenceFits(reference)) return update({ phase: { kind: "too-large" } });
      send(undefined);
    },
    cancel: () => {
      if (!live() || snapshot.phase.kind === "idle") return;
      retire();
      controller.abort();
      end({ kind: "cancelled" });
    },
    dispose: () => {
      disposed = true;
      retire();
      controller.abort();
      listeners.clear();
    },
  };
};
