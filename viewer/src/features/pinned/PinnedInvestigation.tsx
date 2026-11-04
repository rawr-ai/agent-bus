import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { INVESTIGATION_PAGE_SIZE, MAX_INVESTIGATION_ENTRIES } from "../../../shared/limits";
import type {
  InvestigationPage,
  InvestigationPageInput,
  InvestigationReference,
} from "../../../shared/public";
import { commitAttributes, commitLabel } from "../../snapshot-labels";
import { Text } from "../../Text";
import { ThemeToggle } from "../../ThemeToggle";
import { ConversationMessage } from "../conversations/ConversationMessage";
import { countsLabel, coverageLabel, statusLabel } from "./labels";
import { narrowedReference } from "./reference";
import {
  createPinnedTraversal,
  emptyProgress,
  type PinnedTraversal,
  type TraversalSnapshot,
} from "./traversal";
import "./pinned.css";

export type ReadPage = (
  input: InvestigationPageInput,
  signal: AbortSignal
) => Promise<InvestigationPage>;

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>agent bus</span>
          <span className="brand-separator" />
          <span className="brand-context">Pinned investigation</span>
        </div>
        <div className="header-actions">
          <a className="text-action" href="#">
            Live viewer
          </a>
          <ThemeToggle />
        </div>
      </header>
      <main className="pinned">{children}</main>
    </div>
  );
}

function Optional({ value }: { value: string | undefined }) {
  return value === undefined ? (
    <span className="pinned-unset">not set</span>
  ) : (
    <Text value={value} />
  );
}

