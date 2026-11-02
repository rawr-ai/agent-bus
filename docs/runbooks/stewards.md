# Domain Stewards

Use this procedure to invoke repository-local domain agents and maintain their definitions. General verification is in [contributor instructions](../../AGENTS.md#verification); native discovery and its limits are described in [Codex](../platforms/codex.md#repository-agents) and [Claude Code](../platforms/claude-code.md#repository-agents).

## Before you start

Work from the code-owning checkout, including its dedicated development worktree. The enduring roles live in this repository's `.codex/agents/`, with matching native `.claude/agents/` counterparts, not an external prompt store. A steward is a resident domain expert and partner to implementation: its purpose, protected outcome and relationships guide its judgment. It is not a generic audit gate or a replacement release owner.

The roles cover [testing design](../../.codex/agents/agent_bus_testing_design_steward.toml), [Effect](../../.codex/agents/agent_bus_effect_steward.toml), [oRPC](../../.codex/agents/agent_bus_orpc_steward.toml), [SPARQL](../../.codex/agents/agent_bus_sparql_steward.toml), [Fluree query](../../.codex/agents/agent_bus_fluree_query_steward.toml), [MCP](../../.codex/agents/agent_bus_mcp_steward.toml), [state machines](../../.codex/agents/agent_bus_state_machine_steward.toml), [simplicity](../../.codex/agents/agent_bus_simplicity_steward.toml), and [steward design and maintenance](../../.codex/agents/agent_bus_steward_designer.toml). A definition's `name` is its native agent identity. Do not parse and transplant its instructions into a general-purpose agent as the ordinary invocation path. Fresh native CLI invocations of testing, Fluree query, MCP and the designer were *Rehearsed 2026-11-02* on bounded source commissions. The other roles and refresh in an already-loaded session remain *Unverified*; file existence is not invocation.

## Invoke a domain agent

1. **Prepare the task prompt.** Give the steward the desired outcome, relevant context and sources, its consumer and action scope. Identify the exact candidate for review and material risks or evidence gaps. For testing, include the observable claims and candidate independent oracles. Leave the steward room to choose an approach; the brief is direction and success criteria, not a reasoning script. Independent review has no source-write scope. Expected: a self-contained commission, without copying the enduring role prompt. *Rehearsed 2026-11-02* on query and viewer source-review commissions.

2. **Select the native named agent in the current provider.** Both providers use the same role names. For example:

   ```text
   Use agent-bus-testing-design-steward to independently review this lane's tests.
   Outcome: identify consequential failures the tests would miss.
   Candidate and sources: <exact revision and relevant files>.
   Consumer: <implementation owner>.
   Scope: read-only review; no live services or silent repairs.
   Evidence: <checks already run, plus known gaps>.
   Stop: return prioritized findings, independent oracles and the smallest useful corrections.
   ```

   Choose an appropriate model and effort explicitly through the runtime's supported per-commission settings; match them to the decision, not a fixed review model. State the actual permission context: a role definition does not override its parent's permissions. Start independent work with fresh context; where the spawn API exposes `fork_turns`, use `"none"`. Expected: the native agent receives its repository definition plus this task prompt. *Rehearsed 2026-11-02* through fresh Codex CLI delegates and a Claude native state-machine invocation. The latter was a no-tool hypothetical, not source verification or proof of role effectiveness; other Claude roles and existing-session hotload remain unverified.

3. **Use the domain judgment.** The implementation owner resolves material findings or explicitly declines them with a reason, owns production changes and integrated checks, and reports actual results and remaining uncertainty. Re-engage when material assumptions or implementation change. Expected: useful coverage or design changes, not a second approval chain. *Rehearsed 2026-11-02:* query and viewer owners accepted material findings; query repairs and test-only coverage changes followed. This does not establish deployment or real-team adoption.

## Maintain the roles

The current director owns maintenance and explicitly hands the source and unresolved concerns to a successor. Commission the native `agent-bus-steward-designer` for bounded research, role authorship or revision. A role persists in Git; it does not depend on one chat staying alive.

Inspect established shared-domain agents before creating another role. Bring the selected, reviewed definition into this repository, removing private and unrelated project coupling while preserving its domain judgment and public-safe provenance. Do not make ordinary invocation depend on another repository. Add a permanent role only when its enduring decisions and boundaries justify it; omit unrelated technology roles. Lead with who the steward is, what outcome it protects and how it partners with neighboring owners; retain meaningful technical distinctions without prescribing every step.

Edit the canonical TOML definitions, then run `bun run sync:stewards`. This deterministically renders the full role bodies into checked-in Claude-native Markdown; it is a maintenance operation, not runtime prompt transplantation. The closing frontmatter delimiter and its newline are the only separator before the complete decoded TOML body; nothing in that body is trimmed or rewritten. `.claude/agents/` is reserved for these generated counterparts. Remove retired counterparts deliberately; the renderer refuses unexpected files rather than deleting them. Run `bun run check:stewards` to detect missing, stale or extra files without changing them; it also runs in `bun run check`. Expected: the two native formats carry identical identities, descriptions and complete role bodies, with Claude inheriting its commissioning model. *Rehearsed 2026-11-02:* literal-output, malformed-input, read-only reconciliation, unrelated-working-directory and repository parity tests passed; Claude's native directory validator also passed. Static validation does not establish invocation.

For new or materially changed steward prompts, commission focused reviews of prompt-design's five dimensions and domain, framing, objective, team and information design as appropriate. Apply relevant habitat guidance to authority, commission boundaries and handoffs, adapted to an acting domain role rather than a workstream auditor. The designer prepares review commissions and dispatches only when given staffing authority; otherwise the commissioning owner dispatches and consumes findings. The director resolves maintenance conflicts. Domain roles may act within assigned ownership; independent reviews alone are read-only and never silently repair. Avoid a sign-off committee or prompt-receipt registry. Evaluate effectiveness on a real commission when available. Expected: natively usable roles with clear authority and demonstrated usefulness. *Unverified* until the review and invocation have run.

Use the intended model's current primary guidance when shaping its prompt, not a stale profile for a different model. Start with [OpenAI's prompting guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices) or [Claude's prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) and the selected model's own guide. Preserve clear outcomes and authority while leaving the model room for judgment. Core resources are entrypoints, not the end of discovery: follow their relevant references and extend the search when a task-specific gap warrants it.

## If it fails

| Symptom | Response |
| --- | --- |
| The named role is unavailable | Check the project checkout and native definition requirements in [Codex](../platforms/codex.md#repository-agents). Start a fresh project session if needed; do not restart another owner's session or copy prompts around the missing discovery. |
| An authored agent definition cannot be written under the session's permissions | Return the draft and refusal to the maintainer. Do not write elsewhere, change permissions or claim the file was created. The maintainer applies authorized source changes through normal review. |
| Scope or oracle is unclear | Have the lane owner clarify the commission; do not invent production policy or overstate what a check proves. |
| A check would touch live services or personal data | Resolve the authority boundary and prefer a disposable check. Operational recovery is in [recover](recover.md). |
