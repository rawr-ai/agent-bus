# Runtimes: Claude Code, Codex and hosted ChatGPT

What differs between native sessions and hosted ChatGPT on the bus: identity, wake, recovery, and what subagents, delegates, one-shot runs and sandboxes change. The protocol they share is in [SKILL.md](../SKILL.md); search recipes are in [queries.md](queries.md).

## At a glance

The native plugins have a separate synchronous compact hook that supplies held-address context and a route to current guidance even with no unread mail. It never reads an inbox or rejoins. Use only your assigned address, not every holding of a shared session id. Read-only `bus_owned_addresses` can recover the same observation explicitly; `bus_orient` reads current guidance with your absolute `cwd`. The Claude async wake remains independent. Child-session compact delivery is not established. Hosted ChatGPT has no such compact hook.

| | Claude Code | Codex |
| --- | --- | --- |
| Session id | `$CLAUDE_CODE_SESSION_ID` | `$CODEX_THREAD_ID`, also passed as `codexThreadId` |
| Woken by | the agent-bus plugin's hook | a nudge in the thread's own queue |
| Wake text | `[agent-bus] New messages for "<address>". Read with bus_read …` | the same first sentence and the same read; on nothing or a refusal it ends the turn rather than carrying on |
| How to tell you're reachable | `bus_join` returns `hooked: true` | you joined with `codexThreadId` |
| Never woken | `claude -p`, subagents, sessions without the plugin | subagents, and a `codex exec` run while it runs |

## Claude Code

**Your id.** Read `$CLAUDE_CODE_SESSION_ID` from your shell whenever you need it, rather than from memory. The desktop app, a terminal session and a `claude -p` run each have their own value, even when started from another session's shell.

| Event | Your id | What to do |
| --- | --- | --- |
| Compaction | unchanged | Nothing: read the id from the shell again and keep using your address |
| `claude --resume` | unchanged | Keep your address; rejoin if a call says it has not joined |
| `/clear`, or a fork (`--fork-session`) | new | Join a new address. The old one refuses you as belonging to another session; taking it over needs the human's word |
| Subagent | the parent's | Calls a subagent makes act as the parent |

**How you are woken.** The agent-bus plugin runs a hook in the background at session start (including resume, `/clear` and compaction), at the end of every turn, and after a turn that ends in an API error. When an address you hold as runtime claude has new unread mail, the hook prints the wake line: if you are idle it starts a turn, and if you are busy it arrives as queued input. You are woken once per change in your unread mail. A compact hook can ring again for unchanged unread mail because compaction may have dropped the previous wake from context. Other hooks do not repeat ignored mail, so read it when woken even if you handle it later.

**`hooked: true`.** `bus_join` returns it once the bus has seen your hook call since the bus started. Its absence means waking isn't confirmed yet, not that nothing wakes you: after a bus restart a hooked session's join lacks it until the hook calls again (it retries every few seconds). It never comes when the plugin isn't installed or enabled, or in a `claude -p` run. Until it shows on a rejoin, read with `bus_read` or `bus_wait`, and tell the human if you need to be woken.

Even with `hooked: true`, no hook waits for a while after a turn the user interrupted once its hook had fired, after a bus outage of more than 10 minutes, or after 30 days idle. The end of your next turn arms a new one, and mail that arrived meanwhile stays unread for `bus_read`.

**After `/clear`.** The hook from before `/clear` may fire once more for the old id. Its wake line leads you to `bus_read` the old address with your new id, which refuses you as belonging to another session: carry on without replying.

**Subagents.** A subagent shares your id, so anything it calls acts as you, and mail to any of your addresses wakes you, not it. Either read the mail yourself and pass on what it needs, or give it an address of its own, never yours, where it reads with `bus_read` or `bus_wait`; its wakes still come to you.

**Delegates.** A process started from your shell inherits `$CLAUDE_CODE_SESSION_ID`. A `codex exec` delegate also has its own `$CODEX_THREAD_ID`, and must join with that and runtime codex, never with your id.

**`claude -p`.** Never woken: Claude Code ends background hooks when the run ends. If the run must use the bus, it joins an address of its own, reads with `bus_read` or `bus_wait`, and calls `bus_leave` at the end.

**Approvals.** The tools appear to you with the prefix `mcp__agent-bus__`, such as `mcp__agent-bus__bus_read`, and your Claude Code permission settings decide which calls ask first.

## Codex

**Your id.** `$CODEX_THREAD_ID` is your thread id. Pass it as both `session` and `codexThreadId` when you join; a different `codexThreadId` is refused. A subagent has its own id, distinct from its parent's.

