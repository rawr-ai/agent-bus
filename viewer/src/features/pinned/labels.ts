import { MAX_INVESTIGATION_ENTRIES } from "../../../shared/limits";
import type { IdentityField } from "../../../shared/public";
import { commitLabel } from "../../snapshot-labels";
import type { Fault, TraversalEnd, TraversalSnapshot } from "./traversal";

// The words a pinned investigation shows. Only a complete reading says "Complete"; every other
// end says what stopped it, and the entries kept beside a stop are labelled as partial.

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const FAULTS: Record<Fault, string> = {
  "continuation-after-end": "a continuation after its last page",
  "missing-continuation": "no continuation before its last page",
  "repeated-continuation": "a continuation it had already returned",
  "repeated-entry": "an entry already read",
  "out-of-order": "entries out of commit order",
  stalled: "an empty page that did not end the reading",
  "damage-count": "a damage total that does not add up",
  "unclaimed-end": "a clean last page that did not claim the whole window",
};

const IDENTITY: Record<IdentityField, string> = {
  name: "query",
  catalogueVersion: "catalogue version",
  ledger: "ledger",
  t: "commit",
  criteria: "set of criteria",
  limit: "page size",
};

const endLabel = (end: TraversalEnd, snapshot: TraversalSnapshot): string => {
  const { progress, reference } = snapshot;
  switch (end.kind) {
    case "complete": {
      const kept = progress.entries.length;
      return kept === 0
        ? `Complete: no messages match these criteria at ${commitLabel(reference.t)}.`
        : `Complete: all ${plural(kept, "message", "messages")} matching these criteria at ${commitLabel(reference.t)}.`;
    }
    case "bound":
      return `Stopped at the ${MAX_INVESTIGATION_ENTRIES}-entry bound.`;
    case "damaged":
      return `Stopped: the bus met ${plural(progress.damaged, "unreadable entry", "unreadable entries")}.`;
    case "omitted":
      return `Stopped: the viewer omitted ${plural(progress.omitted, "record", "records")} it cannot show.`;
    case "transport":
      return "Stopped: the next page cannot be requested within the viewer's request limits.";
    case "deadline":
      return "Stopped: a page did not answer in time.";
    case "cancelled":
      return "Cancelled: you stopped the reading.";
    case "fault":
      return `Stopped: the bus returned ${FAULTS[end.fault]}.`;
    case "bus-error":
      return "Stopped: the bus refused the page.";
    case "identity":
      return end.field === undefined
        ? "Stopped: the bus answered for a different reading than this reference."
        : `Stopped: the bus answered for a different ${IDENTITY[end.field]} than this reference.`;
    case "rejected":
      return "Stopped: the bus returned a page the viewer cannot read.";
    case "unavailable":
      return "Stopped: the viewer could not reach the bus.";
  }
};

/** What the reading is doing now, or how it ended. */
export const statusLabel = (snapshot: TraversalSnapshot): string => {
  const page = snapshot.progress.pages + 1;
  switch (snapshot.phase.kind) {
    case "idle":
      return "Not started.";
    case "reading":
      return `Reading page ${page} at ${commitLabel(snapshot.reference.t)}.`;
    case "busy":
      return `Waiting: the viewer is busy with other reads. Retrying page ${page}.`;
    case "too-large":
      return "Not read: this reference is too large to send with a continuation. Ask the agent for a reference with fewer participants.";
    case "ended":
      return endLabel(snapshot.phase.end, snapshot);
  }
};

/**
 * What the kept entries cover when the reading stopped short, or undefined while it runs and
 * when it is complete. Damage and omissions stop the reading on their page, so only a stop
 * that met neither keeps a gap-free start of the window.
 */
export const coverageLabel = (snapshot: TraversalSnapshot): string | undefined => {
  if (snapshot.phase.kind !== "ended" || snapshot.phase.end.kind === "complete") return undefined;
  const { entries, damaged, omitted } = snapshot.progress;
  if (entries.length === 0) return "No entries were kept before the stop.";
  const rest = "The rest were not kept, and nothing is claimed about them.";
  if (damaged === 0 && omitted === 0) {
    return `Partial: the earliest ${plural(entries.length, "entry", "entries")} of the window. ${rest}`;
  }
  const met = [
    ...(damaged > 0 ? [`${damaged} unreadable`] : []),
    ...(omitted > 0 ? [`${omitted} omitted by the viewer`] : []),
  ].join(" and ");
  return `Partial: ${plural(entries.length, "readable entry", "readable entries")} from the start of the window; ${met} met while reading. ${rest}`;
};

/** How much the reading has kept and met so far. */
export const countsLabel = (snapshot: TraversalSnapshot): string => {
  const { entries, pages, omitted, damaged } = snapshot.progress;
  return [
    `${plural(entries.length, "entry", "entries")} kept`,
    `${plural(pages, "page", "pages")} read`,
    `${omitted} omitted by the viewer`,
    `${damaged} unreadable`,
  ].join(" · ");
};
