import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewerClient } from "../shared/client-types";
import { DEFAULT_HISTORY_LIMIT } from "../shared/limits";
import type {
  HistoryInput,
  HistoryObservation,
  HistoryWindow,
  PeersObservation,
  Snapshot,
  ThreadInput,
  ThreadObservation,
} from "../shared/public";
import type { AnnouncerOptions } from "./announcements";
import { ConversationMessage } from "./features/conversations/ConversationMessage";
import {
  buildConversationIndex,
  type ConversationContext,
  contextKey,
  conversationsForContext,
  messageMatchesContext,
  type ObservedConversation,
} from "./features/conversations/model";
import { AutoRefreshToggle } from "./features/investigation/AutoRefreshToggle";
import { InvestigationControls } from "./features/investigation/InvestigationControls";
import { PeerList } from "./features/peers/PeerList";
import { canonicalHistoryInput, historyInputKey, isHistoryInvestigation } from "./history-criteria";
import { createObservationResource, failureFromStatus } from "./observation-resource";
import {
  EMPTY_READING_SNAPSHOT,
  type ReadingIntent,
  type ReadingSnapshot,
  type ReadingUnit,
  reconcileReadingUnit,
} from "./reading-unit";
import {
  commitAttributes,
  commitLabel,
  treeLabel,
  upstreamNotes,
  windowLabel,
} from "./snapshot-labels";
import { formatTime, Text } from "./Text";
import { ThemeToggle } from "./ThemeToggle";
import {
  type Announcement,
  useAnnouncement,
  useAutomaticRefresh,
  useObservation,
} from "./use-observation";
import "./style.css";
import "./conversation.css";

type Navigation = {
  context: ConversationContext;
  message: string | null;
  page: "contexts" | "conversations" | "thread" | "peers";
  chronology: boolean;
};
const defaultNav: Navigation = {
  context: { kind: "all" },
  message: null,
  page: "contexts",
  chronology: false,
};
function parseHash(): Navigation {
  const p = new URLSearchParams(location.hash.slice(1));
  const kind = p.get("context");
  const value = p.get("value");
  const context: ConversationContext =
    kind === "broadcast"
      ? { kind: "broadcast" }
      : (kind === "topic" || kind === "address") && value !== null
        ? { kind, value }
        : { kind: "all" };
  const message = p.get("message");
  const page = p.get("page");
  return {
    context,
    message,
    page: page === "peers" || page === "thread" || page === "conversations" ? page : "contexts",
    chronology: p.get("view") === "chronology",
  };
}
function toHash(nav: Navigation) {
  const p = new URLSearchParams();
  p.set("context", nav.context.kind);
  if ("value" in nav.context) p.set("value", nav.context.value);
  if (nav.message !== null) p.set("message", nav.message);
  p.set("page", nav.page);
  if (nav.chronology) p.set("view", "chronology");
  return `#${p}`;
}
function contextLabel(context: ConversationContext) {
  return "value" in context
    ? context.value
    : context.kind === "all"
      ? "All messages"
      : "Broadcast (*)";
}
function Refresh({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <RefreshCw size={16} aria-hidden="true" />
    </button>
  );
}
interface WindowInfo {
  readonly window: HistoryWindow;
  readonly snapshot: Snapshot;
  readonly count: number;
  readonly damaged: number;
  readonly omitted: number;
}
const windowOf = (observation: HistoryObservation): WindowInfo => ({
  window: observation.window,
  snapshot: observation.snapshot,
  count: observation.messages.length + observation.omitted,
  damaged: observation.damaged,
  omitted: observation.omitted,
});
/** A reply tree read for a selected message, with the criteria it was opened under. */
interface ThreadRead {
  readonly request: ThreadInput;
  readonly criteria: HistoryInput;
}
interface ThreadReading {
  readonly observation: ThreadObservation;
  readonly criteria: HistoryInput;
}
function CriteriaScope({
  criteria,
  window,
}: {
  criteria: HistoryInput;
  window?: WindowInfo | undefined;
}) {
  return (
    <p className="observation-scope" {...(window ? commitAttributes(window.snapshot.t) : {})}>
      {window
        ? windowLabel(
            window.window,
            window.snapshot,
            window.count,
            criteria,
            window.damaged,
            window.omitted
          )
        : `${isHistoryInvestigation(criteria) ? "Server matches" : "Latest messages"} · limit ${criteria.limit}`}
      {criteria.query !== undefined && (
        <>
          {" "}
          · Query: <Text value={criteria.query} />
        </>
      )}
      {criteria.participant !== undefined && (
        <>
          {" "}
          · Exact participant: <Text value={criteria.participant} />
        </>
      )}
    </p>
  );
}
const historyAnnouncer: AnnouncerOptions<HistoryObservation> = {
  name: "History",
  noun: ["message", "messages"],
  identities: (value) => value.messages.map((message) => message.id),
  omitted: (value) => value.omitted,
};
const peersAnnouncer: AnnouncerOptions<PeersObservation> = {
  name: "Current peers",
  noun: ["peer", "peers"],
  identities: (value) => value.peers.map((peer) => peer.address),
  omitted: (value) => value.omitted,
  reportDepartures: true,
};
/** One polite region per resource; the visible observation lines are not live regions. */
function LiveAnnouncement({ value }: { value: Announcement | null }) {
  return (
    <p className="visually-hidden" role="status" aria-atomic="true">
      {value && <span key={value.sequence}>{value.text}</span>}
    </p>
  );
}
/**
 * One observation's line: its receipt and loading state, then the caveats it was read with.
 * A retained reading shows its caveats without a status, since it is no longer being read.
 */
