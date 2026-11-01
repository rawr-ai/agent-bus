import { Code2, FileText } from "lucide-react";
import { memo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MAX_RENDERED_MARKDOWN_LENGTH, safeWebUrl } from "./markdown-policy";
import { safeText } from "./Text";

const Rendered = memo(function Rendered({ body }: { body: string }) {
  return (
    <div className="markdown" dir="auto">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url, key) => (key === "href" ? safeWebUrl(url) : undefined)}
        components={{
          a: ({ href, children }) =>
            href && safeWebUrl(href) ? (
              <a
                href={href}
                title={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                referrerPolicy="no-referrer"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>[Image{alt ? `: ${alt}` : " omitted"}]</span>,
          input: ({ checked }) => (
            <input
              type="checkbox"
              checked={Boolean(checked)}
              disabled
              aria-label="Message task item"
            />
          ),
          pre: ({ children }) => (
            <div className="code-scroll" tabIndex={0} role="region" aria-label="Code block">
              <pre>{children}</pre>
            </div>
          ),
          table: ({ children }) => (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Message table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {safeText(body)}
      </Markdown>
    </div>
  );
});
export const MessageBody = memo(function MessageBody({ body }: { body: string }) {
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const tooLarge = body.length > MAX_RENDERED_MARKDOWN_LENGTH;
  const showSource = mode === "source" || tooLarge;
  return (
    <section className="body-section">
      <div className="body-toolbar">
        <span className="field-label">Body</span>
        <div className="mode-control" role="group" aria-label="Message body view">
          <button
            type="button"
            title="Rendered"
            aria-label="Rendered"
            aria-pressed={!showSource}
            disabled={tooLarge}
            onClick={() => setMode("rendered")}
          >
            <FileText size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            title="Source"
            aria-label="Source"
            aria-pressed={showSource}
            onClick={() => setMode("source")}
          >
            <Code2 size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      {tooLarge && (
        <p className="render-limit">
          Rendered view unavailable for this large message. Showing full source.
        </p>
      )}
      {showSource ? (
        <div className="message-source" dir="auto">
          {safeText(body)}
        </div>
      ) : (
        <Rendered body={body} />
      )}
    </section>
  );
});
