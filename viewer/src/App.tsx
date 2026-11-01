import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewerClient } from "../shared/client-types";
import { DEFAULT_HISTORY_LIMIT } from "../shared/limits";
import type { HistoryObservation, PeersObservation } from "../shared/public";
import { ConversationMessage } from "./features/conversations/ConversationMessage";
import {
  buildConversationIndex,
  type ConversationContext,
  contextKey,
  conversationsForContext,
  messageMatchesContext,
  type ObservedConversation,
} from "./features/conversations/model";
import { PeerList } from "./features/peers/PeerList";
import { formatTime, Text } from "./Text";
import { ThemeToggle } from "./ThemeToggle";
import "./style.css";
import "./conversation.css";

function useResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: boolean }>({
    data: null,
    loading: true,
    error: false,
  });
  const current = useRef<{ generation: number; controller: AbortController | null }>({
    generation: 0,
    controller: null,
  });
  const refresh = useCallback(() => {
    current.current.controller?.abort();
    const controller = new AbortController();
    const generation = ++current.current.generation;
    current.current.controller = controller;
    setState((previous) => ({ ...previous, loading: true, error: false }));
    void load(controller.signal).then(
      (data) => {
        if (generation === current.current.generation)
          setState({ data, loading: false, error: false });
      },
      () => {
        if (generation === current.current.generation && !controller.signal.aborted)
          setState((previous) => ({ ...previous, loading: false, error: true }));
      }
    );
  }, [load]);
  useEffect(() => {
    refresh();
    return () => {
      current.current.generation++;
      current.current.controller?.abort();
    };
  }, [refresh]);
  return { ...state, refresh };
}
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
function Observation({
  loading,
  error,
  observedAt,
  omitted,
}: {
  loading: boolean;
  error: boolean;
  observedAt: string | undefined;
  omitted: number | undefined;
}) {
  const status = error
    ? observedAt
      ? `Refresh failed · last observed ${formatTime(observedAt)}`
      : "Observation unavailable"
    : loading
      ? observedAt
        ? `Observed ${formatTime(observedAt)} · Refreshing`
        : "Loading"
      : observedAt
        ? `Observed ${formatTime(observedAt)}`
        : "Not yet observed";
  return (
    <div className={`observation${error ? " observation-error" : ""}`} role="status">
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
  const historyRequest = useCallback(
    (signal: AbortSignal) => client.history({ limit: DEFAULT_HISTORY_LIMIT }, { signal }),
    [client]
  );
  const peersRequest = useCallback((signal: AbortSignal) => client.peers({}, { signal }), [client]);
  const history = useResource<HistoryObservation>(historyRequest);
  const peers = useResource<PeersObservation>(peersRequest);
  const [nav, setNav] = useState<Navigation>(() => (location.hash ? parseHash() : defaultNav));
  const [snapshot, setSnapshot] = useState<{
    group: ObservedConversation;
    observedAt: string;
    criteria: HistoryObservation["criteria"];
  } | null>(null);
  const [returnId, setReturnId] = useState<string | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const contextHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const threadHeading = useRef<HTMLHeadingElement>(null);
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
  useEffect(() => {
    if (group && history.data)
      setSnapshot({ group, observedAt: history.data.observedAt, criteria: history.data.criteria });
  }, [group, history.data]);
  const navigate = (next: Navigation) => {
    window.history.pushState(null, "", toHash(next));
    setNav(next);
  };
  const selectContext = (context: ConversationContext) => {
    setReturnId(null);
    navigate({ ...nav, context, message: null, page: "conversations", chronology: false });
    requestAnimationFrame(() => listHeading.current?.focus());
  };
  const selectGroup = (selected: ObservedConversation, id = selected.anchorMessageId) => {
    if (history.data)
      setSnapshot({
        group: selected,
        observedAt: history.data.observedAt,
        criteria: history.data.criteria,
      });
    setReturnId(null);
    navigate({ ...nav, message: id, page: "thread" });
    requestAnimationFrame(() => {
      if (id !== selected.messages[0]?.id) {
        nodes.current.get(id)?.scrollIntoView({ block: "start" });
        nodes.current.get(id)?.focus();
      } else threadHeading.current?.focus();
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
  const selectedGroup =
    group ??
    (nav.message !== null && snapshot?.group.messages.some((message) => message.id === nav.message)
      ? snapshot.group
      : undefined);
  const groups = index ? conversationsForContext(index, nav.context) : [];
  const contexts = index?.contexts ?? [];
  const visibleGroups =
    nav.chronology && index
      ? [...index.conversations].sort((a, b) => b.latestSourceIndex - a.latestSourceIndex)
      : groups;
  const contextIds = new Set(groups.flatMap((item) => item.messages.map((message) => message.id)));
  const contextMessages =
    history.data?.messages.filter((message) => contextIds.has(message.id)) ?? [];
  const showContextFlow =
    nav.message === null && nav.context.kind !== "all" && !nav.chronology && history.data !== null;
  const readMessages = selectedGroup?.messages ?? (showContextFlow ? contextMessages : undefined);
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
      <main className={`context-workspace page-${nav.page}`}>
        <section className="context-rail" aria-labelledby="contexts-heading">
          <div className="rail-title">
            <div className="eyebrow">OBSERVATION</div>
            <h1 id="contexts-heading" ref={contextHeading} tabIndex={-1}>
              Contexts
            </h1>
            <p>In the latest {history.data?.criteria.limit ?? DEFAULT_HISTORY_LIMIT} messages</p>
          </div>
          <Observation
            loading={history.loading}
            error={history.error}
            observedAt={history.data?.observedAt}
            omitted={history.data?.omitted}
          />
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
          {nav.context.kind !== "all" && !nav.chronology && history.data && (
            <button
              className="read-context"
              type="button"
              onClick={() => {
                setReturnId(null);
                navigate({ ...nav, message: null, page: "thread" });
                requestAnimationFrame(() => threadHeading.current?.focus());
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
              <PeerList data={peers.data} error={peers.error} />
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
                </div>
              </div>
              <div className="thread-scroll">
                {readMessages ? (
                  <div className="thread-inner">
                    {!group && !showContextFlow && snapshot && (
                      <p className="notice">
                        Not in the latest observation · limit {snapshot.criteria.limit} · last
                        observed <Text value={formatTime(snapshot.observedAt)} />
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