function Observation({
  loading,
  error,
  observedAt,
  omitted,
  snapshot,
  damaged = 0,
  status: showStatus = true,
}: {
  loading: boolean;
  error: null | "unavailable" | "timeout";
  observedAt: string | undefined;
  omitted: number | undefined;
  snapshot?: Snapshot | undefined;
  damaged?: number | undefined;
  status?: boolean;
}) {
  const notes = snapshot ? upstreamNotes(snapshot, damaged) : [];
  if (!showStatus && notes.length === 0 && !omitted) return null;
  const status = error
    ? observedAt
      ? `${error === "timeout" ? "Refresh timed out" : "Refresh failed"} · last observed ${formatTime(observedAt)}`
      : error === "timeout"
        ? "Observation timed out"
        : "Observation unavailable"
    : loading
      ? observedAt
        ? `Observed ${formatTime(observedAt)} · Refreshing`
        : "Loading"
      : observedAt
        ? `Observed ${formatTime(observedAt)}`
        : "Not yet observed";
  return (
    <div className={`observation${showStatus && error ? " observation-error" : ""}`}>
      {showStatus && (
        <span {...(snapshot ? commitAttributes(snapshot.t) : {})}>
          {status}
          {snapshot && ` · ${commitLabel(snapshot.t)}`}
        </span>
      )}
      {notes.map((note) => (
        <span className="upstream" key={note.text} {...commitAttributes(note.t)}>
          {note.text}
        </span>
      ))}
      {Boolean(omitted) && (
        <span className="omitted">
          {omitted} {omitted === 1 ? "record" : "records"} omitted
        </span>
      )}
    </div>
  );
}
/**
 * A tree read for the selected message that does not hold it: the bus's tree is larger than
 * the viewer reads and the message comes later, or its record was withheld. This state is
 * final for that read; the message can still be opened as the history observation holds it.
 */
