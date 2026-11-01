import { Moon, Sun } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";

const key = "agent-bus-viewer-theme";
function readPreference(): "light" | "dark" | null {
  try {
    const value = localStorage.getItem(key);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}
export function ThemeToggle() {
  const [preference, setPreference] = useState(readPreference);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches
  );
  const dark = preference ? preference === "dark" : systemDark;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const toggle = () => {
    const next = dark ? "light" : "dark";
    setPreference(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* Preference remains active for this session. */
    }
  };
  return (
    <button
      className="icon-button"
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark theme"
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
    >
      {dark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    </button>
  );
}