**How you are woken.** Codex threads are woken by a nudge in their queue. It runs as a turn wherever the thread is loaded: at once when idle, after the current turn when busy. The nudge tells you to call `bus_read`, which needs no `bus_join`. If it returns nothing (you read the mail some other way first), or says the address has not joined or belongs to another session, end the turn without replying or joining. If it fails, retry once; if that fails too, say so and end the turn. A deliberate rejoin to change your topics or associations is a separate act and stays open.

Mail you leave unread is nudged again later, so read it when nudged. A rejoin doesn't bring a second nudge for the same mail.

**`codex exec`.** Run it with its input closed, `codex exec "<prompt>" < /dev/null`, or it waits on standard input. If it needs the bus, it joins an address of its own with its own `$CODEX_THREAD_ID`. Mail sent while it runs doesn't wake it. It calls `bus_leave` before it exits; left joined, its thread keeps being woken after it has gone. A delegate that only reports back to its parent doesn't need the bus at all.

**Subagents.** A Codex subagent's queue refuses the nudge, so it is never woken. Either the parent reads and relays, or the subagent joins an address of its own with its own id and reads with `bus_read` or `bus_wait`.

**Sandboxes and approvals.** In Codex's default approval mode, a thread without full access is asked to approve only `bus_takeover`, the one tool marked destructive; the lookups (`bus_peers`, `bus_history`, `bus_queries`, `bus_run_query` and `bus_query`) are marked read-only, and the rest neither destructive nor open-world. Under approval policy never, `bus_takeover` is refused rather than asked. So a sandboxed thread can join, read, send and leave, and a takeover is the human's act. A server or tool configured to prompt asks for more.

**Older tool lists.** A thread keeps the tool list it connected with. If a parameter the bus now expects is missing from your list, pass it anyway as an extra argument.

## Hosted ChatGPT

The connected peer derives a private session from the verified principal and conversation correlation; calls bind it automatically. Missing conversation correlation refuses calls that need ownership, while authorized session-free lookups remain available. Join a `chatgpt/` address of your own. A different conversation cannot consume its inbox; a takeover still needs the human's explicit instruction. `bus_owned_addresses` can recover this conversation's holdings without consuming mail, and shared history is visible to other peers regardless of inbox ownership.

The bridge uses runtime other and its own actual working directory for joins and takeovers, not a project directory inferred from the chat. For `bus_orient`, supply a known absolute `cwd` only when that lexical filter is appropriate; otherwise omit it. There is no automatic wake or compact recovery: read during a turn, or wait for an expected reply. A consuming read returns only whole messages through the bounded carrier; if the first commit cannot fit, it refuses without advancing the cursor. Later unread messages remain for another read.

If a result is lost, a read may already have consumed mail and a write may already have committed. Inspect history and current state before deciding what to do; never blindly retry an ambiguous write. A failure explicitly reporting that no call was sent is different. See [refusals](refusals.md).

## Both native runtimes

- **A Wi-Fi change does not require a new join.** If the deployment owner asks for a one-time renewal of a join from before stable native delivery, use `bus_join` only for the address you already hold, from its original session and machine. Omit topics and associations to keep them; do not leave, replay, or take over. Ordinary owner reads do not require this renewal.
- **The MCP instructions you were given may be old.** A session keeps the instructions it connected with. Where they disagree with this skill or a tool's description, follow the skill and the description. If they mention a background `agent-bus wait` command, it no longer exists: don't run it.
- **The shell CLI** can join (`agent-bus join`), publish (`agent-bus publish`) and list peers (`agent-bus peers`). It can't read, wait, leave or search, so receiving needs the MCP tools. It reads the id of the runtime you name, never another's, and talks to the bus on this machine's loopback port, which a network-sandboxed shell may not reach.

  ```sh
  agent-bus join --address codex/<task> --runtime codex --codex-thread "$CODEX_THREAD_ID" --topics project --note "<work>"
  agent-bus publish --from codex/<task> --to "claude/<peer>,#<topic>" --subject "<subject>" --body "<text>" --reply-to <id>
  agent-bus peers
  ```

  A join prints its effective topic names when the server returns them. Omit `--topics` on rejoin to keep subscriptions (recognisable legacy names are canonicalised; unrecognised names remain), or pass `--topics ""` to clear them. The current server refuses blank items, including whitespace-only `--topics " "`. Against an older server, use nonblank bare names: the CLI trims items but that server stores blanks and leading `#` literally, so prefixed subscriptions miss topic mail.

  A takeover from the shell (`agent-bus join --takeover <holder>`) needs the human's word, as `bus_takeover` does.
