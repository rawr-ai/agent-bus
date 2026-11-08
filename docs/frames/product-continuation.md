# Frame: product continuation

This frame selects the next engineering work after the [coordination turnaround](coordination-turnaround.md), without replacing its real-team outcome. Current behaviour remains with the architecture and runbook pages linked below; this frame does not describe shipped features.

Status: **owner-accepted for packaging implementation and qualification**, 2026-11-07; not implemented. Production activation remains a separate decision. Remote access remains a design candidate requiring its own access, disclosure and activation decisions. The Claude bus co-lead owns packaging; the Codex director reviews and coordinates the integrated sequence. The director assigns owners for other lanes.

## Continue engineering without declaring adoption

The intended end state is a bus that can be operated independently of a development checkout, with the remaining requested continuity and access questions investigated rather than silently lost. The turnaround's human outcome remains the destination: a real team finds context and coordinates without repeated private briefing. Core features have shipped; the original broader adoption and relay-reduction outcomes remain unmeasured. A shipped feature or a successful technical exercise is not that measurement.

The unit of work here is a *bounded operational outcome*, not a collection of feature flags. Select in a source-independent release cohort, proactive Codex continuity, and private ChatGPT web access research. Foreground release independence because the current primary is live source for both `serve` and hooks, coupling routine development and operations ([deploy](../runbooks/deploy.md#before-you-start)). Keep real use and its observation separate from this engineering queue. Deliberately outside are a general distribution programme, container migration, an assumption that packaging is prerequisite to MCP, and a full repository refactor.

The structural alternative is to stop engineering until a new adoption trial is available, making the trial rather than an operational capability the unit of priority. It protects against building unused features, but leaves the demonstrated source/deployment coupling in place. The accepted ordering starts packaging work while retaining the turnaround's real-use gate; it does not manufacture a trial or claim that the remaining human blockers are resolved. A simplicity review supported packaging first and bounded parallel discovery for the other two requests.

### Commitments and uncertainty

1. Preserve the original human outcome and honest evidence: unobserved use remains unmeasured, not success or failure.
2. Make an exact, reversible runtime cohort independent of the mutable development checkout before claiming release independence. Store, configuration and credentials are not release artifacts to replace.
3. Investigate the requested continuity and remote access on their actual clients and trust boundaries before choosing mechanisms. Neither is permission to invent another runtime or duplicate an existing owner.
4. Acceptance of this packaging frame and production activation are separate decisions. Remote access requires its own exact access and disclosure decision, not bundled approval.

The exact release layout, build method, access mechanism, and order of the bounded investigations are adjustable. Assumptions: a release can include the required assets and runtime without a source checkout; a genuine native client path can be established for each requested user outcome. Neither is established by this frame. The perspectives composed are the accepted turnaround's deployment follow-up, the current deploy procedure, the continuity investigation, and the independent simplicity review.

## Prioritized work ledger

| Priority | Work and owner | Next concrete outcome | Status |
| --- | --- | --- | --- |
| 1 | Release independence; Claude bus co-lead, Codex director review | Design and qualify one versioned release directory containing the exact runtime or executable and the CLI, `serve`, hooks, plugin and viewer assets. | Owner-accepted for implementation and qualification; not implemented or activated. |
| 2 | Private ChatGPT web MCP; director to assign access DRA | Qualify a separate read-only facade and the existing owned host/OAuth adapter against actual ChatGPT web before proposing activation. | Candidate researched; bounded discovery can proceed in parallel. |
| Parallel | Proactive Codex continuity; existing handover owner with Codex lead | Determine whether a supported first-party/native Desktop path lets the agent request same-thread compaction and coordinate its next turn; qualify the handover only if that path exists. | Feasibility investigation; otherwise deferred on the upstream gate. |
| Later | Thread mute; activity owner when a real consumer need warrants it | Decide thread identity and direct-versus-ambient behaviour, then specify compatibility, rollout and rollback before any command write. | Deferred, not an enum-only change. |

Parallel discovery does not authorize parallel activation. The order can change on evidence of a more urgent actual user job or a security/deployment dependency; record that decision rather than making one lane an implicit prerequisite for another.

## Release independence: the smallest complete story

The accepted turnaround already directs a versioned release artifact while retaining Effect CLI and Bun ([operational follow-up](coordination-turnaround.md#acceptance-and-operational-follow-up)). The candidate is a versioned directory with a pinned runtime or executable and all assets needed by the installed CLI, server, actual hook, plugin and viewer. A single executable is optional, not the objective. Packaging choices must be qualified as a complete cohort, including asset resolution and dependencies, rather than inferred from one command starting.

The first proof installs a relocated, unpacked artifact with the owned staged build path absent at activation, an unrelated working directory, and a clean home and `PATH` without build dependencies. No install, build or download step is allowed or needed for this proof; it does not require changing network or cache configuration or moving a live checkout. An early feasibility check must also prove plugin and marketplace cache refresh: switching a release pointer may switch `serve` while guidance remains cached until a version change. Do not assume a symlink switch is atomic across caches and native hooks.

One disposable, authenticated real-Fluree and native service rehearsal must cover the actual first rollback boundary: if migration promises return to the deployed-shaped source binding, prove it along with the source-to-package A-to-package B and rollback sequence. Preserve store identity, configuration and credential bytes and modes; record only boolean comparisons, never their contents. Exclude private configuration and keys from the artifact.

Identify the reviewed source and tree, artifact hashes, runtime, live process arguments and same-cohort executable, plugin, marketplace, skill references and viewer assets. Exercise an independent MCP client against a pinned result and a forbidden `SERVICE`, a shipped CLI join and publish, an actual installed Claude hook waking an idle owned session that reads correlated mail, and a production browser rendering a known pinned viewer row and cut. Qualify Codex's native installed discovery separately from proactive compaction. If hook overlap is promised, hold a real hook across upgrade and rollback. Sentinels must show that consumed mail stays read and unread or new-cohort writes survive rollback. A tampered or incomplete cohort must be rejected without moving the active release; if bindings can change separately, inject that failure and demonstrate coherent restoration or a stopped, guarded endpoint. A green build, health check or stand-in hook alone does not prove this story.

This candidate must settle release identity, asset and runtime ownership, activation sequence, rollback floor and failure recovery in the design and qualification. Acceptance of this frame permits that bounded work; it does not change the current [deploy procedure](../runbooks/deploy.md) or authorize production activation under the existing deployment gate.

## Proactive Codex continuity

The deferred outcome is distinct from the shipped [compact recovery](compact-recovery.md): a normally configured Codex Desktop agent deliberately requests a handover at a useful phase boundary, saves a per-thread note and continuation, and after its own successful turn and a real native compact resumes on that same thread without operator input. It recovers the saved next action and, when joined, retains the assigned-address and current-guidance route without rejoin.

The separate handover owner has proved note, compact and continuation on isolated app-server threads. That does not establish agent-callable control of an existing desktop-owned thread: the [app-server compact request](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction) is not itself that control. Default summary steering is not parity with the durable note. The next investigation is the exact supported first-party/native Desktop same-thread compact and coordinated next-turn path with that owner. If none exists, record the upstream gate and stop rather than adding private IPC, a replacement owner, a new harness or a duplicate bus feature. If it exists, qualify a real ordered compact and note-only continuation on a disposable ordinary Desktop thread, retaining identity, before testing a real phase boundary.

## Private ChatGPT web access candidate

The candidate is an owner-only, read-only ChatGPT web plugin reached through the official [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt): an outbound-only tunnel, not public ingress. The [plugin quickstart](https://developers.openai.com/plugins/quickstart) describes the client integration. An existing owned shared MCP host and OAuth architecture has already served another archive through the web client; reuse its design only after qualifying the actual adapter, not because two hosts happen to use the same Effect version. Use a separate tunnel profile and configuration rather than copying the other service's resources. Its observed six-tool web success, restart and process-replacement checks are evidence for that service, not Bus qualification or proof of every refresh path.

A separate local facade would call the existing Bus MCP read-only surfaces, with no second `QueryGateway`, ranking state, store reader or Fluree token. Bounded admission and deadlines ahead of the shared query pool protect local agents; reuse the host's existing capability and measure its fit rather than inventing a scheduler or prescribing a fixed concurrency. Saved projections and the existing validated `bus_query` are candidate inputs under the existing query and projection rules ([connections rules 6 and 13](../architecture/connections.md#rules)); this does not reinstate withdrawn containment. Expose owner-authenticated whole-bus public projections, not per-topic ACLs. Omit and refuse native mutators, consuming reads and ownership tools. Raw notes and provenance can contain sensitive user-supplied material; excluding stored claims is not a blanket privacy guarantee.

Verify OAuth on every invocation; a tunnel runtime key is not proof of the human owner's identity. Although the [custom MCP server guide](https://developers.openai.com/api/docs/guides/custom-mcp-server#how-to-use) permits unauthenticated configurations, the candidate prefers the existing verified owner route. Browser OAuth login must still reach private authorization routes: the tunnel does not tunnel the browser. Resource URL, issuer and tunnel identity are distinct values. Before activation, establish the exact account and workspace associations and explicitly decide whether whole-bus disclosure to that owner is intended; publish no identities, paths or secrets in this frame.

Qualification must exercise the actual ChatGPT client: discovery, a call with a visible response body, paged query results, revoked or wrong authorization, refusal of mutators, no change to unread cursors, and cleanup. Return stable text and structured payloads within the native tool response budgets. One genuine owner question whose evidence is used is a separate adoption observation; synthetic messages and technical calls are not adoption. All of this remains a proposal, not approval to expose an endpoint, change network or security configuration, or activate. It has no dependency on packaging.

## Thread mute stays deferred

Thread muting needs a stable thread identity and an explicit decision about direct and ambient routes before a contract can be designed. The accepted [reachable inactivity](reachable-inactivity.md#adjustment-damaged-standing-fails-the-read) command law also requires every `serve` to decode a new command field or scope before its first write; rollback below that decoder is then unsafe while such a command remains in the log. Treating it as an enum addition would skip both user semantics and the rollout law.

## Evidence and reframe triggers

Record release qualification separately from real-team adoption: who performed the technical checks, on which cohort and client, and what failed or was not exercised. For real use, record the actual job, observable correct result and whether a briefing was needed; sanitize receipts rather than storing raw content. The turnaround's comparative relay measure retains its agreed cohort, windows, denominator and safeguards. A successful disposable install or handover does not count as reduced relay. Missing eligible real use or comparable baseline stays unmeasured.

Reconsider packaging first if the complete source-absent cohort cannot support the existing hook and viewer without introducing a larger operational dependency than the checkout coupling it removes, or if a demonstrated urgent user job requires another ordering. Reframe the work rather than repeatedly patching the candidate if three independent qualification attempts expose the same structural dependency on mutable source. If a proposed remote route cannot preserve the intended private trust boundary, stop and revise that access design rather than weakening the boundary.

## Moved into current docs

- [ ] Contract: pending accepted and implemented interfaces and tool descriptions, if any.
- [ ] Rules: pending shipped behaviour and limits in the owning architecture pages.
- [ ] Agent guidance: pending verified changes to the skill, if applicable.
- [ ] Platform claims: pending version-sensitive findings and their evidence, if applicable.
- [ ] Procedure: pending rehearsed installation, activation, rollback and recovery for an accepted release.
