# Frame: load on mail

## Outcome

A Codex thread with unread mail gets run, without a human opening it or an agent restarting it. Waking takes two acts, and the bus now does both:
1. **Post:** `serve` adds one nudge to the thread's queue, unchanged from [queue-wake](queue-wake.md).
2. **Load:** `serve` asks this machine's Codex daemon to load the thread.

The writer lock decides who runs the nudge:
- **A runner with a queue service already holds the thread** (the desktop app's server, or the daemon). The load is refused or simply attaches, and that runner runs the nudge on its own poll. A desktop thread runs it with all its tools.
- **Nothing holds it.** The daemon borrows the thread, runs the nudge, and lets go 5 s after the thread goes idle.
- **Anything else** (a running `codex exec` holds the lock but never reads its queue; a load fails): `serve` tries again on a back-off schedule until the mail is read.

## The problem

Since [one-codex-route](one-codex-route.md), `serve` only posts. A queued nudge runs only where a server has the thread loaded, and nothing in agent-bus loads one. So a thread loaded nowhere keeps its mail until a human opens it in an app. That happens to:
- **A desktop Local thread** after 3 quiet hours off screen, once it falls out of the desktop's 10 most recently used, or after an app restart. The Director is one.
- **A TUI or SSH-project thread** once the daemon unloads it: 300 s after its last client leaves, since the owner set `thread_unload_delay_secs = 300`.
- **An exited `codex exec` thread,** always.

one-codex-route accepted "no headless resume" as a cost, because the daemon had been seen holding threads for hours. Back then, a resume held the thread for the full unload delay (1800 s) and retried until the desktop let go. A per-load release, verified below, makes a resume a short borrow.

**The incident this must not repeat** ([codex-wake](codex-wake.md)):
1. The desktop app restarted.
2. Four seconds later, the old deliverer resumed a desktop thread in the daemon and started a turn there.
3. The restarted desktop was refused, and the owner's window locked: "open in another app", no input.

The daemon then held the thread for the full delay. That led to the rule "the bus never loads a thread", and to the goal that the owner can always see and type into the threads they work in.

A borrow can land in the same gap: when the desktop has let a thread go, the daemon takes it. What changes is how long that lasts. The owner is locked out of a thread only while the bus's work runs in it: the borrowed turns, then 5 s. Decision 6 rules out the borrowed turn that could wait indefinitely, one blocked on an approval. That is a deliberate trade of a brief lockout, measured in turns, for never having to reopen threads by hand.

## What it rests on

The platform facts are in [Codex hosting](../architecture/codex-hosting.md) and the investigation behind it.

- **One program, one loader.** Every Codex server is the same program, `codex app-server`, and any of them can load any thread stored in that machine's `~/.codex`. A writer lock per thread allows one loader at a time, and loading a thread drains its queue. (Live, Codex 0.164.0-alpha.11.1.)
- **Only the desktop's own server has desktop features.** Neither the daemon nor any server we start can get them. (Live and in code, desktop 26.1021.31345.)
- **The desktop's hold isn't ours to set.**
  - Its UI keeps on-screen threads, and releases others after 3 h, or once they fall out of its 10 most recently used. That rule is hard-coded.
  - Its wake link holds a thread until the app restarts.

  (In code; the link's hold was seen live for over 34 min.)
- **`codex exec` has no queue service.** It holds the writer lock while it runs, but nothing in it reads the queue. (In code, 0.164: exec doesn't depend on `ext/queue`.)
- **The managed daemon's lifecycle** (in code, 0.164):
  - `daemon start` runs the managed package at `~/.codex/packages/app-server-daemon/current/bin/codex`. It installs that package from the invoking CLI only if none is present, and a CLI with no package manifest can't install it.
  - A started daemon runs an update loop, on by default. A version change restarts the daemon, which reloads its threads under the global delay, not a borrow's 5 s.
  - `bootstrap` installs no login item or launchd job.
  - The daemon raises its own soft file limit to 4096.

  So the older docs claim that "a running daemon never updates itself" is wrong for managed daemons. The other machine's 0.165.0 daemon probably came from this loop.

The design was checked live on 2026-10-27, on throwaway threads, with the bus host's daemon (Codex 0.164.0-alpha.11.1). The other machine's daemon (0.165.0) was read in source only.

| Check | Result |
| --- | --- |
| Cold borrow: an exited `codex exec` thread, a private-server thread, a daemon thread | The daemon took the lock about 0.4 s after `thread/resume`. The queued item ran as its own turn, and the lock went 5.0–5.3 s after the turn ended. Another server could resume the thread at once. Model, effort, cwd and approval policy were kept |
| The desktop holds the thread | Refused in 7 ms with "already has an active writer". The desktop's poll ran the item in about 8–10 s. Window order and the frontmost app didn't change |
| Two nudges, 2 s or 0.2 s apart, or both queued before one borrow | Each ran once, in order, as its own turn. Nothing was lost or doubled |
| A resume at the moment of release | "thread … is closing; retry thread/resume after the thread is closed", seen once in 30 tries. A retry 52 ms later succeeded |
| The 5 s override with a client attached | Ignored while a client is attached. The thread kept the global 300 s after a TUI-like client left. If the client had already left and the thread was idle, a borrow rebuilt it, and it went about 11 s after the client left instead of about 300 s |
| An approval request with no client attached | The turn waited, holding the lock, for the 150 s watched, with no timeout in the code. A later subscriber saw the replayed request and could answer it. Under `never`, the action failed at once and the turn finished |
| A borrowed thread's sandbox | A thread started with the older `sandbox: "workspace-write"` setting resumed with the daemon's `config.toml` default, here full access. Read-only threads, and threads started with the `":workspace"` profile (the desktop's Auto mode), kept their sandbox. The code is unchanged in 0.165 |
| `bus_read` and `bus_publish` on a sandboxed, approve-on-request daemon thread | No approval asked |
| The other machine, from the 0.165.0 source | `thread/resume` accepts `excludeTurns` and `config`. The override rule and the closing text are the same |

## Decisions

**1. A borrow follows every post, outside the lock.**
1. **Under the address's lock**, through its own short-lived app-server, `serve` lists the thread's queue, adds the nudge if none of ours waits, and reads the thread's stored permissions (decision 6). None of this loads the thread. It ends that app-server before the lock is released, as today, so a late add can't land after a takeover.
2. **Then, outside the lock**, if the thread is eligible (decision 6), it connects to the daemon's control socket: WebSocket JSON-RPC, `ws+unix://~/.codex/app-server-control/app-server-control.sock:/rpc`. It sends `initialize`, then:
   ```json
   { "method": "thread/resume",
     "params": { "threadId": "<thread>", "excludeTurns": true,
                 "config": { "thread_unload_delay_secs": 5 } } }
   ```
   then `thread/unsubscribe`, and disconnects.
3. It sends nothing that starts or steers a turn, and never waits for a turn.
4. The whole borrow has a deadline of 15 s, plus 10 s when the daemon has to be started, so a hung daemon can't stall every other peer.
5. A nudge that was found waiting is handled the same as one just added: the lock makes the borrow idempotent.

A borrow can run after a takeover, a rejoin or a leave. Its result applies only to the join that was nudged, so a stale result can't hold off the new owner. The cost is one turn in the old thread, whose `bus_read` is refused. The borrow still takes the writer lock for that turn, and runs anything else waiting in that thread's queue.

**2. The lock is the check.** `serve` never asks whether a thread is loaded; it asks the daemon to load it, and reads the answer:

| The daemon's answer | Meaning | What `serve` does |
| --- | --- | --- |
| OK | The daemon has the thread: cold, or already held | Mark the attempt (decision 5) |
| "already has an active writer" | Another process holds it: the desktop's server, whose poll will run the nudge, or a running `codex exec`, which won't | Mark the attempt. Decision 5's retry covers the `exec` case once it exits |
| "is closing; retry…" | It is being released at this moment | One retry after 1 s; if that fails too, back-off |
| "no rollout found", "session is archived" | The thread can't be loaded | Back-off, as today |
| The socket is missing or refuses the connection | No daemon | Decision 3 |
| No answer within the deadline | A wedged daemon | Back-off, with a warning |

A "wait one poll, then resume" rule was rejected. It is itself a check whose answer can go stale, and it adds latency. A queued item also stays queued while its thread is busy, so a waiting nudge doesn't mean the thread is loaded nowhere.

**3. `serve` starts the daemon if it isn't running.**
1. When the socket is missing or refuses, `serve` runs `<codex> app-server daemon start`, with the CLI it already uses for the queue.
2. It waits up to 10 s for the socket, then retries the borrow once.
3. If that fails too, the attempt backs off unmarked.

This starts whatever managed package that machine has installed, with its update loop; Codex's update behaviour is left as Codex ships it. Qualification records, on both machines, which binary and version actually start. If a machine has no managed package and its CLI can't install one, that is a deploy prerequisite: the deploy installs the package, rather than leaving it to a borrow.

**4. Releases.**
- **Per borrow:** each borrow carries `thread_unload_delay_secs: 5`. That is 5 s after the thread is both idle and unsubscribed. Mail arriving mid-turn queues another turn before the idle point, so a run of mail keeps the daemon holding until it stops.
- **Global:** the global `thread_unload_delay_secs = 300` stays as the owner's preference for threads a human loads. It also applies after a daemon restart or update reloads threads.
- **Not 0:** unload and queue dispatch fire on the same idle event and would race.
- **Threads a human holds:** a borrow doesn't change them while a client is attached. It shortens the release of a thread the human has already left, idle in the daemon, from up to 300 s to about 5 s after the borrowed turn. That costs a cold reload of about a second next time.

**5. Attempts and retries (choice b, repaired).**
- **What the mark records.** The unread-span mark means "a nudge was posted or found, and the daemon answered the borrow with OK or 'active writer'". It doesn't mean the mail was delivered or read. A failed borrow leaves the span unmarked, and the 15 s tick (`changes` merges a 15 s timer) tries again under the existing back-off.
- **Reconciling.** While a marked span stays unread, `serve` reconciles it again 5 min, then 15 min, then 60 min after the last attempt, and every 60 min after that:
  - if our nudge still waits, it borrows again;
  - if the nudge is gone, it posts a new one and borrows.
- **Stopping.** Reconciling stops when the owner reads, the mail changes, or the thread leaves or rejoins. After the third reconciliation, `serve` logs a warning once per span.

This covers a borrowed turn that crashed or failed before reading, a daemon update mid-turn, `bus_read` failing, and the `exec` that held the lock. The cost is at most one extra turn an hour, and only for a thread whose mail stays unread. The rejected choice (a) left such mail until a human acted.

**6. Only threads that can't block, and can't widen, are borrowed.**
- **Where the permissions come from.** No Codex call reports a thread's stored permissions without loading it: `thread/read` has no such field (0.164, in code and live). A resume takes them from the thread's rollout, its session file: the latest `turn_context` or `thread_settings_applied` record. `serve` reads that same record. It gets the file's location from `thread/read`'s `path`, and reads backwards from the end until it finds the record.
- **Eligible:** the record's approval policy is `never`, and its permissions are ones a resume keeps:
  - a named profile, such as `:danger-full-access` (the owner's default) or `:workspace`; or
  - full access (a `disabled` profile); or
  - a managed profile with no entries for specific paths, which is read-only.
- **Not eligible:** any other approval policy, which could wait on an approval with no end. Also a managed profile with entries for specific paths: the older `workspace-write` setting, which a resume drops for the daemon's default.
- **Fails closed:** a missing path, an unreadable file, no record, or a shape `serve` doesn't recognise all count as not eligible.
- **An ineligible thread** still gets its nudge, which runs wherever it is loaded. `serve` doesn't borrow it, and logs once per join why it can't be woken unattended.

`serve` passes no permission settings on the borrow. A resume persists the settings it applies at once, before any turn (seen live: the widened profile was recorded right after the resume), so anything passed would outlive the borrow.

Reading the rollout ties `serve` to Codex's record format; that is a Codex gap, since no API reports the field. The rule mirrors Codex 0.164's resume code (`persisted_resume_settings.rs`, and the profile filter in `core/src/config/mod.rs`). Qualification checks it on both machines' versions, and the platform docs pin it to them.

**7. Threads: guidance in the docs, not code.**
- Long-lived collaborators start in the desktop, the TUI, or by `thread/start` on the daemon, under full access or `never`.
- `codex exec` is for one-shot jobs. A delegate that joins the bus leaves it when its job is done; otherwise decision 5 keeps waking it.
- To reach a thread the daemon is running, attach from a terminal with `codex resume --remote` (see [codex-wake](codex-wake.md)), or Retry in the desktop once the run ends. Use Retry, not Fork, which splits the thread.

**8. What goes.**
- **The "never" policy:** "`serve` never loads, resumes or starts a turn in a Codex thread, and never connects to the Codex daemon" goes, in [delivery](../architecture/delivery.md) policy 7, [connections](../connections.md), Codex hosting ("the bus must never load a thread"), the README, the overview and repo memory. In its place: "`serve` loads a thread only to run its own queued nudge, through the daemon; the lock rules out a second writer".
- **The old cost:** one-codex-route's accepted "no headless resume" is superseded.
- **The open items:** the overview's wake-link and `codex exec` items are closed.
- **Wrong platform claims:** "a running daemon never updates itself", and Codex hosting's "when a nudge doesn't run", are corrected.
- **The mark's old meaning:** the delivery page's unread-span paragraph is rewritten to decision 5.
- **Code:** nothing else in it is a stand-in. The queue post, list-before-add, the subagent refusal and the back-off all stay. The old daemon client (`44e9d13^`) is restored only as transport, without steering, classifying joins, or marking read on delivery.

**9. Docs.** The owner asked for this in the same release, as its own step. Platform facts move to `docs/platforms/codex.md`, `claude-code.md` and `fluree.md`, each fact with its version and basis, and only what agent-bus rests on. `docs/architecture/` keeps agent-bus's decisions, and links to those facts. The Codex page carries:
- the server matrix: the desktop's server, the daemon, private servers, `codex exec`;
- the writer lock and the queue;
- unloading, and the desktop's hold rules;
- what desktop features need;
- the wake link;
- approvals and sandboxes on resume;
- the managed daemon and its updates;
- `codex exec` as one-shot, with no queue service.

The future skill is out of scope.

## Rejected

- **The desktop's wake link,** alone or tried first. It holds a thread until the app restarts, which shuts out the daemon and the other machine's SSH projects. It also keeps a sticky retry set, and it is private and undocumented.
- **The desktop as every thread's runner.** Its only way to load a thread is the wake link.
- **Loading in `serve`'s own app-server, or with `codex exec resume`.** The bus would become the turn's writer, tied to a process meant to exit.
- **Sorting threads by origin at join.** The lock, decision 6 and decision 5 cover every case.
- **Passing `approvalPolicy: "never"` on the borrow.** It would persist into the thread.
- **Supervising borrowed turns:** staying subscribed and interrupting on an approval request. Decision 6 makes the blocking case ineligible instead, at far lower cost.
- **A hard time limit on borrowed turns.** It would mean interrupting turns, which is the steering the bus gave up. Eligible turns end on their own.
- **Reverting the global delay to 1800 s.** Waking no longer depends on it.
- **`daemon bootstrap` at install.** It adds nothing at login, and starting on demand also covers a daemon that dies.

## Known limits

- **A cold-borrowed desktop thread runs without desktop tools.** If the Director ever needs desktop tools on an unattended wake *and* takeover from SSH or the TUI, no route gives both: that is a Codex gap.
- **The lockout is a run of turns, not a fixed time.** While the bus's work runs in a thread the desktop let go, the desktop shows "open in another app". Whether its Retry fires by itself is unverified.
- **Ineligible threads aren't woken while loaded nowhere.** That covers sandboxed `on-request` threads and the older `workspace-write`. Their mail waits, as it does today.
- **A wedged daemon,** whose socket answers but whose requests time out, backs off and warns. It needs restarting by hand.
- **A daemon update during a borrow** reloads the thread under the global 300 s.
- **Daemon turns post no desktop notification.**
- **The daemon's socket has no authentication.** Its directory is 0700 and the socket 0600: the same boundary as `~/.codex`.
- **Eligibility reads Codex's rollout format.** If a Codex update changes the record, `serve` stops borrowing and warns once per join, which leaves threads as they are today. A Codex API field for stored permissions would remove the dependency.

## Qualification

**Before building,** check live on throwaway threads that `thread/read`, from a short-lived app-server that loads nothing, reports the stored sandbox and approval policy decision 6 needs. Cover full access, `never` with read-only, the `":workspace"` profile, the older `workspace-write`, and `on-request`. If it doesn't, decision 6 is reframed before any code is written.

*Result (2026-10-27, 0.164.0-alpha.11.1):*
- **`thread/read` reports no permissions,** in code and live. Decision 6 was reframed to read the rollout's latest settings record.
- **That record separates every case,** across 15 throwaway rollouts from the investigation: `never` and `on-request`; read-only, the older `workspace-write`, and `:workspace`; and threads before and after a widening borrow.
- **Both Codex peers on the bus** (the Director and one subagent) are stored as `never` with the named profile `:danger-full-access`, so both are eligible.

**Unit tests**, with a stand-in daemon and queue:
- every answer in decision 2, including "active writer" from an `exec` holder followed by a later successful re-borrow;
- the start on demand, within its deadline;
- the closing retry;
- decision 5's mark and reconcile schedule, including a lost response and a stale result after a rejoin;
- decision 6's eligibility, with no borrow for an ineligible thread;
- no borrow for a refused (subagent) join;
- cursors moving only on the owner's read.

**Live, after deploy**, on throwaway threads and `qual/*` addresses on both machines:
1. A cold `codex exec` thread, a released private-server thread and a released daemon thread are each woken by mail and read it with `bus_read`. Each is released about 5 s after it goes idle, with its permissions unchanged.
2. **A disposable desktop Local thread,** which the owner creates in the app: once the desktop has let it go, mail wakes it on the daemon. The desktop retakes it with Retry; record whether Retry was needed. While the desktop holds it, the desktop's poll runs the nudge and the daemon is refused, with nothing visible.
3. A running `codex exec` holding the lock: no wake while it runs, and a wake after it exits, within the schedule.
4. Continuous mail (several messages, a few seconds apart, to a borrowed thread): each is read, and the thread releases once the run ends.
5. A human-held daemon thread with a client attached is unaffected.
6. An ineligible thread (on-request, sandboxed) is not borrowed, and the log says so once.
7. The daemon down: on a machine where it has no threads loaded, and with the owner's go-ahead, stop it. Mail starts it; record the binary, version and file limit, and confirm the wake. Then restart `serve` and confirm the daemon outlives it.
8. A failed turn: a borrowed turn that ends without reading is reconciled on the schedule.
9. The Director: record its stored permissions. After the release, see that the next real mail wakes it once the desktop has let it go. This is observed, not provoked.
10. `serve`'s log: borrows and reconciles follow decisions 2 and 5, with no warning beyond those expected.

## Reviews

Astra (max) and Fable reviewed the first draft, after the live check. Both picked decision 5(b). Accepted:
- **The lockout bound was overstated** (both). A release starts only after the thread is idle and unsubscribed. An approval wait has no end, and a run of mail keeps the hold. The outcome now says "a run of turns", and decision 6 removes the indefinite case.
- **Permissions were left to documentation** (Astra). A borrow widened the older `workspace-write`. Eligibility is now decided before loading. Passing `never` on the borrow would persist it (Fable), so nothing is passed.
- **"Active writer" doesn't mean the holder will run the nudge** (Fable). A running `codex exec` holds the lock with no queue service. Decision 5's reconciling covers it.
- **`daemon start` runs the managed package, and it auto-updates** (Fable, from the 0.164 source). Decision 3 and "What it rests on" now say so, and the wrong doc claim goes.
- **The borrow needs a deadline** (Fable). It has one now.
- **The mark's meaning, and stale results across joins** (both). Decisions 1 and 5.
- **(b) as first written missed a nudge left waiting after an "active writer"** (Astra), **and stopped for good after 60 minutes** (Astra). Reconciling now re-borrows or re-posts, every 60 min until the mail is read.
- **Qualification gaps** (both): a real desktop Local thread, an `exec` holder, continuous mail, Retry, the daemon start and its outliving `serve`, an ineligible thread, a failed turn.

Fable's suggestion to move the docs split to its own frame was not taken: the owner asked for it in this release. It is decision 9, a separate step that is now scoped.
