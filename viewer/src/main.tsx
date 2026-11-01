import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ArrowLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import { type RefObject, StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ViewerClient } from "../shared/client-types";
import type { HistoryObservation, PeersObservation, PublicMessage } from "../shared/public";
import "./style.css";

const client: ViewerClient = createORPCClient(
  new RPCLink({ url: new URL("/rpc", location.origin) })
);

type Resource<T> = { data: T | null; loading: boolean; error: boolean };

function useResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<Resource<T>>({ data: null, loading: true, error: false });
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
        if (current.current.generation === generation)
          setState({ data, loading: false, error: false });
      },
      () => {
        if (current.current.generation === generation && !controller.signal.aborted) {
          setState((previous) => ({ ...previous, loading: false, error: true }));
        }
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

const loadHistory = (signal: AbortSignal) => client.history({ limit: 50 }, { signal });
const loadPeers = (signal: AbortSignal) => client.peers({}, { signal });

// Directional controls are made visible so untrusted strings cannot reorder their labels.
function safeText(value: string) {
  return value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
function Text({ value }: { value: string }) {
  return <bdi dir="auto">{safeText(value)}</bdi>;
}
function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? safeText(value)
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      });
}
function shortTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? safeText(value)
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function IconButton({
  label,
  onClick,
  spinning = false,
}: {
  label: string;
  onClick: () => void;
  spinning?: boolean;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <RefreshCw size={16} aria-hidden="true" className={spinning ? "spinning" : undefined} />
    </button>
  );
}
function Observation({
  name,
  loading,
  error,
  observedAt,
  omitted,
}: {
  name: string;
  loading: boolean;
  error: boolean;
  observedAt: string | undefined;
  omitted: number | undefined;
}) {
  let status = observedAt ? `Observed ${time(observedAt)}` : "Not yet observed";
  if (loading) status = observedAt ? `${status} · Refreshing` : "Loading";
  if (error)
    status = observedAt
      ? `Refresh failed · last observed ${time(observedAt)}`
      : `${name} unavailable`;
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
function Audience({ values }: { values: string[] }) {
  return (
    <span className="audience">
      {values.map((value, index) => (
        <span className="audience-value" key={`${index}-${value}`}>
          <Text value={value} />
        </span>
      ))}
    </span>
  );
}
function MessageDetail({
  message,
  present,
  lastObserved,
  replyAvailable,
  headingRef,
  onReply,
}: {
  message: PublicMessage;
  present: boolean;
  lastObserved: string;
  replyAvailable: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onReply: (id: string) => void;
}) {
  return (
    <div className="detail-content">
      {!present && (
        <p className="notice">
          Not in the latest observation · last observed <Text value={time(lastObserved)} />
        </p>
      )}
      <div className="detail-heading">
        <div>
          <div className="eyebrow">MESSAGE</div>
          <h2 ref={headingRef} tabIndex={-1}>
            {message.subject ? <Text value={message.subject} /> : "Message"}
          </h2>
        </div>
        <time className="detail-time" dateTime={message.ts} title={safeText(message.ts)}>
          <Text value={time(message.ts)} />
        </time>
      </div>
      <dl className="metadata">
        <div>
          <dt>From</dt>
          <dd>
            <Text value={message.from} />
          </dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>
            <Audience values={message.to} />
          </dd>
        </div>
      </dl>
      <div className="message-body">
        <Text value={message.body} />
      </div>
      {message.replyTo && (
        <div className="reply">
          <span className="field-label">Reply to</span>
          {replyAvailable ? (
            <button className="reply-link" type="button" onClick={() => onReply(message.replyTo!)}>
              <Text value={message.replyTo} />
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          ) : (
            <>
              <span className="reply-id">
                <Text value={message.replyTo} />
              </span>
              <span className="reply-unresolved">Target not in this observation</span>
            </>
          )}
        </div>
      )}
      <details className="provenance">
        <summary>Recorded with this message</summary>
        <dl className="metadata provenance-fields">
          {message.origin &&
            Object.entries(message.origin).map(
              ([key, value]) =>
                typeof value === "string" && (
                  <div key={key}>
                    <dt>{key === "cwd" ? "Directory" : key[0]!.toUpperCase() + key.slice(1)}</dt>
                    <dd>
                      <Text value={value} />
                    </dd>
                  </div>
                )
            )}
          <div>
            <dt>Message ID</dt>
            <dd>
              <Text value={message.id} />
            </dd>
          </div>
        </dl>
      </details>
      <section className="compose" aria-label="Compose">
        <div className="field-label">Compose</div>
        <p>Sending is not available.</p>
      </section>
    </div>
  );
}
function App() {
  const history = useResource<HistoryObservation>(loadHistory);
  const peers = useResource<PeersObservation>(loadPeers);
  const [selected, setSelected] = useState<{ message: PublicMessage; observedAt: string } | null>(
    null
  );
  const [view, setView] = useState<"activity" | "message" | "peers">("activity");
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const listHeading = useRef<HTMLHeadingElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (!history.data) return;
    const observation = history.data;
    setSelected((previous) => {
      if (!previous) return previous;
      const message = observation.messages.find((item) => item.id === previous.message.id);
      return message ? { message, observedAt: observation.observedAt } : previous;
    });
  }, [history.data]);
  const messages = history.data?.messages ?? [];
  const actual = selected
    ? messages.find((message) => message.id === selected.message.id)
    : undefined;
  const displayed = actual ?? selected?.message;
  const select = (message: PublicMessage) => {
    setSelected({ message, observedAt: history.data?.observedAt ?? "" });
    setView("message");
    if (matchMedia("(max-width: 850px)").matches)
      requestAnimationFrame(() => detailHeading.current?.focus());
  };
  const back = () => {
    setView("activity");
    requestAnimationFrame(() => (selectedRef.current ?? listHeading.current)?.focus());
  };
  const reply = (id: string) => {
    const target = messages.find((message) => message.id === id);
    if (target) select(target);
  };
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
        <button
          className="refresh-all"
          type="button"
          aria-label="Refresh all"
          title="Refresh all"
          onClick={() => {
            history.refresh();
            peers.refresh();
          }}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </header>
      <nav className="mobile-nav" aria-label="Viewer sections">
        <button
          type="button"
          aria-current={view === "activity" ? "page" : undefined}
          onClick={() => setView("activity")}
        >
          Activity
        </button>
        <button
          type="button"
          aria-current={view === "message" ? "page" : undefined}
          onClick={() => setView("message")}
        >
          Message
        </button>
        <button
          type="button"
          aria-current={view === "peers" ? "page" : undefined}
          onClick={() => setView("peers")}
        >
          Current peers
        </button>
      </nav>
      <main className="workspace">
        <section
          className={`activity panel ${view !== "activity" ? "mobile-hidden" : ""}`}
          aria-labelledby="activity-heading"
        >
          <div className="panel-heading">
            <div>
              <div className="eyebrow">OBSERVATION</div>
              <h1 id="activity-heading" tabIndex={-1} ref={listHeading}>
                Activity
              </h1>
            </div>
            <IconButton
              label="Refresh activity"
              onClick={history.refresh}
              spinning={history.loading}
            />
          </div>
          <div className="scope-line">
            <span>Latest {history.data?.criteria.limit ?? 50} messages</span>
            <span className="scope-dot">·</span>
            <span>Time ordered</span>
          </div>
          <Observation
            name="History"
            loading={history.loading}
            error={history.error}
            observedAt={history.data?.observedAt}
            omitted={history.data?.omitted}
          />
          <div className="activity-list">
            {!history.data && history.loading && <p className="empty">Loading activity…</p>}
            {!history.data && history.error && (
              <div className="empty">
                <p>History unavailable.</p>
                <button className="text-action" type="button" onClick={history.refresh}>
                  Try again
                </button>
              </div>
            )}
            {history.data && messages.length === 0 && (
              <p className="empty">
                {history.data.omitted
                  ? "No displayable messages in this observation."
                  : "No messages in this observation."}
              </p>
            )}
            {messages.map((message) => (
              <button
                type="button"
                key={message.id}
                ref={message.id === selected?.message.id ? selectedRef : undefined}
                className={`message-row${message.id === selected?.message.id ? " selected" : ""}`}
                aria-pressed={message.id === selected?.message.id}
                onClick={() => select(message)}
              >
                <span className="row-top">
                  <span className="sender">
                    <Text value={message.from} />
                  </span>
                  <time dateTime={message.ts} title={time(message.ts)}>
                    <Text value={shortTime(message.ts)} />
                  </time>
                </span>
                <span className="row-subject">
                  <Text value={message.subject || message.body || "Message"} />
                </span>
                <span className="row-audience">
                  <span>To</span>
                  <Audience values={message.to} />
                </span>
              </button>
            ))}
          </div>
        </section>
        <section
          className={`reading panel ${view === "activity" ? "mobile-hidden" : ""}`}
          aria-label="Message and peers"
        >
          <div className="reading-tabs">
            <button
              className="back-button"
              type="button"
              onClick={back}
              aria-label="Back to activity"
              title="Back to activity"
            >
              <ArrowLeft size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={view !== "peers" ? "active" : ""}
              onClick={() => setView("message")}
            >
              Message
            </button>
            <button
              type="button"
              className={view === "peers" ? "active" : ""}
              onClick={() => setView("peers")}
            >
              Current peers
            </button>
          </div>
          <div className="reading-scroll">
            {view === "peers" ? (
              <div className="peers-content">
                <div className="peer-title">
                  <div>
                    <div className="eyebrow">PRESENCE</div>
                    <h2>Current peers</h2>
                  </div>
                  <IconButton
                    label="Refresh current peers"
                    onClick={peers.refresh}
                    spinning={peers.loading}
                  />
                </div>
                <Observation
                  name="Peers"
                  loading={peers.loading}
                  error={peers.error}
                  observedAt={peers.data?.observedAt}
                  omitted={peers.data?.omitted}
                />
                {!peers.data && peers.loading && <p className="empty">Loading peers…</p>}
                {!peers.data && peers.error && (
                  <div className="empty">
                    <p>Peers unavailable.</p>
                    <button className="text-action" type="button" onClick={peers.refresh}>
                      Try again
                    </button>
                  </div>
                )}
                {peers.data && peers.data.peers.length === 0 && (
                  <p className="empty">
                    {peers.data.omitted
                      ? "No displayable peers in this observation."
                      : "No currently joined peers in this observation."}
                  </p>
                )}
                {peers.data?.peers.map((peer, index) => (
                  <div className="peer-row" key={`${peer.address}-${index}`}>
                    <div className="peer-address">
                      <Text value={peer.address} />
                    </div>
                    <div className="peer-meta">
                      <Text value={peer.runtime} />
                      {peer.host && (
                        <>
                          {" "}
                          <span>·</span> <Text value={peer.host} />
                        </>
                      )}
                    </div>
                    {peer.topics.length > 0 && (
                      <div className="peer-topics">
                        <span>Topics</span>
                        <Audience values={peer.topics} />
                      </div>
                    )}
                    {peer.note && (
                      <p className="peer-note">
                        <Text value={peer.note} />
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : displayed ? (
              <MessageDetail
                message={displayed}
                present={Boolean(actual)}
                lastObserved={selected?.observedAt ?? ""}
                replyAvailable={Boolean(
                  displayed.replyTo && messages.some((item) => item.id === displayed.replyTo)
                )}
                headingRef={detailHeading}
                onReply={reply}
              />
            ) : (
              <div className="empty-selection">
                <h2>Select a message</h2>
                <section className="compose" aria-label="Compose">
                  <div className="field-label">Compose</div>
                  <p>Sending is not available.</p>
                </section>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
