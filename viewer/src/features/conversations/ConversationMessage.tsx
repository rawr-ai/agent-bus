import { ArrowUpRight } from "lucide-react";
import type { PublicMessage } from "../../../shared/public";
import { MessageBody } from "../../MessageBody";
import { commitAttributes, commitLabel } from "../../snapshot-labels";
import { Audience, formatTime, safeText, Text } from "../../Text";

export function ConversationMessage({
  message,
  messages,
  target,
  focusMessage,
  register,
}: {
  message: PublicMessage;
  messages: readonly PublicMessage[];
  /**
   * For a message read in a reply tree at commit `t`: whether the bus reported its reply
   * target as not an entry there. A target that is not missing is in that tree, so when it is
   * not shown, the viewer withheld it or the bus could not read it. Absent outside a tree.
   */
  target?: { readonly t: number; readonly missing: boolean } | undefined;
  focusMessage: (id: string) => void;
  register: (id: string, node: HTMLElement | null) => void;
}) {
  const parent =
    message.replyTo === undefined
      ? undefined
      : messages.find((item) => item.id === message.replyTo);
  return (
    <article className="thread-message" ref={(node) => register(message.id, node)} tabIndex={-1}>
      <div className="thread-header">
        <div>
          <div className="sender">
            <Text value={message.from} />
          </div>
          {message.subject && (
            <h3>
              <Text value={message.subject} />
            </h3>
          )}
        </div>
        <time dateTime={message.ts} title={safeText(message.ts)}>
          <Text value={formatTime(message.ts)} />
        </time>
      </div>
      <div className="thread-to">
        <span className="field-label">To</span>
        <Audience values={message.to} />
      </div>
      {message.replyTo !== undefined && (
        <div className="reply">
          <span className="field-label">Reply to</span>
          {parent ? (
            <button className="reply-link" type="button" onClick={() => focusMessage(parent.id)}>
              <Text value={parent.subject || parent.from} />
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          ) : (
            <>
              <span>
                <Text value={message.replyTo} />
              </span>
              <span
                className="reply-unresolved"
                {...(target === undefined ? {} : commitAttributes(target.t))}
              >
                {target === undefined
                  ? "Target not in this observation"
                  : target.missing
                    ? `Target is not an entry at ${commitLabel(target.t)}`
                    : `Target is in the reply tree at ${commitLabel(target.t)} but not shown`}
              </span>
            </>
          )}
        </div>
      )}
      <MessageBody body={message.body} />
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
    </article>
  );
}
