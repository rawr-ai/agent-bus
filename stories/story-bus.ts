import type {
  HistoryInput,
  HistoryObservation,
  HistoryWindow,
  PeersObservation,
  PublicMessage,
  PublicPeer,
  ThreadInput,
  ThreadObservation,
} from "../viewer/shared/public";

/**
 * A synthetic bus for stories: observations are recorded at commits of a ledger, and entries
 * accumulate, so a reply tree read at t sees every entry any observation showed at or before
 * t, as an append-only bus would. Nothing here is fetched or stored.
 */

/** A rejection shaped like the oRPC client's: only the HTTP status is read. */
export class StatusError extends Error {
  constructor(readonly status: number) {
    super(`Synthetic ${status}`);
  }
}

export const STORY_LEDGER = "story-ledger";

type Commit = { readonly ledger: string; readonly t: number; readonly messages: PublicMessage[] };
let commits: Commit[] = [];
let head = 0;

/** Every story starts with an empty bus. */
export const resetStoryBus = () => {
  commits = [];
  head = 0;
};

export interface HistoryOptions {
  readonly observedAt?: string;
  readonly omitted?: number;
  readonly criteria?: HistoryInput;
  readonly window?: HistoryWindow;
  readonly damaged?: number;
  readonly ledger?: string;
  /** The commit read; the next one by default. */
  readonly t?: number;
  /** The head when the read finished, when it had moved past t. */
  readonly currentHeadT?: number;
}

/** A history observation, recording its messages as entries at its commit. */
export const historyOf = (
  messages: PublicMessage[],
  options: HistoryOptions = {}
): HistoryObservation => {
  const t = options.t ?? head + 1;
  head = Math.max(head, t, options.currentHeadT ?? 0);
  const ledger = options.ledger ?? STORY_LEDGER;
  commits.push({ ledger, t, messages });
  const window = options.window ?? "all";
  const damaged = options.damaged ?? 0;
  return {
    messages,
    criteria: options.criteria ?? { limit: 200 },
    observedAt: options.observedAt ?? "2026-01-01T12:00:00Z",
    omitted: options.omitted ?? 0,
    snapshot: {
      ledger,
      t,
      ...(options.currentHeadT === undefined ? {} : { currentHeadT: options.currentHeadT }),
    },
    window,
    damaged,
    complete: window === "all" && damaged === 0,
  };
};

export const peersOf = (addresses: string[], omitted = 0): PeersObservation => ({
  observedAt: "2026-01-01T12:00:01Z",
  omitted,
  peers: addresses.map((address): PublicPeer => ({ address, runtime: "other", topics: [] })),
  snapshot: { ledger: STORY_LEDGER, t: Math.max(head, 1) },
  damaged: 0,
  complete: true,
});

/**
 * The reply tree containing `request.id` at its commit: every entry reaching, along replyTo
 * links, a node the selected entry reaches. A missing target cuts the tree there. A 503 when
 * the entry is not on that ledger at t.
 */
export const threadOf = (request: ThreadInput): ThreadObservation => {
  const entries = new Map<string, PublicMessage>();
  for (const commit of commits)
    if (commit.ledger === request.ledger && commit.t <= request.t)
      for (const message of commit.messages)
        if (!entries.has(message.id)) entries.set(message.id, message);
  if (!entries.has(request.id)) throw new StatusError(503);
  const reach = (id: string) => {
    const seen = new Set<string>();
    for (let node: string | undefined = id; node !== undefined && !seen.has(node); ) {
      seen.add(node);
      node = entries.get(node)?.replyTo;
    }
    return seen;
  };
  const top = reach(request.id);
  const members = [...entries.values()].filter((message) =>
    [...reach(message.id)].some((node) => top.has(node))
  );
  const ids = new Set(members.map((message) => message.id));
  const missing = members
    .map((message) => message.replyTo)
    .filter((target): target is string => target !== undefined && !ids.has(target));
  return {
    messages: members,
    request,
    observedAt: "2026-01-01T12:00:02Z",
    omitted: 0,
    snapshot: { ledger: request.ledger, t: request.t },
    missingReplyTargets: [...new Set(missing)].sort(),
    damaged: 0,
    exhausted: true,
    complete: true,
  };
};
