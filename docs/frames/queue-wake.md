# Frame: waking desktop Codex threads through their queue

## Outcome

Mail for a Codex desktop Local thread wakes that thread within seconds, even when it is idle, with no human relay, no second writer and nothing new in the desktop app. The bus stays the record: the thread reads its mail with `bus_read`, and only that read moves its cursor.

## What it rests on

Verified live on a disposable top-level Local thread, desktop 26.1021.31345 with Codex 0.164 ([spike result](desktop-wake-spike.md#result-before-gate-0-the-supported-queue-wakes-idle-local-threads-2026-10-27)):
- An item added to a thread's queue (`~/.codex/queue_1.sqlite`) runs in the desktop within 2–6 s when the thread is open and idle: on screen, with the app in the background, or with the window on Settings.
- A thread nobody has open keeps the item until it is opened.
- The turn runs in the desktop's own app-server. The daemon never holds the thread.
- Items don't coalesce: three queued items ran as three turns.

Checked while framing (2026-10-27), on the bundled CLI 0.164.0-alpha.11.1, which both machines have at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`:
- **`codex queue` is a thin client.** It starts an app-server inside its own process and sends `thread/queue/add`. It needs no daemon: against an empty `CODEX_HOME` it set up its own state and answered in about 0.1 s.
- **The app-server protocol has the whole queue:** `thread/queue/list`, `add`, `update`, `delete`, `reorder` and `start`. All are **experimental**; they need `experimentalApi` at `initialize`.
- **Through a `codex app-server` started for the purpose** (stdio, no daemon), on an unopened thread:
  - `list` returned the queue;
  - `add` returned the item with the `clientUserMessageId` we gave it;
  - `delete` removed it;
  - the thread was never loaded;
  - each call took well under 0.1 s.
- **Adding twice with the same `clientUserMessageId` queues two items,** so the protocol doesn't deduplicate.
- **An unknown thread fails at once** with `no rollout found for thread id …` and queues nothing.
- **`serve` can't find `codex` on its own.** It runs under launchd with the default `PATH`, which has none.

## Decisions

**1. Route by where the thread runs.** Superseded by [one-codex-route](one-codex-route.md): every Codex thread now takes the queue route, and `serve` no longer connects to the daemon.

| Peer | Route |
| --- | --- |
| `codexHost: daemon`, and no other app-server has refused the daemon | `turn/start` through the daemon, resuming it if needed (unchanged) |
| `codexHost: other`, or a daemon thread whose resume was refused ("active writer") | A nudge through the thread's queue |
| A subagent on the daemon | Nothing until it rejoins (unchanged) |

An `other` thread is never sent to the daemon, even if the daemon has it loaded. Today `serve` sends `turn/start` to an `other` thread the daemon happens to have loaded; that path goes. This is a simplification, not a safety repair. A thread loaded in the daemon has no other writer, so removing the path guards against nothing. What it loses: delivery to a desktop or `codex exec` thread later opened in the TUI, and to a daemon thread whose join was classified `other` because the daemon didn't answer within 5 s. Rejoining from the daemon restores live push for both. Whether the daemon also runs queued items is checked in qualification if convenient.

**2. At most one bus nudge waits in a thread's queue.** For a queue-route peer with unread mail, under the address's delivery lock, the deliverer:
1. Skips the peer if its unread mail (first to newest message) is what it was when a nudge was last known to be waiting, as recorded per join. This saves starting an app-server on every ledger change.
2. Starts the desktop's bundled `codex app-server` on stdio and initializes it with `experimentalApi`.
3. Lists the thread's queue. If a bus nudge for this address is already waiting, it records the unread mail as covered and adds nothing: the waiting nudge will read the new mail too.
4. Otherwise adds one nudge, with a fresh `clientUserMessageId`, and records the unread mail as covered.
5. Closes the app-server: it closes stdin, kills the process if it hasn't exited, and waits for it. All of this happens before the lock is released, so an `add` can't land after a takeover.

The nudge never marks anything read: `send` returns false, and the owner's own read moves the cursor under the same lock.

What this bounds:
- **Empty turns.** At most one bus nudge is waiting at any time, so at most one empty turn follows any read. That empty turn is the case where the thread reads its mail some other way (the `Stop` hook, or a read mid-turn) before the waiting nudge runs.
- **Restarts.** The covered mark is in memory. After a restart, the listing still finds a waiting nudge, so a restart adds a nudge only for a thread that already ran its last one and hasn't read.
- **Uncertain outcomes.** A timed-out or failed `add` is retried on the existing back-off. Each retry lists first, so an item that did land is found and not added again.
- **A thread that doesn't read** (its nudged turn failed, or it ignored the nudge) is nudged again only when newer mail arrives or it reads part of its mail, so it is never left without a wake while new mail comes in.

*Alternatives:*
- **`codex queue` with an in-memory mark** (the first draft). It can't tell whether a nudge is still waiting. Reads before a nudge runs therefore stack several empty turns, and a timed-out call forces a choice between a possible duplicate and a missed wake. The owner chose list-then-add (2026-10-27).
- **A cooldown timer:** bounds nudges by time, not by reads.
- **`thread/queue/start`:** never used. It could run an item in an app-server that isn't the thread's owner.

**3. The nudge carries no sender text.** A queued item runs as the owner's own input, so message bodies, subjects and sender addresses (which senders choose freely) stay in `bus_read`'s result. The nudge names only the recipient address, quoted, and gives fixed instructions:

> [agent-bus] New messages for "codex/opa-director". Read them with the agent-bus bus_read tool, as that address with your $CODEX_THREAD_ID as session, and handle them. If bus_read returns no messages, or says the address isn't joined or belongs to another session, end this turn without replying and without rejoining. If it fails, try once more; if it fails again, say so and end the turn.

The deliverer recognises its own waiting nudge by this text's first line, which names the address.

**4. The binary and its limits.**
- **The binary** is a new `serve --codex` flag. It defaults to the desktop's bundled CLI, so the protocol always matches the desktop that reads the queue. There is no `PATH` fallback: under launchd it would find nothing, and run by hand it could pick a CLI whose experimental protocol differs. A machine without the desktop app has nothing that runs the items anyway.
- **Each request** gets 2 s, and a whole nudge (start, list, add) gets 6 s. The app-server then has 0.5 s to exit on the end of its input before it is killed and reaped. So a hung app-server holds the address's lock for under 7 s, less than the `Stop` hook's 10-second read.
- **Every failure is retried** with the deliverer's back-off (30 s doubling to five minutes), with the mail left unread. That includes "no rollout": a brand-new thread may not have its rollout yet.
- **If Codex changes these experimental methods,** the failure shows as a logged error. The `Stop` hook still delivers at turn end.

**5. Which peers.** Only Codex peers that joined from this machine with a thread id, as now; the join rule makes that id the peer's own session. Each machine's `serve` nudges its own threads through that machine's `~/.codex`, so every machine is covered by the same build, and there is no cross-machine path.

Threads that can't run the item:
- An exited `codex exec` thread, and a desktop thread no window has open, keep their one waiting nudge until opened.
- A native subagent on the desktop has its own thread, so its queue accepts the item. Whether the desktop runs it is unknown. It is checked in qualification if a subagent is at hand. Until then, "subagents are never woken" holds only for the daemon route. *Later found ([one-codex-route](one-codex-route.md)): a spawned subagent's queue refuses the add, through `serve`'s own app-server.*

**6. Fit with what exists.**
- **The `Stop` hook stays.** A busy thread gets its mail inline at turn end, and the waiting nudge then runs once and finds nothing: the one empty turn the Director accepts.
- **Classification and the guard are unchanged.** Joining still classifies by the daemon's loaded list, and the guard still never resumes an `other` thread.
- **A refused resume** (`active writer`) now leads to nudges rather than to holding.
- **The refusal is remembered only until `serve` restarts.** That limit is inherited: after a restart, a `daemon` join can again be resumed if the desktop has released the thread. It is left for the simplification pass.

**7. Trust.** `serve` can now start turns in the user's desktop threads. It does so only:
- for a Codex thread that joined an address from this machine with its own thread id;
- when that address has unread mail;
- with the fixed nudge text.

It also starts a short-lived `codex app-server` per nudge, with the user's Codex configuration. `docs/connections.md` gets this row.

## Folded into the same release

- **`bus_leave` returns `{ address }`.** It declared no success schema, so Claude Code reported "did not return structured content" for a leave that worked.
- **The instructions state how each session is woken, and the limits.** This was the Director's request: addresses and topics decide what is yours to read; how you run decides whether you are woken.
  - The join result's `codexHost` description and the CLI's join message describe the queue route.
  - The server instructions add one paragraph covering every route.

## Not doing

- No watcher service, no registration protocol, no cross-machine queue path.
- No direct access to Codex's queue database; the app-server protocol is the interface.
- No deleting of stale nudges. That would need a deliverer pass on reads, which append nothing to the ledger.
- The Director's heartbeat isn't touched. The Director retires it after one real handoff on the shipped version.
- Other loose ends go to the simplification pass: the "has not joined" warning, CLI stack traces, the daemon's thread-store conflicts, and the restart limit in decision 6.

## Known limits

- **The partial-read remainder.** After a partial read with `limit`, the remainder is nudged at the next ledger change rather than at once, since reads append nothing. The thread chose the limit, so it knows more is waiting.
- **The read-then-lost window.** The existing window where a read is marked read before its response arrives ([overview](../overview.md)) is unchanged. The bus doesn't promise exactly-once handling.

## Tests (unit, JSONL)

**The deliverer, with a fake queue.** The fake keeps per-thread items, and can be set to fail, or to accept an add and then fail anyway:
- An `other` peer with mail gets one nudge.
  - Its text names the address and none of the mail (body, subject or sender).
  - The cursor doesn't move.
  - A daemon that has the thread loaded is never called.
- **Coalescing:** more mail while a nudge waits adds nothing, and starts no app-server once the newest mail is covered.
- **After the nudge runs:**
  - The owner reads everything: nothing more is added.
  - The owner reads part (`limit`): a nudge is added when nothing is waiting.
  - The owner doesn't read, then new mail arrives: one nudge is added. Without new mail, nothing is added.
- **A read by another path while a nudge waits** (the hook), then new mail: nothing is added. That is the one-empty-turn bound.
- **Uncertain outcome:** an add that lands and then reports failure is retried after the back-off, finds the waiting nudge, and adds nothing.
- **A failing queue:** the mail stays unread and the attempt is retried on the doubling delay.
- **A restart** (fresh holds) with a nudge waiting adds nothing.
- **Leave, rejoin and takeover:**
  - after a leave, nothing is added;
  - a same-owner rejoin with a nudge waiting adds nothing;
  - a takeover nudges only the new thread.
- **Routing:**
  - a refused daemon resume nudges in the same cycle, and is never resumed again;
  - daemon threads are unchanged (the existing tests).

**The real stdio client, with a fake `codex app-server` script.** It covers initialize with `experimentalApi`, then list and add with the right parameters, an error reply, a server that never answers (stopped at the deadline and its process reaped), and a missing binary.

`bun run check` passes, and knip stays clean.

## Qualification (live, after deploy)

On a disposable top-level Local thread joined to a test address, never the Director's:
1. **Idle arrival** starts a turn within seconds. `lsof` shows the desktop's app-server holding the rollout, and the daemon never lists the thread. The thread's model and permission settings are unchanged after the nudged turn.
2. **A burst:** three messages sent before the thread reads become one nudge and one turn.
3. **The thread is closed and gets mail.** It is then read by another path and the thread opened: at most one empty turn.
4. **Hook coexistence:** mail during a busy turn is delivered inline by the `Stop` hook, followed by at most one empty turn, even with several messages arriving across hook continuations.
5. **Leave, rejoin and takeover:**
   - after a leave, nothing is queued;
   - a rejoin adds nothing while a nudge waits;
   - a takeover by another test thread nudges only the new thread, and the old thread's waiting nudge, when run, ends on the refusal.
6. **A `serve` restart** with a nudge waiting adds nothing.
7. **A failing `--codex`,** on an isolated `serve`, retries with the mail kept unread.
8. **The launchd environment:** the deployed `serve` finds the bundled CLI and nudges with launchd's environment.
9. **The Pro,** if a desktop thread is available there: idle arrival. Otherwise its desktop path is reported as unverified.
10. **Optional:**
    - a desktop subagent's nudge;
    - whether the daemon runs a queued item for a thread it has loaded.

## Qualification (2026-10-27)

Shipped in 3d10fca and deployed to both machines (02:47–02:48 UTC). Results, all verified live unless marked:

| Check | Result |
| --- | --- |
| **Idle arrival (the Director, a real desktop Local thread)** | A Claude session's message at 02:55:52 was nudged at 02:55:53, and the idle thread started a turn at 02:55:59, read its mail and resumed work without a relay. The desktop's bundled app-server (a child of ChatGPT.app) held the rollout; the daemon didn't have the thread loaded. The nudged turn ran with the same model, effort, approval and permission settings as the turns before it. The Director separately saw a nudge whose mail it had already read, and stopped silently |
| **Busy thread** | A nudge queued during a 71-minute turn waited until that turn ended. New mail during the nudged turn queued exactly one more |
| **Burst** | Three messages became one waiting nudge and one log line (a throwaway `codex exec` thread that no app has open, so items stay countable) |
| **Read while a nudge waits, then new mail** | Nothing added |
| **`serve` restart with a nudge waiting, then new mail** | No duplicate |
| **Leave, then mail** | Nothing added |
| **Same-owner rejoin** | Nothing added (the waiting nudge was found) |
| **Takeover** | Only the new thread was nudged. The old thread's waiting nudge stays, and its read is refused ("belongs to another session"), which the nudge text says to stop on |
| **A failing `--codex`** (isolated `serve`, JSONL) | Retried at 30 s, then 1 m. The real CLI's "no rollout" for an unknown thread was retried with the id redacted. Both messages were still unread afterwards |
| **launchd** | The deployed `serve` found the bundled CLI and nudged under launchd's environment on both machines |
| **The Pro** | A burst from the Mini became one nudge in the Pro's own queue, added by the Pro's `serve`. Whether the Pro's desktop runs it is **unverified** (no desktop thread there) |
| **Daemon-hosted threads and queued items** | **Verified:** a daemon thread with a client attached (as with an open TUI) ran a queued item as a turn 5.8 s after it was added, and its queue drained. A fresh thread has no rollout until its first turn, so the queue refuses it until then; that is why "no rollout" is retried. A daemon thread with no client attached is untested |
| **A desktop subagent's nudge** | Not tested |
| **The `Stop` hook beside the nudge** | Installed and trusted on the Mini. A full turn-end case on a busy thread with mail was not isolated beyond the Director's busy-turn sequence above |
