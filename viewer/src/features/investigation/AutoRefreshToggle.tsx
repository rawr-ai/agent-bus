import { Pause, Play } from "lucide-react";
import "./investigation.css";

export function AutoRefreshToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  const label = enabled ? "Pause automatic refresh" : "Resume automatic refresh";
  return (
    <div className="automatic-refresh">
      <span>{enabled ? "Automatic refresh on" : "Automatic refresh paused"}</span>
      <button
        type="button"
        className="investigation-icon"
        aria-label={label}
        title={label}
        onClick={onToggle}
      >
        {enabled ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
      </button>
    </div>
  );
}