function SelectedBeyondTree({
  tree,
  fromHistory,
  onFocusMessage,
}: {
  tree: ThreadObservation;
  fromHistory: HistoryObservation | null;
  onFocusMessage: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const read = tree.messages.length + tree.omitted;
  const message = fromHistory?.messages.find((item) => item.id === tree.request.id);
  return (
    <div className="thread-inner">
      <p className="notice" role="status" {...commitAttributes(tree.snapshot.t)}>
        {tree.exhausted
          ? `The selected message was withheld from the reply tree read at ${commitLabel(tree.snapshot.t)}.`
          : `Conversation larger than ${read} ${read === 1 ? "entry" : "entries"}; the selected message is beyond what was read at ${commitLabel(tree.snapshot.t)}.`}
      </p>
      {message !== undefined && fromHistory !== null && !open && (
        <button className="text-action" type="button" onClick={() => setOpen(true)}>
          Open it in history
        </button>
      )}
      {message !== undefined && fromHistory !== null && open && (
        <>
          <p className="observation-scope" {...commitAttributes(fromHistory.snapshot.t)}>
            As the history observation at {commitLabel(fromHistory.snapshot.t)} holds it
          </p>
          <ConversationMessage
            message={message}
            messages={[message]}
            focusMessage={onFocusMessage}
            register={() => {}}
          />
        </>
      )}
    </div>
  );
}
export function App({ client }: { client: ViewerClient }) {
  const resources = useMemo(
    () => ({
      history: createObservationResource<HistoryInput, HistoryObservation>({
        input: { limit: DEFAULT_HISTORY_LIMIT },
        keyOf: historyInputKey,
        load: (input, signal) => client.history(input, { signal }),
        classifyFailure: failureFromStatus,
      }),
      peers: createObservationResource<Record<string, never>, PeersObservation>({
        input: {},
        keyOf: () => "peers",
        load: (input, signal) => client.peers(input, { signal }),
        classifyFailure: failureFromStatus,
      }),
      // The selected conversation's reply tree, read at the history observation's own commit
      // and kept with that observation's criteria, so a tree is never relabelled by later ones.
      thread: createObservationResource<ThreadRead | null, ThreadReading | null>({
        input: null,
        keyOf: (input) =>
          input === null
            ? "none"
            : JSON.stringify([
                input.request.id,
                input.request.ledger,
                input.request.t,
                historyInputKey(input.criteria),
              ]),
        load: (input, signal) =>
          input === null
            ? Promise.resolve(null)
            : client
                .thread(input.request, { signal })
                .then((observation) => ({ observation, criteria: input.criteria })),
        classifyFailure: failureFromStatus,
      }),
    }),
    [client]
  );
  const history = useObservation(resources.history);
  const peers = useObservation(resources.peers);
  const thread = useObservation(resources.thread);
  const historyAnnouncement = useAnnouncement(resources.history, historyAnnouncer);
  const peersAnnouncement = useAnnouncement(resources.peers, peersAnnouncer);
  const automaticRead = useCallback(() => {
    resources.history.refresh({ replacePending: false });
    resources.peers.refresh({ replacePending: false });
  }, [resources]);
  const automatic = useAutomaticRefresh(automaticRead);
  const applyCriteria = (input: HistoryInput) => {
    const next = canonicalHistoryInput(input);
    const same = historyInputKey(next) === resources.history.getSnapshot().key;
    resources.history.setInput(next);
    if (same) resources.history.refresh();
  };
  const previousCriteria =
    history.data !== null && historyInputKey(history.data.criteria) !== history.key;
  const [nav, setNav] = useState<Navigation>(() => (location.hash ? parseHash() : defaultNav));
  const [readingSnapshot, setReadingSnapshot] = useState<ReadingSnapshot>(EMPTY_READING_SNAPSHOT);
  const [returnId, setReturnId] = useState<string | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const contextHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const threadHeading = useRef<HTMLHeadingElement>(null);
  const readerScroll = useRef<HTMLDivElement>(null);
  const peersHeading = useRef<HTMLHeadingElement>(null);
  const selectedRow = useRef<HTMLButtonElement>(null);
  const index = useMemo(
    () => (history.data ? buildConversationIndex(history.data) : null),
    [history.data]
  );
  const threadRequest = useMemo<ThreadRead | null>(
    () =>
      nav.message !== null && history.data !== null
        ? {
            request: {
              id: nav.message,
              ledger: history.data.snapshot.ledger,
              t: history.data.snapshot.t,
            },
            criteria: history.data.criteria,
          }
        : null,
    [nav.message, history.data]
  );
  useEffect(() => resources.thread.setInput(threadRequest), [resources, threadRequest]);
  // The last tree read for the selected message, at whatever commit and under whatever
  // criteria it was read: a newer read replaces it only once that read succeeds.
  const treeReading =
    thread.data !== null && thread.data.observation.request.id === nav.message ? thread.data : null;
  const tree = treeReading?.observation ?? null;
  const treeCurrent = treeReading !== null && thread.observation?.key === thread.key;
  // The bus's tree is one conversation. Reply groups are rebuilt from it only to find the
  // selected entry and any cycle: a reply whose target the projection withheld would
  // otherwise start a group of its own and hide the readable entries above it.
  const treeConversation = useMemo<ObservedConversation | undefined>(() => {
    if (tree === null) return undefined;
    const index = buildConversationIndex(tree);
    const selected = index.byMessageId.get(tree.request.id);
    return selected === undefined
      ? undefined
      : {
          ...selected,
          messages: tree.messages,
          // Missing anchors are the bus's answer at t, not inferred from what loaded.
          missingTargetIds: tree.missingReplyTargets,
          cyclic: index.conversations.some((group) => group.cyclic),
        };
  }, [tree]);
  useEffect(() => {
    const change = () => setNav(parseHash());
    window.addEventListener("popstate", change);
    window.addEventListener("hashchange", change);
    return () => {
      window.removeEventListener("popstate", change);
      window.removeEventListener("hashchange", change);
    };
  }, []);
  const navigate = (next: Navigation) => {
    window.history.pushState(null, "", toHash(next));
    setNav(next);
  };
  const investigate = (input: HistoryInput) => {
    applyCriteria(input);
    navigate({ ...nav, context: { kind: "all" }, page: "conversations", chronology: false });
    requestAnimationFrame(() => listHeading.current?.focus());
  };
  const selectContext = (context: ConversationContext) => {
    setReadingSnapshot(EMPTY_READING_SNAPSHOT);
    setReturnId(null);
    navigate({ ...nav, context, message: null, page: "conversations", chronology: false });
    requestAnimationFrame(() => {
      if (readerScroll.current) readerScroll.current.scrollTop = 0;
      listHeading.current?.focus({ preventScroll: true });
    });
  };
  const selectGroup = (selected: ObservedConversation, id = selected.anchorMessageId) => {
    setReadingSnapshot(EMPTY_READING_SNAPSHOT);
    setReturnId(null);
    navigate({ ...nav, message: id, page: "thread" });
    requestAnimationFrame(() => {
      if (id !== selected.messages[0]?.id) {
        nodes.current.get(id)?.scrollIntoView({ block: "start" });
        nodes.current.get(id)?.focus({ preventScroll: true });
      } else {
        if (readerScroll.current) readerScroll.current.scrollTop = 0;
        threadHeading.current?.focus({ preventScroll: true });
      }
    });
  };
  const backToList = () => {
    navigate({ ...nav, page: "conversations" });
    requestAnimationFrame(() => (selectedRow.current ?? listHeading.current)?.focus());
  };
  const focusMessage = (id: string) => {
    setReturnId(
      document.activeElement?.closest("article")?.getAttribute("data-message-id") ?? nav.message
    );
    nodes.current.get(id)?.scrollIntoView({ block: "start" });
    nodes.current.get(id)?.focus();
  };
  const groups = index ? conversationsForContext(index, nav.context) : [];
  const contexts = index?.contexts ?? [];
  const visibleGroups =
    nav.chronology && index
      ? [...index.conversations].sort((a, b) => b.latestSourceIndex - a.latestSourceIndex)
      : groups;
  const contextMessages = useMemo(() => {
    const contextGroups = index ? conversationsForContext(index, nav.context) : [];
    const ids = new Set(
      contextGroups.flatMap((item) => item.messages.map((message) => message.id))
    );
    return history.data?.messages.filter((message) => ids.has(message.id)) ?? [];
  }, [index, nav.context, history.data]);
  const showContextFlow =
    nav.message === null && nav.context.kind !== "all" && !nav.chronology && history.data !== null;
  const readingIntent = useMemo<ReadingIntent | null>(
    () =>
      nav.message !== null
        ? { kind: "conversation", selectedMessageId: nav.message }
        : showContextFlow
          ? { kind: "flow", context: nav.context }
          : null,
    [nav.message, nav.context, showContextFlow]
  );
  // A conversation candidate is built from the tree reading alone, so it keeps that reading's
  // criteria, commit and receipt time, and stays the same object while a newer read is
  // pending. It shows every message the tree's projection emitted, in the bus's order. A
  // failed read, or a current tree without the selected entry, offers none.
  const treeCandidate = useMemo<ReadingUnit | null>(
    () =>
      readingIntent?.kind === "conversation" &&
      treeReading !== null &&
      tree !== null &&
      treeConversation !== undefined
        ? {
            ...readingIntent,
            criteria: treeReading.criteria,
            observedAt: tree.observedAt,
            snapshot: tree.snapshot,
            conversation: treeConversation,
            messages: tree.messages,
            tree: {
              missingReplyTargets: tree.missingReplyTargets,
              exhausted: tree.exhausted,
              damaged: tree.damaged,
              complete: tree.complete,
              omitted: tree.omitted,
            },
          }
        : null,
    [readingIntent, treeReading, tree, treeConversation]
  );
  const flowCandidate = useMemo<ReadingUnit | null>(
    () =>
      readingIntent?.kind === "flow" && history.data !== null
        ? {
            ...readingIntent,
            criteria: history.data.criteria,
            observedAt: history.data.observedAt,
            snapshot: history.data.snapshot,
            window: history.data.window,
            count: history.data.messages.length + history.data.omitted,
            damaged: history.data.damaged,
            omitted: history.data.omitted,
            complete: history.data.complete,
            messages: contextMessages,
          }
        : null,
    [readingIntent, history.data, contextMessages]
  );
  const candidate =
    readingIntent?.kind === "flow"
      ? flowCandidate
      : thread.error !== null || (treeCurrent && treeConversation === undefined)
        ? null
        : treeCandidate;
  const reading = useMemo(
    () => reconcileReadingUnit(readingSnapshot, readingIntent, candidate),
    [readingSnapshot, readingIntent, candidate]
  );
  useEffect(() => {
    if (reading !== readingSnapshot) setReadingSnapshot(reading);
  }, [reading, readingSnapshot]);
  const unit = reading.unit;
  const selectedGroup = unit?.kind === "conversation" ? unit.conversation : undefined;
  const readMessages = unit?.messages;
  const retainedSelection = unit !== null && reading.retained;
  const previousReadingCriteria = unit !== null && historyInputKey(unit.criteria) !== history.key;
  const allActive = nav.context.kind === "all" && !nav.chronology;
  const readingState = retainedSelection
    ? "Outside current observation"
    : readMessages !== undefined && previousReadingCriteria
      ? "Previous criteria observation"
      : "";
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
          <span className="brand-context">Observer</span>
        </div>
        <div className="header-actions">
          <AutoRefreshToggle enabled={automatic.enabled} onToggle={automatic.toggle} />
          <ThemeToggle />
          <Refresh
            label="Refresh all"
            onClick={() => {
              history.refresh();
              peers.refresh();
            }}
          />
        </div>
      </header>
      <LiveAnnouncement value={historyAnnouncement} />
      <LiveAnnouncement value={peersAnnouncement} />
      <main className={`context-workspace page-${nav.page}`}>
        <section className="context-rail" aria-labelledby="contexts-heading">
          <div className="rail-title">
            <div className="eyebrow">OBSERVATION</div>
            <h1 id="contexts-heading" ref={contextHeading} tabIndex={-1}>
              Contexts
            </h1>
            <CriteriaScope
              criteria={history.data?.criteria ?? history.input}
              window={history.data ? windowOf(history.data) : undefined}
            />
          </div>
          <Observation
            loading={history.loading}
            error={history.error}
            observedAt={history.data?.observedAt}
            omitted={history.data?.omitted}
            snapshot={history.data?.snapshot}
            damaged={history.data?.damaged}
          />
          {previousCriteria && (
            <p className="notice">
              Showing the previous criteria observation until the applied criteria succeeds.
            </p>
          )}
          <InvestigationControls criteria={history.input} onApply={investigate} />
          <div className="context-scroll">
            <button
              type="button"
              className={`context-item${allActive ? " active" : ""}`}
              aria-current={allActive ? "true" : undefined}
              onClick={() => selectContext({ kind: "all" })}
            >
              All messages
            </button>
            <button
              type="button"
              className={`context-item${nav.chronology ? " active" : ""}`}
              aria-current={nav.chronology ? "true" : undefined}
              onClick={() => {
                navigate({ ...nav, chronology: true, message: null, page: "conversations" });
                requestAnimationFrame(() => listHeading.current?.focus());
              }}
            >
              Chronology
            </button>
            {(["topic", "address", "broadcast"] as const).map((kind) => {
              const items = contexts.filter((c) => c.kind === kind);
              return (
                items.length > 0 && (
                  <div className="context-group" key={kind}>
                    <h2>
                      {kind === "topic" ? "Topics" : kind === "address" ? "Addresses" : "Broadcast"}
                    </h2>
                    {items.map((context) => {
                      const active =
                        !nav.chronology && contextKey(context) === contextKey(nav.context);
                      return (
                        <button
                          type="button"
                          key={contextKey(context)}
                          className={`context-item${active ? " active" : ""}`}
                          aria-current={active ? "true" : undefined}
                          onClick={() => {
                            selectContext(context);
                          }}
                        >
                          <Text value={contextLabel(context)} />
                        </button>
                      );
                    })}
                  </div>
                )
              );
            })}
            <button
              type="button"
              className="context-item peer-link"
              onClick={() => {
                navigate({ ...nav, page: "peers" });
                requestAnimationFrame(() => peersHeading.current?.focus());
              }}
            >
              Current peers
            </button>
          </div>
        </section>
        <section className="conversation-list" aria-labelledby="conversation-heading">
          <div className="list-title">
            <button
              className="mobile-back icon-button"
              type="button"
              aria-label="Back to contexts"
              title="Back to contexts"
              onClick={() => {
                navigate({ ...nav, page: "contexts" });
                requestAnimationFrame(() => contextHeading.current?.focus());
              }}
            >
              <ArrowLeft size={16} />
            </button>
            <div>
              <div className="eyebrow">OBSERVED CONVERSATIONS</div>
              <h2 id="conversation-heading" tabIndex={-1} ref={listHeading}>
                <Text value={nav.chronology ? "Chronology" : contextLabel(nav.context)} />
              </h2>
              <p>{nav.chronology ? "Messages in observation" : "Reply groups in observation"}</p>
            </div>
            <Refresh label="Refresh activity" onClick={history.refresh} />
          </div>
          <Observation
            loading={history.loading}
            error={history.error}
            observedAt={history.data?.observedAt}
            omitted={history.data?.omitted}
            snapshot={history.data?.snapshot}
            damaged={history.data?.damaged}
          />
          {previousCriteria && (
            <p className="notice">
              Previous criteria observation. Applied criteria has not succeeded.
            </p>
          )}
          {history.data && (
            <CriteriaScope criteria={history.data.criteria} window={windowOf(history.data)} />
          )}
          {nav.context.kind !== "all" && !nav.chronology && history.data && (
            <button
              className="read-context"
              type="button"
              onClick={() => {
                setReadingSnapshot(EMPTY_READING_SNAPSHOT);
                setReturnId(null);
                navigate({ ...nav, message: null, page: "thread" });
                requestAnimationFrame(() => {
                  if (readerScroll.current) readerScroll.current.scrollTop = 0;
                  threadHeading.current?.focus({ preventScroll: true });
                });
              }}
            >
              Read context
            </button>
          )}
          <div className="conversation-scroll">
            {!history.data && (
              <p className="empty">
                {history.error ? "History unavailable." : "Loading activity…"}
              </p>
            )}
            {history.data && visibleGroups.length === 0 && (
              <p className="empty">
                {history.data.omitted && index?.conversations.length === 0
                  ? "No displayable messages in this observation."
                  : "No matching messages in this observation."}
              </p>
            )}
            {nav.chronology
              ? history.data?.messages.map((message) => {
                  const item = index?.byMessageId.get(message.id);
                  return (
                    item && (
                      <button
                        type="button"
                        className={`conversation-row${message.id === nav.message ? " selected" : ""}`}
                        aria-current={message.id === nav.message ? "true" : undefined}
                        key={message.id}
                        onClick={() => selectGroup(item, message.id)}
                      >
                        <span className="sender">
                          <Text value={message.from} />
                        </span>
                        <strong>
                          <Text value={message.subject || message.body || "Message"} />
                        </strong>
                        <span className="summary-meta">
                          <Text value={formatTime(message.ts)} />
                        </span>
                      </button>
                    )
                  );
                })
              : visibleGroups.map((item) => {
                  const first = item.messages[0]!;
                  const last = item.messages[item.messages.length - 1]!;
                  const active =
                    nav.message !== null && item.messages.some((m) => m.id === nav.message);
                  const mixed =
                    nav.context.kind !== "all" &&
                    item.messages.some((m) => !messageMatchesContext(m, nav.context));
                  return (
                    <button
                      type="button"
                      ref={active ? selectedRow : undefined}
                      className={`conversation-row${active ? " selected" : ""}`}
                      aria-current={active ? "true" : undefined}
                      key={item.anchorMessageId}
                      onClick={() => selectGroup(item)}
                    >
                      <span className="sender">
                        <Text value={first.from} />
                      </span>
                      <strong>
                        <Text value={first.subject || first.body || "Message"} />
                      </strong>
                      <span className="summary-meta">
                        {item.messages.length} observed{" "}
                        {item.messages.length === 1 ? "message" : "messages"} ·{" "}
                        <Text value={formatTime(last.ts)} />
                      </span>
                      {mixed && <span className="summary-meta">Includes other audiences</span>}
                    </button>
                  );
                })}
          </div>
        </section>
        <section
          className="thread-view"
          aria-labelledby={nav.page === "peers" ? "peers-heading" : "thread-heading"}
        >
          {nav.page === "peers" ? (
            <>
              <div className="thread-title">
                <button
                  className="mobile-back icon-button"
                  type="button"
                  aria-label="Back to contexts"
                  title="Back to contexts"
                  onClick={() => {
                    navigate({ ...nav, page: "contexts" });
                    requestAnimationFrame(() => contextHeading.current?.focus());
                  }}
                >
                  <ArrowLeft size={16} />
                </button>
                <div>
                  <div className="eyebrow">PRESENCE</div>
                  <h2 id="peers-heading" ref={peersHeading} tabIndex={-1}>
                    Current peers
                  </h2>
                </div>
                <Refresh label="Refresh current peers" onClick={peers.refresh} />
              </div>
              <Observation
                loading={peers.loading}
                error={peers.error}
                observedAt={peers.data?.observedAt}
                omitted={peers.data?.omitted}
                snapshot={peers.data?.snapshot}
                damaged={peers.data?.damaged}
              />
              <PeerList
                data={peers.data}
                error={peers.error !== null}
                onInvestigate={(address) => {
                  investigate({ limit: DEFAULT_HISTORY_LIMIT, participant: address });
                }}
              />
            </>
          ) : (
            <>
              <div className="thread-title">
                <button
                  className="mobile-back icon-button"
                  type="button"
                  aria-label="Back to conversations"
                  title="Back to conversations"
                  onClick={backToList}
                >
                  <ArrowLeft size={16} />
                </button>
                <div>
                  <div className="eyebrow">READING</div>
                  <h2 id="thread-heading" ref={threadHeading} tabIndex={-1}>
                    {showContextFlow ? "Context flow" : "Conversation"}
                  </h2>
                  <p className="reading-observation-state" role="status" aria-atomic="true">
                    {readingState}
                  </p>
                </div>
              </div>
              <div className="thread-scroll" ref={readerScroll}>
                {readMessages ? (
                  <div className="thread-inner">
                    {retainedSelection && unit && (
                      <p className="notice" {...commitAttributes(unit.snapshot.t)}>
                        Not in the current observation · frozen at {commitLabel(unit.snapshot.t)} ·
                        last observed <Text value={formatTime(unit.observedAt)} />
                      </p>
                    )}
                    {unit?.kind === "conversation" && (
                      <p className="observation-scope" {...commitAttributes(unit.snapshot.t)}>
                        {treeLabel(
                          unit.tree,
                          unit.snapshot,
                          unit.messages.length + unit.tree.omitted
                        )}
                      </p>
                    )}
                    {unit?.kind === "flow" && (
                      <CriteriaScope
                        criteria={unit.criteria}
                        window={{
                          window: unit.window,
                          snapshot: unit.snapshot,
                          count: unit.count,
                          damaged: unit.damaged,
                          omitted: unit.omitted,
                        }}
                      />
                    )}
                    {retainedSelection && history.error && (
                      <p className="notice">
                        Current history refresh failed. This retained reading is from an earlier
                        observation.
                      </p>
                    )}
                    {/* The unit's own caveats, retained or not: never the current observation's. */}
                    {unit && (
                      <Observation
                        status={!retainedSelection}
                        loading={unit.kind === "conversation" ? thread.loading : history.loading}
                        error={unit.kind === "conversation" ? thread.error : history.error}
                        observedAt={unit.observedAt}
                        omitted={unit.kind === "conversation" ? unit.tree.omitted : unit.omitted}
                        snapshot={unit.snapshot}
                        damaged={unit.kind === "conversation" ? unit.tree.damaged : unit.damaged}
                      />
                    )}
                    {previousReadingCriteria && (
                      <p className="notice">
                        {previousCriteria
                          ? "Showing the previous criteria observation. Applied criteria has not succeeded."
                          : "This retained reading uses earlier criteria."}
                      </p>
                    )}
                    <div className="thread-scope">
                      {showContextFlow && (
                        <>
                          <Text value={contextLabel(nav.context)} /> ·{" "}
                        </>
                      )}
                      {readMessages.length} observed{" "}
                      {readMessages.length === 1 ? "message" : "messages"}
                      {selectedGroup?.cyclic && " · Cyclic reply references"}
                    </div>
                    {showContextFlow && readMessages.length === 0 && (
                      <p className="empty">No matching messages in this observation.</p>
                    )}
                    {returnId !== null && (
                      <button
                        className="text-action return-link"
                        type="button"
                        onClick={() => {
                          nodes.current.get(returnId)?.scrollIntoView({ block: "start" });
                          nodes.current.get(returnId)?.focus();
                          setReturnId(null);
                        }}
                      >
                        Return to reply
                      </button>
                    )}
                    {readMessages.map((message) => (
                      <ConversationMessage
                        key={message.id}
                        message={message}
                        messages={readMessages}
                        target={
                          unit?.kind !== "conversation"
                            ? undefined
                            : {
                                t: unit.snapshot.t,
                                missing: unit.tree.missingReplyTargets.includes(
                                  message.replyTo ?? ""
                                ),
                              }
                        }
                        focusMessage={focusMessage}
                        register={(id, node) => {
                          if (node) {
                            node.dataset.messageId = id;
                            nodes.current.set(id, node);
                          } else nodes.current.delete(id);
                        }}
                      />
                    ))}
                    <section className="compose">
                      <div className="field-label">Compose</div>
                      <p>Sending is not available.</p>
                    </section>
                  </div>
                ) : nav.message !== null && thread.error !== null ? (
                  <p className="empty">Conversation unavailable.</p>
                ) : nav.message !== null && tree !== null && treeCurrent ? (
                  <SelectedBeyondTree
                    key={nav.message}
                    tree={tree}
                    fromHistory={history.data}
                    onFocusMessage={focusMessage}
                  />
                ) : nav.message !== null ? (
                  <p className="empty">Loading conversation…</p>
                ) : (
                  <p className="empty">Select a conversation</p>
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
