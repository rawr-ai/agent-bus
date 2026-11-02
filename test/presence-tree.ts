// A reply tree whose middle entry is a presence: root (message) <- presence <- selected
// (message). The bus returns all three, exhausted, undamaged and complete, with no missing
// target; the viewer's projection withholds the presence. Shared by the projection tests,
// the page validation and the App's story, so all three read the same pages. It imports
// only the page builder, so stories can bundle it.
import { busPage, entryRow } from "./bus-pages";

/** The three entries, in commit order. */
export const PRESENCE_TREE_ENTRIES = {
  root: {
    id: "tree-root",
    ts: "2026-01-01T10:00:00Z",
    from: "agent/lead",
    to: ["#alpha"],
    kind: "message" as const,
    subject: "Tree root",
    body: "The readable root.",
  },
  presence: {
    id: "tree-presence",
    ts: "2026-01-01T10:01:00Z",
    from: "agent/reviewer",
    to: ["#alpha"],
    kind: "presence" as const,
    body: "joined",
    replyTo: "tree-root",
    presence: { runtime: "codex" as const, status: "joined" as const, topics: ["alpha"] },
  },
  selected: {
    id: "tree-selected",
    ts: "2026-01-01T10:02:00Z",
    from: "agent/lead",
    to: ["agent/reviewer"],
    kind: "message" as const,
    subject: "Tree reply",
    body: "Replying past the presence.",
    replyTo: "tree-presence",
  },
};

export const PRESENCE_TREE = {
  root: PRESENCE_TREE_ENTRIES.root.id,
  presence: PRESENCE_TREE_ENTRIES.presence.id,
  selected: PRESENCE_TREE_ENTRIES.selected.id,
} as const;

/** The entries as the bus's rows, written at commits 1, 2 and 3. */
export const presenceTreeRows = [
  entryRow(PRESENCE_TREE_ENTRIES.root, 1),
  entryRow(PRESENCE_TREE_ENTRIES.presence, 2),
  entryRow(PRESENCE_TREE_ENTRIES.selected, 3),
];

/** The bus's thread page for the selected entry, read at `t` (3 or later). */
export const presenceTreePage = (ledger: string, t = 3) =>
  busPage({
    name: "thread",
    ledger,
    t,
    args: { id: PRESENCE_TREE.selected, limit: 200 },
    rows: presenceTreeRows,
    extra: { root: PRESENCE_TREE.root, members: 3, missingReplyTargets: [] },
  });
