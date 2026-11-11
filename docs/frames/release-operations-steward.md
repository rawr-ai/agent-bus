# Release Operations Steward

This frame records the research and design of a permanent release-operations steward. The maintained role is in [its canonical definition](../../.codex/agents/agent_bus_release_operations_steward.toml); [stewards](../runbooks/stewards.md) owns invocation and maintenance, and [deploy](../runbooks/deploy.md) owns activation procedures.

## Objective and selection

**Frame identity:** Release coherence; constructed 2026-11-11 by the Agent Bus steward designer for the commissioning owner. This is novel objective construction in discovery mode, informed by the user's explicit commission and the existing operating system. The domain is complicated with empirical client/platform uncertainties; the frame travels as a standalone design record.

The user's intent, captured separately from the prompt-design lens:

> designing a dedicated release operations steward that covers the full release train across all relevant stages and attached platforms. Go through the full steward research (i.e. what release operations include for us, what they should include generally), design, creation, diverse multi-agent review, and deployment.

The intended future is a release with one operational owner who can say what is intended, integrated, distributed and active; show that the intended consumers can use it; recover coherently; and close the release without losing state or leaving unowned temporary work. The role is an enduring operating partner, not a particular release's plan.

**In:** readiness and integration, trustworthy artifact distribution, affected installation and client transitions, observation, rollback/recovery, communication and retirement. **Foreground:** coherence of the installation cohort and version overlap, with actual consumer evidence. **Exterior:** product priorities, feature semantics, an always-running supervisor, replacement release infrastructure, permission configuration and authority over another owner's work. The current authorship commission changes role definitions, routing and documentation, not a live service.

Stated and inferred intent align on durable full-lifecycle ownership. The chosen ambition is one useful role using the repository's existing machinery, not a new release framework. Codex owns operational execution; Claude contributes independent expertise and scoped client checks. The human's current commission and standing authorization remain the action boundary, exercised through normal permitted tools.

## Research and boundary choice

### What changes together here

