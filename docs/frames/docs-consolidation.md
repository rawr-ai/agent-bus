# Frame: docs consolidation

## Outcome

agent-bus's knowledge is organised in three layers, each with a fixed set of homes, so that later changes update a page that already exists instead of reshaping the docs:

1. **Reference:** what agent-bus is and does (`docs/architecture/`, one concern per page), and the platform behaviour it rests on (`docs/platforms/`).
2. **Entry points:** a concise README that says what agent-bus is, why it exists, what it compares with and how to install it; an overview that shows how the parts fit; and runbooks for operating it.
3. **The agent skill:** what an agent needs to use the bus well, shipped in the `agent-bus` plugin, so sessions aren't taught the protocol in every prompt.

A reader can understand the system without opening a release frame, an operator can run and recover it from the runbooks, and an agent can use the bus from the skill. Every fact has one home, and a written rule says where a new one goes.

This frame decides the structure and the work plan. It doesn't write the pages.

## What it rests on

A census on 2026-10-28 read all 22 Markdown files (2,971 lines), the agent-facing text in code (MCP instructions, tool descriptions, wake texts, refusals, CLI help), the plugin, the scripts and the 29 repo memories. Astra and Fable then gave independent proposals for the organisation (see [Reviews](#reviews)). The census found:

- **The reference material is mostly right.** The earlier split of platform facts (each with basis and version) from agent-bus's decisions works. The weak spots are mixing and repetition. The README and the overview each carry three layers. Borrow eligibility and the limits on what `serve` may do are stated in four places: delivery, Codex hosting, connections and the MCP instructions. Dated versions and measurements sit inside pages meant to be timeless.
- **The ten frames (1,807 lines) are history.** The current docs already restate nearly all their final decisions. A short list of content lives only in frames ([migration map](#migration-map)). Two chains of frames reverse each other, so no single frame is safe to read as current truth.
- **Runbooks are the largest gap.** There are no literal commands to restart `serve`, no deploy procedure (its one constraint, "the primary checkout runs only a deployed main", lives only in repo memory), no guide to launching a reachable agent, no health check, no log vocabulary (log lines exist only in code), no Codex or Claude Code upgrade steps, and no recovery guide. Install and the Fluree upgrade are covered.
- **There is no skill.** An agent learns the bus from one ~400-word MCP instructions paragraph, which mixes etiquette with borrow rules it can't act on, and from terse tool descriptions. A long-running session keeps the instructions it connected with: this session still shows a retired `agent-bus wait`, which current `serve`s no longer send.
- **Plugins can carry the skill.** The Claude plugin today ships only hooks. Codex 0.164 plugins can carry `skills/<name>/SKILL.md` and an `.mcp.json` with `mcpServers` (read in code: the source's plugin tests). A long skill body appears to be truncated, so the skill stays short and puts depth in references.

## Decisions

### 1. The structure

```
README.md                    what it is, why it exists, compared with what, install in brief, where to go next
AGENTS.md                    contributors: toolkit, invariants, memory, verification, the placement rule (decision 2)
docs/
  overview.md                how the parts fit: the model, one diagram, reading order, which page owns each topic
  architecture/              what agent-bus does, one concern per page
    topology.md              machines, processes, transports, where state lives
    messaging.md             addresses, sessions and ownership; topics and replies; the ledger and cursors
    delivery.md              waking: the Claude hook; the Codex nudge, borrow, removal, eligibility and reconcile
    interfaces.md            the MCP tools and parameters, annotations, refusals, the CLI, configuration and environment
    connections.md           trust boundaries, and what serve may do to a thread
  platforms/                 the behaviour of Codex, Claude Code and Fluree that agent-bus rests on
    README.md                installed versions, the findings register with recheck triggers, how claims are marked
    codex.md, claude-code.md, fluree.md
  runbooks/
    install.md               prerequisites, the bus host, another machine, registering MCP and the plugin
    operate.md               start, stop, restart, health, logs and their meaning, an isolated bus for checks
    deploy.md                the primary-checkout rule, fast-forward, restart, verify, roll back
    launch-agents.md         starting sessions the bus can wake, delegates, subagents, one-shot runs
    upgrade.md               Codex, Claude Code, Fluree and the plugin: what to recheck
    recover.md               symptom, check, fix, verify
  frames/                    release records, frozen at their paths; README.md indexes them
  research/                  investigations, frozen; indexed from frames/README.md
plugin/skills/agent-bus/
  SKILL.md                   the agent protocol, short
  references/                runtimes.md (Claude and Codex specifics), queries.md (history and SPARQL recipes)
```

- **Kept names and paths:** `architecture/`, `platforms/` (plural: the folder is a collection of platforms), `frames/` and `research/`. Renaming costs link churn and buys nothing.
- **Moved:** `docs/connections.md` moves into `architecture/`, because it describes agent-bus's own trust boundaries. `architecture/codex-hosting.md` is folded and removed:
  - its reasons go to delivery's Why section;
  - its Codex facts go to `platforms/codex.md`;
  - its machine prerequisites go to install;
  - the unload setting goes to operate;
  - the wedged daemon goes to recover.
- **New:** `messaging.md` and `interfaces.md` take the reference sections out of the README and the overview. `runbooks/` is new.
- **Roles:**
  - The README sells and installs, then routes: it carries no rules or reference tables.
  - The overview explains how the parts fit and maps each topic to its owner.
  - AGENTS.md governs contributors and holds the placement rule.
  - The skill is for bus users, not contributors.

### 2. The placement rule (the axes)

Content is placed first by its kind, then by the stable concern or task it serves. It is never placed by release or by runtime. The rule lives in AGENTS.md, which every contributing agent reads:

| A new… | goes to | never |
| --- | --- | --- |
| fact about how Codex, Claude Code or Fluree behaves | `platforms/<platform>.md`, with its basis and version, and a row in the findings register when it can change on upgrade | restated elsewhere; other pages link to it |
| rule, behaviour, reason or limit of agent-bus | the `architecture/` page that owns the concern, in that page's fixed section | a second architecture page, the README or the overview |
| procedure an operator follows | `runbooks/<task>.md` | inside reference pages, beyond a link |
| guidance for agents using the bus | the skill, and if it is a single call's contract, that tool's description | the MCP instructions, beyond the essentials (decision 6) |
| plan, measurement, qualification or review of a release | that release's frame | current pages, except a verified limit or fact promoted to its owner |

- **A change usually carries several facts,** one per facet: the contract (interfaces and the tool description), the rule (its architecture page), agent guidance (the skill), the platform claim (platforms) and the procedure (a runbook). Each facet goes to its own home. A frame's closing checklist (decision 4) lists all five, so a writer doesn't stop at one page.
- **Versions appear only in `platforms/`.** There are two exceptions:
  - a binding requirement, such as "needs a Codex CLI with the queue methods", is stated where it binds;
  - a frame records the versions its experiments ran on.
- **Measured numbers stay with their evidence.** A current page states a constant from code ("6 s") and links to the platform page for anything measured. A platform claim, or a row of the findings register, may cite the frame whose experiment established it. That is provenance. No current page relies on a frame for a current rule.
- **A new page appears only for a new concern or task** that no page covers. When a page grows, its internal structure improves first.
- **Writing goes against the vocabulary of the existing pages.** Addresses, sessions, joins, runs of joins, nudges, borrows and reconciles keep one name each.

### 3. A fixed shape for each kind of page

The shape is the axis that page grows along, so updates land in a known place:

- **Architecture page:** a scope line saying what it covers and where its neighbours are, then:
  - **What it does:** the mechanism, with its diagram.
  - **Rules:** numbered, so other pages can cite them.
  - **Why:** the current choice and the alternatives rejected, one or two sentences each.
  - **Limits:** what it doesn't do and the known gaps.
  - **Rests on:** the platform claims, linked.
  - **History:** a footer linking the frames that made it, and never needed for current truth.
- **Platform page:** as now, each claim marked with its basis and version.
- **Runbook:** when to use it, before you start, steps with literal commands, how to check, and if it fails (linking recover).
- **The skill:** sections an agent can scan mid-task. Depth goes in its references.

### 4. History

- **The frames stay frozen at their paths.** Memory, platform pages and code comments cite them as evidence. Only their links may be fixed, never their decisions.
- **`frames/README.md` indexes them,** with date, what each decided, what superseded it and the current owner page. It also holds the table of retired mechanisms: the Codex Stop hook, the daemon deliverer, the background `wait`, the JSONL production store and owner-less ownership, each with its replacement and reason.
- **Decisions live in the Why section of their concern's page.** They don't get a separate decision-record directory, which would restate those Why sections and recreate the duplication this frame removes.
- **Future releases still write frames,** in `docs/frames/`, for design-and-qualification work. Each frame gains a closing "Moved into current docs" checklist, with a row for each of the five facets of decision 2, and its release isn't done until that checklist is. Routine changes need no frame. They update the owners in their own PR.

### 5. Entry points

- **The README:**
  - what agent-bus is, in a paragraph;
  - why it exists: the research verdict that MCP alone can't wake an idle session, with a "compared with" table drawn from the research's field survey and marked with its date;
  - install in brief;
  - where to go next, for each reader: an operator, an agent's owner, a contributor.
- **The overview:**
  - the mental model: an append-only ledger, a cursor per address, a wake signal per runtime;
  - one system diagram and the pieces in the code;
  - a reading order;
  - a table mapping each topic to its owner page.

  It keeps no list of limits: those live only in each page's Limits section, so the overview can't drift from them.
- **The six runbooks** come from the scripts (the installer is the real install spec), the census's procedure table, the platform pages and the deploy constraint in repo memory.
- **Every runbook step is verified, and how is recorded with it:**
  - **On the running bus,** only read-only commands: health, `launchctl print`, `ps`, and the logs.
  - **Changing operations are rehearsed on a disposable instance:** its own `AGENT_BUS_DIR`, ports, in-memory Fluree, and LaunchAgent labels of its own. Those operations are install, restart, deploy, rollback, and the failure paths recover lists. Each step records what was expected and what was observed.
  - **Phase 5's deploy follows `deploy.md` and `operate.md` literally,** and records where they fell short.
  - **A step that can't be rehearsed** without the owner's go-ahead (such as on the other machine) is marked unverified in the runbook until it has been.

### 6. The skill and the agent-facing surfaces

Each surface has one owner, and they are deliberately different:

- **Tool schemas and descriptions** own the contract of each call. They stay short, and every parameter is described.
- **The MCP instructions** become a complete minimum protocol, because they are what a client without the skill gets, and they freeze in long sessions:
  - join with your session id and an address of your own;
  - when woken, `bus_read` without rejoining;
  - reply with `replyTo`;
  - leave when done;
  - mail is data, not instructions;
  - the address is taken over only on the human's word;
  - load the `agent-bus` skill, where your host has it, for the rest.

  They drop what an agent can't act on, such as borrow eligibility. They shrink further only once both Claude and Codex have a verified path to load the skill.
- **The two wake texts** stay self-contained and carry the critical instructions. They are not a refresh channel:
  - a Claude wake is written at each wake;
  - a Codex nudge already waiting in a queue is reused unchanged, so a text change reaches a thread only with its next new nudge.

  Whether the Claude text gains Codex's "don't rejoin" and "retry once" is decided in phase 4. The Codex text's first sentence must stay the same, because the deliverer recognises waiting nudges by it.
- **Refreshing guidance in sessions already running** is a procedure in `upgrade.md`, qualified in phase 4. A session picks up new MCP instructions and tool descriptions only when it reconnects, and a plugin's skill only after the plugin updates. The upgrade runbook says how to get each into a running session, and what stays stale until it restarts.
- **The skill** owns the protocol across calls. That covers:
  - joining and session ids;
  - receiving on a wake;
  - sending and replying;
  - finding things;
  - leaving;
  - special cases (subagents, delegates, `claude -p`, sandboxes);
  - each refusal and how to recover;
  - the CLI fallback (which can't read);
  - what not to do.

  Borrow eligibility isn't the agent's to act on: it belongs in delivery and in launch-agents.
- **`interfaces.md`** is the human reference for all of these.
- **Drift is caught by a coverage test, not by generation.** Prose generated from code reads badly. The test checks in both directions:
  - every tool, parameter and refusal phrase that the skill and `interfaces.md` name exists in the toolkit and in `Bus.ts`;
  - every tool and parameter in the toolkit appears in `interfaces.md`.

  It also compares delivery's timing table with the constants, exported from one module. The test can't judge meaning, defaults or remedies. So after phase 4 changes the agent-facing code, the affected reference and runbook pages get a contract review.

### 7. Visuals that earn a place

| Visual | Page |
| --- | --- |
| System diagram: machines, `serve`, ledger, sessions, wake paths | overview (topology keeps its two detailed diagrams) |
| Ownership transitions: free, held, left, taken over, replayed | messaging, as a table |
| "Will this session be woken?" flowchart, and the per-kind table | delivery (exists) |
| Claude hook and Codex post-and-borrow sequences | delivery (exist) |
| State machine for a Codex address's wake state: run of joins, posted, covered, reconcile due, removed, backed off | delivery (new) |
| Timing and limits table: every timeout, retry and schedule, checked against code by the coverage test | delivery (new) |
| Tool × annotation × "asks for approval in a Codex sandbox" | interfaces |
| Who may do what to whose thread or queue item | connections |
| Symptom → check → fix | recover |
| Findings × version × basis × recheck trigger | platforms/README (exists; gains the trigger column) |

### 8. A maintained check

`scripts/check-docs.ts`, run by `bun run check`, verifies:

- every relative link and anchor in the Markdown resolves;
- every current page has its scope line;
- the overview's topic table names every architecture, platform and runbook page;
- a current page links into `frames/` or `research/` only from its History footer, or, on a platform page, as the evidence cited by a claim or register row.

Phase 1 ships the last check with an allowlist of today's links, and phase 2 empties it. The coverage test of decision 6 lives in `test/`.

## Migration map

Where today's content goes. The per-file census reports in this release's scratch area hold the line-level detail.

| Today | Goes to |
| --- | --- |
| README: intro and stack | README (what, why); overview (stack and pieces) |
| README: dev commands; CLI table; tool table | AGENTS.md (dev); interfaces (CLI, tools) |
| README: addresses belong to sessions | messaging Rules; the skill (etiquette) |
| README: registering MCP and the plugin; setup and other machines | install |
| README: MCP Inspector recipe | operate (an isolated bus for checks) |
| README: how sessions are woken | delivery (README keeps one sentence) |
| README: security; ledger model | connections; messaging |
| README: known gaps; next | the owners' Limits; README one line |
| overview: model, pieces | overview, without hard-coded sizes or dated versions |
| overview: identity and ownership policies | messaging Rules |
| overview: open gaps and limits | each owner's Limits section |
| overview: simplification questions | frames/README (answered); messaging Limits (Q9, `codexThreadId`, still open) |
| connections | architecture/connections. It gains the desktop IPC router's exposure, now only in desktop-wake-spike, as a trust row. For the own-nudge removal it has one row citing delivery's numbered rule |
| nudge-hygiene: the owner's own-nudge-removal policy and its residual race | delivery Rules and Limits |
| topology | topology; log paths and LaunchAgent labels also as commands in operate |
| codex-hosting | folded and removed (decision 1) |
| delivery | delivery in the fixed shape. It gains the four limits missing everywhere: the per-address empty-turn bound, unread mail re-read on every pass, an unknown queue item shape, and one `serve` per machine. It also gains, in Why, the choice of a 5 s release rather than 0 |
| nudge-hygiene: topics kept on a rejoin that names none | messaging Rules |
| platforms/README | the same, plus the recheck column |
| platforms/codex.md | gains these facts, from frames:<br>- hooks are built once at thread load, and a failing hook never blocks;<br>- the `CODEX_THREAD_ID` facts;<br>- the desktop IPC router;<br>- the daemon's open-file limits;<br>- what happens in the gap after a release, which 5 s rather than 0 rests on;<br>- the full list of persisted status events;<br>- what a plugin can carry, and the skill-length truncation, verified in phase 4 |
| codex-wake, load-on-mail: daemon file-limit and restart operations | operate and upgrade |
| platforms/claude-code.md | gains, from frames:<br>- the session inbox socket;<br>- channels (terminal only);<br>- `CLAUDE_CODE_SESSION_ID` in desktop, `-p` and inherited shells;<br>- the hook timeout kill;<br>- `SessionStart` starting a turn;<br>- a plugin's MCP server renaming tools |
| platforms/fluree.md | resolves its two disagreements with the README (the subject-less token on the event stream, the search delay after creation) by recording one verified status |
| research | stays as history; its verdict and comparison feed the README |
| MCP instructions, tool descriptions, wake texts, refusals | the skill; interfaces; shortened instructions (decision 6) |
| installer, `qualify-fluree`, `package.json` scripts | install, operate, upgrade |
| repo memory | the deploy constraint goes to deploy. Entries that only restate docs are updated to point at their page. Developer traps stay |
| frames | frozen; indexed in frames/README; their unique content as listed above |

## The workstream

Each phase ends with a review loop: the writers' result goes to two reviewers on the bus, findings are adjudicated, and the phase is committed on the `docs-consolidation` branch. Writers are subagents working on disjoint files. Opus writes judgment-heavy pages (delivery, messaging, the skill, the README); Sonnet writes mechanical moves and procedure-heavy pages. Reviewers get the diff and the page-level question, never bulk reading. Every factual claim is checked against the code at HEAD or its platform page. The owner reads the frame now and the result at the end, and sees each phase's summary.

| Phase | Work | Review | Done when |
| --- | --- | --- | --- |
| 0. Frame | census, two proposals, this frame, one review round | Astra, Fable | the owner accepts the frame |
| 1. Skeleton and checks | create directories and stubs with scope lines and section headings; move connections; write `frames/README.md` with the retired table; put the placement rule and page shapes in AGENTS.md; write `check-docs.ts`, with its frame-link allowlist, and wire it into `check`; update links | Sol (nothing lost, links right) | `bun run check` passes; every moved paragraph exists at its new home |
| 2. Reference | overview, topology, messaging, delivery, interfaces, connections, the three platform pages; fold codex-hosting; land the migration map; add the visuals; empty the allowlist | Opus (accuracy against code and platform pages), Fable (information design and reading), Sol (nothing lost from the removed text) | every map row is landed; the allowlist is empty; no current page needs a frame for current truth |
| 3. Entry points | README; the six runbooks; read-only checks on the running bus; changing operations rehearsed on a disposable instance (decision 5) | Astra (operator and platform correctness), Fable (clarity), Sol (nothing lost from README and overview) | every step is rehearsed with expected and observed results, or marked unverified |
| 4. The skill | `plugin/skills/agent-bus/` with its references; the MCP instructions as a complete minimum protocol; every tool parameter described; the wake-text decision; the coverage test with exported constants; the refresh procedure in `upgrade.md`; align the two version strings in code (0.2.0, 0.1.0); verify how Codex loads a plugin's skill, and the skill-length truncation, recorded in platforms | Sol and Opus (code), Fable (the skill's prose), then a contract review of the affected pages | `check` and the coverage test pass. A throwaway Claude session loads the skill from the installed plugin's cached copy after a plugin update, not from the checkout. Deploying `serve` waits for the owner's go-ahead |
| 5. Close | trim repo memory against the new pages; final overview map and frames index; full check; deploy by following `deploy.md` and `operate.md` literally, recording where they fell short; this frame's results and "Moved into current docs" checklist | Astra, Fable (whole read) | the owner reviews, then main fast-forwards; `serve` restarts only if phase 4 changed code |

## Results (2026-10-29)

| Phase | Commits | What landed | Reviews |
| --- | --- | --- | --- |
| 1. Skeleton and checks | e53cbcf | `connections.md` moved into `architecture/`; stubs for messaging, interfaces and six runbooks; the placement rule and page shapes in AGENTS.md; `frames/README.md` with the retired table; `scripts/check-docs.ts` in `bun run check`, with its own tests | Sol: revise, six findings, all applied (the parser missed multi-line and reference links) |
| 2. Reference | f988d09, d2fe05d | Five architecture pages in the fixed shape; codex-hosting folded and removed; delivery's wake-state diagram and timing table; the platform pages gain the facts that lived only in frames and a recheck column; both allowlists emptied | Opus: revise, 14 accuracy findings; Fable: accept with trims; Sol: revise, one weakened fact and four facts with two homes. All applied |
| 3. Entry points | 160e37b, b7560da | The README (55 lines, from 133); six runbooks, each step marked rehearsed, checked read-only or unverified; installer overrides for a disposable instance | Astra: revise (rollback not repeatable, an old installer could escape a rehearsal, a daemon restart can lose started turns, `codex exec` holds a thread); Fable and Sol: revise. All applied |
| 4. The skill | 475a30c, 7b245fb | `plugin/skills/agent-bus/` (SKILL.md under Codex's 8,000-byte cut); the MCP instructions as the minimum protocol (495 → about 230 words); every parameter described, with bounds; Claude's wake text says don't rejoin and retry once; `src/timing.ts` and `src/version.ts`; the coverage test; five bug fixes | Opus: accept; Sol: revise (the coverage test passed several wrong pages); Fable: revise lightly. All applied |

- **Measured:** 22 Markdown files and 2,971 lines before; 34 files after, with 3,659 lines of current pages, the skill, the README and AGENTS.md, and the frames unchanged except for links. `bun run check` runs 209 tests and the docs check.
- **Rehearsal:** changing operations ran on disposable instances with their own labels, ports and state, beside the live bus, which kept its processes throughout. Steps that need the other machine, a real session or the real daemon are marked unverified.
- **Found on the way, now on their owner pages:** Fluree refuses a subject-less token on the event stream only when events auth is required; a new durable ledger's text search can fail with HTTP 500 in its first second; Codex lists a skill's name and description and cuts an explicitly mentioned skill at 8,000 bytes; the launchd `serve` would have loaded a `.env` (fixed). The early-search gap seen once on an authenticated server was not reproduced in about 30 runs.
- **Left for later:** whether `owned()` should check the runtime outside join; a CLI `read`; a queue-method retest script; token rotation; dated, rotated `serve` logs.
- **Close-out (2026-10-29), after the owner's review.** Deployed by following `deploy.md` step by step:
  - the end-to-end check passed before the deploy; `main` was fast-forwarded on the remote to 43fd2fd, and the primary checkout fast-forwarded to it; `bun run check` passed there (209 tests);
  - step 5 listed the installer and the plugin, so step 8 reran the installer, which rewrote the plists (`serve` now runs with `--no-env-file`) and restarted Fluree and `serve`; the restart check and the end-to-end check passed, and `agent-bus --version` printed 0.2.0;
  - the plugin was updated (e030289b7fe0 to 43fd2fdb9961), and a throwaway `claude -p` session loaded the `agent-bus` skill.
- **Where the runbooks fell short, now fixed:**
  - step 3 assumed a pull request; this repository fast-forwards `main` with a push of the reviewed branch, which the step now allows;
  - the cache check picked the newest cache directory by time, which was the old one: an update writes an `.orphaned_at` marker into it. It now uses the version `claude plugin list` shows;
  - the variables step 1 sets live in one shell; a deploy run through separate shells has to carry `previous` itself (here, in a file).
- **Not as the frame expected:** the skill loaded from the checkout's `plugin/skills/agent-bus`, not from the cache copy. Claude Code 2.1.311 lists this local-folder marketplace's plugin as read from its source, though the update also made a cache copy holding the skill (recorded on [platforms: Claude Code](../platforms/claude-code.md#plugins)). So a skill change reaches new sessions from the checkout, and the update remains the documented way to register it.
- **Repo memory:** entries now point at the pages that own their facts (the moved connections page, deploy, messaging, the platform pages); the plugin decision mentions the skill; two traps were added: `Schema.Number` drops a tool parameter's description and bounds, and the installer must run with all five overrides outside a real install.

## Moved into current docs

| Facet | Where it now lives | Done |
| --- | --- | --- |
| Contract | `interfaces.md` and the tool schemas, held together by `test/docs-coverage.test.ts` | Yes |
| Rule | the owner architecture pages' numbered Rules; the placement rule and page shapes in AGENTS.md | Yes |
| Agent guidance | the `agent-bus` skill and the MCP instructions | Yes; loaded by a throwaway session after the plugin update |
| Platform claim | `docs/platforms/`, with the recheck column | Yes |
| Procedure | `docs/runbooks/` | Yes; the deploy followed them, and their shortfalls are fixed |

## Not doing

- **Bundling the MCP server into the plugin, and a Codex plugin manifest and install.** They need their own release: Claude Code renames a plugin's MCP tools (`mcp__plugin_…`), which would change every tool name agents and permission rules use, and how Codex loads a plugin's skills should be verified live first. Phase 4 puts the skill where the Claude plugin picks it up.
- **A server-owned "operating note"** returned with join and read results, so long-running sessions get current guidance (Astra's proposal). It is worth framing on its own once the skill exists. Until then running sessions are refreshed by the procedure in `upgrade.md`.
- **Generating docs from code,** and per-runtime or per-audience directories (see [Reviews](#reviews)).
- **Cursor clean-up in code.** Dead cursor files come almost only from test addresses. A small change to `serve` that removes orphaned temp files at start, and a harness that leaves its test addresses, would end the need for manual clean-up. It is a separate change.

## What would force a reframe

- During phase 2, a fact that repeatedly needs stating on two architecture pages would mean the concern boundaries are wrong.
- Runbooks that must explain mechanisms at length would mean the reference pages they link to are missing something.
- After two later releases, a change that the placement rule can't place would mean the rule needs revising.

## Reviews

Two independent proposals came from the census roundup.

**Fable** proposed:
- concern-based reference pages with a fixed section shape;
- role-based entry points;
- frames moved to a dated `docs/history/`;
- a central `policies.md` and `retired.md`;
- one skill with a drift test.

Fable rejected organising by audience, which repeats each mechanism once per reader: the four-copies problem the census found.

**Astra** proposed:
- keeping the working directory names;
- `messaging.md` and `interfaces.md`;
- folding codex-hosting;
- separate `deploy` and `launch-agents` runbooks;
- decision records and an evidence register;
- frames kept at their paths;
- a server-owned operating note for long-running sessions.

Astra rejected per-runtime directories, which duplicate shared ownership, delivery and operations.

Adjudication:

| Topic | Adopted | Rejected, and why |
| --- | --- | --- |
| Pages and directory names | Astra's: `architecture/` kept, `messaging`, `interfaces`, codex-hosting folded | — |
| Runbooks | Astra's split, with `deploy` and `launch-agents` | — |
| Page shape and limits | Fable's fixed shape, with limits and reasons beside their mechanism | Fable's central `policies.md`: rules stay with their concern |
| Frames | Astra's, frozen at their paths, plus Fable's index and closing checklist | Fable's move to `docs/history/`: memory and platform pages cite the paths |
| Retired mechanisms | Fable's table, inside `frames/README.md` | — |
| Decision records | Why sections on each concern page | Astra's decision-record directory: it would restate those sections |
| Evidence | the existing findings register in `platforms/README.md`, gaining a recheck trigger | Astra's evidence register: frames already hold dated results |
| Skill | one skill, as both proposed: Fable's drift test, Astra's split of surfaces and bundled references | — |
| Operating note | deferred | — |
| `platforms/` | kept, as both said | — |

### Review of this frame (2026-10-28)

Both reviewers said to revise, lightly, and all their findings were accepted:

- **No hand-kept copy of the limits.** The overview's limits index was a second copy of every Limits section, so it is dropped. `check-docs.ts` instead checks that the overview's topic table names every page (Fable).
- **Each map row follows the placement rule.** Topics kept on a rejoin go to messaging. The 5 s release is a delivery reason, resting on a Codex fact. Daemon file-limit operations go to runbooks, their facts to platforms. Connections cites delivery's removal rule instead of restating it (Fable, Astra).
- **Frames as evidence.** A platform claim may cite the frame whose experiment established it, and a frame records its own versions. Only a current rule may not rest on a frame (Astra).
- **The checks match the phases.** The frame-link check ships with an allowlist that phase 2 empties, and the nothing-lost review repeats in every phase that removes text (Fable).
- **Runbooks are rehearsed.** Read-only checks only prove a page describes the running bus. Changing operations are rehearsed on a disposable instance, phase 5's deploy follows the runbooks literally, and a step that can't be rehearsed is marked unverified (Astra, Fable).
- **Guidance is staged for both clients.** The MCP instructions stay a complete minimum protocol until Codex has a verified way to load the skill. A Codex nudge already queued keeps its old text. Refreshing running sessions becomes a qualified upgrade procedure (Astra).
- **The drift test is a coverage test.** It checks both directions and compares the timing table with exported constants. A contract review follows phase 4's code changes, because the test can't judge meaning (Astra, Fable).
- **Smaller points.** A change has five facets, each with its own home, and the closing checklist lists them (Fable). The skill-length truncation is verified, not assumed (Fable). The skill is tested from the installed plugin's cached copy (Fable).
