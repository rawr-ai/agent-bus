# Frame: waking Claude sessions without a background wait

## Outcome

A Claude Code session on the bus is woken when mail arrives for an address it owns, whether it is idle or busy, in the desktop app and in the terminal. The model starts and restarts nothing. The wake is a nudge with no message text. Only the session's own `bus_read` marks mail read.

## The problem

Today a Claude session runs `agent-bus wait --address <address>` as a background command, one per address. The command reads the mail, prints it and exits, and its exit wakes the session. The model must then start it again. If it forgets, delivery stops without any sign ([overview](../overview.md#questions-for-a-simplification-pass), question 8).

The idea taken into framing was a Claude Code plugin whose `monitors` entry runs a streaming `agent-bus watch`, so that the host, not the model, keeps the wake armed. Plugin monitors turned out never to start where the owner works, in the desktop app. Hooks with `asyncRewake` do what the monitor was meant to do, in both the desktop app and the terminal.

## What it rests on

Probed 2026-10-27 on throwaway sessions in scratch folders: Claude Code 2.1.310 (the desktop app bundles 2.1.308), a small model, no MCP servers, no bus. The desktop app runs Claude Code as `claude --input-format stream-json --output-format stream-json`, with no terminal, as its process list shows. The stream-json probes ran it the same way.

**Plugin monitors.**
- **Terminal:** a monitor starts about 1 s after the folder is trusted. A line it prints in an idle session starts a turn at once. It ran for the whole 39-minute session, so it has no 30-minute deadline. Its environment has the session's `CLAUDE_CODE_SESSION_ID`. After `/clear` it keeps running with the old id, and its next line woke the cleared conversation.
- **stream-json:** no plugin monitor starts. The plugin loads (it is listed at init), but in two runs of more than 5 minutes, one with the desktop's environment and one clean, its monitor never ran.

**`asyncRewake` hooks** (stream-json mode). Each hook slept, wrote a line to stderr and exited 2:

| Hook | Result |
| --- | --- |
| `Stop`, passed with `--settings` | After the first turn, the idle session started a turn and acted on the line |
| `Stop`, from a plugin (`--plugin-dir`) | The same |
| `SessionStart`, with no input sent at all | The session started a turn of its own and acted on the line |
| `timeout: 5` on a hook that sleeps 15 s | Killed at 5 s; it woke nothing |
| `timeout: 2592000` (30 days) | Accepted; the hook woke the session at 25 s |
| The hook's environment | Its `CLAUDE_CODE_SESSION_ID` equals the `session_id` in its input |

The hook docs agree: an `asyncRewake` hook that exits 2 "wakes Claude immediately even when the session is idle". Each run is its own background process. A `-p` run kills async hooks when it ends. Relative-path plugins from a marketplace added from a local path load in place, with `${CLAUDE_PLUGIN_ROOT}` pointing at the source directory. (Not so at deploy: `claude plugin install` copied the plugin's directory into its cache; see decision 9.) Claude Code doesn't install their dependencies.

**The session's inbox socket** (`$CLAUDE_CODE_MESSAGING_SOCKET`, one per Claude Code process). An unrelated process posted a message frame to an idle stream-json session's socket, and the session started a turn. The socket and its inbound rules are documented, but the frame format is not; it was read from Claude Code's bundle.

## Decisions

**1. The wake is a plugin hook with `asyncRewake`, armed by the host.** The agent-bus plugin runs `agent-bus claude-wake` in the background:
- on `SessionStart`: startup, resume, `/clear` and compaction;
- on `Stop`: every turn's end;
- on `StopFailure`: a turn ended by an API error.

The hook waits until an address the session owns has mail it hasn't been woken for. It then writes a nudge to stderr and exits 2, which wakes the session. The woken turn's `Stop` starts the next hook. The model starts nothing, and a resumed session is armed before its first prompt.

**2. The wake marks nothing read.** `serve` reads each address's unread mail under the address's lock through `Bus.deliver`, the Codex deliverer's path, and returns only addresses. The owner's `bus_read` moves the cursor. When nothing in a batch is the subscriber's, `deliver` passes over it, as the owner's read would ([one-codex-route](one-codex-route.md#decisions), decision 1). Mail can't be marked read on its way through a hook: a killed hook loses its output, so mail reaches the model only in `bus_read`'s result.

**3. One wake per change in unread mail.** For each address and join, `serve` keeps in memory the unread mail, first message to newest, that it last woke the session for. The same unread-span mark is what the Codex deliverer keeps. A call returns an address whose unread mail differs from its mark, and moves the mark. So:
- **New mail** wakes the session, including mail that arrives while a woken turn runs.
- **A partial read** (`bus_read` with a limit) wakes it once more for the rest.
- **Mail left unread** doesn't wake it again, so an ignored nudge can't loop into empty turns.
- **A rejoin, a takeover or a `serve` restart** clears the mark, which costs at most one extra wake per address with unread mail.

A mark moves only with the result that names it:
- **Reads first.** A call reads every address first; the reads can be interrupted, and an address whose read fails is left for the next pass with its mark unchanged.
- **One step.** It then moves the marks in a single step, only while it is still the session's current wait, and only for marks no other wake has moved since the reads (a takeover's new owner, say).
- **Rollback.** If the call then fails, times out, is superseded or is cut off before returning, it puts back the marks it moved.

A failed read of one address can therefore never hide another's mail. The change stream is subscribed alongside the first read, so mail landing during it is seen at once, not at Fluree's 15-second poll.

**4. One waiting call per session, bounded in time.** Each arming point starts a hook. A newer `bus_wake` call from the same session ends the older one, which returns `superseded`, and that hook exits 0. The 50-second limit covers the whole call, reads included. A read that stalls in the store can't hold a call past its limit, or past a newer call. While a call waits, its addresses count as an open wait with a fresh last call, as a background `wait` did. So a session refused one of those addresses can still tell a live holder from a dead one.

**5. Identity, and which addresses count.**
- **Identity.** The hook presents its input's `session_id`, which equals the session's `CLAUDE_CODE_SESSION_ID`.
- **Which addresses.** A call covers the addresses that session holds as `claude`, joined from this machine, the one whose `serve` keeps their cursors. An address joined from this machine whose cursor is missing (a replaced ledger, say) is logged and skipped, as the Codex deliverer does.
- **After `/clear`** the session has a new id. `SessionStart` arms a hook for it, which finds no addresses until the session joins again; a cleared session already needs a new address ([README](../../README.md#addresses-belong-to-sessions)). The hook from before `/clear` keeps waiting under the old id. It fires at most once, if mail reaches the old addresses: the cleared conversation's `bus_read` is then refused, and the nudge tells it to carry on.
- **`--resume`** keeps the id. `SessionStart` re-arms the wake.
- **Subagents** share their parent's id, so mail to a subagent's own address wakes the parent, which may read it.
- **Two processes resuming the same id** share one wait: the one that armed last is the one woken.
- **A hook whose session has gone** stops: it checks between calls that its parent process is still the one that started it.

**6. A session that hasn't joined pays one call per arming point.** The hook exits 0 at once when the session owns no address: a `bun` start and one MCP call, about 0.2 s, in the background.

**The hook retries every failed call,** every 5 seconds for up to ten minutes, then exits quietly until the next arming point. The hook checks the session id itself, so `bus_wake` has no refusal left, and every failure is transient:
- `serve` unreachable (restarting, say);
- its store failing;
- a `serve` from before `bus_wake`, which a deploy replaces within that window.

The bus returns a declared failure's message, not its type, so the hook can't tell these apart, and needn't.

**7. What the session is told.** Claude Code shows the hook's stderr to the model, under its own label "Stop hook blocking error from command …". The text names only the recipient address, one line per address:

> [agent-bus] New messages for "claude/x". Read them with the agent-bus bus_read tool, as that address with your $CLAUDE_CODE_SESSION_ID as session, and handle them. If bus_read returns no messages, or says the address isn't joined or belongs to another session, carry on without replying.

Sender text stays out. The nudge enters the session's context as host output, and senders choose bodies, subjects and addresses freely.

**8. A new bus tool, `bus_wake`, and a flag on `bus_join`.**
- **`bus_wake`** takes `session` and waits up to 50 seconds. It returns the addresses to wake for, whether the session owns any address, and whether a newer call superseded it.
  - **Annotations:** closed-world and non-destructive, but not read-only, because it moves the woken mark and passes cursors over other entries.
  - **Description:** says it is for agent-bus's Claude Code hook, not for sessions to call.
- **`bus_join`** returns `hooked: true` for a Claude join when this machine's `serve` has had a `bus_wake` call from the session. The plugin's `SessionStart` hook makes that call before the session's first turn, so a session with the plugin is told at its first join.

The MCP instructions say: with `hooked: true`, run nothing; without it, run `agent-bus wait` as before. That keeps sessions without the plugin, or with it not yet loaded, on the route that works for them.

Rejected: folding the wake into `bus_wait`, which would give a tool every model reads a second meaning. A second endpoint for the CLI alone would be a second HTTP surface.

**9. Install: a plugin served in place from the checkout.** Two files go at the repo root: `.claude-plugin/marketplace.json`, and `.claude-plugin/plugin.json` with the hooks inline. Install with:

```sh
claude plugin marketplace add <agent-bus checkout>
claude plugin install agent-bus@agent-bus
```

`${CLAUDE_PLUGIN_ROOT}` is then the checkout itself, and the hook runs `bun "${CLAUDE_PLUGIN_ROOT}/src/bin.ts" claude-wake` against the checkout's own dependencies. The hook's `timeout` is 30 days.

**Superseded at deploy** ([finish-swap](finish-swap.md), decision 1): a marketplace install copies the plugin's directory into Claude Code's cache, so the plugin is now `plugin/`, a manifest whose hook runs the installer's `~/.local/bin/agent-bus` link to the checkout.

The hook's requirements:
- `bun`. Hooks inherit Claude Code's environment, not a shell's, so the command looks on that `PATH` and then in `~/.bun/bin` and `~/.local/bin`, the two places `bun` is installed on the owner's machines (since [finish-swap](finish-swap.md), those two first);
- the checkout's dependencies installed;
- `AGENT_BUS_PORT` the same in Claude Code's environment as in `serve`'s, or unset in both (8096).

The plugin is preferred over a hook in `~/.claude/settings.json` because the CLI manages it, it can be turned off in `/plugin`, and there is no JSON to edit by hand on each machine.

**10. Deploy order, per machine.**
1. Fast-forward the primary checkout, install dependencies if the lockfile changed, and restart `serve`.
2. Check that `serve` lists `bus_wake`.
3. Install the plugin.
4. Sessions pick it up at their next start or `/reload-plugins`.

A hook that meets a `serve` without `bus_wake` retries it for ten minutes, so a `serve` restarted within that window is picked up. Installing further out of order costs wakes until the next arming point, not errors. A session still running a background `wait` may be woken twice for one message, once by each route, and the second wake reads nothing.

**11. What it replaces.**
- **The background `wait` as the Claude wake,** for every session whose join says `hooked`. `agent-bus wait` stays as the fallback, for sessions without the plugin and for `-p` runs.
- **The README's "Next" item,** host-armed Claude waking.
- **Overview question 8,** which this answers.

## Rejected

- **A plugin monitor running a streaming `watch`** (the idea tested). It wakes idle terminal sessions, but the desktop app runs Claude Code in stream-json mode, where no plugin monitor starts. The hooks cover the terminal as well, so a monitor for terminals alone would be a second route for the same job.
- **`serve` posting a nudge into the session's inbox socket.** It needs no process per session. What rules it out: `serve` isn't the session's own child, so a session that bypasses permissions holds the message, and the desktop drops it after five minutes.
- **A hook-started watcher posting to its own session's socket.** As the session's own child, it is delivered under the default rules. It would still be a long-lived process per session, as the hook is, but it would depend on the undocumented frame format and need its own supervision. `asyncRewake` gives the same wake through a documented exit code.
- **Channels.** Terminal only, behind an allowlist or a development flag.

## Not doing

- **Delivering message text at the turn's end.** The simplification pass retired that for Codex.
- **Waking `-p` runs.** Claude Code kills async hooks when a `-p` run ends.
- **Local supervision of hook processes** (decision 5 and Known limits).
- **Registering the MCP server through the plugin.** It would rename every bus tool (`mcp__plugin_…`).
- **Retiring `agent-bus wait` now.** It is the fallback in decision 8.

## Known limits

- **A turn the user interrupts arms nothing.** The hook from the previous arming point keeps waiting unless it already fired. If it did, no hook waits until the next turn ends or the session restarts.
- **Idle longer than 30 days:** the hook is killed, and the session isn't woken until its next arming point.
- **A result lost in transit.** If a call returns but the hook dies before printing, the mark has moved, so that mail doesn't wake the session until it changes. It stays unread and readable.
- **Hook processes during an outage.** While `serve` or its store is down, each arming point leaves one hook retrying for up to ten minutes. Once the bus answers, the next call supersedes it.
- **After `/clear`,** the old id's hook stays until it fires once or the session ends.
- **The woken mark is per `serve`,** so a restart may wake once more per address with unread mail.
- **`StopFailure` with `asyncRewake`** is documented but wasn't probed.

## Reviews

GPT-6 Astra (max effort) and GPT-6.1 Sol (xhigh) both found the first draft sound with changes. An Opus simplicity pass found the core minimal and cut packaging and text. This revision takes the following changes.

**From both reviewers:**
- **Arming:** also on `SessionStart` (probed) and `StopFailure`, so a resumed idle session is armed.
- **Lost wakes:** marks are staged and moved in one step, with a rollback. A failure on one address had lost another's wake (both reproduced it).
- **Bounds:** reads can be interrupted, and the deadline and supersession bound the whole call.
- **Transient failures:** the hook retries any failed call, a storage error included, rather than taking it as a refusal.
- **Rollout:** `hooked` on `bus_join` keeps sessions without the plugin on `wait`, and the deploy order is set out.
- **Eligibility:** addresses must be held as `claude` and joined from this machine, and a missing local cursor is logged.
- **The span policy** is documented (the draft had moved to it).
- **The deploy requirements** are listed.
- **The socket variant** started by a hook is assessed separately.

**From the simplicity pass:**
- no `timeoutSeconds` on `bus_wake`;
- no fallback from the hook input to `$CLAUDE_CODE_SESSION_ID`;
- a narrower case against the socket route;
- shorter text.

Plugin hooks in stream-json mode, which it flagged as unprobed, are now probed.

**Declined, with reasons:**
- **Local supervision of hook processes** (both reviewers). It would need a stable per-process key that Claude Code doesn't document; the socket path is per process but is internal. The bounds in Known limits hold without it.
- **A settings hook instead of the plugin** (simplicity). Both of its concerns are now covered: plugin hooks run in stream-json mode (probed), and in-place loading is documented. The plugin avoids hand-edited JSON on each machine.
- **Retiring `agent-bus wait` in this release** (simplicity). It is the fallback for sessions without the plugin, which includes every session started before the install.
- **Annotating `bus_wake` read-only** (the maintainer session). It moves the woken mark and passes cursors over other entries, so it isn't a pure lookup, and both reviewers kept it non-read-only.

## Code review

GPT-6.1 Sol and Opus reviewed the code. Their findings are taken:
- **A scan outrun by a takeover** could overwrite the new owner's mark (Sol reproduced it). A mark now moves only if it is still the one read under the lock.
- **A storage error on one address** held up the session's other addresses. It now skips that address for the pass.
- **A hooked session's addresses** looked idle to a refused join. They now count as an open wait.
- **`hooked`** is now given only for Claude joins.
- **The change stream** is now subscribed alongside the first read.
- **A hook outliving its session** now stops.
- **The race test didn't exercise the mark commit and its rollback** (Opus removed both and the tests still passed). They are now pure helpers, tested directly.
- **Two README sentences** are corrected: `claude-wake`'s session and retries, and the cursor's pass over other entries.

Each mechanism's test fails without it (checked by removing the mechanism).

## Checked before release

On a throwaway `serve` with its own store and port, a throwaway stream-json session loaded the plugin in place from the worktree:
- `bus_join` returned `hooked: true`, since the `SessionStart` hook had already called.
- Each of two messages, sent while the session was idle, woke it within 1.5 s, and it read the mail with `bus_read`.
- One hook process waited after each turn, and none outlived the session.
- The same held when the session ran with the desktop app's own `PATH`, and with a launchd-style `PATH` that has no `bun` (`/usr/bin:/bin:/usr/sbin:/sbin`), where the command found `bun` in the fallback directories. A unit test runs the manifest's command under `/bin/sh` with a `PATH` lacking `bun` and a home whose only `bun` is in `~/.bun/bin`; it fails with a bare `bun`.

## Qualification

Unit tests:
- `bus_wake` wakes once for unread mail, again when the unread mail changes (new mail, or a partial read), and not for mail left unread;
- it marks nothing read, and passes over only what isn't the subscriber's mail;
- a session that owns nothing returns at once;
- a newer call supersedes an older one;
- mail racing a newer call wakes exactly one of the two;
- only Claude addresses joined from this machine count;
- a rejoin clears the mark, and a takeover leaves the old session owning nothing;
- a failed read of one address doesn't hold up another's wake;
- a scan outrun by a takeover doesn't overwrite the new owner's mark;
- marks move only where no other wake moved them, and a lost result puts them back;
- a waiting hook counts as an open wait for a refused join;
- a stalled read doesn't outlast the deadline or a newer call;
- a join reports `hooked` once the session's hook has called, and only for a Claude join;
- the hook reads `session_id` from its input, waits through empty answers, prints one line per address, and exits 0 when superseded, owning nothing, refused or given no session;
- the hook retries any failure every 5 s, and gives up after ten minutes of them;
- end to end, through `serve`, the CLI exits 2 with the nudge on stderr and leaves the mail unread, and exits 0 for a session that owns nothing.

After deploy, with throwaway sessions and `qual/*` addresses (the owner opens the desktop sessions):
1. **Desktop and terminal sessions with the plugin:** `bus_join` returns `hooked: true`. Idle, each is woken by mail within seconds, and only its own `bus_read` marks the mail read.
2. **Several wake, read and Stop cycles in a row:** each arrival wakes once, with no empty turns.
3. **A busy session:** mail sent mid-turn is handled after the turn.
4. **An ignored nudge:** no further wake until the unread mail changes.
5. **A resumed session left idle:** woken without a prompt.
6. **`/clear`, then a new join:** the new address is woken, with at most one stray wake.
7. **Two addresses in one session,** and a subagent's address.
8. **`serve` restarted, and the store unavailable, while a hook waits:** the wake still arrives.
9. **Hook processes:** after many turns, at most one waits per session, and none lingers for a session that hasn't joined (`ps`).
10. **A session without the plugin:** its join has no `hooked`, and it runs `wait` as before.
11. **Both machines:** the plugin is installed, its hook runs the primary checkout (through `~/.local/bin/agent-bus` since [finish-swap](finish-swap.md)), and `bun` resolves from Claude Code's environment.

### Results (2026-10-27)

Run on throwaway stream-json sessions (how the desktop app runs Claude Code) with `qual/*` addresses, after the launcher release:

- **1, 2, 9:** joins returned `hooked: true`. Three idle arrivals in a row each woke the session once, in 1.6–2.6 s, and each was read by its own `bus_read`. One hook process waited after every turn, and none was left after the session ended.
- **3:** mail sent mid-turn was read within that turn, with no extra turn after it.
- **4:** an ignored nudge brought no further turn in 30 s of quiet; new mail then woke the session, and its read also returned the ignored mail.
- **6:** after `/clear` and a new join, the new address was woken in 2.2 s. Mail to the pre-clear address caused exactly one stray turn.
- **5:** a resumed session left idle was woken with no prompt, 1.5 s after it started.
- **7:** a second address in one session was woken. A subagent's address wasn't tried: a subagent is reached through its parent.
- **10:** a session without the plugin got no `hooked` and no hook process. Since [finish-swap](finish-swap.md) it isn't woken at all.
- **11:** both machines run the hook through the link to the primary checkout.
- **8:** the store being unavailable is covered by the unit tests. A `serve` restart while a hook waits was checked at the deploy that retired `wait` ([finish-swap](finish-swap.md#release-b)): on 2026-10-27, a throwaway session whose hook was waiting across the restart was woken by the next mail, with the hook's event 4.3 s after the send. That closes item 8.
