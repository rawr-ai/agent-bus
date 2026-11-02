import type { HistoryInput, HistoryWindow, Snapshot } from "../shared/public";

const entries = (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`;

/**
 * What a history window covers, from the bus's own exhaustion and ranking: never inferred
 * from how many rows came back. `count` is every entry in the window, omitted ones included.
 */
export function windowLabel(
  window: HistoryWindow,
  snapshot: Snapshot,
  count: number,
  criteria: HistoryInput
): string {
  switch (window) {
    case "ranked":
      return `Best matches at t=${snapshot.t}; ranked, not complete`;
    case "all":
      return criteria.participant === undefined
        ? `All entries at t=${snapshot.t}`
        : `All entries naming this participant at t=${snapshot.t}`;
    case "latest":
      return `Latest ${entries(count)} at t=${snapshot.t}; older entries exist`;
  }
}

/**
 * What a conversation covers: the reply tree containing the selected message at t, from the
 * nearest top its reply links reach. A reply to a missing entry cuts the tree there.
 */
export function treeLabel(
  exhausted: boolean,
  snapshot: Snapshot,
  count: number,
  missing: number
): string {
  const cut =
    missing === 0 ? "" : `; cut at ${missing} missing ${missing === 1 ? "entry" : "entries"}`;
  return exhausted
    ? `${missing === 0 ? "Whole reply tree" : "Reply tree"} at t=${snapshot.t}${cut}`
    : `First ${entries(count)} of the reply tree at t=${snapshot.t}; more exist${cut}`;
}

/** Upstream incompleteness, kept apart from the viewer's own projection omissions. */
export function upstreamNotes(snapshot: Snapshot, damaged: number): string[] {
  return [
    ...(damaged > 0 ? [`${entries(damaged)} unreadable at t=${snapshot.t}`] : []),
    ...(snapshot.currentHeadT === undefined
      ? []
      : [`The bus reached t=${snapshot.currentHeadT} while this was read`]),
  ];
}
