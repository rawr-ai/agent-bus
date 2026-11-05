import { busPage, entryRow, peerRow, searchRow } from "../test/bus-pages";
import {
  type HistoryInput,
  type HistoryObservation,
  type PeersObservation,
  type PublicMessage,
  projectHistory,
  projectPeers,
  projectThread,
  type ThreadInput,
  type ThreadObservation,
} from "../viewer/shared/public";

/**
 * A synthetic bus for stories: observations are recorded at commits of a ledger, and entries
 * accumulate, so a reply tree read at t sees every entry any observation showed at or before
 * t, as an append-only bus would. Each answer is a bus_run_query page, built by the same
 * builder the tests check against the catalogue, and projected as the viewer's server
 * projects it, so a story cannot show an observation the bus could not produce. Nothing here
 * is fetched or stored.
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
let pages: unknown[] = [];

/** Every story starts with an empty bus. */
export const resetStoryBus = () => {
  commits = [];
  head = 0;
  pages = [];
};

/** The pages this bus has answered with since it was reset, for the contract test. */
export const storyBusPages = (): readonly unknown[] => [...pages];

const answered = <P>(page: P): P => {
  pages.push(page);
  return page;
};

/** The commit that first wrote an entry on a ledger, at or before t. */
const writtenAt = (ledger: string, id: string, t: number): number =>
  commits.find(
    (commit) =>
      commit.ledger === ledger &&
      commit.t <= t &&
      commit.messages.some((message) => message.id === id)
  )?.t ?? t;

export interface HistoryOptions {
  readonly observedAt?: string;
  /** Join entries in the window: valid rows the viewer's projection does not show. */
  readonly omitted?: number;
  readonly criteria?: HistoryInput;
  /** latest: older entries exist past this window; all (the default): none do. */
  readonly window?: "all" | "latest";
  /** Unreadable entries the bus met reading the window. */
  readonly damaged?: number;
  readonly ledger?: string;
  /** The commit read; the next one by default. */
  readonly t?: number;
  /** The head when the read finished, when it had moved past t. */
  readonly currentHeadT?: number;
}

/**
 * A history observation, recording its messages as entries at its commit: a history page, or
 * a search page when the criteria have a query, projected as the viewer reads it.
 */
export const historyOf = (
  messages: PublicMessage[],
  options: HistoryOptions = {}
): HistoryObservation => {
  const t = options.t ?? head + 1;
  head = Math.max(head, t, options.currentHeadT ?? 0);
  const ledger = options.ledger ?? STORY_LEDGER;
  commits.push({ ledger, t, messages });
  const criteria = options.criteria ?? { limit: 200 };
  const participants =
    criteria.participant === undefined ? {} : { participants: [criteria.participant] };
  const joins = Array.from({ length: options.omitted ?? 0 }, (_, index) =>
    entryRow(
      {
        id: `story-join-${t}-${index}`,
        ts: "2026-01-01T09:00:00Z",
        from: `agent/joined-${index}`,
        to: [],
        kind: "presence",
        body: "",
        presence: { runtime: "other", status: "joined", topics: [] },
      },
      t
    )
  );
  const rows = [
    ...messages.map((message, rank) =>
      criteria.query === undefined
        ? entryRow(message, writtenAt(ledger, message.id, t))
        : searchRow(message, writtenAt(ledger, message.id, t), messages.length - rank)
    ),
    ...joins,
  ];
  const page = answered(
    busPage({
      ...(criteria.query === undefined
        ? {
            name: "history",
            args: { ...participants, direction: "backward", limit: criteria.limit },
          }
        : {
            name: "search",
            args: { ...participants, text: criteria.query, limit: criteria.limit },
          }),
      ledger,
      t,
      ...(options.currentHeadT === undefined ? {} : { head: options.currentHeadT }),
      rows,
      ...(options.window === "latest" ? { next: "story-older" } : {}),
      ...(options.damaged === undefined ? {} : { damaged: options.damaged }),
    })
  );
  return projectHistory([page], criteria, options.observedAt ?? "2026-01-01T12:00:00Z");
};

/** A peer row the viewer withholds on purpose: its runtime is not one the bus records. */
const MALFORMED_PEER = { runtime: "unsupported", topics: [] };