/** The reference being read, exactly as the bus echoed it. */
function Identity({ reference }: { reference: InvestigationReference }) {
  const { criteria } = reference;
  return (
    <dl className="pinned-identity" aria-label="Investigation reference">
      <div>
        <dt>Ledger</dt>
        <dd>
          <Text value={reference.ledger} />
        </dd>
      </div>
      <div>
        <dt>Commit</dt>
        <dd {...commitAttributes(reference.t)}>{commitLabel(reference.t)}</dd>
      </div>
      <div>
        <dt>Catalogue version</dt>
        <dd>{reference.catalogueVersion}</dd>
      </div>
      <div>
        <dt>Participants</dt>
        <dd>
          {criteria.participants === undefined ? (
            <Optional value={undefined} />
          ) : (
            <ul className="pinned-participants">
              {criteria.participants.map((participant) => (
                <li key={participant}>
                  <Text value={participant} />
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <div>
        <dt>From</dt>
        <dd>
          <Optional value={criteria.fromTs} />
        </dd>
      </div>
      <div>
        <dt>To (exclusive)</dt>
        <dd>
          <Optional value={criteria.toTs} />
        </dd>
      </div>
      <div>
        <dt>Reading</dt>
        <dd>Messages, oldest first</dd>
      </div>
      <div>
        <dt>Page size</dt>
        <dd>{INVESTIGATION_PAGE_SIZE}</dd>
      </div>
      <div>
        <dt>Entry bound</dt>
        <dd>{MAX_INVESTIGATION_ENTRIES}</dd>
      </div>
    </dl>
  );
}

const WINDOW_PROBLEMS = {
  window: "From and To must be UTC instants such as 2026-11-01T17:31:12Z, with From before To.",
  "too-large": "This window makes the reference too large to send.",
} as const;

/** Another window at the same commit, opened as a link of its own. */
function WindowForm({
  reference,
  onOpen,
}: {
  reference: InvestigationReference;
  onOpen: (reference: InvestigationReference) => void;
}) {
  const [fromTs, setFromTs] = useState(reference.criteria.fromTs ?? "");
  const [toTs, setToTs] = useState(reference.criteria.toTs ?? "");
  const [problem, setProblem] = useState<keyof typeof WINDOW_PROBLEMS | null>(null);
  const unchanged =
    fromTs === (reference.criteria.fromTs ?? "") && toTs === (reference.criteria.toTs ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const narrowed = narrowedReference(reference, fromTs, toTs);
    if ("problem" in narrowed) setProblem(narrowed.problem);
    else onOpen(narrowed.reference);
  };
  return (
    <form className="pinned-window" onSubmit={submit} aria-labelledby="pinned-window-heading">
      <h2 id="pinned-window-heading">Read a window at {commitLabel(reference.t)}</h2>
      <label>
        From
        <input
          value={fromTs}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setFromTs(event.target.value);
            setProblem(null);
          }}
        />
      </label>
      <label>
        To (exclusive)
        <input
          value={toTs}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setToTs(event.target.value);
            setProblem(null);
          }}
        />
      </label>
      <button type="submit" className="pinned-button" disabled={unchanged}>
        Read this window
      </button>
      {problem !== null && (
        <p className="pinned-problem" role="alert">
          {WINDOW_PROBLEMS[problem]}
        </p>
      )}
    </form>
  );
}

/** One reading's screen, drawn from its snapshot alone. */
export function PinnedInvestigationView({
  snapshot,
  onCancel,
  onReadAgain,
  onOpen,
}: {
  snapshot: TraversalSnapshot;
  onCancel: () => void;
  onReadAgain: () => void;
  onOpen: (reference: InvestigationReference) => void;
}) {
  const { reference, phase, progress } = snapshot;
  const nodes = useRef(new Map<string, HTMLElement>());
  const messages = useMemo(
    () => progress.entries.map((entry) => entry.message),
    [progress.entries]
  );
  const coverage = coverageLabel(snapshot);
  const running = phase.kind === "reading" || phase.kind === "busy";
  return (
    <Shell>
      <section className="pinned-summary" aria-labelledby="pinned-heading">
        <div className="eyebrow">PINNED INVESTIGATION</div>
        <h1 id="pinned-heading">Message history at {commitLabel(reference.t)}</h1>
        <Identity reference={reference} />
        <p className="pinned-status" role="status">
          {statusLabel(snapshot)}
        </p>
        {coverage !== undefined && <p className="pinned-coverage">{coverage}</p>}
        <p className="pinned-counts">{countsLabel(snapshot)}</p>
        <div className="pinned-actions">
          {running && (
            <button type="button" className="pinned-button" onClick={onCancel}>
              Cancel
            </button>
          )}
          {phase.kind === "ended" && (
            <button type="button" className="pinned-button" onClick={onReadAgain}>
              Read again
            </button>
          )}
        </div>
        {phase.kind !== "too-large" && <WindowForm reference={reference} onOpen={onOpen} />}
      </section>
      <section className="pinned-entries" aria-label="Entries kept">
        <ol>
          {progress.entries.map((entry) => (
            <li key={entry.message.id}>
              <div className="pinned-entry-meta">
                <span {...commitAttributes(entry.t)}>{commitLabel(entry.t)}</span>
                <span>
                  <Text value={entry.message.ts} />
                </span>
              </div>
              <ConversationMessage
                message={entry.message}
                messages={messages}
                focusMessage={(id) => {
                  nodes.current.get(id)?.scrollIntoView({ block: "start" });
                  nodes.current.get(id)?.focus();
                }}
                register={(id, node) => {
                  if (node === null) nodes.current.delete(id);
                  else nodes.current.set(id, node);
                }}
              />
            </li>
          ))}
        </ol>
      </section>
    </Shell>
  );
}

const subscribeNone = () => () => {};

/** One traversal of `reference`, started when shown and disposed when replaced or hidden. */
function Reading({
  reference,
  readPage,
  onReadAgain,
  onOpen,
}: {
  reference: InvestigationReference;
  readPage: ReadPage;
  onReadAgain: () => void;
  onOpen: (reference: InvestigationReference) => void;
}) {
  // Created in the effect, so a remount gets a fresh traversal rather than a disposed one.
  const [traversal, setTraversal] = useState<PinnedTraversal | null>(null);
  useEffect(() => {
    const next = createPinnedTraversal({ reference, readPage });
    setTraversal(next);
    next.start();
    return () => next.dispose();
  }, [reference, readPage]);
  const idle = useMemo<TraversalSnapshot>(
    () => ({ reference, phase: { kind: "idle" }, progress: emptyProgress, calls: 0 }),
    [reference]
  );
  const snapshot = useSyncExternalStore(
    traversal?.subscribe ?? subscribeNone,
    () => traversal?.getSnapshot() ?? idle
  );
  return (
    <PinnedInvestigationView
      snapshot={snapshot}
      onCancel={() => traversal?.cancel()}
      onReadAgain={onReadAgain}
      onOpen={onOpen}
    />
  );
}

/** A pinned investigation: read on open, and read afresh on request. */
export function PinnedInvestigation({
  reference,
  readPage,
  onOpen,
}: {
  reference: InvestigationReference;
  readPage: ReadPage;
  onOpen: (reference: InvestigationReference) => void;
}) {
  const [run, setRun] = useState(0);
  return (
    <Reading
      key={run}
      reference={reference}
      readPage={readPage}
      onReadAgain={() => setRun((count) => count + 1)}
      onOpen={onOpen}
    />
  );
}

const REFUSALS = {
  invalid: "This link does not carry a pinned history reference in the form the bus returns.",
  unsupported:
    "This reference asks for more than a forward message reading, which the viewer does not read.",
} as const;

/** A link whose fragment names an investigation the viewer refuses. */
export function RefusedReference({ reason }: { reason: keyof typeof REFUSALS }) {
  return (
    <Shell>
      <section className="pinned-summary" aria-labelledby="pinned-heading">
        <div className="eyebrow">PINNED INVESTIGATION</div>
        <h1 id="pinned-heading">Reference refused</h1>
        <p className="pinned-status" role="status">
          {REFUSALS[reason]}
        </p>
        <p>Nothing was read. Ask the agent for the link again, or open the live viewer.</p>
      </section>
    </Shell>
  );
}
