import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createAutoRefreshScheduler } from "./auto-refresh";
import type { ObservationResource } from "./observation-resource";

export function useObservation<I, T>(resource: ObservationResource<I, T>) {
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  useEffect(() => {
    resource.refresh();
    // StrictMode replays this lifetime on the same store; cancel is reusable.
    return resource.cancel;
  }, [resource]);
  return {
    ...state,
    data: state.observation?.value ?? null,
    refresh: () => resource.refresh(),
  };
}

export function useAutomaticRefresh(refresh: () => void) {
  const [enabled, setEnabled] = useState(true);
  const scheduler = useMemo(
    () =>
      createAutoRefreshScheduler({
        refresh,
        visible: document.visibilityState === "visible",
      }),
    [refresh]
  );
  useEffect(() => {
    scheduler.setVisible(document.visibilityState === "visible");
    scheduler.start();
    const changed = () => scheduler.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      scheduler.stop();
    };
  }, [scheduler]);
  useEffect(() => scheduler.setEnabled(enabled), [scheduler, enabled]);
  return { enabled, toggle: () => setEnabled((previous) => !previous) };
}
