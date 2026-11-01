# Frame: inactive is still reachable

This candidate frame studies work activity separately from address retirement in the [turnaround](coordination-turnaround.md). Current ownership, cursors and wake behaviour remain in [messaging](../architecture/messaging.md) and [delivery](../architecture/delivery.md).

Status: owner-confirmed outcome, proposed feature frame; transition API not accepted. DRA: Claude lead, cross-reviewed by Codex. Depends on the orientation vertical's shared relationship model and composed onboarding boundary. Mode: co-framing; object: solution.

## What and why

An agent finishing a unit may need fewer concern notifications while remaining reachable for direct contact and reactivation. Treating every completion as leaving retires that connection. The product needs an explicit distinction between address membership, work activity and topic interest.

In are active/inactive transitions, direct-mail reachability, notification/subscription policy and current orientation on return. Foreground a real completed participant being re-engaged without a human rejoining its address. Exterior are liveness inferred from silence, expiry that releases ownership, automatic takeover and task-completion tracking.

An alternative is clearing subscriptions while staying joined. Keep it if it meets the complete workflow, but compare discoverability, restoration of interests and current-bulletin delivery. Merely changing the skill's leave sentence may leave the underlying state transition implicit.

## Hard core and open questions

1. Inactivity never transfers ownership or makes another session the reader of the inbox.
2. Direct contact remains available; the contract explicitly distinguishes suppressing wakes from suppressing topic delivery.
3. Reactivation has an explicit backlog and current-bulletin policy, with no silent cursor reset or replay.

The owner explicitly asked that inactive/done/idle agents remain on the bus for direct messages and reactivation while stopping project/topic notifications (O4 in the parent frame). Existing wake paths can re-engage only supported available runtimes: a closed Claude session is not made executable merely by retaining its address; its hook-based wake needs a running session. Queued direct contact and actual execution must be distinguished. State vocabulary and exact transition API remain undecided; do not reuse current joined/left values as work-status labels without design.

The replacement must reconcile current MCP instruction point 7, the skill's leave-when-done guidance and the runtimes reference's delegate-leave rule. Retire contradictory defaults across those surfaces together; do not preserve them as a fallback beside inactivity.

## Adoption and falsifier

Baseline the actual finish-and-reactivate workflow, including any owner intervention. After deploy, an existing participant becomes inactive, stops the agreed concern notifications, receives a legitimate direct reactivation and recovers current orientation without another owner manipulating its session. Maintained transition tests supplement, not replace, that real use. If a human must still restore the contact or unread messages are lost, reframe before adoption.

## Moved into current docs

- [ ] Activity transition and peer-result contract.
- [ ] Delivery, cursor and retirement rules.
- [ ] Finish/inactive/leave guidance across skill and server instructions.
- [ ] Runtime transition claims with observed basis.
- [ ] Reactivation and recovery procedure.
