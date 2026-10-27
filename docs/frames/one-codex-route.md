# Frame: one Codex wake route

## Outcome

Every Codex thread is woken the same way: one nudge in its own queue ([queue-wake](queue-wake.md), decisions 2–4). `serve` no longer connects to the Codex daemon. It doesn't classify threads at join, resume them or start turns in them.

The owner's goals then hold the same way for every Codex thread:
- **Waking:** a top-level thread that some app-server has loaded (the desktop's, or the daemon's) is woken within seconds when idle.
- **No second writer:** none, by construction.
- **Empty turns:** at most one empty queued turn per address.
- **Reading:** no message is marked read except by the owner's read. This was never true for daemon threads, whose mail was marked read when the daemon accepted the turn.

## What it rests on

Verified live 2026-10-27 on throwaway threads, Codex 0.164.0-alpha.11.1 on one machine. The item was added through a stdio app-server of its own, as `serve` does.

| Thread | What the queued item did |
| --- | --- |
| On the daemon, with a client attached (an open TUI) | Ran as a turn 5.8 s after the add; the queue drained (earlier result) |
| On the daemon, its only client unsubscribed and disconnected (a closed TUI) | Ran within 15 s (the first 15-second check), as user input; the queue drained |
| On the daemon, idle with no client for hours | Still loaded; ran within 15 s |
| Loaded nowhere (an exited `codex exec` thread) | Stayed queued for the 45 s observed; ran at once when a client resumed the thread on the daemon |
| On the daemon, mid-turn | Not steered into the running turn: ran as its own turn the moment that turn completed |
| A spawned subagent | `thread/queue/add` is refused: "direct app-server input is not allowed for unloaded spawned sub-agents". The daemon still refuses `turn/start` for it, too |

