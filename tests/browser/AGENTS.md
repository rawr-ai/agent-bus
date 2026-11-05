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
- Fixture lanes use synthetic data only; never point them at the running bus.
  The explicitly opt-in `test:browser:live` check in the [viewer runbook](../../docs/runbooks/viewer.md#verify-the-viewer)
  reads an already-running loopback viewer without starting or stopping it or the bus.
  Keep real content in the page: report only structural flags, counts and timing, never raw content or screenshots.
- Cleanup limits: these scripts run unsupervised and end Chrome only from their own
  cleanup. A caller's death does not cancel the script: observed runs carried on
  through their remaining browser journeys and only then cleaned up, and nothing
  bounds a hung script or a failed cleanup. A script killed with SIGKILL orphans its
  Chrome, which Stagehand starts detached, and that Chrome's `stagehand-chrome-*`
  temporary profile; this path is unsupported. A leftover found by that prefix or by
  a parent pid of 1 is only a lead: signal a process or remove a profile only once it
  is attributed to your own run and its pid and start time were recorded, never by
  pattern, and leave anything shared or unattributed alone.
- Reopen supervision of these scripts only on an actual hang or leak from this
  repository, or a need for browser actions to stop as soon as their caller dies,
  with the testing-design steward shaping the signal protocol first. That design must
  handle a signal that can reach both the script and its caller, such as a terminal's
  repeated SIGINT or a SIGTERM to the whole process group.
