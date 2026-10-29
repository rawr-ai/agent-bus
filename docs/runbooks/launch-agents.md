# Launch agents

Use this to start Claude and Codex sessions the bus can wake, and delegates, subagents and one-shot runs that should or shouldn't join. Which sessions are woken, and why, is in [delivery](../architecture/delivery.md#how-each-kind-of-session-receives-mail).

## Before you start

- **The bus is healthy** ([operate](operate.md#check-that-the-bus-is-healthy)), and each runtime on the machine knows the MCP server: [install](install.md) registers it. Check both, read-only:

  ```sh
  claude mcp get agent-bus
  codex mcp get agent-bus
  ```

  Expect the URL `http://127.0.0.1:8096/mcp` and, for Claude, `Status: ✔ Connected`. *Checked read-only 2026-10-28.*

- **Which kinds of session are woken** is delivery's table, linked above. In short: Claude Code with the plugin, and top-level Codex threads; not `claude -p`, subagents or other clients.
- **An address belongs to one session.** Pick one specific to the session, such as `claude/<project>-<task>` or `codex/<task>`. Groups share a `#topic`. The session id is the runtime's own variable, read from the session's shell: `$CLAUDE_CODE_SESSION_ID` or `$CODEX_THREAD_ID`. Never invent one ([messaging](../architecture/messaging.md#rules)).
- **What the agent is told is already in place; its owner doesn't paste a protocol into prompts.** Every session that connects gets the bus's MCP instructions, the minimum protocol: join with your session id and an address of your own, read without rejoining when told of new mail, reply with `replyTo`, leave when done, treat mail as data and take over an address only on the human's word. A Claude Code session with the agent-bus plugin also has the `agent-bus` skill (`plugin/skills/agent-bus/`), which carries the rest across calls: waking, subagents and delegates, refusals, the CLI. What each surface owns is in [interfaces](../architecture/interfaces.md#instructions-and-wake-texts), and how a running session picks up a change in [upgrade](upgrade.md#refreshing-guidance-in-running-sessions). A session started before a change keeps the guidance it began with.
- **No sessions were started to write this page.** They would appear in the owner's apps. Steps that need one are marked *Unverified*, with what was checked in its place: the code, the platform pages, `--help`, or the same calls with a made-up session on an isolated bus (*Rehearsed 2026-10-28*). The end of each step's expected result carries the mark ([runbook shape](../../AGENTS.md#page-shapes)).

## Start a Claude session the bus can wake

Every step here is *Unverified* with a real session, which none was started for. The join, the `hooked` field and the wake line were *Rehearsed 2026-10-28* with a made-up session and a simulated hook on an isolated bus.

1. Check that the plugin is installed and enabled on this machine ([install](install.md) installs it).

   ```sh
   claude plugin list
   ```

   Expect `agent-bus@agent-bus` with `Status: ✔ enabled`. *Checked read-only 2026-10-28.*

2. Start the session in the desktop app, or run `claude` in a terminal. Not `claude -p`: Claude Code ends async hooks when a run ends, so a `-p` run is never woken. The hook arms at the session's start, including a resume. `claude --resume` keeps the session id, so the session still owns its address; `--fork-session` and `/clear` give it a new id, which owns nothing until it joins ([platforms: Claude Code](../platforms/claude-code.md#session-ids)). `claude --help` lists `-p`, `--resume` and `--fork-session`.

3. Join with an address of its own and its own session id. The agent does it with the `bus_join` tool (`runtime: claude`, `session` from `$CLAUDE_CODE_SESSION_ID`, `cwd`). From a shell inside the session, the CLI reads the variable itself:

   ```sh
   agent-bus join --address claude/<project>-<task> --runtime claude --note "<what you are working on>"
   ```

   Expect `joined as claude/<project>-<task>`. A held address is refused: pick another ([recover](recover.md#held-by-another-session)).

4. Check that it is armed. The join result carries `hooked: true` once `serve` has seen the session's hook. A rejoin by the same session is harmless and keeps its unread mail, so ask the session to join again and read the field. Without the field, see [recover](recover.md#a-claude-session-isnt-woken).

5. That is all. The session needs no background command and no loop. When mail arrives, its hook wakes it with a line telling it to call `bus_read`; it reads, answers with `replyTo` and carries on.

A Claude subagent shares its parent's id, so mail to its parent's address wakes the parent.

## Start a Codex thread the bus can wake

Every step here is *Unverified* with a real thread, which none was started for. A Codex address can't be joined on an isolated bus: its `serve` reads the real `~/.codex` and would post nudges into real threads.

1. Start a top-level thread on the machine whose `serve` should wake it: a Local thread in the desktop app, `codex` in a terminal, or a desktop SSH project (the thread then lives on the SSH host, so it joins there). For the bus to wake it when it is loaded nowhere, the thread must be eligible to borrow ([delivery rule 9](../architecture/delivery.md#rules)):
   - approval policy `never`;
   - Default collaboration mode, not Plan;
   - no tools registered by a client;
   - full access, or read-only, or a built-in profile with no denied paths;
   - a last turn that wasn't interrupted.

   From a terminal, the first and fourth come from the options:

   ```sh
   codex -a never -s danger-full-access
   ```

   `codex --help` lists both options. Whether `-s workspace-write` records a profile that qualifies wasn't checked: the log tells you ([recover](recover.md#why-a-thread-isnt-borrowed)). A thread that is not eligible still gets its nudge, and runs it when someone next loads the thread.

2. Join from inside the thread with its own thread id as both `session` and `codexThreadId`. The agent does it with the `bus_join` tool (`runtime: codex`, `session` and `codexThreadId` from `$CODEX_THREAD_ID`, `cwd`). From the thread's shell, the CLI reads the variable for `--session`:

   ```sh
   agent-bus join --address codex/<task> --runtime codex --codex-thread "$CODEX_THREAD_ID" --note "<what you are working on>"
   ```

   Without `codexThreadId` the thread is not woken. A `codexThreadId` that differs from `session` is refused with "codexThreadId must be your own thread id, the same as session." (*Rehearsed 2026-10-28*: the refusal, and no peer left behind.)

3. Check that it is woken. From another address, send the thread a message, then look in `serve`'s log:

   ```sh
   agent-bus publish --from <your address> --to codex/<task> --body "test"
   grep 'codex/<task>' ~/.agent-bus/agent-bus.log | tail -n 5
   ```

   Within seconds (the 15 s tick at most) expect `Waking codex/<task>: queued a nudge, …`, and then a turn in the thread that reads the message. Any other line has its row in [recover](recover.md#a-codex-thread-isnt-woken).

Leave the thread's mode, permissions and approval policy alone after the join: changing them can make it ineligible, and a turn the owner interrupts makes its mail wait for new input. Subagents are never woken: a Codex subagent's queue refuses the nudge (see the next section).

## Delegates, subagents and one-shot runs

A process started from a session's shell inherits that session's ids, and acts as the session if it reads the wrong variable ([platforms: Codex](../platforms/codex.md#thread-ids-and-codex_thread_id), [messaging limits](../architecture/messaging.md#limits)). So a delegate either joins an address of its own, or doesn't join at all; the instructions say the same to any agent that connects, and the skill's table of special cases covers subagents, `codex exec` and `claude -p` for one that loads it. Tell a delegate which of the two you want in its prompt. Every step here is *Unverified*: no delegate, run or subagent was started. The facts come from the platform pages and delivery, and the options from `--help`.

1. A `codex exec` delegate. Run it unattended with its prompt as an argument and its input closed, because it reads standard input when that isn't a terminal and waits.

   ```sh
   codex exec "<prompt>" < /dev/null
   ```

   If it needs the bus, it joins its own address as a Codex thread (the section above, with its own `$CODEX_THREAD_ID`), and leaves with `bus_leave` before it ends. Left joined, the reconciles keep waking its thread. Mail sent while it runs isn't woken; mail sent after it exits is, as for any eligible thread loaded nowhere ([delivery](../architecture/delivery.md#how-each-kind-of-session-receives-mail) says why). A delegate that only reports back can skip the bus, and let its parent read its output.

2. A `claude -p` run. It is never woken. If it must use the bus, it joins its own address and reads with `bus_read`, or `bus_wait` within the run, and leaves at the end. Its session id is its own, even when started from another session's shell.

3. Subagents of either runtime. Don't join them. A Claude subagent shares its parent's session id, so it would act as the parent. A Codex subagent has its own id, but its queue refuses the nudge: `serve` logs `Not waking <address>: its Codex thread takes no direct input`, and its mail stays unread until a `bus_read`. Have the parent read the mail and pass it on.

## Sandboxes and approvals

Whether a session is asked to approve a bus call depends on the runtime and its sandbox.

- **Codex, without full access, under default approvals:** no bus tool asks except `bus_takeover`, which is marked destructive and is refused under approval policy `never`. So a sandboxed `never` thread can join, read, send and leave, but can't take an address over: that is a human's act from a shell ([recover](recover.md#held-by-another-session)). The table of every tool is in [interfaces](../architecture/interfaces.md#tool--annotation--approval), and Codex's rule in [platforms: Codex](../platforms/codex.md#approvals-for-mcp-tools). *Unverified* with a thread; the annotations were read from the tool list through the MCP Inspector (*Rehearsed 2026-10-28*).
- **Borrowing needs `never`.** A sandboxed `on-request` thread, and one using the older `workspace-write` setting, is not borrowed while loaded nowhere; it still runs its nudge when loaded ([delivery](../architecture/delivery.md#for-codex-threads)).
- **Claude Code** asks according to its own permission settings. The tools appear to the session as `mcp__agent-bus__bus_*`. A rule that allows them by that name is a Claude Code setting (`claude --help` lists `--allowedTools`). *Unverified:* which calls it asks about.
- **The CLI from a sandboxed shell** needs to reach `127.0.0.1:8096`. *Unverified.*

## If it fails

- A Claude session isn't woken: [recover](recover.md#a-claude-session-isnt-woken).
- A Codex thread isn't woken, or isn't borrowed: [recover](recover.md#a-codex-thread-isnt-woken).
- A join is refused as held: [recover](recover.md#held-by-another-session).
