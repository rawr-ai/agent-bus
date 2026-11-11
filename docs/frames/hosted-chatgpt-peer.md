# Frame: hosted ChatGPT peer

This continuation frames full hosted participation in Agent Bus, superseding the evidence-only product boundary of [private ChatGPT web MCP](private-chatgpt-web-mcp.md). Current contracts remain in [interfaces](../architecture/interfaces.md), [messaging](../architecture/messaging.md), [delivery](../architecture/delivery.md) and [connections](../architecture/connections.md).

Status: **owner-corrected product scope; lead-reviewed for implementation and local qualification**, 2026-11-11. Prepared by the MCP steward from native implementation, owned-host inspection and official client documentation, with state-machine and Claude co-lead review. Actual-host qualification and reviewed activation remain required; this status is not deployment authorization.

## Participation, not another reader

The outcome is a ChatGPT conversation that joins as its own peer, receives and answers mail, participates in topics and uses the other native operations, followed by qualified arrival-triggered work where ChatGPT supports it. The unit is the participating conversation, not an OAuth account or an evidence page.

The prior frame assumed the owner wanted evidence rather than participation. Its four read tools cannot send, receive an inbox or reply: successful reader qualification cannot satisfy the corrected request. The named reframing move is **constraint relaxation**: remove the artificial read-only boundary, not the existing Bus ownership, public projection or query restrictions. The prior frame stays frozen as its experiment's record.

Select in interactive participation, authenticated conversation identity and supported Work-chat wake. Foreground ordinary native semantics and actual model-visible results. Deliberately outside are a second Bus/store reader, native-runtime impersonation, private browser interfaces, a general messaging broker and preemptive acknowledgement/idempotency redesign.

The structural alternatives are retaining an evidence reader, which misses the outcome, or forwarding every native parameter unchanged, which lets remote callers choose another session's ownership or wake destination. A thin authenticated peer projection preserves the existing system without either failure.

## Four commitments

1. **Full native peer, one owning Bus.** Native `other` already supports participation; the adapter calls the existing `serve`, not Fluree or a second `QueryGateway`.
2. **An authenticated conversation, not an authenticated account-wide inbox.** Verify the owner grant on every invocation and bind each conversation to its own private stable Bus session.
3. **Truthful effects and evidence.** Preserve native ownership, result units, public fields, receipts and uncertainty; neither transport success nor a callback proves model action.
4. **Interactive first, Work Events next.** Both belong to the product objective; an unavailable autonomous channel does not turn the interactive peer back into a reader.

Tool names, page sizes and admission settings are adjustable implementation choices. Assumptions are that the owner intends native whole-bus public visibility and that supported conversation metadata distinguishes chats reliably. Neither assumption permits silently weakening authorization.

## Surface and identity

The [native tools](../../src/mcp.ts) and [runtime model](../../src/domain.ts) support the following projection. "Supported" describes native and documented client capability, not completed actual-host proof.

| Capability | Disposition |
| --- | --- |
| Join/rejoin, topic subscriptions, associations and replay | Supported as `other`, with native replacement and refusal rules. |
| Publish/reply to addresses, topics and everyone | Supported; preserve audience selection, reply links and pierce confirmation. |
| Read/wait, ownership recovery, activity/mutes and leave | Supported for the conversation's own holdings; qualify actual call bounds. |
| Peers, orientation, history, catalogue, saved and validated raw queries | Supported with native public projection, snapshots and completeness. |
| Directory and bulletin publication/withdrawal | Supported with native operation identities, revision checks and receipts. |
| Takeover | The native explicit-human replacement rule remains; not a permanent remote ban. |
| Unsolicited wake | Conditional through qualified MCP Events in Work chats. |
| Claude hook `bus_wake`, Codex thread IDs/nudging | Not hosted ChatGPT mechanisms; do not masquerade as either runtime. |

**Documented, read 2026-11-10:** OpenAI's [custom MCP guide](https://developers.openai.com/api/docs/guides/custom-mcp-server) supports read and write tools, without mandatory search/fetch. Its [plugin reference](https://developers.openai.com/plugins/reference#_meta-fields-the-client-provides) documents `openai/session` request metadata as an anonymized conversation identifier. OAuth authenticates the principal; this metadata correlates chats, not authorization.

**Read in the exact owned artifact:** the SDK receives request metadata, but FastMCP drops it before direct execution and the owned invocation context omits it. Its exposed session ID is the MCP transport session, not the conversation. The preferred minimal change preserves supported metadata through that host, produces a newly pinned artifact, then maps verified principal plus `openai/session` to a private application-generated Bus session. Never use tokens, browser cookies, private ChatGPT IDs, the principal alone or transport IDs as that session.