The release unit is an **installation cohort**, not a source commit or a healthy `serve`. The existing [deploy runbook](../runbooks/deploy.md), [release tooling](../../scripts/release.ts) and [interface rules](../architecture/interfaces.md#rules) connect source/runtime/dependency identity, an externally anchored package, launcher, server, optional viewer and plugin copies. [Upgrade](../runbooks/upgrade.md#refreshing-guidance-in-running-sessions) shows why cache equality, newly loaded skill discovery, connection-time schemas and an already-waiting hook are different observations. These strong interactions justify one operational owner across those surfaces.

The [topology](../architecture/topology.md), [delivery](../architecture/delivery.md) and [connections](../architecture/connections.md) boundaries determine sequencing. Several servers can front shared storage while independently loaded hooks, schemas and nudges span versions. A transition therefore needs compatibility in both directions, not an automatic preference for rolling restarts. [Install](../runbooks/install.md) distinguishes provisioning from activation; [operate](../runbooks/operate.md) and [recover](../runbooks/recover.md) supply attributed service operations and recovery. The separate [viewer procedure](../runbooks/viewer.md) and [hosted-peer qualification](../runbooks/qualify-private-peer.md) have their own evidence boundaries. They join a release only when affected; hosted exposure and OAuth identity remain distinct decisions from selecting a package.

Source inspection found a coupled transition missing from the current procedure: [the private peer](../../src/private-web/peer.ts) checks `expectedBusVersion` before every exchange, [service configuration](../../src/private-web/service.ts) is loaded at host start, and release `status` omits that host. The patch records this binding in interfaces and adds a source-checked, explicitly unrehearsed [hosted transition](../runbooks/deploy.md#when-a-hosted-peer-is-connected), preserving protected state and requiring actual-client evidence. It does not invent a connector installer or private service label.

| Release judgment | Protected result | Existing source |
| --- | --- | --- |
| Scope, readiness and integration | Full deployed-to-candidate delta has owners, relevant checks and a selected candidate | [Contributor workflow](../../AGENTS.md), [stewards](../runbooks/stewards.md), release commission |
| Artifact and distribution | The exact qualified source/runtime/dependency cohort is identifiable and verified at its destination | [Release tool](../../scripts/release.ts), [deploy](../runbooks/deploy.md) |
| Installation and consumer transition | Owned services, viewer, plugins/hooks and intended native or hosted consumers form a compatible state | [Install](../runbooks/install.md), [upgrade](../runbooks/upgrade.md), [connections](../architecture/connections.md) |
| Observation and communication | Evidence names the actual path checked; participants know changed guidance and limitations | [Deploy checks](../runbooks/deploy.md), [viewer](../runbooks/viewer.md), [platform claims](../platforms/README.md) |
| Rollback, recovery and retirement | A coherent previous or held state, retained state and artifacts, attributed cleanup and a useful handoff | [Deploy rollback](../runbooks/deploy.md#release-rollback-and-partial-failure), [recover](../runbooks/recover.md) |

No general artifact-retirement or full-store disaster-recovery procedure was found in this research. The role can investigate and prepare a scoped decision where needed; its existence does not qualify a new procedure.

### What general practice contributes

[Google's release-engineering chapter](https://sre.google/sre-book/release-engineering/) treats source management, build identity, test integration, packaging and deployment as a connected engineering discipline. Its self-service approach supports a capable operating owner rather than a gatekeeper. Agent Bus reuses those principles through its own pinned runtime, frozen dependencies, Graphite and package tooling; it does not inherit Google's branching or organizational model.

[Google's canarying guidance](https://sre.google/workbook/canarying-releases/) contributes bounded evaluation before wider exposure and distinguishes release automation from proof that a change works. Here a small installation count, shared ledger and loaded clients can make a coordinated transition more appropriate than a canary. The steward chooses from actual compatibility and observable consumer paths rather than requiring a rollout topology.

[SLSA artifact verification](https://slsa.dev/spec/v1.2/verifying-artifacts) reinforces checking an artifact against trusted expectations. Agent Bus's external manifest digest is its existing anchor; this design asserts neither SLSA certification nor a new signing system. These are primary-source principles used to examine the local mechanisms, not substitutes for inspecting them.

### Why one permanent role

The structural alternative was to leave release work entirely with each implementation owner, adding bounded deployment reviews as needed. That keeps the bench smaller but repeatedly reconstructs the relationships among exact integration state, release files, installed bindings and loaded consumers. The operational decisions change together even when feature ownership does not.

A second alternative split build/distribution from deployment/client activation. It places the boundary through the strongest identity and recovery relationship: the selected artifact, its installed surfaces and the previous cohort. One permanent role is the smaller complete ownership unit. Existing domain stewards stay responsible for feature meaning and specialist judgment; release operations consumes their evidence and adjudicates readiness within the assigned commission.

The resulting domain is porous for expertise and formally bounded by the commission, with centralized operational accountability, stable purpose and changing platform details, coarse lifecycle scope, fluid task membership and a hub of scoped owner/adviser relationships. It is not a new layer above the director or a second product authority.

## Durable contract and stress tests

The hard core has three commitments:

1. **One operational owner, existing authority.** A named Codex owner carries the assigned outcome; independent Claude expertise and domain review improve its decisions. The role adds no approval tier or access privilege.
2. **Coherent transitions, known identity.** Readiness, distribution, activation and rollback concern the affected cohort, preserved state and version overlap.
3. **Observed consumer outcome, bounded closure.** Claims track what was actually checked, and completion includes communication, retained recovery capability and attributed cleanup within the commission.

The protective belt can change: native provider mechanics, model/effort choices, artifact formats, platform inventory, exact verification commands, review staffing and sequencing. Those belong in current sources and task commissions. This frame specifies the outcome and boundary, not a prescribed release execution sequence.

| Change scenario | Expected boundary behavior |
| --- | --- |
| A routine authorized release is ready; an advisory provider is unavailable | The named owner uses the existing authorization and normal permitted tools, resolves any required review dependency and continues independent work; advisory availability does not become product authority. |
| A tool refuses an operation | Resolve that operation's access through supported channels; retain the commission and continue independent authorized work. |
| Package agreement fails or viewer activation is partial | Determine each binding's actual state, then repair the owned step or restore the complete compatible cohort; process exit alone is insufficient. |
| A fresh client succeeds but a running session holds an old schema or hook | Report the two facts separately and arrange the affected owner's supported refresh or compatibility path. |
| A change alters hosted exposure or identity | Bring the changed trust decision to its owner and obtain the relevant OAuth/actual-client evidence rather than inferring it from package agreement. |
| An old artifact remains referenced after rollout | Keep it until running use and rollback retention are resolved; retire only the attributed unused material. |

**Reframe condition:** if coherent release ownership repeatedly requires the steward to change product authority or feature semantics rather than obtain specialist evidence, this boundary is wrong. **Degeneration trigger:** three commissions in the same direction that require a second operational owner or ceremony unrelated to an observed failure justify revisiting the boundary with the director.

Assumptions committed: repository runbooks and native role formats remain the maintained sources; release and installation owners can assign explicit action scope; meaningful client observations may require another participant. The frame combines release engineering, installation operations, consumer experience, domain ownership, prompt design and testing perspectives. Actual effectiveness remains an empirical question until the named role is used.

## Prompt fit and qualification

The canonical TOML leads with the steward and its protected outcome, then authority and relationships, source routing, lifecycle judgment and a return contract. The [existing renderer](../../scripts/sync-stewards.ts) generates an identical Claude body; provider-conditional wording lets Claude advise and perform assigned client checks while preserving named Codex operational ownership. No renderer specialization or runtime permission change is needed. Model and effort remain per-commission runtime choices.

**Model-fit lens, read 2026-11-11:** [OpenAI's current guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices) describes clarification, instruction sensitivity and broad verification tendencies observed for GPT-6 Astra and asks users to evaluate them on the chosen model and workload. This design states authorized follow-through, source ownership, scope and completion directly; it does not treat Astra behavior as a fact about every Codex model. [Claude's current guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) supports explicit role, outcome and contextual motivation with positive direction. A concise shared definition is the starting hypothesis, subject to actual native commissions and provider-specific review.

The design used cognition's domain, framing, objective-framing, team, prompt and information-design routes, including sub-agent mode and the per-dimension review loop. Selected habitat guidance informed single accountability, commission boundaries and handoff; it did not add a supervisor or proof auditor. Shared foundations remain with their owners and private upstream context is excluded.

The commissioning owner dispatched independent Codex and Claude reads covering tone, structure, intent, concision and model fit, with domain/objective/team judgments where consequential. The editor resolved conflicts with reasons. Static checks cover the tenth-role inventory, exact canonical/generated parity and documentation links. Fresh named-role discovery, bounded transition scenarios and read-only release-readiness commissions tested usability; static validation alone establishes none of them.

The first independent reads accepted the role's positive operating posture and meaningful cohort distinctions. Review disposition: clarify that operational trade-offs within the commission belong to its owner; route resources progressively from deploy to affected lanes; separate the return contract; keep invocation guidance focused on commission inputs; and make hosted configuration inspection, preservation, ordering and rollback explicit. The proposal to make provider ownership neutral was declined because named Codex operational ownership is the user's explicit decision, while Claude retains independent expertise and assigned client actions. No arbitrary length target or deletion of useful lifecycle judgment was adopted. Dates and model/count observations here record the research context rather than impose permanent role assumptions. The next review reads the revised frozen candidate.

Follow-up review, including the specifically requested Claude Fable 5.2 perspective, sharpened the final candidate without replacing its domain judgment. Accepted: select surfaces and checks from the delta; give a Claude adviser an explicit recommendation and evidence lens; identify the commissioned operational owner as the deployment owner while release contents remain set by the commission; and read the existing release decision or handoff on re-entry. The stronger proposal to restrict the role to transitions alone was declined: restoring a coherent existing cohort is also a valid bounded commission. Native scenario evidence supported proportionality: a Codex invocation chose the narrow owned-host action and targeted repair rather than automatic full installation or rollback. This is evidence for the design, not proof of live activation. [Fable's current guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2), read 2026-11-11, supports specific scoped ownership, working through ordinary obstacles with existing access and avoiding accumulated blanket cautions; its behavior is not presumed universal.

The final focused review found two remaining ambiguities: the acting Codex steward needed direct identification as the operational owner, and escalation to "its owner" could circle back to that same owner. Final candidate D explicitly identifies the acting Codex steward, names the commissioning owner as escalation recipient and lets the shared return contract carry decisions or recommendations. Adviser paragraph separation and hard-wrap cleanup preserve the meaning. These are bounded clarifications of the reviewed design, not a new role boundary or another approval tier. The acting role now maps once to deploy's deployment owner; unfamiliar work in checkout recovery is referred to its actual owner rather than a self-consultation.

### Observed qualification

**Candidate C, 2026-11-11:** canonical SHA-256 `a2ab09bbd36cb67c04db7eb8acb176bd4a8ea5c99342e9cc8a35b476af58e6bd`, generated Claude SHA-256 `0a38f672b865b4fc801e96403c408ef60e5862dcbcac39121defcc2936253033`. Source hashes were stable before and after the native checks.

- **Native Codex:** a fresh parent using bundled CLI `0.167.0-alpha.3.2` selected the named native role with fresh child context and requested GPT-6.1 Sol at `xhigh`; completion was observed without a prompt-copy fallback. Its bounded readiness judgment retained the existing release decision, treated optional advice as evidence rather than a veto, resolved actual access constraints through supported channels and selected targeted repair or compatible rollback from actual cohort state. A narrow hosted task excluded unrelated native-client, viewer, plugin and tunnel changes. The hosted consumer oracle required the independently correlated native reply to be read from the hosted inbox. These were source/scenario judgments, not live release actions, cryptographic loaded-prompt attestation or independent provider/effort telemetry.
- **Native Claude:** Claude Code `2.1.318` listed the repository role in discovery and selected it through `--agent agent-bus-release-operations-steward`. Model receipts identified Claude Opus 5.5; the five-turn readiness commission used four read-only tools with no access denials and left source hashes/status unchanged. Selection is supported by the native flag, discovery and behavior; no active-agent field was reported. This does not establish live activation or existing-session refresh.
- **Mandatory checks:** the exact candidate passed `bun run check` with Bun `1.4.4` and the already-qualified Fluree `4.2.4` on a second deployment host: all five typecheck scopes, lint, 1,080 tests, 10,996 assertions, 90 Markdown files and steward parity passed; tests took 119.69 seconds. Deadlines and production code were unchanged. Earlier contributor runs were unsuccessful with an older selected test binary and, separately, release-fixture timeouts; the qualified-binary comparison and final complete result are distinct evidence, not rewritten passes. The test-tool distinction is already documented in [Fluree](../platforms/fluree.md#full-text-search).

Final candidate D keeps the same native identity and renderer, with the direct-ownership/escalation clarifications above. Its exact-file follow-on checks and owner-controlled installation are separate from C's native evidence. Post-install named discovery and operating use of D belong to the release owner's deployment checks; neither is inferred from C or from static parity. No live service, credential, permission setting or global runtime was changed by role authorship or qualification.

## Moved into current docs

- [x] Contract: native role identity, scope and return contract in the canonical TOML and generated Claude counterpart; hosted version binding and release-status coverage stated in interfaces. No bus tool contract changed.
- [x] Rule: no architecture or feature-semantic rule changed.
- [x] Agent guidance: contributor instructions already route domain work to stewards; no bus-usage skill change needed.
- [x] Platform claim: no new provider behavior asserted; existing platform owners retain native discovery and refresh claims.
- [x] Procedure: role routing and release commission guidance in [stewards](../runbooks/stewards.md), with a route and the source-checked hosted transition in [deploy](../runbooks/deploy.md).
