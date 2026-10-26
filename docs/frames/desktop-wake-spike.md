# Spike: waking desktop Local threads through the app's coordination socket

## Question

Which Codex desktop **Local** threads have a desktop owner, and can a same-user process get that owner to start or steer a turn, with a confirmed outcome, so the app's own app-server stays the thread's only writer?

The answer decides whether `serve` gets a desktop route, and for which threads. Three outcomes count:
- **Full go:** threads open in any window, including idle and unloaded ones, can be woken.
- **Limited go:** only threads a window currently owns can be woken; the rest fall back to the `Stop` hook.
- **No-go:** the route can't be used safely.

Every gate below ends in pass, fail or inconclusive. An inconclusive gate is reported as such, never rounded up.

## Routes

| Route | Desktop features | Wakes idle Local threads | Place |
| --- | --- | --- | --- |
| Desktop on the daemon (SSH project, `CODEX_APP_SERVER_WS_URL`) | Lost in part | Yes | Rejected |
| Codex `Stop` hook (shipped) | All | No: delivers when a turn ends | Fallback, kept |
| **Coordination socket** | All | Only for threads with an owner (to establish) | **This spike** |
| App-tools pipe (`CODEX_APP_TOOLS_PIPE_PATH`) | All | Reaches the same owner handler | Second: native peer authorization and a ready renderer make it harder, and it adds no reach |
| Persisted queue + `threads/wake/<id>` deep link (`wakeQueuedThread`) | All | Possibly, for threads with queued input | Compared statically at Gate 0: whether an outside process can enqueue, and whether waking consumes the queue automatically |
| Phone remote control | All | Yes | Not pursued: pairing and OpenAI's relay, meant for a phone |
| Deep link with a prompt | All | No: prefills the composer, needs a click | Rejected |

## Known from the code (desktop 26.1021.31345; read, not run)

Three reviewers read `/Applications/ChatGPT.app/Contents/Resources/app.asar` (`.vite/build/src-*.js`, `main-*.js`). Minified names change between builds; search by string literals.

- **Endpoint:** `$CODEX_HOME/ipc/ipc.sock`, with a legacy fallback `$TMPDIR/codex-ipc/ipc-<uid>.sock`; the legacy directory exists on the bus host. The directory is 0700 and the socket 0600; there is no peer check.
- **Framing:** a 4-byte little-endian length, then JSON (256 MB cap). `initialize {clientType}` returns a `clientId`.
- **Router behaviour:** on `initialize`, the router announces the new client to every window (`client-status-changed`) and then sends it every broadcast, including `thread-stream-state-changed` for all threads. The router doesn't check who sends broadcasts. The app's own client code (`getOrStartRouterEndpoint`, `IpcRouterManager`) unlinks a stale socket and listens itself when it can't connect.
- **Requests and versions:** `thread-owner-discovery` v1 `{hostId: "local", conversationId}`, start-turn v2, steer v1; each version is one higher when `hostId` is set. Versions must match exactly. A version mismatch during discovery comes back as `canHandle: false` and then surfaces as `no-client-found`, the same as "no owner".
- **Ownership:** the owner is a renderer window streaming the thread (`ownsThread`), not the app-server. A request goes router → client discovery → that window's follower handler → its app-server.
- **Replies and errors:** replies carry `handledByClientId`. The errors are:
  - no owner: `no-client-found`, `client-not-found`;
  - outcome unknown: `request-timeout` (10 s default, `timeoutMs` overridable), `connection-closed`;
  - unsupported: `no-handler-for-request`, `request-version-mismatch`;
  - thrown by the owner: for example "Conversation … is not being streamed".
- **Input:**
  - `responseItems` require the owner's `supportsUntrustedAppInput`, so send plain input only.
  - `clientUserMessageId` can serve as a dedupe key.
  - `inheritThreadSettings` governs the model and permissions.
  - There is a `thread-queued-followups` mechanism.

## Safety

These hold through every gate:
- **Connect only.** Write a small, bounded client. Never import or run the app's code, and never bind, unlink or chmod a socket. If connecting fails, stop.
- **One connection.** No reconnect loop.
- **Advertise no ownership.** Answer any discovery request with `canHandle: false`.
- **Discard broadcasts unread.** Log method names only, and never send a broadcast. Other threads' content arrives just by connecting, so it must be thrown away, not merely left unlisted.
- **Send only to the disposable thread.**
- **Leave everything else as it is.** Don't quit, restart or reconfigure the app, the daemon or `serve`, or edit `~/.codex`.
- **Stop on any misbehaviour,** such as a window error, an unexpected change to another thread, or the app stalling.

The owner is present for the live gates and watches at these checkpoints:
- the Gate 1 connect, since every window sees a new client;
- every send;
- closing or hiding the disposable thread's window.

The disposable thread holds no unsent draft except in the draft test. The owner archives it afterwards.

## Gates

