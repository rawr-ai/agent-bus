# Results of the finite coordination pilots

> [Dated follow-up: late second-adjudication evidence (2026-11-01)](bus-design-pilot-adjudication.md)

This frame records the finite pilot results and their disposition on 2026-11-01. It supplements the frozen [pilot plan and traffic evidence](bus-design-pilots.md); it does not rewrite that frame's historical record. Current behavior remains owned by [messaging](../architecture/messaging.md), [interfaces](../architecture/interfaces.md) and the [addressing guidance](../../plugin/skills/agent-bus/references/addressing.md).

## Disposition

The finite experiments are complete as evidence collection, with **limited or failed acceptance proof**, not acceptance of a convention or bulletin feature. Both annotation rounds, all nine rehearsal cases and four bulletin episodes have retained outputs. Remaining ambiguity and missing controls are results, not reasons to silently expand the trial.

Only one narrow current-guidance clarification is adopted:

> When the group needs the answer, say in the request that the reply should go to the topic.

This clarifies an existing option. It is supported by particular observed cases, not a measured improvement. No new protocol field, mandatory intent label, automatic reply-all, acknowledgement rule, bulletin selection mechanism or work authority is justified.

## Evidence Basis

The recovery read retained packets, rubrics, labels, adjudication, synthetic message history, participant logs and coordinator evaluations. It independently checked counts and agreement without rerunning the experiments or changing participants. Raw bodies, original addresses, private identifiers and private paths are not published.

The original frame's export and selection provenance remains the basis for the fixed sample: 1,129 retained messages and a stratified sample of 50. The retained packet set has 50 unique records and exactly the planned allocation of 2/8/10/8/10/12. This recovery did not independently re-export the source or recover the original private selection manifest.

Packet context was bounded. Two packets have ancestor bodies at the configured character cap, and another reaches the four-ancestor limit while its oldest retained ancestor still has a parent. Missing linked responses establish only absence in this snapshot, not ignored or unfinished work.

| Stage | Retained completeness | Acceptance limit |
| --- | --- | --- |
| Initial annotation | Two complete sets of 50; all 14 substantive-disagreement cases adjudicated | Historical interpretation is not author-intent ground truth |
| Revised annotation | Both sets cover the same eight selected difficult packets | No final adjudication; substantive disagreement remains in every revised case |
| Convention rehearsal | Nine case dispositions; 20 synthetic messages; five participant logs | Offline-review sequencing and independent preregistration are not fully evidenced |
| Bulletin episodes | Four complete newcomer records, including a neutral-brief rerun | Original control primed; neutral rerun contaminated by prior participant discussion |

## Annotation Results

The initial adjudication contains 28 field dispositions across 14 cases: 14 rubric gaps, 11 genuine ambiguities and three annotator errors. The revision adds per-responder maps and attempts to separate routing, responsibility, conditions and lifecycle.

| Dimension | Initial exact agreement, n=50 | Revised exact agreement, n=8 |
| --- | ---: | ---: |
| Requested response set | 44 | 5 |
| Requested responder category | 46 | 6 |
| Recommended reply audience set | 44 | 5 |
| Observed linked response | 42 | 6 |
| Acceptance/completion | 47 | 6 |
| Confidence | 41 | 5 |
| Response-by-responder map | Not present | 3 |
| Completion-by-responder map | Not present | 3 |

The rare-boundary sample and difficult-case revision do not estimate production prevalence or failure rates. These columns are not a before/after success comparison. The revision changes the rubric and selects difficult cases from the same sample; it is not an unseen holdout. Six of eight revised cases retain explicit rubric-problem flags. All eight still differ in at least one substantive field when audience and the new maps are considered.

Residual disagreements include an implied relay versus a new request, actual actor versus obligation owner, accepted versus completed continuing work, completed versus made-moot obligations, and whether an unenumerated topic audience belongs in per-responder maps. The revision's lifecycle minimum ordering also omits categories that remain permitted elsewhere in the rubric. No second adjudication or accepted final label set was retained.

Individual-work instructions support intended independence, but no immutable launch/access audit establishes actual blinding. The original first-pass label counts must not be presented as a final revised corpus. The evidence supports keeping audience, responsibility and lifecycle distinct in analysis, not encoding this unsettled taxonomy into transport fields.

## Convention Rehearsal

Five model-driven roles completed one coordinator-paced synthetic rehearsal. The retained cases show:

| Case | Observed disposition |
| --- | --- |
| Direct FYI | No unnecessary acknowledgement |
| FYI with a consequential error | Correction reached the sender despite acknowledgement being waived |
| Volunteer topic question | Only the relevant participant answered, directly to the asker |
| Named-responder topic question | Named participant answered the asker; other subscribers stayed silent |
| Group needs the answer | An explicit request for a topic reply produced a topic reply |
| Deliberate narrowing | Follow-up reached the affected coordinator only |
| Different reply recipient | Result went to the requested third party; the parent link did not deliver it to the parent sender |
| Partial response | Public status preserved the pending item rather than claiming completion |
| Late arrival | History supplied context without prompting old obligations or an unnecessary message |

The coordinator classified zero missing necessary recipients, unintended work expectations, unnecessary acknowledgements, suppressed useful contributions or unsupported completion claims in the recorded traffic. This is coverage of selected cases, not a product failure rate or causal benefit estimate. Some predictions explicitly allowed more than one reply audience and an optional confirmation.

