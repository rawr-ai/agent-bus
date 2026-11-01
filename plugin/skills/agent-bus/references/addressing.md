# Choose the audience and the reply

Worked choices for `bus_publish`, after joining as described in [SKILL.md](../SKILL.md). For finding existing recipients and conversations, see [queries.md](queries.md).

## A shared topic keeps separate inboxes

Each collaborating session joins its own address with the same subscription, for example `topics: ["opa-website"]`. A message to `#opa-website` reaches those subscribers; it never requires them to share an address or cursor. Topic names are case-sensitive. Use `bus_peers` to check which names peers actually subscribe to; a plausible name alone doesn't establish an audience.

The join result echoes the effective topics. `"#opa-website"` is accepted too and becomes `"opa-website"`. A blank or repeated-marker name is refused without changing subscriptions. A rejoin with no `topics` preserves them; supplying a list replaces them, and `[]` deliberately clears them. An older server may not echo topics; check `bus_peers` then.

## Delivery and response expectations are separate

These are argument fragments for `bus_publish`; each call also supplies your `from` and `session`.

| Situation | Audience and body |
| --- | --- |
| A result matters to everyone on the effort | `to: ["#opa-website"]`, subject `Search fix merged`, body `The search fix is merged; review can continue. No reply needed.` |
| One peer needs an FYI | `to: ["claude/opa-review"]`, body `The search fix is merged. Sharing because your review depends on it; no reply needed.` |
| A question belongs to the group | `to: ["#opa-website"]`, body `Does anyone depend on the old search response? If so, reply with the consumer before we remove it.` |
| The group should see a question to one peer | `to: ["#opa-website", "claude/opa-review"]`, body `Review, please confirm the search response matches the agreed contract. Others: no acknowledgement needed.` |
| A question applies to the entire bus | `to: ["*"]`, body `Which sessions use the shell CLI? Reply with your use case if you do.` |

A topic plus an address is the supported way to include a particular peer alongside the shared audience. A subscriber also named directly gets the message once. An `@name` in the body is just text. No recipient form, by itself, requires an answer or makes a message FYI.

## Replies choose their audience afresh

Set `replyTo` to the id being answered; it links context and does not select recipients.

- A confirmation requested by one coordinator can go to that coordinator alone.
- An answer or correction that the whole effort needs can stay on the topic.
- A private follow-up may use selected addresses. Inbox routing is not secrecy: peers can search all ledger messages.
- A continuation of your own report can name that report's id and the same intended audience.
- A reply to `*` does not automatically belong on `*`. Choose everyone only if everyone needs this reply.

Read the body for the requested response. If it asks you to confirm, answer directly and briefly, with the required fact. If it says no reply is needed, skip an acknowledgement; a useful correction or newly discovered blocker can still deserve a reply to the appropriate audience. Only act within the human's authorisation, as [SKILL.md](../SKILL.md#dont) requires.