**Gate 0 — offline (no connections).**
- Record the build fingerprint (app version, the `app.asar` hash) and every method's version.
- Write the exact frames for `initialize`, discovery, start-turn and steer. Derive the minimal valid start-turn (`request` and `context`) with plain input and a `clientUserMessageId`.
- Find how acceptance is reported: what a successful start or steer returns, and whether it carries the turn id.
- Settle the queue + wake-link comparison from the code.
- Pass: every frame is specified, and an offline check confirms the method and version table matches this build. Otherwise, fail.

**Gate 1 — connect and ownership (no mutation).**
- Find the live endpoint with `lstat` only, connect, and initialize.
- Send only `thread-owner-discovery` for the disposable thread, in each of these states:
  - the thread shown in a focused window;
  - shown in a background window;
  - its window open on another thread;
  - its window closed, with the thread still in the sidebar;
  - the window minimised;
  - the app hidden.
- Record the owner (`handledByClientId`), or the error and how long it took. This decides full, limited or no-go before anything is sent.
- Pass: at least the focused state has an owner. Fail: no state has one. Inconclusive: errors that could be version filtering; check against Gate 0's table.

**Gate 2 — idle wake.** The disposable thread is idle and owned.
- Snapshot the daemon's `thread/loaded/list`, and the desktop app-server child's PID and parentage (`ps`, `lsof`, read-only).
- Send one start-turn with a unique nonce, asking for a reply that echoes it.
- Pass needs all of these:
  - the reply correlates the request, thread and turn;
  - the rollout gains the nonce input and the echoed reply;
  - `lsof` shows the desktop child holding the rollout;
  - the daemon doesn't list the thread before, during or after;
  - the owner sees the turn arrive live, can type the next turn, and the thread's model and permission settings are unchanged.

  Missing provenance makes the gate inconclusive.

**Gate 3 — busy thread.**
- The owner starts a turn that runs a long command. Use the observed in-progress turn id rather than timing.
- Send a steer with a nonce, and separately a start-turn to the busy thread.
- Record for each:
  - whether it steers, queues or errors;
  - whether steer needs the turn id;
  - that the same turn receives it.
- Also test:
  - two distinct inputs back to back;
  - a send racing the turn's completion;
  - an unsent draft in the composer, which must survive;
  - stop still working;
  - an approval the owner answers, if the thread's policy can raise one.

**Gate 4 — edges.**
- A thread no window streams, and an unloaded one: do they load, fail cleanly, or open a window?
- A nonexistent thread id.
- A locked screen.
- A forced `request-timeout` with a small `timeoutMs`: did the turn start anyway? This tests outcome-unknown reconciliation through `clientUserMessageId` or the rollout.
- The app quit: from the code only.

**Gate 5 — fit.** Specify the desktop route in `serve`:
- **Routing:** route by owner discovery at delivery time; positive desktop ownership is required. Desktop delivery doesn't depend on the daemon being reachable.
- **Actions by result:**

  | Result | Action |
  | --- | --- |
  | No owner | Wait; the `Stop` hook delivers |
  | Transport failure | Bounded back-off |
  | Unsupported protocol or version | Disable the route and log once |
  | Permanent refusal | Hold |
  | Outcome unknown | Reconcile before any retry |

- **Delivery:** it runs inside `Bus.deliver`'s per-address lock and cursor contract. The hook's reads go through the same lock, so a message is taken once; the remaining duplicate risk is an unknown outcome.
- **Leave the owner's connection alone:** never unsubscribe or otherwise touch the owner's app subscriptions, unlike the daemon route.
- **Version drift:** a self-test checks the build fingerprint and method versions, so an app update disables the route instead of mimicking "no owner".

## Report

- Lead with full go, limited go or no-go, then each gate's pass, fail or inconclusive.
- Give the frames used, with secrets redacted and other threads' content excluded.
- Give the evidence for each gate, and what the owner saw at each checkpoint.
- Map every observed result to its action.
- List the risks: how private this interface is, and what an update breaks.
- Mark each claim verified live, read in the code, or inferred.

## On go

`serve` routes each Codex delivery:

| Thread | Route |
| --- | --- |
| Loaded in the daemon | `turn/start` through the daemon |
| Owned by a desktop window (positive discovery) | Start or steer through the coordination socket |
| Joined from the daemon, not loaded | `thread/resume`, then `turn/start` |
| Otherwise | Wait; the `Stop` hook delivers at the next turn end |

Everything shipped stays:
- **The guard and the `codexHost` classification.** They decide daemon-resume eligibility, and `other` also covers `codex exec` threads and an unreachable daemon.
- **The `Stop` hook,** as the fallback.

Then update:
- the README, which today says Local threads can't be woken;
- the hold messages and the join note, which say the same;
- the frame `codex-wake.md`;
- `docs/connections.md`: add a trust row (any same-user process can drive desktop threads and see every thread's broadcasts), and keep the SSH-to-self and override sections only as rejected options.
