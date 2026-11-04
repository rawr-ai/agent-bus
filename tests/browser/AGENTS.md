# Native Browser Checks

Borrowed from OPA website's native Stagehand 4 guest-page harness. These are
deterministic local Chrome checks, not model evaluations or a Playwright adapter.

- Run `bun --no-env-file run test:browser` after `viewer:build`.
- Keep costly entry points named `.browser.ts`, outside default Bun test discovery.
- Use native Stagehand selectors and explicit asserted waits. Do not emulate role
  locators, call models, use cloud sessions, inherit personal profiles, or sleep to
  synchronize UI state.
- Every browser gets a fresh temporary profile. Always await Stagehand and browser
  cleanup, and close owned fixture/static servers even on assertion failure.
- Set and assert the actual viewport; launch-window size alone is not sufficient.
- Use synthetic fixture data only. Never connect these tests to the running bus.
- Cleanup limits: these scripts run unsupervised and end Chrome only from their own
  cleanup. A script whose caller is killed keeps running; observed runs then finished
  and cleaned up, but nothing bounds a hung script or a failed cleanup. A script killed
  with SIGKILL orphans its Chrome, which Stagehand starts detached, and that Chrome's
  `stagehand-chrome-*` temporary profile; this path is unsupported. A leftover found
  by that prefix or by a parent pid of 1 is only a lead: signal a process or remove a
  profile only once it is attributed to your own run and its pid and start time were
  recorded, never by pattern, and leave anything shared or unattributed alone.
- Reopen supervision of these scripts only on an actual hang or leak from this
  repository, with the testing-design steward shaping the signal protocol first: a
  repeated SIGINT and a SIGTERM to the whole group both reach the script and its
  caller.
