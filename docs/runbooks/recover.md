# Recover

Use this when the bus misbehaves: each symptom, how to check it, the fix and how to verify it. Routine operation is in [operate](operate.md).

## Before you start

## A wedged Codex daemon

<!-- draft from phase 2: docs/architecture/codex-hosting.md, "What waking needs from each machine"; docs/frames/load-on-mail.md, "Known limits" -->

Symptom: the daemon's socket answers, but its requests time out. Borrows fail and back off with a warning in `serve`'s log (`~/.agent-bus/agent-bus.log`). It needs restarting by hand: see [operate](operate.md#the-codex-daemon-file-limit-and-restarts) for how, and for the open-file limit to raise first.

## Borrowed turns run as an earlier user

<!-- draft from phase 2: docs/architecture/codex-hosting.md, "What waking needs from each machine"; docs/frames/load-on-mail.md, "Known limits" and qualification results -->

Symptom: after the owner changes the Codex login, borrowed turns run as the earlier user, and fail if that user's limit is used up (the turns saw "Your workspace is out of credits"). The daemon keeps the login it started with ([platforms: Codex](../platforms/codex.md#the-daemon)). Fix: restart the daemon ([operate](operate.md#the-codex-daemon-file-limit-and-restarts)). After the restart in the source's test, every check passed.

## `bun` not found over SSH on the other machine

<!-- draft from phase 2: docs/overview.md, "Open gaps and limits" (status "Operations") -->

The other machine's non-interactive SSH `PATH` lacks `bun`. A remote command that needs `bun` can fail to find it; remote commands need `~/.bun/bin` on their `PATH`. This is stated in the source as a limit, not as an observed error message.

## If it fails
