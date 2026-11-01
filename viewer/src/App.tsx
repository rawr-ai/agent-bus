import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewerClient } from "../shared/client-types";
import { DEFAULT_HISTORY_LIMIT } from "../shared/limits";
import type { HistoryInput, HistoryObservation, PeersObservation } from "../shared/public";
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
function CriteriaScope({ criteria }: { criteria: HistoryInput }) {
  return (
    <p className="observation-scope">
      {isHistoryInvestigation(criteria) ? "Server matches" : "Latest messages"} · limit{" "}
      {criteria.limit}
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
};
const peersAnnouncer: AnnouncerOptions<PeersObservation> = {
  name: "Current peers",
  noun: ["peer", "peers"],
  identities: (value) => value.peers.map((peer) => peer.address),
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
function Observation({
  loading,
  error,
  observedAt,
  omitted,
}: {
  loading: boolean;
  error: null | "unavailable" | "timeout";
  observedAt: string | undefined;
  omitted: number | undefined;
}) {
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
    <div className={`observation${error ? " observation-error" : ""}`}>
      <span>{status}</span>
      {Boolean(omitted) && (
        <span className="omitted">
          {omitted} {omitted === 1 ? "record" : "records"} omitted
        </span>
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
    }),
    [client]
  );
  const history = useObservation(resources.history);
  const peers = useObservation(resources.peers);
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
  const group = nav.message === null ? undefined : index?.byMessageId.get(nav.message);
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
  const candidate = useMemo<ReadingUnit | null>(() => {
    if (history.data === null || readingIntent === null) return null;
    const observation = { criteria: history.data.criteria, observedAt: history.data.observedAt };
    if (readingIntent.kind === "conversation")
      return group
        ? {
            ...readingIntent,
            ...observation,
            conversation: group,
            messages: group.messages,
          }
        : null;
    return { ...readingIntent, ...observation, messages: contextMessages };
  }, [history.data, readingIntent, group, contextMessages]);
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
            <CriteriaScope criteria={history.data?.criteria ?? history.input} />
          </div>
          <Observation
            loading={history.loading}
            error={history.error}
            observedAt={history.data?.observedAt}
            omitted={history.data?.omitted}
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
              className={`context-item${nav.context.kind === "all" && !nav.chronology ? " active" : ""}`}
              onClick={() => selectContext({ kind: "all" })}
            >
              All messages
            </button>
            <button
              type="button"
              className={`context-item${nav.chronology ? " active" : ""}`}
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
                    {items.map((context) => (
                      <button
                        type="button"
                        key={contextKey(context)}
                        className={`context-item${!nav.chronology && contextKey(context) === contextKey(nav.context) ? " active" : ""}`}
                        onClick={() => {
                          selectContext(context);
                        }}
                      >
                        <Text value={contextLabel(context)} />
                      </button>
                    ))}
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
          />
          {previousCriteria && (
            <p className="notice">
              Previous criteria observation. Applied criteria has not succeeded.
            </p>
          )}
          {history.data && <CriteriaScope criteria={history.data.criteria} />}
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
                        className="conversation-row"
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
                      <p className="notice">
                        Not in the current observation · limit {unit.criteria.limit} · last observed{" "}
                        <Text value={formatTime(unit.observedAt)} />
                      </p>
                    )}
                    {unit && <CriteriaScope criteria={unit.criteria} />}
                    {retainedSelection && history.error && (
                      <p className="notice">
                        Current history refresh failed. This retained reading is from an earlier
                        observation.
                      </p>
                    )}
                    {!retainedSelection && unit && (
                      <Observation
                        loading={history.loading}
                        error={history.error}
                        observedAt={unit.observedAt}
                        omitted={history.data?.omitted}
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
