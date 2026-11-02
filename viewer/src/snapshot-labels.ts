import type { HistoryInput, HistoryWindow, Snapshot } from "../shared/public";

// Visible text names the ledger commit as "commit N"; the raw `t` stays in tooltips and data
// attributes beside it.

const entries = (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`;

/** A commit as the viewer shows it. */
export const commitLabel = (t: number) => `commit ${t}`;

/** The tooltip and data attribute that keep the raw ledger `t` beside a commit label. */
export const commitAttributes = (t: number) => ({ title: `Ledger t=${t}`, "data-t": t });

/**
 * What a history window covers, from the bus's own exhaustion, damage and ranking: never
 * inferred from how many rows came back. `count` is every entry in the window, omitted ones
 * included; `damaged` is the unreadable entries the bus met.
 */
export function windowLabel(
  window: HistoryWindow,
  snapshot: Snapshot,
  count: number,
  criteria: HistoryInput,
  damaged: number
): string {
  const at = commitLabel(snapshot.t);
  const naming = criteria.participant === undefined ? "" : " naming this participant";
  switch (window) {
    case "ranked":
      return `Best matches at ${at}; ranked, not complete`;
    case "all":
      return `All entries${naming} at ${at}`;
    case "readable":
      return `All readable entries${naming} at ${at}; ${damaged} unreadable`;
    case "latest":
      return `Latest ${entries(count)} at ${at}; older entries exist`;
  }
}

/** The bus's answer about one reply tree, as the label reads it. */
export interface TreeCoverage {
  readonly exhausted: boolean;
  readonly damaged: number;
  readonly missingReplyTargets: readonly unknown[];
}

/**
 * What a conversation covers: the reply tree containing the selected message at t, from the
 * nearest top its reply links reach. Only an exhausted tree with nothing unreadable and no
 * missing target is whole; a reply to a missing entry cuts the tree there.
 */
export function treeLabel(tree: TreeCoverage, snapshot: Snapshot, count: number): string {
  const at = commitLabel(snapshot.t);
  const missing = tree.missingReplyTargets.length;
  const cut =
    missing === 0 ? "" : `; cut at ${missing} missing ${missing === 1 ? "entry" : "entries"}`;
  const unreadable = tree.damaged === 0 ? "" : `; ${tree.damaged} unreadable`;
  if (!tree.exhausted)
    return `First ${entries(count)} of the reply tree at ${at}; more exist${cut}${unreadable}`;
  if (missing > 0) return `Reply tree at ${at}${cut}${unreadable}`;
  return tree.damaged === 0
    ? `Whole reply tree at ${at}`
    : `All readable entries of the reply tree at ${at}${unreadable}`;
}

/** One upstream note and the commit it names. */
export interface UpstreamNote {
  readonly text: string;
  readonly t: number;
}

/** Upstream incompleteness, kept apart from the viewer's own projection omissions. */
export function upstreamNotes(snapshot: Snapshot, damaged: number): UpstreamNote[] {
  const head = snapshot.currentHeadT;
  return [
    ...(damaged > 0
      ? [{ text: `${entries(damaged)} unreadable at ${commitLabel(snapshot.t)}`, t: snapshot.t }]
      : []),
    ...(head === undefined
      ? []
      : [{ text: `The bus reached ${commitLabel(head)} while this was read`, t: head }]),
  ];
}