/** A scope a peer mutes, as the serve's peers rows carry it. */
export type StoryMute =
  | { readonly scope: "programme" }
  | { readonly scope: "topic"; readonly topic: string }
  | { readonly scope: "directory"; readonly directory: string }
  | { readonly scope: "concern"; readonly directory: string; readonly concern: string };

/** The fields an older serve, before reachable inactivity, never sends. */
const ACTIVITY_KEYS = new Set(["activity", "activityReason", "activeSince", "mutes"]);

/** A current peer with the activity the serve folded for it; by default active and unmuted. */
export interface StoryPeer {
  readonly address: string;
  readonly activity?: "active" | "inactive" | "unknown";
  /** Why activity is unknown; the serve sends it only beside unknown. */
  readonly activityReason?: "damaged-mail" | "incomplete-scan";
  readonly activeSince?: string;
  readonly mutes?: ReadonlyArray<StoryMute>;
}

/**
 * Current peers at the latest commit. `omitted` adds deliberately malformed rows, so a story
 * can show the projection withholding them; no bus would send them. An `older` serve predates
 * reachable inactivity and sends no activity, activeSince or mutes for any peer.
 */
export const peersOf = (
  peers: ReadonlyArray<string | StoryPeer>,
  omitted = 0,
  serve: "current" | "older" = "current"
): PeersObservation => {
  const t = Math.max(head, 1);
  const rowOf = (peer: string | StoryPeer) => {
    const { address, ...activity } = typeof peer === "string" ? { address: peer } : peer;
    const row = peerRow({ address, runtime: "other", topics: [], ...activity }, t);
    return serve === "current"
      ? row
      : Object.fromEntries(Object.entries(row).filter(([key]) => !ACTIVITY_KEYS.has(key)));
  };
  const rows = [
    ...peers.map(rowOf),
    ...Array.from({ length: omitted }, (_, index) =>
      peerRow({ address: `story-malformed-${index}`, ...MALFORMED_PEER }, t)
    ),
  ];
  const page = answered(
    busPage({ name: "peers", ledger: STORY_LEDGER, t, args: { limit: 500 }, rows })
  );
  return projectPeers([page], "2026-01-01T12:00:01Z");
};

/**
 * The reply tree containing `request.id` at its commit: every entry reaching, along replyTo
 * links, a node the selected entry reaches. A missing target cuts the tree there. A 503 when
 * the entry is not on that ledger at t. With `readLimit`, the bus has more entries than the
 * viewer read: only the first, in commit order, with more to come.
 */
export const threadOf = (request: ThreadInput, readLimit?: number): ThreadObservation => {
  const entries = new Map<string, { readonly message: PublicMessage; readonly t: number }>();
  for (const commit of commits)
    if (commit.ledger === request.ledger && commit.t <= request.t)
      for (const message of commit.messages)
        if (!entries.has(message.id)) entries.set(message.id, { message, t: commit.t });
  if (!entries.has(request.id)) throw new StatusError(503);
  const reach = (id: string) => {
    const seen = new Set<string>();
    for (let node: string | undefined = id; node !== undefined && !seen.has(node); ) {
      seen.add(node);
      node = entries.get(node)?.message.replyTo;
    }
    return seen;
  };
  const top = reach(request.id);
  const members = [...entries.values()]
    .filter((entry) => [...reach(entry.message.id)].some((node) => top.has(node)))
    .sort((a, b) => a.t - b.t);
  const ids = new Set(members.map((entry) => entry.message.id));
  const missing = members
    .map((entry) => entry.message.replyTo)
    .filter((target): target is string => target !== undefined && !ids.has(target));
  const root = members.find((entry) => entry.message.replyTo === undefined)?.message.id;
  const page = answered(
    busPage({
      name: "thread",
      ledger: request.ledger,
      t: request.t,
      args: { id: request.id, limit: 200 },
      rows: members.slice(0, readLimit).map((entry) => entryRow(entry.message, entry.t)),
      ...(readLimit !== undefined && members.length > readLimit ? { next: "story-later" } : {}),
      extra: {
        ...(root === undefined ? {} : { root }),
        members: members.length,
        missingReplyTargets: [...new Set(missing)].sort(),
      },
    })
  );
  return projectThread([page], request, "2026-01-01T12:00:02Z");
};
