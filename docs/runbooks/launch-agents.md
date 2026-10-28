# Launch agents

Use this to start Claude and Codex sessions the bus can wake, and delegates, subagents and one-shot runs that should or shouldn't join. Which sessions are woken, and why, is in [delivery](../architecture/delivery.md#will-a-session-be-woken).

## Before you start

- **The bus is healthy** ([operate](operate.md#check-that-the-bus-is-healthy)), and each runtime on the machine knows the MCP server: [install](install.md) registers it. Check both, read-only:

  ```sh
  claude mcp get agent-bus
  codex mcp get agent-bus
  ```

  Expect the URL `http://127.0.0.1:8096/mcp` and, for Claude, `Status: ✔ Connected`. *Checked read-only on this machine (2026-10-28): expected both; observed both.*

- **Pick the kind of session.** A session is woken only if it is one of the first three:

  | You start | Woken? |
  | --- | --- |
  | A Claude Code session in the desktop app or a terminal, with the agent-bus plugin | Yes, within seconds |
  | A top-level Codex thread: a desktop Local thread, the `codex` TUI, or a desktop SSH project | Yes, while it is loaded; once unloaded, only if it is eligible to borrow |
  | A `codex exec` run | Mail sent after it exits, yes; while it runs, no |
  | `claude -p`, a subagent, or any other client | No: it reads with `bus_read`, or `bus_wait` within a turn |

- **An address belongs to one session.** Pick one specific to the session, such as `claude/<project>-<task>` or `codex/<task>`. Groups share a `#topic`. The session id is the runtime's own variable, read from the session's shell: `$CLAUDE_CODE_SESSION_ID` or `$CODEX_THREAD_ID`. Never invent one ([messaging](../architecture/messaging.md#rules)).
- **No sessions were started to write this page.** They would appear in the owner's apps. Every step that needs one is marked unverified, with what was checked in its place: the code, the platform pages, `--help`, or a rehearsal of the same calls with a made-up session on an isolated bus.

## Start a Claude session the bus can wake

1. Check that the plugin is installed and enabled on this machine ([install](install.md) installs it).

   ```sh
   claude plugin list
   ```

   Expect `agent-bus@agent-bus` with `Status: ✔ enabled`. *Checked read-only on this machine (2026-10-28): expected it enabled; observed that.*

2. Start the session in the desktop app, or run `claude` in a terminal. Not `claude -p`: Claude Code ends async hooks when a run ends, so a `-p` run is never woken. The hook arms at the session's start, including a resume. `claude --resume` keeps the session id, so the session still owns its address; `--fork-session` and `/clear` give it a new id, which owns nothing until it joins ([platforms: Claude Code](../platforms/claude-code.md#session-ids)). *Unverified: no session was started. `claude --help` was checked for `-p`, `--resume` and `--fork-session`.*

3. Join with an address of its own and its own session id. The agent does it with the `bus_join` tool (`runtime: claude`, `session` from `$CLAUDE_CODE_SESSION_ID`, `cwd`). From a shell inside the session, the CLI reads the variable itself:

   ```sh
   agent-bus join --address claude/<project>-<task> --runtime claude --note "<what you are working on>"
   ```

   A held address is refused: pick another ([recover](recover.md#held-by-another-session)). *Rehearsed with a made-up session: expected the join to return the address and a cursor; observed that. Unverified with a real session.*

4. Check that it is armed. The join result carries `hooked: true` once `serve` has seen the session's hook. A rejoin by the same session is harmless and keeps its unread mail, so ask the session to join again and read the field.

   *Rehearsed with a simulated hook: expected no `hooked` before the hook had called, and `hooked: true` after; observed both. Unverified with a real session.*

5. That is all. The session needs no background command and no loop. When mail arrives, its hook wakes it with a line telling it to call `bus_read`; it reads, answers with `replyTo` and carries on. *Rehearsed for the hook: expected the wake line and exit 2; observed both. Unverified for a real wake, which needs a real session.*

A Claude session is also not woken when it has no plugin; after an interrupted turn until its next turn ends ([recover](recover.md#a-claude-session-isnt-woken)); and under an address its old id held (after `/clear` or a fork). A Claude subagent shares its parent's id, so mail to its parent's address wakes the parent.

## Start a Codex thread the bus can wake

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

   `-a` and `-s` are listed by `codex --help`. Whether `-s workspace-write` records a profile that qualifies wasn't checked: the log tells you ([recover](recover.md#why-a-thread-isnt-borrowed)). A thread that is not eligible still gets its nudge, and runs it when someone next loads the thread. *Unverified: no thread was started. The options were checked against `codex --help`.*

2. Join from inside the thread with its own thread id as both `session` and `codexThreadId`. The agent does it with the `bus_join` tool (`runtime: codex`, `session` and `codexThreadId` from `$CODEX_THREAD_ID`, `cwd`). From the thread's shell, the CLI reads the variable for `--session`:

   ```sh
   agent-bus join --address codex/<task> --runtime codex --codex-thread "$CODEX_THREAD_ID" --note "<what you are working on>"
   ```

   Without `codexThreadId` the thread is not woken. A `codexThreadId` that differs from `session` is refused. *Rehearsed for the refusal: expected "codexThreadId must be your own thread id, the same as session." and no peer; observed both. The join of a real thread is unverified: an isolated bus reads the real `~/.codex`, so a Codex address on it would post nudges into real threads.*

3. Check that it is woken. From another address, send the thread a message, then look in `serve`'s log:

   ```sh
   agent-bus publish --from <your address> --to codex/<task> --body "test"
   grep 'codex/<task>' ~/.agent-bus/agent-bus.log | tail -n 5
   ```

   Within seconds (the 15 s tick at most) expect `Waking codex/<task>: queued a nudge, …`. Then the thread runs a turn that reads the message. Any other line has its row in [recover](recover.md#a-codex-thread-isnt-woken). *Unverified: it needs a real thread. The log lines were seen on the running bus for other threads.*

Leave the thread's mode, permissions and approval policy alone after the join: changing them can make it ineligible, and a turn the owner interrupts makes its mail wait for new input. Subagents are never woken: a Codex subagent's queue refuses the nudge (see the next section).

## Delegates, subagents and one-shot runs

A process started from a session's shell inherits that session's ids, and acts as the session if it reads the wrong variable ([platforms: Codex](../platforms/codex.md#thread-ids-and-codex_thread_id), [messaging limits](../architecture/messaging.md#limits)). So a delegate either joins an address of its own, or doesn't join at all.

1. A `codex exec` delegate. Run it unattended with its prompt as an argument and its input closed, because it reads standard input when that isn't a terminal and waits.

   ```sh
   codex exec "<prompt>" < /dev/null
   ```

   If it needs the bus, it joins its own address as a Codex thread (the section above, with its own `$CODEX_THREAD_ID`), and leaves with `bus_leave` before it ends. Left joined, the reconciles keep waking its thread. Mail sent while it runs isn't woken: the run may take a nudge and exit mid-turn, which leaves the thread interrupted, so it isn't borrowed until it gets new input. Mail sent after it exits is borrowed like any thread loaded nowhere, if it is eligible. A delegate that only reports back can skip the bus, and let its parent read its output. *Unverified: no delegate was run. The standard input behaviour is verified live on the platform page; the options were checked against `codex exec --help`.*

2. A `claude -p` run. It is never woken. If it must use the bus, it joins its own address and reads with `bus_read`, or `bus_wait` within the run, and leaves at the end. Its session id is its own, even when started from another session's shell. *Unverified: no run was started. The platform page records that `-p` ends async hooks.*

3. Subagents of either runtime. Don't join them. A Claude subagent shares its parent's session id, so it would act as the parent. A Codex subagent has its own id, but its queue refuses the nudge: `serve` logs `Not waking <address>: its Codex thread takes no direct input`, and its mail stays unread until a `bus_read`. Have the parent read the mail and pass it on. *Unverified: no subagent was started. The refusal text is read in code.*

## Sandboxes and approvals

Whether a session is asked to approve a bus call depends on the runtime and its sandbox.

- **Codex, without full access, under default approvals:** no bus tool asks except `bus_takeover`, which is marked destructive and is refused under approval policy `never`. So a sandboxed `never` thread can join, read, send and leave, but can't take an address over: that is a human's act from a shell ([recover](recover.md#held-by-another-session)). The table of every tool is in [interfaces](../architecture/interfaces.md#tool--annotation--approval), and Codex's rule in [platforms: Codex](../platforms/codex.md#approvals-for-mcp-tools). *Unverified: no thread was started. The annotations were read from the tool list through the MCP Inspector on an isolated bus.*
- **Borrowing needs `never`.** A sandboxed `on-request` thread, and one using the older `workspace-write` setting, is not borrowed while loaded nowhere; it still runs its nudge when loaded ([delivery](../architecture/delivery.md#for-codex-threads)).
- **Claude Code** asks according to its own permission settings. The tools appear to the session as `mcp__agent-bus__bus_*`, as in this tool list. A rule that allows them by that name is a Claude Code setting (`claude --help` lists `--allowedTools`); which calls it asks about wasn't verified.
- **The CLI from a sandboxed shell** needs to reach `127.0.0.1:8096`. *Unverified.*

## If it fails

- A Claude session isn't woken: [recover](recover.md#a-claude-session-isnt-woken).
- A Codex thread isn't woken, or isn't borrowed: [recover](recover.md#a-codex-thread-isnt-woken).
- A join is refused as held: [recover](recover.md#held-by-another-session).
