export const AUTO_REFRESH_MILLIS = 15_000;

export interface AutoRefreshScheduler {
  readonly start: () => void;
  readonly stop: () => void;
  readonly setEnabled: (enabled: boolean) => void;
  readonly setVisible: (visible: boolean) => void;
}

/** One timer, no catch-up queue. Resource controllers separately skip pending reads. */
export function createAutoRefreshScheduler(options: {
  readonly refresh: () => void;
  readonly enabled?: boolean;
  readonly visible?: boolean;
  readonly intervalMillis?: number;
  readonly schedule?: (run: () => void, millis: number) => () => void;
}): AutoRefreshScheduler {
  const interval = options.intervalMillis ?? AUTO_REFRESH_MILLIS;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error("Invalid refresh interval");
  const schedule =
    options.schedule ??
    ((run, millis) => {
      const timer = setTimeout(run, millis);
      return () => clearTimeout(timer);
    });
  let enabled = options.enabled ?? true;
  let visible = options.visible ?? true;
  let running = false;
  let generation = 0;
  let cancelTimer: (() => void) | undefined;
  const active = () => running && enabled && visible;
  const clear = () => {
    generation++;
    cancelTimer?.();
    cancelTimer = undefined;
  };
  const arm = () => {
    clear();
    if (!active()) return;
    const current = generation;
    cancelTimer = schedule(() => {
      if (generation !== current || !active()) return;
      cancelTimer = undefined;
      try {
        options.refresh();
      } finally {
        if (generation === current && active()) arm();
      }
    }, interval);
  };
  const resumed = () => {
    clear();
    if (!active()) return;
    try {
      options.refresh();
    } finally {
      if (active()) arm();
    }
  };
  return {
    start: () => {
      if (running) return;
      running = true;
      arm();
    },
    stop: () => {
      running = false;
      clear();
    },
    setEnabled: (next) => {
      if (enabled === next) return;
      enabled = next;
      resumed();
    },
    setVisible: (next) => {
      if (visible === next) return;
      visible = next;
      resumed();
    },
  };
}