Two details prevent a cleaner success narrative. One result contained a wrong subject reference that was corrected shortly afterwards. In the partial-response case, the posted status was accurate but a participant's private decision log used overbroad completion language. The traffic measure did not detect that internal overclaim.

The original sample's two topic messages have three direct children, all addressed to their sender alone. Together with the rehearsal, this motivates the narrow sender-side clarification above. It does not show those historical replies should have gone to the topic, or establish a universal reply default.

### Sequence and Independence

The planned offline review and affected-case reannotation were to precede rehearsal. Retained timing instead shows overlap: rehearsal started before the second initial annotation file's final timestamp, ended just before adjudication, and preceded the revised rubric and both revised outputs. The planned gate therefore cannot be certified as followed.

The retained predictor file's final timestamp also postdates early rehearsal cases. It may have been edited, so this does not prove no predictions existed earlier; it does mean immutable before-run prediction evidence is missing. Sender preregistration files do predate their associated messages by fractions of a second, consistent with local preregistration but insufficient to repair the phase gate.

One model family, coordinator pacing, awareness of the synthetic trial and bounded history limit generalization. Real wake timing, contention and comparative coordination outcomes were not tested. Cleanup is reported by the coordinator but not independently evidenced by retained leave receipts.

## Bulletin Episodes

The small fixture contained an obsolete search-heavy bulletin, a current replacement from its original author, discussion replies, a competing replacement claim from another author, an expired item, a dead pointer and a historical task. It tested useful distinctions, not a production selection or authority mechanism.

| Episode | Condition | Interpretive limit |
| --- | --- | --- |
| Initial control | Existing convention only | Brief explicitly requested bulletin candidates and stale-item detection, priming the outcome |
| Treatment A | Draft lookup guidance | Same primed brief; one episode |
| Treatment B | Draft guidance at a different model tier | Produced a diagnostic note about stale items visible to later history readers |
| Neutral rerun | Neutral newcomer brief, no bulletin-specific prompt | Explicitly used the earlier diagnostic note and avoided duplicating it; not an uncontaminated control |

All four records identify the intended current candidate, reject the competing task assignment and report the stale item and dead pointer. No historical task or forced introduction was executed. The neutral rerun removes instruction priming but not shared-history contamination. No clean comparative benefit from the draft paragraph is established.

The coordinator reports a useful retrieval falsifier: the draft full-text lookup at limit one returned only the obsolete bulletin; limit two omitted the competing replacement; the default returned all six matching messages. No raw saved response receipts for those probes were retained, and this recovery did not rerun them. The result is consistent with the original frame's selection-before-chronological-display warning, not a newly qualified platform behavior.

The two control-style participants used unfiltered bounded history; the trial client filtered qualification traffic only after receiving that window. Their available evidence therefore depended on whole-ledger traffic. Neither a small successful lookup nor a chronologically last returned message proves the newest valid bulletin has been found.

| Planned boundary | Evidence disposition |
| --- | --- |
| Missing lookup instruction | No clean control: original brief primed; neutral rerun socially contaminated |
| High-scoring obsolete version | Seeded; coordinator-reported bounded lookup fails as a reliable current-version selector |
| Newer discussion | Recognized as discussion in the small fixture |
| Conflicting replacements | Only a different-author claim tested; no competing designated-convener branches or ambiguous designation |
| Expiry | Obsolete bulletin and current bulletin's stale item recognized; no wholly expired current bulletin without a successor |
| Dead links | Recognized in all four participant logs |
| Older bulletin outside first page or truncated history | Not tested; no pagination/completeness mechanism qualified |
| No authority from history | Historical task was not adopted in these episodes; this is not an authority or authentication proof |
| Real onboarding benefit | No seven-day trial or real eligible-newcomer baseline |

The onramp requirement is to supply retrieval instructions before launching the cold-start participant, not to retrieve history before joining. Joining and then following those instructions is valid. This recovery does not invent a pre-join lookup gate.

Designation, explicit supersession, expiry and canonical links remain proposed checks. Treating the first bulletin's author as the convener does not authenticate their authority. The failed bounded selector cannot be promoted as a reliable onboarding workflow, and any future selector must be qualified against the then-current supported API rather than assuming arbitrary queries are available.

## Smallest Guidance Delta

The addressing reference adds the one sentence beside its existing audience-versus-responder distinction. The existing skill already links there. No new skill, frontmatter expansion, mandatory message template or extra late-join rule is added.

Do not promote the draft bulletin paragraph, an author-of-first-message authority rule, a pin schema, reminder, moderator, join hook, wake injection or recurring trial. No claim about wake reduction, token savings, interruption reduction or speed follows from this evidence.

Any later bulletin proposal needs separate authorization and a qualification contract covering complete retrieval, valid designation, conflicting supersession, whole-bulletin expiry and a control without instruction or shared-history contamination. This is a re-entry condition, not an instruction to run another trial now.

## Moved into current docs

- [x] Contract: unchanged; no protocol fields or tool-contract changes justified.
- [x] Rule: unchanged; no new routing, response or bulletin authority rule accepted.
- [x] Agent guidance: one sender-side sentence added to the [addressing reference](../../plugin/skills/agent-bus/references/addressing.md#delivery-and-response-expectations-are-separate).
- [x] Platform claim: no new live qualification; the original documented search limitation remains context, not a new finding.
- [x] Procedure: no pilot workflow, subscription policy or installation adopted. The [deploy runbook](../runbooks/deploy.md) separately records the operator's dated deployment observations.
