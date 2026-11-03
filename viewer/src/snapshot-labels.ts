import type { HistoryInput, HistoryWindow, Snapshot } from "../shared/public";

// Visible text names the ledger commit as "commit N"; the raw `t` stays in tooltips and data
// attributes beside it.

const entries = (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`;

/**
 * The viewer's own omissions, named in the label beside the bus's damage and never merged
 * with it: a label claims no coverage the reader cannot see.
 */
const omittedNote = (omitted: number) =>
  omitted === 0 ? "" : `; ${omitted} omitted by the viewer`;

/** A commit as the viewer shows it. */
export const commitLabel = (t: number) => `commit ${t}`;

/** The tooltip and data attribute that keep the raw ledger `t` beside a commit label. */
export const commitAttributes = (t: number) => ({ title: `Ledger t=${t}`, "data-t": t });

/**
 * What a history window covers, from the bus's own exhaustion, damage and ranking: never
 * inferred from how many rows came back. `count` is every entry in the window, omitted ones
 * included; `damaged` is the unreadable entries the bus met; `omitted` is the records the
 * viewer's projection withheld.
 */
export function windowLabel(
  window: HistoryWindow,
  snapshot: Snapshot,
  count: number,
  criteria: HistoryInput,
  damaged: number,
  omitted: number
): string {
  const at = commitLabel(snapshot.t);
  const naming = criteria.participant === undefined ? "" : " naming this participant";
  const withheld = omittedNote(omitted);
  switch (window) {
    case "ranked":
      return `Best matches at ${at}; ranked, not complete${withheld}`;
    case "all":
      return `All entries${naming} at ${at}${withheld}`;
    case "readable":
      return `All readable entries${naming} at ${at}; ${damaged} unreadable${withheld}`;
    case "latest":
      return `Latest ${entries(count)} at ${at}; older entries exist${withheld}`;
  }
}

/** The bus's answer about one reply tree, as the label reads it. */
export interface TreeCoverage {
  readonly exhausted: boolean;
  readonly damaged: number;
  readonly missingReplyTargets: readonly unknown[];
  /** Records the viewer's projection withheld from the reading. */
  readonly omitted: number;
}

/**
 * What a conversation covers: the reply tree containing the selected message at t, from the
 * nearest top its reply links reach. Only an exhausted tree with nothing unreadable, no
 * missing target and nothing the viewer omitted is whole; a reply to a missing entry cuts the
 * tree there.
 */
export function treeLabel(tree: TreeCoverage, snapshot: Snapshot, count: number): string {
  const at = commitLabel(snapshot.t);
  const missing = tree.missingReplyTargets.length;
  const cut =
    missing === 0 ? "" : `; cut at ${missing} missing ${missing === 1 ? "entry" : "entries"}`;
  const unreadable = tree.damaged === 0 ? "" : `; ${tree.damaged} unreadable`;
  const caveats = `${cut}${unreadable}${omittedNote(tree.omitted)}`;
  if (!tree.exhausted)
    return `First ${entries(count)} of the reply tree at ${at}; more exist${caveats}`;
  if (missing > 0) return `Reply tree at ${at}${caveats}`;
  if (tree.damaged > 0) return `All readable entries of the reply tree at ${at}${caveats}`;
  return tree.omitted === 0
    ? `Whole reply tree at ${at}`
    : `All entries of the reply tree at ${at}${caveats}`;
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
