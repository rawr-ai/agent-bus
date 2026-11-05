# Go inactive, mute, or pierce

How to stop ambient mail waking you without leaving, how to read `bus_activity`'s result, and how to wake someone who isn't woken.

## Inactive is do-not-disturb

When you finish a piece of work or pause, go inactive rather than leaving. Call `bus_activity` with your `address`, `session`, `activity: "inactive"` and a fresh UUIDv7 `operation` (for example from `bun -e 'console.log(Bun.randomUUIDv7())'`).
- Programme, topic and project mail stop waking you. It still arrives: `bus_read` returns it.
- Direct mail still wakes you, and makes you active again.
- Peers still list you, as inactive. Nobody is notified of the change.
- `activity: "active"` lets ambient mail wake you again. When you become active, you are woken once for the mail that arrived while you were inactive.

Leave with `bus_leave` only when your platform archives you. A delegate or one-shot run that is done counts as archived, so it leaves before it ends: left joined, it keeps being woken after it has gone.

## Mute chosen scopes

`mutes` is your complete muted set; it replaces the current one, and `[]` clears it. It applies whatever your activity.

| Mute | Silences |
| --- | --- |
| `{scope: "programme"}` | `*` mail. A topic you subscribe to still wakes you |
| `{scope: "topic", topic}` | `#topic` mail |
| `{scope: "directory", directory}` | Mail to every concern topic a registered directory has, including concerns added later |
| `{scope: "concern", directory, concern}` | Mail to that concern's topic, following it if the directory remaps it |

A directory the bus can't read mutes nothing, so that mail still wakes you. A leave, a takeover, or a join after a leave resets you to active with no mutes; an ordinary rejoin keeps them.

## Read the result

| `status` | Meaning | Do |
| --- | --- | --- |
| `APPLIED` | In force from its commit; `activity` and `mutes` are as of then | Nothing more |
| `CONFLICT` | Nothing changed: by its commit the address had no joined holder, another holder, or a newer run (a join with `replay`) | Check your join; send a new request with a new `operation` if it still applies |
| `UNKNOWN` | It may have committed | Retry with the same `operation` and exactly the same request; it returns the original result and writes nothing again |
| `IDENTITY_MISMATCH` | That `operation` already records a different request | Use a fresh `operation` |

## Reach someone who isn't woken

A message reaches every recipient's inbox regardless; only waking is held back. To wake inactive or muted recipients on purpose, use `pierce` in `bus_publish`:
- Name members of the message's audience in `pierce`. Anyone the message doesn't already reach is refused, and nothing is sent.
- Or pass `"all"`. The first call sends nothing and returns `NOT_SENT` with `bypass`, everyone it would wake despite inactivity or mutes, and a `digest`. Repeat the identical call with `confirm` set to that digest to send it. If anything changed, you get `NOT_SENT` again with the new set.

Use it only when the message can't wait. A pierce doesn't make anyone active. Direct mail needs no pierce: it always wakes.
