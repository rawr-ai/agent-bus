// Synthetic bus_run_query result pages for the viewer's tests, its reading fixture and its
// stories: one builder, so none of them can drift from what the bus sends on its own.
// test/viewer-bus-pages.test.ts checks the pages it builds against the catalogue's own row
// schemas and envelope literals. It imports nothing, so stories can bundle it.

/** The catalogue version the pages claim; checked against the catalogue. */
export const PAGE_CATALOGUE_VERSION = 1;

/** The operations the viewer reads, and the unit each one's rows are. */
export const PAGE_UNITS = {
  history: "entry",
  search: "ranked match",
  peers: "address",
  thread: "entry",
} as const;
export type PageOperation = keyof typeof PAGE_UNITS;

export interface PageInput {
  readonly name: PageOperation;
  readonly ledger: string;
  /** The commit the page was read at. */
  readonly t: number;
  /** The head when the read finished; reported only when it had moved past `t`. */
  readonly head?: number;
  readonly args: Readonly<Record<string, unknown>>;
  readonly rows: ReadonlyArray<unknown>;
  /** A cursor while the traversal has more pages. */
  readonly next?: string;
  /** Unreadable entries met on this page, and on every page so far. */
  readonly damaged?: number;
  readonly damagedTotal?: number;
  /** Operation fields beyond the envelope, such as a thread's missingReplyTargets. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * One result page, as the catalogue shapes it: exhausted exactly when there is no cursor, and
 * complete only when exhausted, with no damage met, for an operation that can be complete.
 */
export const busPage = (input: PageInput) => {
  const damagedTotal = input.damagedTotal ?? input.damaged ?? 0;
  const exhausted = input.next === undefined;
  return {
    name: input.name,
    catalogueVersion: PAGE_CATALOGUE_VERSION,
    ledger: input.ledger,
    t: input.t,
    ...(input.head !== undefined && input.head > input.t ? { currentHeadT: input.head } : {}),
    unit: PAGE_UNITS[input.name],
    args: input.args,
    rows: input.rows,
    damage: "checked" as const,
    damaged: input.damaged ?? damagedTotal,
    damagedTotal,
    exhausted,
    complete: exhausted && damagedTotal === 0 && input.name !== "search",
    ...(input.next === undefined ? {} : { next: input.next }),
    note: "Synthetic page.",
    ...input.extra,
  };
};

/** An entry row: a message and the commit that wrote it. */
export const entryRow = <M extends object>(message: M, t: number) => ({ t, ...message });

/** A search row: an entry row with its relevance; higher is better. */
export const searchRow = <M extends object>(message: M, t: number, score: number) => ({
  t,
  ...message,
  score,
});

/** A current peer row: a joined presence, the commit that wrote it, active and unmuted. */
export const peerRow = <P extends object>(peer: P, t: number) => ({
  activity: "active" as const,
  mutes: [],
  ...peer,
  status: "joined" as const,
  t,
});