Two actual chats under the same owner must prove separation and stable reconnect before adopting this mapping. Missing or malformed conversation metadata explicitly refuses session-bearing operations; authenticated session-free lookup remains available. An explicit peer handle/resume alternative is considered only if actual evidence defeats the documented metadata path; it is not another protocol to build now.

Identity injection and checking address/session correspondence prevent accidental cross-chat consumption. Hosted join and takeover require `chatgpt/` addresses so they cannot claim or replace a native runtime's address; native human-directed takeover remains available within that namespace. The prefix is not authorization by itself: the verified principal, application grant and derived session retain that responsibility. Hosted calls cannot supply arbitrary filesystem `cwd`. Any required native join directory describes fixed bridge execution context, with truthful bridge origin, not a fabricated browser checkout; project associations remain explicit.

## Two complete outcomes

```mermaid
flowchart LR
    chat["ChatGPT conversation"] -->|"Permanent private connection"| host["OAuth host and peer projection"]
    host -->|"Native MCP operations"| bus["Existing owning serve"]
    bus --> store["Existing ledger"]
    classDef client fill:#e7f1ff,stroke:#41688d,color:#152c40;
    classDef owned fill:#e9f5ee,stroke:#427458,color:#193729;
    class chat client;
    class host,bus,store owned;
```

**Interactive participation** replaces the four-tool ceiling with full peer authorization and native public projection. Reuse the approved permanent private connection, not disposable production connections. Reader-specific withholding and refusal of mutators are superseded as the final target. Assess existing deadlines, budgets and admission independently: retain protections for shared query capacity, whole-result serialization and disconnect settlement where justified, not merely because the reader used them.

Native consuming reads advance before outer response receipt, and publish has no retry operation identity. Native uncertainty parity is the accepted baseline, not a new exactly-once promise. Do not automatically retry an ambiguous publish, claim an interrupted read left mail unread, truncate bodies or substitute summaries. Strengthen delivery only if a measured remote limitation requires it.

**Arrival-triggered Work participation** uses OpenAI's documented [MCP Events](https://developers.openai.com/plugins/build/mcp-events), not an assumed generic MCP notification wake. Its supported webhook channel targets subscribed Work chats; it does not establish the same capability in ordinary Chat. Persist principal-owned subscriptions, verify and sign callbacks, recheck authorization, and obtain unread eligibility through the owning Bus without consuming mail. Callback receipt, wake coverage and inbox acknowledgement remain different facts. Subscription callbacks do not by themselves identify subsequent ordinary tool calls.

## Evidence, boundaries and open choices

Qualify a disposable fixture first, then the actual ChatGPT read/write path, then an explicitly authorized live peer after reviewed qualification. Exercise two-chat identity, joins, topics, native-peer exchange, consuming reads and replies, state changes, takeover refusal/confirmation, restart, grant refusal/revocation, complete result carriers and bounded failure recovery. Work Events separately proves subscribe, idle arrival, actual read/reply, expiry/restart and unsubscribe without feedback loops. An SDK pass, metadata receipt or callback `2xx` is not this host proof.

Director-observed permanent tunnel and OAuth-client creation is infrastructure progress, not a working peer connection or qualification; live data is not connected. The shared-host metadata improvement is intended for reuse: each consumer's owning team assesses benefit and compatibility, then owns its upgrade and verification. This lane does not deploy another consumer incidentally or require it to remain on an older version. The independent native packaging hold does not block code or disposable proof here. Genuine team use and reduced relay remain adoption observations, never synthetic acceptance or prerequisites manufactured to halt engineering.

Remaining choices are whether measured host behavior forces any narrower call bounds and whether qualified Work Events meets the desired autonomous workflow. The default identity and native-parity recommendations above stand unless evidence defeats them. No extra approval chain is introduced.

Reframe if supported metadata cannot preserve separate chat ownership across reconnect, the route cannot maintain owner authorization, or actual result limits prevent useful native participation. After three independent failures at one such boundary, revise the design rather than accumulate workarounds. This composes MCP consumer-path and state-machine analyses; protocol/API claims remain distinct from unperformed actual-host qualification. Deployment procedures, not this frame, own commands and activation.

## Moved into current docs

- [ ] Contract: full peer tools, identity inputs and result limits in interfaces and descriptions after implementation.
- [ ] Rules: hosted ownership, public projection and Work delivery in their architecture owners.
- [ ] Agent guidance: hosted join, receive/reply, recovery and Work-event guidance in the skill.
- [ ] Platform claims: version-bound metadata, host preservation and actual ChatGPT findings with their evidence.
- [ ] Procedure: rehearsed permanent-connection qualification, activation, revocation and recovery in runbooks.
