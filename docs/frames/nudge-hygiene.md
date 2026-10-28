# Frame: nudge hygiene

## Outcome

[load-on-mail](load-on-mail.md) wakes Codex threads with mail, including threads loaded nowhere. Its qualification found three ways the wake costs more than it should, or achieves nothing. This release closes them, and finishes two checks that qualification couldn't make.
1. **No empty turn after a rejoin.** A woken thread that calls `bus_join` before reading doesn't get a second nudge.
2. **Fewer empty turns after a mid-turn read.** When a thread reads its mail some other way while our nudge waits (a `bus_read` or `bus_wait` in a running turn), `serve` takes that nudge back out of the queue if it can.
3. **No pointless borrows of interrupted threads.** A thread whose last turn was interrupted isn't borrowed, since Codex won't run its queue. The log says why, once per run of joins and reason.
4. **The checks still open:** `serve` starting the daemon itself, live; and the 15- and 60-minute reconciles.
5. **A sandboxed thread can join without approval.** Takeover moves out of `bus_join` into its own tool, so `bus_join` no longer says it is destructive.

Nothing here changes which threads can be woken, or adds a way to start or steer a turn. Decision 2 adds one new write, removing a nudge of our own, which the owner approved (see [Policy](#policy-for-the-owner)).

## The problem

Each of these was seen live on 2026-10-28 (Codex 0.164.0-alpha.11.1 on the bus host; 0.165.0 daemon on the other machine). The evidence is in load-on-mail's qualification results.

**Rejoins.**
- Several borrowed turns called `bus_join` before `bus_read`, though the nudge asks only for a read.
- A rejoin is a new join, and the deliverer keeps its wake state per join (`Hold.joinId` in `src/codex.ts`). So the next cycle saw a new join with unread mail and queued a second nudge, which later ran as an empty turn.

**Mid-turn reads.**
- The Director reads mail inside its own turns: `bus_read` at the start, then `bus_wait` loops.
- Mail that arrives during such a turn gets a nudge, which waits behind the running turn. The turn reads the mail itself, and the nudge runs afterwards as an empty turn.
- Seen at 00:45 on 2026-10-28: the Director read the close-out note 7 s into a turn, while the nudge for it waited.

**Interrupted threads.**
- How Codex treats them:
  - Codex's queue dispatches nothing while a thread's status is `Interrupted` (`ext/queue/src/service.rs`).
  - A resume sets that status when the last persisted status event in the resumed history is a `turn_aborted` with reason `interrupted` or `budget_limited` (`core/src/session/mod.rs`, `agent/status.rs`; [platforms: Codex](../platforms/codex.md#an-interrupted-thread-runs-no-queued-input)).
- Where it came up: the owner's Stop, quitting the desktop mid-turn (as happened to the Director), and a `codex exec` run exiting 2 s into the nudge it had taken.
- What it costs:
  - Each reconcile then borrows the thread, loads it, writes a settings record, runs nothing and lets it go.
  - The log claims the daemon "loaded its thread to run it".
  - The third-reconcile warning gives no reason.

**Joins outside full access.**
- Codex 0.164 asks approval for an MCP call, or refuses it under approval policy `never`, unless the thread has full access, the server is set to approve, or the tool says it is read-only, or neither destructive nor open-world (`core/src/mcp_tool_call.rs`, `requires_mcp_tool_approval`; `codex-mcp/src/mcp/mod.rs`).
- agent-bus's tools say so, except `bus_join`, which says it is destructive because its optional `takeover` replaces another session's hold ([connections](../connections.md#approval-in-codex)). So a read-only thread under `never` can read and answer its mail, but can't join or rejoin itself. Seen while setting up this release's persistent reviewers: a read-only Codex reviewer would have needed the coordinator to join it.

**Open checks.**
- `serve` starting the daemon never ran live. On the bus host, a desktop SSH project from another machine restarted the daemon within 5 s of each stop.
- Item 8's address was freed before its 15-minute reconcile.

## What it rests on

Read in the Codex 0.164.0-alpha.11.1 source unless marked.
- **Queue items have an id and a client id.** `thread/queue/add` answers with the item (`queuedSubmission`: `id`, `input`, `clientUserMessageId`), and `thread/queue/list` returns the same fields. `thread/queue/delete {threadId, queuedSubmissionId}` answers `{deleted}`, with no condition on the item's content. Any app-server can call these without loading the thread, since they read the store (`thread_queue_processor.rs`). All of `thread/queue/*` is experimental.
- **An owner can edit a queued item,** which keeps its ids. Nothing makes a list followed by a delete atomic against such an edit.
- **The writer's dispatch** reads an item, starts its turn, then deletes the row (`service.rs`), under a lock local to its own app-server. So another server's delete can land after the turn has started and still answer `deleted: true`.
- **Persisted status events** are `task_started`, `task_complete` (which may carry an error) and `turn_aborted` (with a `reason`). `error` and `shutdown_complete` are transient and never written (`rollout/src/policy.rs`).
  - A last `task_started` (a crash mid-turn) restores no `Interrupted` status, and the queue dispatches.
  - Other abort reasons map to `Errored`, which dispatches too.
- **A paginated fork by reference** resumes with its lineage's history up to the fork point (`thread-store/src/local/model_context.rs`). So a fork with no status event of its own takes its status from an ancestor's events.
- **`Bus.deliver`** runs its callback under the address's lock only when there is unread mail. With none, it moves the cursor past what isn't the subscriber's mail and returns (`src/Bus.ts`).
- **The deliverer cycles** on every ledger change and on a 15 s tick. A read moves a cursor file, not the ledger, so the tick is what notices a read.

## Decisions

**1. Wake state survives an ordinary rejoin by the same thread.**
- **The rule.** The deliverer keeps its wake state per run of joins: a join, and the ordinary rejoins that renew it. Before, it kept it per join. The wake state is the posted nudge (decision 2), the coverage mark and the warned flag. So a rejoin by the same thread finds our nudge recorded, and if the unread span is unchanged it posts nothing.
- **Where the run comes from.** The deliverer sees only each address's latest presence, so the run is written into it. A join records `rejoinOf`, the first join of the run it continues, when the address's previous presence is a join by the same session and the new join has no `replay`. Any other join records none and starts a new run: a `replay`, which asks for its mail again; a join after a leave; and a takeover. Because `rejoinOf` names the run's first join, not the join before it, any number of ordinary rejoins between two cycles keep the run, and a replay or leave followed by ordinary rejoins still starts a new one (Fable, Astra).
- **What stays per join.** The subagent refusal, which is documented as retried after a rejoin, and the failure back-off.
- **Topics on a rejoin.** A rejoin that names no topics keeps the address's topics; one that names topics replaces them. Before, a rejoin without topics dropped every subscription, and a later read passed over pending topic mail (Astra). Models rejoin with few arguments, so this is a fix in its own right.
- **What still posts.** A rejoin whose unread span changed (new mail, a partial read) is woken as before, and decision 2 cleans up after it.
- **The wording.** The nudge text also says "You are already joined; don't call `bus_join`". Its first sentence (`nudgeHead`) is unchanged, so nudges already waiting are still recognised. The wording isn't relied on: models didn't follow the existing "without rejoining".

**2. `serve` removes its own nudge once the mail is read, if it can.**
1. **Knowing which nudge is ours.** When `serve` adds a nudge, it records the `id`, `clientUserMessageId` and exact text Codex answered the add with. Only its own add is recorded: a nudge found already waiting still covers the mail, so nothing is added, but it isn't recorded, since the owner can queue our exact text too (Astra, Fable). This "posted" record is kept apart from the coverage mark, so an add that succeeded is known even when the rollout read or the borrow afterwards failed.
2. **When.** On a cycle that finds a posted record and no unread mail. `Bus.deliver` gains an optional second callback, run under the address's lock when the subscriber has nothing unread.
3. **What.** Through its short-lived app-server, within the existing 6 s nudge deadline:
   - list the queue;
   - delete the recorded item only if it is still there with the recorded ids and exactly the recorded text;
   - clear the record.

   Prefix matching isn't used, and found items aren't adopted, so input the owner queued, even our text word for word, is never touched.
4. **Best effort.**
   - **`deleted: true` doesn't mean no turn.** The writer may already have started the turn, which then runs empty, as today.
   - **`deleted: false`** means the writer took it.
   - **A failed list or delete** is logged at debug level, and the record is cleared anyway: no back-off, no retry storm.
5. **The residual risk.** An owner's edit to that nudge, landing between the list and the delete, a window of milliseconds, would be deleted with it. Codex has no conditional delete. See [Policy](#policy-for-the-owner). This is the only owner input the removal can touch.
6. **The cost.** Every normal wake ends with a posted record and no unread mail. So each wake costs one more short-lived app-server, which lists the queue and usually finds the nudge gone.

**3. A thread whose last turn was interrupted isn't borrowed.**
- **The check.** Eligibility reads the last persisted status event in the thread's own rollout. If it is `turn_aborted` with reason `interrupted` or `budget_limited`, the thread is ineligible: "its last turn was interrupted, so Codex runs no queued input until the thread gets new input".
- **The scan.** The backward scan stops only once it also has that event, or reaches the file's start.
- **No status event in its own file:**
  - A thread that has never run a turn is not interrupted.
  - A fork by reference (its `session_meta` has `history_base`) is ineligible: "it hasn't run a turn since it was forked, so its status comes from another thread's history". Following the lineage isn't worth it for a thread that has never run.
- **The nudge stays posted.** It runs once new input starts a turn, which is when Codex resumes the queue. The warning is logged once per run of joins and reason, and the third-reconcile warning names the reason.
- **Not `thread/queue/start`,** though it bypasses the interrupted check. It would have the bus start a turn the owner just stopped, which crosses delivery policy 7. Stop is the owner's signal.

**4. Finish load-on-mail's open checks.**
- **On the other machine,** with the owner's go-ahead (asked for separately), stop its managed daemon while it holds no threads. Then mail a throwaway thread, and record:
  - that `serve` started the daemon;
  - its binary and version;
  - its file limit;
  - the wake.

  The bus host can't be used: a desktop SSH project restarts its daemon first.
- **Reconciles:** a throwaway thread that skips agent-bus messages is followed through its 5-, 15- and 60-minute reconciles and the warning, with nothing freeing its address early.

**5. Docs and policy text.**
- **Delivery:**
  - policy 7 becomes "`serve` adds and removes only its own nudges, identified by the ids Codex gave them, and loads a thread only to run them";
  - the per-thread wake state, the removal, and the interrupted rule;
  - the "rejoin starts over" wording;
  - the table rows for desktop Local and `codex exec` threads.
- **Elsewhere:**
  - `docs/connections.md`: what `serve` may do to Codex threads;
  - the MCP instructions in `src/mcp.ts`: the removal, and don't rejoin when nudged;
  - [platforms: Codex](../platforms/codex.md): queue ids, delete and editing, and the MCP approval rule with its config override;
  - decision 6: `docs/connections.md#approval-in-codex`, the README's takeover paragraph, `docs/overview.md`, the MCP instructions, and the repo memory that says `bus_join` stays destructive (Fable);
  - the frame: results.

**6. Takeover is its own tool.**
- **The split.** `bus_join` loses its `takeover` parameter and says it is neither destructive nor open-world, like `bus_publish`. A new `bus_takeover` takes the same inputs plus the holder's join id (required), and says it is destructive. Its behaviour is today's join with `takeover`, unchanged: the same lock, unread mail carried over, the previous owner refused from then on. The holder id is checked only while another session holds the address; on a free address, or the caller's own, it joins as `bus_join` does, as `Bus.join` always has (Astra).
- **Why `bus_join` isn't destructive.** Without `takeover`, it claims a free address or reconnects the caller's own session, and refuses a held address before writing anything; `replay` rewinds only the caller's own cursor; topics change only when the caller names them (decision 1). It affects only the caller's own state, the standard under which `bus_leave` was already marked non-destructive ([one-codex-route](one-codex-route.md)). Astra read MCP's definition ("only additive updates") strictly; the omitted-topics case it found was a real loss of mail and is fixed, and an explicit topic change stays the caller's choice about its own subscriptions.
- **The refusal** for a held address names `bus_takeover` and `agent-bus join --takeover`, since the CLI shares it (Fable).
- **The CLI** keeps `agent-bus join --takeover`, which now calls `bus_takeover`.
- **What it changes, in Codex 0.164.** A thread with approval `never` and no full access can join and rejoin itself, where before its join was refused. The rule (`core/src/mcp_tool_call.rs`, `maybe_request_mcp_tool_approval`) holds under the default per-server approval mode (`auto`) without strict auto-review; a server or tool set to `prompt` asks for everything, one set to `writes` for everything not read-only, and one set to `approve` allows even the takeover (Astra, Fable). A takeover still needs approval or full access by default. The annotation is not the human's authorization: `bus_takeover`'s description keeps "only when the human says so". Claude Code has its own permission rules, and nothing here claims they follow the hints (Fable, Astra).
- **This reverses** one-codex-route's rejection of a takeover tool ("adds a tool"). The balance changed: read-only reviewers and other sandboxed Codex threads under `never` couldn't join at all (Fable).

## Policy for the owner

**Chosen: (a)**, by the owner on 2026-10-28.

Decision 2 is the first time `serve` would remove anything from a thread's queue. It removes only an item it added or recorded, with matching ids and identical text. The one exposure is an owner editing that nudge in the milliseconds between the list and the delete. The choice:
- **(a) Take decision 2 as written** (recommended): it saves an empty turn after most mid-turn reads, for a race that needs an edit of the bus's own nudge in a window of milliseconds.
- **(b) Drop decision 2:** the empty turn after a mid-turn read stays, as load-on-mail accepted.

## Rejected

- **Deleting by text prefix.** Owner input can quote the header (Astra).
- **Deleting the nudge from the read path.** `take` would have to reach Codex from inside a read that today touches only the ledger and cursors. The 15 s tick is soon enough.
- **Keeping wake state per join and relying on the wording.** Models rejoined against the existing wording.
- **Treating `Errored` like `Interrupted`.** An errored turn doesn't stop the queue, and today's reconcile covers a turn that failed.
- **Restarting an interrupted thread's queue with `thread/queue/start`.** Decision 3.

## Known limits

- **A nudge the writer takes before the tick still runs empty,** whether or not the delete reports success.
- **An edit landing between list and delete is lost** (decision 2.5, if (a) is chosen).
- **Retraction depends on experimental queue methods,** like the post itself.
- **An interrupted thread's mail waits** for the owner's next input. The nudge stays queued for it, and the log says why.
- **After an ordinary rejoin,** a nudge that was consumed and cut off (the `exec` case) is re-posted only at the next reconcile, not at once.
- **Only a nudge this `serve` added in the current run of joins is removed.** One found waiting (an add whose answer timed out, one from an earlier run, after a replay or a leave, or one from before a `serve` restart or this release's deploy) still covers the mail but runs once, empty, after a mid-turn read (Fable, Opus).
- **Removal holds the address's lock** for up to 6 s while a short-lived app-server lists and deletes, on the first cycle after the read, so a `bus_read` or `bus_wait` by the same thread can wait that long (Opus). The post already did the same.

## Qualification

**Unit tests:**
- **Rejoins:**
  - a same-thread rejoin with the span unchanged posts nothing;
  - a rejoin with `replay`, a leave then rejoin between cycles, a takeover, or a changed span posts again;
  - the reconcile schedule and the warned flag carry across an ordinary rejoin.
- **Removal:**
  - a read clears the record and deletes only the recorded item;
  - the owner's items are untouched, including one that quotes our header, one that is our text word for word (whether found before or after ours), and one with our ids but edited text;
  - `deleted: false`, a failed list and a failed delete each clear the record without back-off, and log at debug level;
  - removal never runs while unread mail exists;
  - mail arriving between the empty read and the delete is woken on the next cycle;
  - a partial read leaves the nudge;
  - a posted record survives a failed rollout read or a failed borrow, and is removed after a later read.
- **Takeover:**
  - `bus_join` has no `takeover` input and isn't marked destructive; `bus_takeover` is, and requires the join id;
  - a takeover through `bus_takeover` behaves as today's (unread carried over, the old owner refused); a stale join id is refused;
  - the held-address refusal names `bus_takeover`, and the CLI's `--takeover` reaches it.
- **Runs and topics:**
  - `rejoinOf` is recorded for a rejoin while joined, naming the run's first join, and not for a replay, a join after a leave or a takeover;
  - a replay or a leave followed by ordinary rejoins between cycles starts over;
  - a rejoin without topics keeps them, with pending topic mail still readable; one naming topics replaces them.
- **Eligibility:**
  - a last `turn_aborted` with `interrupted` or `budget_limited` is ineligible;
  - other abort reasons, a `task_complete` carrying an error, a later `task_started`, or a last `task_started` from a crash are not;
  - no status event: a thread that has never run is eligible, and a fork by reference with no turn of its own is ineligible;
  - the status event is found across chunks.

**Live, after deploy,** on throwaway threads and `qual/*` addresses on both machines:
1. A borrowed thread that rejoins before reading gets no second nudge.
2. A thread in a long turn that reads its mail with `bus_wait` mid-turn: its waiting nudge is removed within about 15 s, and no empty turn follows, unless its turn ended within that window.
3. An interrupted thread (a turn stopped with `turn/interrupt` on a private server) isn't borrowed. It logs once, and its nudge runs after the next input.
4. `serve` starts the daemon on the other machine (decision 4, with the owner's go-ahead).
5. The 5-, 15- and 60-minute reconciles, and the warning that names the reason.
6. The Director, observed: no empty turn after its mid-turn reads.
7. A read-only Codex thread under approval `never` joins itself with `bus_join`, and is refused `bus_takeover` (Codex only).

## Reviews

Astra (max) and Fable reviewed the first draft, both against the 0.164 source. Accepted:
- **Prefix matching isn't proof of ownership** (Astra), so `serve` deletes by the ids it recorded, after an exact-text check (Fable's suggestion). The remaining race with an owner's edit goes to the owner (Policy).
- **`deleted: true` doesn't prove the nudge didn't run** (both). Decision 2.4.
- **Removal is a new write,** which the policy text must name (Fable). Decision 5 and Policy.
- **The posted record is kept apart from coverage** (Astra), since an add can succeed while the borrow fails.
- **A `replay` rejoin, and a leave then rejoin, reset the wake state** (Astra).
- **Status events:** `error` and `shutdown_complete` are never persisted (both, checked in `rollout/src/policy.rs`).
- **A fork by reference with no status event of its own** can't be judged from its own file, so it fails closed (both).
- **The cost of removal per wake,** and wake state that holds only while the span is unchanged (Fable).
- **The tests both listed.**

**Re-review of the revision** (2026-10-28), by Astra and Fable as persistent reviewers on the bus, against `aaf62eb`. Both found the first round's findings fixed, and asked for revision. Accepted, all:
- **Exact text isn't authorship** (Astra must-fix, Fable optional): only `serve`'s own add is recorded (decision 2.1).
- **The deliverer can't see a leave, or a reset before another rejoin** (Fable and Astra must-fix): the run of joins is written into the presence as `rejoinOf`, naming the run's first join (decision 1).
- **A rejoin without topics dropped subscriptions** (Astra must-fix): it keeps them now (decision 1). Its other half, that `bus_join` must be marked destructive while it can change topics at all, is rejected with the reason in decision 6.
- **Permission claims** (both): Codex's conditions are stated; the Claude Code equivalence is removed (decision 6).
- **The CLI's `--takeover`, the refusal text, the takeover precondition, the reversal of one-codex-route, the stale memory, and the limits on found nudges** (Astra and Fable optional).

**Code review** (2026-10-28) by Sol and Opus as persistent reviewers on the bus, of `2dfbb5e..dece53c`. Opus: ship, no P1 or P2; seven P3s, all accepted:
- back-off and failures could carry from an earlier join within one cycle: they now belong to the join;
- a peer in back-off wasn't checked for removal, so a read inside the back-off waited up to 5 minutes: back-off now holds off posting only;
- the warning is per run and reason: a different reason is logged again;
- docs: the limit on found nudges includes an earlier run's; removal's hold on the lock; the `codex exec` row;
- tests: an older client passing `takeover` to `bus_join`, a failed rollout read, removal outcomes not warning, and a rejoin while a borrow is in flight.

Sol: fix first, one P2 and four P3s, all accepted:
- **P2:** a rejoin after the cycle read its peers inherited the old join's failure count, through the failure arithmetic as well as the copy (the same as Opus's first item, which fixed only the copy). Join-local state (refusal, failures, back-off) is now read only from a hold for the attempted join itself, with a regression test that reproduced it.
- the trust table in `connections.md` names `thread/queue/delete`, and the approval claim there names its conditions;
- an ineligible thread's log says its nudge stays queued, not that it runs when next loaded, which is false for an interrupted thread;
- the repo memory that says `bus_join` stays destructive is updated at close-out.
