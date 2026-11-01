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
