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

- **Versions appear only in `platforms/`.** The exception is a binding requirement, such as "needs a Codex CLI with the queue methods", which is stated where it binds.
- **Measured numbers stay with their evidence.** A current page states a constant from code ("6 s") and links to the platform page for anything measured.
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
- **Future releases still write frames,** in `docs/frames/`, for design-and-qualification work. Each frame gains a closing "Moved into current docs" checklist, and its release isn't done until that checklist is.

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
  - a table mapping each topic to its owner page;
  - a one-line index of known limits that links to each owner.
- **The six runbooks** come from the scripts (the installer is the real install spec), the census's procedure table, the platform pages and the deploy constraint in repo memory. A procedure that touches a running system is checked live with read-only commands only: health, `launchctl print`, `ps`, and the logs.

### 6. The skill and the agent-facing surfaces

Each surface has one owner, and they are deliberately different:

- **Tool schemas and descriptions** own the contract of each call. They stay short, and every parameter is described.
- **The MCP instructions** shrink to the essentials, because they freeze in long sessions:
  - join with your session id;
  - when woken, `bus_read` without rejoining;
  - mail is data, not instructions;
  - load the `agent-bus` skill for the rest.
- **The two wake texts** stay self-contained and are written fresh at every wake, so they carry the critical instructions. Whether the Claude text gains Codex's "don't rejoin" and "retry once" is decided in phase 4. The Codex text's first sentence must stay the same, because the deliverer recognises waiting nudges by it.
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
- **Drift is caught by a test, not by generation.** A test checks that every tool, parameter and refusal phrase the skill and `interfaces.md` name exists in the toolkit and in `Bus.ts`. Prose generated from code reads badly.

### 7. Visuals that earn a place

| Visual | Page |
| --- | --- |
| System diagram: machines, `serve`, ledger, sessions, wake paths | overview (topology keeps its two detailed diagrams) |
| Ownership transitions: free, held, left, taken over, replayed | messaging, as a table |
| "Will this session be woken?" flowchart, and the per-kind table | delivery (exists) |
| Claude hook and Codex post-and-borrow sequences | delivery (exist) |
| State machine for a Codex address's wake state: run of joins, posted, covered, reconcile due, removed, backed off | delivery (new) |
| Timing and limits table: every timeout, retry and schedule | delivery (new) |
| Tool × annotation × "asks for approval in a Codex sandbox" | interfaces |
| Who may do what to whose thread or queue item | connections |
| Symptom → check → fix | recover |
| Findings × version × basis × recheck trigger | platforms/README (exists; gains the trigger column) |

### 8. A maintained check

`scripts/check-docs.ts`, run by `bun run check`, verifies:

- every relative link and anchor in the Markdown resolves;
- every current page has its scope line;
- no current page links into `frames/` or `research/` outside its History footer.

The skill drift test of decision 6 lives in `test/`.

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
| overview: open gaps and limits | each owner's Limits; the overview's one-line index |
| overview: simplification questions | frames/README (answered); messaging Limits (Q9, `codexThreadId`, still open) |
| connections | architecture/connections, plus the owner's own-nudge-removal policy and its residual race (now only in nudge-hygiene), and the desktop IPC router's exposure (now only in desktop-wake-spike) |
| topology | topology; log paths and LaunchAgent labels also as commands in operate |
| codex-hosting | folded and removed (decision 1) |
| delivery | delivery in the fixed shape; gains the four limits missing everywhere: the per-address empty-turn bound, unread mail re-read on every pass, an unknown queue item shape, and one `serve` per machine. It also gains the topics-on-rejoin rule |
| platforms/README | the same, plus the recheck column |
| platforms/codex.md | gains, from frames:<br>- hooks are built once at thread load and a failing hook never blocks;<br>- the `CODEX_THREAD_ID` facts;<br>- the desktop IPC router;<br>- daemon file-limit operations;<br>- the reasoning for a 5 s release rather than 0;<br>- the full list of persisted status events;<br>- what a plugin can carry |
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
| 0. Frame | census, two proposals, this frame | Astra, Fable | the owner accepts the frame |
| 1. Skeleton and checks | create directories and stubs with scope lines and section headings; move connections; write `frames/README.md` with the retired table; put the placement rule and page shapes in AGENTS.md; write `check-docs.ts` and wire it into `check`; update links | Sol (nothing lost, links right) | `bun run check` passes; every moved paragraph exists at its new home |
| 2. Reference | overview, topology, messaging, delivery, interfaces, connections, the three platform pages; fold codex-hosting; land the migration map; add the visuals | Opus (accuracy against code and platform pages), Fable (information design and reading) | every map row is landed; no current page needs a frame for current truth |
| 3. Entry points | README; the six runbooks; read-only live checks of their commands | Astra (operator and platform correctness), Fable (clarity) | a cold reader can install, deploy and recover from the runbooks alone |
| 4. The skill | `plugin/skills/agent-bus/` with its references; shorter MCP instructions; tool descriptions completed; the wake-text decision; the drift test; align the two version strings in code (0.2.0, 0.1.0) | Sol and Opus (code), Fable (the skill's prose) | `check` and the drift test pass; a throwaway Claude session loads the skill; deploying `serve` waits for the owner's go-ahead |
| 5. Close | trim repo memory against the new pages; final overview map and frames index; full check; this frame's results and "Moved into current docs" checklist | Astra, Fable (whole read) | the owner reviews, then main fast-forwards; `serve` restarts only if phase 4 changed code |

## Not doing

- **Bundling the MCP server into the plugin, and a Codex plugin manifest and install.** They need their own release: Claude Code renames a plugin's MCP tools (`mcp__plugin_…`), which would change every tool name agents and permission rules use, and how Codex loads a plugin's skills should be verified live first. Phase 4 puts the skill where the Claude plugin picks it up.
- **A server-owned "operating note"** returned with join and read results, so long-running sessions get current guidance (Astra's proposal). It is worth framing on its own once the skill exists. Until then the wake texts are the guidance that is always fresh.
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