Also seen:
- **Latency:** 5.8 s with a client attached and within 15 s without, against 2–6 s in the desktop. The daemon's `thread/queue/changed` came 10 s after an add made mid-turn, which suggests it polls. These are healthy-path observations, not a bound: end to end there is also the ledger's change detection (Fluree's stream, with a 15-second poll behind it) and any back-off.
- **The daemon kept a thread with no clients loaded for hours,** against the 30 minutes in Codex's docs. How often threads unload in practice isn't measured.
- **The `Stop` hook ran** at the end of the queued turn in the daemon thread.

Since the queue route shipped, every Codex wake on both machines has been a queue nudge. The last daemon deliveries were to the Director, before it moved to the queue.

## Decisions

**1. One route for every Codex peer.** A Codex peer that joined from this machine with its thread id gets the queue nudge, unchanged from queue-wake: list, then add one fixed nudge if none of ours waits, with an in-memory unread-span mark, 2 s per request, 6 s per nudge, and the app-server ended before the address's lock is released.

What goes:
- `connect` (the WebSocket client for the daemon's socket), `defaultSocket` and `serve --codex-socket`;
- classification at join (`ThreadHosts`, which held each Codex join for up to 5 s), and `thread/loaded/list`;
- `thread/resume`, `turn/start` and `thread/unsubscribe`;
- the `elsewhere` hold and the refused-resume path (`active writer`);
- marking read on delivery. `Bus.deliver` hands the deliverer the unread mail under the address's lock and marks nothing read. Only `take`, the owner's read, does.

What stays, each for a failure that still exists:
- **The stdio JSON-RPC client:** reply correlation, close handling, and ignoring server requests that reuse an id.
- **Ending and reaping the app-server before the lock is released:** a timed-out add can't land after a takeover.
- **List-before-add:** an add that timed out but landed, a restart, and the `Stop` hook all leave one nudge, not a stack.
- **The in-memory unread-span mark:** saves an app-server per ledger change and avoids repeated turns for mail the thread won't read. It is suppression, not knowledge that a nudge still waits. If the nudge runs without a successful read (`bus_read` failed twice, say), or someone deletes it, the same unread mail is not nudged again until newer mail arrives, the owner reads part of it, the thread rejoins or `serve` restarts. The mail stays unread and readable; the bus promises an attempt to wake per unread span, not that the mail gets read.
- **The back-off,** for a missing CLI, a missing rollout, or a changed protocol.
- **The `refused` hold for subagents** (decision 4).

**`Bus.deliver` hands over mail without marking it read.** It reads the subscriber's unread mail under the address's lock and passes it to the nudge; `take`, the owner's read, is the one path that acknowledges. One exception stays. When nothing in the batch is for the subscriber, `deliver` moves the cursor past those entries: presences, the subscriber's own sends, and messages addressed elsewhere. The owner's own read would pass over exactly the same entries under the same lock. Without this, every Codex peer with no mail would re-read the ledger from its join point on every change, and that would grow without bound. Both reviewers asked for it to go, so that "only the owner's read moves its cursor" would hold literally. It stays for this reason, and the invariant is stated as "no message is marked read except by the owner's read".

**2. What changes for daemon threads** (the `codex` TUI, desktop SSH projects):

| Daemon thread | Before | After |
| --- | --- | --- |
| Idle, loaded (open TUI, or a closed one the daemon still holds) | Mail as a turn at once | A nudge, seen running within 15 s; the thread reads its mail with `bus_read` |
| Busy | Mail steered into the running turn | Mail as its own turn after the current one, or inline at turn end from the `Stop` hook where it is installed and trusted |
| Loaded nowhere (after a daemon restart, or unloaded for any reason) | Resumed headlessly and given the mail | **The nudge waits in its queue and the mail stays unread until the thread is reopened** (in the test, reopening ran it at once) |
| Cursor | Marked read when the daemon accepted the turn | Marked read only by the thread's own read |
| What the machine needs | The daemon's socket | A queue-capable Codex CLI for `serve --codex` (by default the desktop's bundled one), run as the same user with the same Codex home, on the machine that owns the thread. For a desktop SSH project, that is the SSH host |

The "before" column applies only to joins classified `daemon`. A join made while the daemon couldn't be reached was classified `other` and already took the queue route, as did `codex exec` threads.

The costs accepted, all for daemon threads:
- slower idle wake (within 15 s observed, rather than at once);
- no mid-turn steering;
- no headless resume of a thread nothing has loaded;
- a dependency on a queue-capable CLI, whose experimental protocol must match the daemon's.

The owner works in desktop Local threads, which never had steering or headless resume. Nobody is getting daemon deliveries now: every wake on both machines since the queue release has been a nudge.

**3. No second writer, by construction.** `serve` never loads, resumes or starts a turn in any thread, and its only app-server is its own stdio one, which lists and adds without loading the thread. The guard against resuming a thread another app-server runs therefore has nothing left to guard, and the memory constraint for it is replaced by this one.

**4. Subagents.** A spawned subagent's queue refuses the add. The refusal begins "direct app-server input is not allowed", as the daemon's did, so the existing check still matches it. The deliverer holds that join as refused and logs once. It doesn't retry for that join while `serve` runs; a rejoin or a restart tries once more. The subagent's mail stays unread for `bus_read`. `serve`'s app-server has every spawned subagent unloaded, so this should hold for desktop subagents too, but that is inferred from the message, not tested.

**5. Compatibility: wire- and storage-compatible with the previous release.**
- **`codexHost` leaves the schemas** (`Presence`, the join result). Effect 4.0.6 strips excess keys by default, and both stores decode presences through the same `MessageJson` (Fluree from `bus:json`), so old entries decode. Unit tests pin an old nested presence and an old join result. New joins write none, and `bus_peers` never exposed it.
- **Clients:** the advertised output schema still requires only `address` and `cursor`, and allows more. Older CLIs print the plain join message, and the new CLI now always does. It used to describe the wake route, which an older `serve` could contradict.
- **Mixed versions are compatible but not equivalent.** An older `serve` still sends its persisted `daemon` joins `turn/start`. The guarantees above hold once both machines' `serve` processes are replaced, which qualification checks.

**6. `formatDelivery` stays where it is,** for `agent-bus wait` (Claude sessions) and the `Stop` hook; its comment no longer says it is a Codex turn's input. The reviewers split on moving it: Sol would move it now, Astra calls the location cosmetic. It moves when step 2 settles its users.

**7. Trust narrows.** `serve` no longer opens the daemon's socket, which gives full control of every thread the daemon can load. Its only reach into Codex is a stdio app-server sent `thread/queue/list` and `thread/queue/add`.

**8. Docs.**
- **`docs/connections.md`:**
  - the `serve`-to-daemon row goes;
  - "What `serve` may do" states the queue-only reach;
  - "Running the desktop app on the daemon" goes. It existed so the bus could wake desktop threads live, which the queue does for Local threads;
  - "Operating the daemon" shrinks to what still matters for TUI and SSH threads: the CLI and Codex-home prerequisite, the open-file limit, and that a daemon restart unloads threads, whose nudges then wait until they are reopened.
- **README:** the wake section describes one route, and the table says when each kind of thread is woken.
- **`docs/overview.md`:** updated, with question 1 answered.
- **The older frames:** [codex-wake](codex-wake.md) is marked superseded, and queue-wake's decisions 1 and 5 point here.

**9. Smaller fixes in the same code.**
- **The queue listing follows every page.** It read only the first 100 items, so a waiting nudge further down could be missed and another one added.
- **`initialize` always asks for the experimental methods.** Its mode flag served only the socket client, and the identity wrappers are gone.
- **A peer that leaves between the deliverer's listing and its lock is skipped quietly.** This was the "has not joined" warning after a leave.

## Not doing

- **`thread/queue/start`.** It would run the item in `serve`'s own app-server, making it a second writer.
- **Resuming unloaded threads** by any other means. That is the accepted cost in decision 2.
- **Retiring the `Stop` hook.** That is step 2, which comes after this is live and with the owner's agreement.
- **Moving `formatDelivery`** (decision 6).

## Known limits

- **The empty-turn bound is per address.** A thread that owns two addresses can have two nudges waiting, and so two empty turns if the `Stop` hook reads both inboxes first. A per-thread bound would need coalescing across addresses; nobody runs two addresses from one thread today.
- **A queued item of an unknown shape reads as no text,** so if Codex changed the item format, a waiting nudge could go unrecognised and a second be added for the next unread span. The mark still limits this to one per span.
- **The read-then-lost window** ([overview](../overview.md)) is unchanged.

## Qualification

Unit tests:
- a nudge never marks mail read, and with nothing for the subscriber it passes over only what isn't its mail;
- every page of a queue listing is read;
- a server request that reuses a pending id isn't taken for the reply;
- a subagent's refused add holds that join, keeps its mail unread, and is retried after a rejoin;
- the back-off doubles to five minutes;
- old nested presences and old join results decode.

After deploy, with throwaway threads and test addresses:
1. **Daemon thread, client attached:** mail gets one nudge and the thread's own read, and only that read marks it read.
2. **The same thread after its client unsubscribes and disconnects:** it is woken.
3. **A busy daemon thread:** the mail comes as its own turn after the current one.
4. **A daemon thread nothing has loaded:** the nudge waits and the mail stays unread, until the thread is resumed.
5. **A desktop thread, as a regression check:** woken as before.
6. **A Codex join:** it returns at once, with only `address` and `cursor`.
7. **Both machines:** each runs the release, and the running `serve` has no connection to the daemon's socket (`lsof`).
8. **The Director,** observed as a real user: woken as before.

Reviews: GPT-6 Astra and GPT-6.1 Sol both found the frame sound with changes. This revision takes their changes, except for removing the empty-batch skip (decision 1, with the reason).
