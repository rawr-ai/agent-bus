# Frame: simplification pass

## Outcome

The owner approved four removals on 2026-10-27, from the overview's simplification questions. They ship together:
1. **The Codex `Stop` hook is retired.** A Codex thread gets its mail only from its own read, after a nudge.
2. **Fluree is the only production store.** The JSONL ledger becomes test support, and `import-jsonl` goes.
3. **Owner-less presences are ignored.** The legacy ownership rules go.
4. **Origin repo and branch stay, as optional metadata for queries.** The commit-window view they were recorded for, which was never built, is dropped.

Kept, by the owner's decision:
- **`bus_query` and SPARQL,** because the owner plans to grow the ledger's properties (topic, task, action, stack, workstream, constraints, decisions, tags, reference docs) so history can be queried by meaning, not only by text. This frame adds none of them but closes no door.
- **Two locks per address.**

## What it rests on

| Evidence | Source |
| --- | --- |
| With reads approval-free, the nudge alone delivers to idle, busy, clientless and unloaded threads. The hook's remaining effects are inline delivery at a busy turn's end, the empty turn after it, and hiding a failed read | [one-codex-route qualification](one-codex-route.md#qualification-2026-10-27) |
| Codex builds a thread's hooks when it loads the thread (`Hooks::new` at session construction), and nothing reloads them. A loaded thread keeps calling the hook's command after `hooks.json` changes, until its app-server restarts | openai/codex `codex-rs/core/src/session/session.rs` |
| The bus host's `~/.codex/hooks.json` holds only the agent-bus `Stop` hook. `config.toml` holds its trust record (`hooks.state` for `hooks.json:stop:0:0`) beside another project's | Read on the bus host; the other machine is checked at deploy |
| Both machines' `config.json` name a Fluree ledger. The installer writes it only when the file is absent, and re-runs `import-jsonl` on every bus-host install while `ledger.jsonl` exists. Only `serve` and `import-jsonl` open the store. JSONL is otherwise used by the unit tests (injected directly), by isolated `serve`s and by the README's Inspector recipe | `scripts/install-launch-agents.sh`, `src/bin.ts` |
| The ledger holds 60 presences, 9 of them owner-less. Two addresses whose latest presence is an owner-less join are still listed as peers. Both are Claude addresses, already refused to their own sessions (an owner-less presence belongs only to a Codex thread), and silent for about 8 hours. No live Codex address depends on adoption | Folded from `bus_query`, owner values never printed |
| Repo and branch are optional fields, recorded on every send and presence from the address's joined directory. A send's branch can't be recovered later, once its worktree or branch is gone. `git` runs with no time limit under the address's lock | `src/Bus.ts` `originFor` |
| A failing `Stop` hook (exit 1) is recorded as a failure and never blocks a turn. Only exit 2 with stderr, or `decision: block`, continues a turn | openai/codex `hooks/src/events/stop.rs` |

## Decisions

**1. Retire the `Stop` hook in two moves.**
- **This release:**
  - The deploy removes the agent-bus entry from each machine's `~/.codex/hooks.json`. Order doesn't matter: a hook that fails is only recorded, so the worst case is one recorded failure for a turn that ends mid-deploy.
  - `codex-stop-hook` becomes a no-op: it prints nothing and exits 0, without reading its input. A thread that loaded the old hook ends its turns without recording a failure each time.
  - `src/hook.ts`, its transcript check, its tests and the README's install section go.
- **The trust record in `config.toml` stays.** It names a hook that no longer exists and grants nothing, and editing `config.toml` for it isn't worth the risk. The other project's record isn't touched.
- **A later release removes the no-op command,** once every Codex app-server (the desktop app's and the daemon) is seen to have started after this deploy (`ps -o lstart`). A running daemon never updates itself, so this can't be assumed. Removing it early costs only recorded failures.
  - Rejected: deleting the command now. Simpler, but every loaded thread would record a failure at each turn end until its app-server restarts.
  - Rejected: two deploys (the no-op first, then the deletion). It guards only against one recorded failure.
- **The cost accepted:** a busy thread gets its mail in the nudged turn after its current turn, not inline at that turn's end. That turn is no longer empty.
- **The Director is told before the deploy.**

**2. `formatDelivery` moves to `client.ts`,** beside `waitFor`. `agent-bus wait` is now its only user ([one-codex-route](one-codex-route.md), decision 6).

**3. Fluree is the only production store.**
- The store opens only with a `fluree` entry in `config.json`. Without one, `serve` exits with a message naming the file and the entry it needs. The installer writes the file only when it is absent, so the message gives the entry rather than pointing at the installer. Meanwhile clients see an unreachable bus (`wait` keeps retrying), and the diagnosis is in `serve`'s log.
- The JSONL ledger moves to `test/` as test support. `Cursors.layerFiles` stays in `src/`, because the Fluree cursors use it.
- `import-jsonl` goes, with the installer step that ran it. It migrated the JSONL ledger into Fluree, and that is done. The old `ledger.jsonl` and `cursors/` files stay on disk, and nothing reads them.
- An isolated `serve` (the README's Inspector recipe, or qualification) runs against an in-memory Fluree without auth (`fluree server run --memory`), on its own ports, and the bus creates its ledger. The startup refusal is a unit test that spawns `serve`.
- The JSONL ledger's own tests go: they test a fixture's handling of concurrent writers.

**4. Owner-less presences are ignored.**
- The fold skips every presence without an owner. `owns` becomes a session comparison, and the two legacy refusal texts go. A leave always records its owner.
- The effect:
  - an address whose history is only owner-less isn't joined;
  - an address with an owned presence keeps that state, as today.
- `session` stays optional in the schema, so old presences still decode and the ledger needs no rewrite.
- **The cost:** the two stale Claude addresses leave the peer list. If their sessions return, a plain join succeeds and starts at the present. Mail sent to them since their last read stays in `bus_history` but isn't carried over; today a takeover would carry it.

**5. Origin repo and branch stay, as optional metadata.**
- They are still recorded on every send and presence, from the joined directory, because a session can switch branches and the branch can't be recovered later.
- Each `git` call gets 2 seconds; a field it misses is left out, so a hung `git` can't hold the address's lock for long.
- They are stored as `bus:repo` and `bus:branch` and are queryable through `bus_query`.
- Docs, comments and memory drop the commit-window purpose. `cwd` and `host` stay.
- Rejected:
  - recording them once at join, which misses branch switches;
  - dropping them, which loses workstream context that can't be reconstructed.

**6. Every claim of the retired pieces goes,** in code comments, docs, `AGENTS.md` and memory:
- the hook's connection, policy and protocol-failure fallback;
- the offline-import exception to "one process opens the store";
- the commit-window purpose.

`NUDGE_TIMEOUT` keeps its value. Its rationale is restated against the CLI's 30-second call, since nudges, reads and replays share the address's lock.

## Not doing

- New ledger properties. That is a later frame, with the owner.
- Removing the no-op hook command, until the app-servers have restarted (decision 1).
- Deleting the old JSONL files on the machines.
- The host-armed Claude wake, which has its own session.
- Deriving `codexThreadId` from the runtime. Once the legacy rules go, it must equal `session`, so it is only a "wake me" flag. That is the next candidate.

## Qualification

Unit tests:
- **The fold, with unread mail seeded and cursors left alone:**
  - owned, then owner-less;
  - owner-less, then owned;
  - owner-less only (joined, then left);
  - a stale takeover argument.
- **`codex-stop-hook`** prints nothing and exits 0, whatever its input.
- **`serve` exits with the message** when `config.json` is missing, and when it lacks the entry.
- **`wait`** still prints deliveries as before.

After deploy:
1. **Both machines:** `hooks.json` has no agent-bus `Stop` entry, other hooks are untouched, and `config.toml` is unchanged. Each machine runs the release.
2. **A throwaway daemon thread loaded before the deploy:** a turn after the deploy ends normally, with no hook failure.
3. **A busy throwaway daemon thread:** mail sent mid-turn is read with `bus_read` in the nudged turn after it, and that turn isn't empty.
4. **The peer list** no longer shows the two stale addresses. An owned address's refusals are unchanged.
5. **The README's Inspector recipe** runs as written.
6. **The trust record** for the removed hook still carries a hash, so a future hook at the same position isn't trusted by it.
7. **The Director,** observed: woken by the release note.

## Qualification (2026-10-27)

Deployed to both machines at 48477d6, after the Director was told. All verified live, except where marked.

| Check | Result |
| --- | --- |
| **1. Both machines** | Each `hooks.json` lost exactly the agent-bus `Stop` entry. The other machine's other hook (`PreToolUse`) is untouched, and `config.toml` is unchanged on both (same hash before and after). Both run the release, healthy, with no errors in `serve`'s log since the restart |
| **2 and 3. A throwaway daemon thread loaded before the deploy, busy when its mail came** | Its busy turn ended with no hook failure recorded. The nudge then ran as its own turn and read the mail with `bus_read`, so that turn wasn't empty. One nudge |
| **4. The peer list** | The two stale owner-less addresses are gone; every live peer is listed as before |
| **5. The Inspector recipe** | `serve` came up healthy on an in-memory Fluree, served all eight tools and accepted a join (before the deploy) |
| **6. The trust record** | Still present with its hash on both machines |
| **7. The Director** | Told before the deploy. It read the release note from one nudge within 12 s, with no warnings |

The no-op command stays until every Codex app-server has started since the deploy. The owner's desktop app restart covers its threads. The daemon restarts on its own schedule.

## Review adjudication

GPT-6 Astra, GPT-6.1 Sol and an Opus simplicity pass.

Taken:
- the config repair message (Sol, Astra);
- isolated runs on an in-memory Fluree, and the startup test (Sol, Astra, Opus);
- the fold matrix (Astra);
- the full list of stale claims (all three);
- the `git` limit (Opus);
- three corrections to this frame's evidence (Opus).

Declined:
- **Deleting the hook command now** (Opus) and **two deploys** (Astra). A failing hook never blocks, so both trade a small no-op for either recorded failures or a second deploy; see decision 1.

Code review: GPT-6.1 Sol and Opus. Taken:
- **The no-op hook does nothing at all.** It no longer reads its input: a failing stdin could escape to stdout and exit 1, and Codex ignores an unread input (Sol, Opus).
- **The fold matrix seeds pre-owner cursors and unread mail,** and aims an owner-less join id at a live owner. A mutant that carried a cursor over on any takeover argument passed the old matrix and fails the new one (Opus, Sol).
- **The spawn tests have a timeout** and assert the message alone (Opus).
- **Unused imports, stale verified rows and the coverage claim** are fixed (Sol, Opus).

Declined:
- **An unconditional `session` on a leave.** The fold guarantees it, but the type doesn't, and the stored result is the same.
