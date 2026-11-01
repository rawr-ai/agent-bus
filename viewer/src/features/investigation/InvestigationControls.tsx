import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_PARTICIPANT_LENGTH,
  MAX_QUERY_LENGTH,
} from "../../../shared/limits";
import type { HistoryInput } from "../../../shared/public";
import "./investigation.css";

export function InvestigationControls({
  criteria,
  onApply,
}: {
  criteria: HistoryInput;
  onApply: (input: HistoryInput) => void;
}) {
  const [query, setQuery] = useState(criteria.query ?? "");
  const [participant, setParticipant] = useState(criteria.participant ?? "");
  useEffect(() => {
    setQuery(criteria.query ?? "");
    setParticipant(criteria.participant ?? "");
  }, [criteria.query, criteria.participant]);
  const clearDisabled =
    query === "" &&
    participant === "" &&
    criteria.query === undefined &&
    criteria.participant === undefined;
  return (
    <form
      className="investigation"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({
          limit: criteria.limit,
          ...(query === "" ? {} : { query }),
          ...(participant === "" ? {} : { participant }),
        });
      }}
    >
      <label className="investigation-field">
        <span>Search messages</span>
        <input
          type="text"
          value={query}
          maxLength={MAX_QUERY_LENGTH}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <label className="investigation-field">
        <span>Exact participant/address</span>
        <input
          type="text"
          value={participant}
          maxLength={MAX_PARTICIPANT_LENGTH}
          onChange={(event) => setParticipant(event.currentTarget.value)}
        />
      </label>
      <div className="investigation-actions">
        <button
          className="investigation-icon"
          type="submit"
          title="Apply search"
          aria-label="Apply search"
        >
          <Search size={16} aria-hidden="true" />
        </button>
        <button
          className="investigation-icon"
          type="button"
          title="Clear search"
          aria-label="Clear search"
          disabled={clearDisabled}
          onClick={() => {
            setQuery("");
            setParticipant("");
            onApply({ limit: DEFAULT_HISTORY_LIMIT });
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
