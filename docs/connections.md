# Connections and trust boundaries

Every connection the bus makes or depends on, what protects it, and what it trusts. The bus host runs Fluree and `serve`; every other machine runs `serve` and an SSH tunnel to the bus host.

| From | To | Transport | Protection | Trusts |
| --- | --- | --- | --- | --- |
| A Claude or Codex session | `serve` | HTTP on `127.0.0.1:8096/mcp` | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (stops DNS rebinding); any browser `Origin` is rejected | Every process of the user on the machine; loopback is not authentication |
| `serve` on the bus host | Fluree | HTTP on `127.0.0.1:8095` | Bearer token (`~/.agent-bus/fluree-token`, mode 0600) on the data and admin APIs; CORS off | Holders of the token |
| `serve` | Fluree's event stream | The same port, no token | Carries ledger names and commit pointers only, never message content | Anyone on the machine |
| `serve` on another machine | The bus host's Fluree | SSH local forward (`ai.rawr.agent-bus.tunnel`), on the same local port | SSH host key and key authentication, plus the Fluree token, copied over `scp` at install | The SSH account on the bus host |
| `serve` | The Codex app-server daemon | WebSocket over `~/.codex/app-server-control/app-server-control.sock` | The directory is 0700; no other authentication | Every process of the user on the machine |
| The Codex desktop app, Local project | Its own app-server | stdio (a child process) | Process boundary | - |
| A Codex `Stop` hook (`agent-bus codex-stop-hook`) | `serve` | HTTP on loopback, as a session | As for sessions; reads only the unread messages of the Codex peer joined with the hook's own thread | Every process of the user on the machine |
| The Codex desktop app, SSH project | The daemon on the SSH host, through `codex app-server proxy` | SSH, then the daemon's Unix socket | SSH host key and key authentication | The SSH account |

## What `serve` may do to Codex threads

The daemon socket gives full control of every thread the daemon can load, so `serve` limits itself:

- It sends `turn/start` only to Codex peers that joined from its own machine, and only with their unread bus messages.
- It never resumes a thread that was running in another app-server when it joined, so it never takes a thread from the desktop app (see [How sessions are woken](../README.md#how-sessions-are-woken)).
- It unsubscribes after each delivery, and never answers approval requests.

## Running the desktop app on the daemon

Only Local threads keep every desktop feature, so the recommended setup keeps working in Local threads and delivers to them with the Codex `Stop` hook. Two ways make desktop threads run on the daemon instead, so the bus can wake them while the owner keeps typing in them; both lose desktop features.

**An SSH project for the same machine (supported).** Add the machine's own key to `authorized_keys`, review and record its host key for `127.0.0.1`, and add a concrete `Host` alias (for example `<machine>-self`; the app ignores pattern-only hosts). Check it with `ssh <alias> 'zsh -lc "command -v codex; ulimit -n"'`, then in the app open Settings → Connections → SSH → Add, choose the alias and the project folder, and create chats under that host. This adds a loopback SSH login for the user; nothing new listens on the network. SSH projects lose the desktop's browser and computer use, native automations and trusted artifact-viewer sessions, and SSH to a Mac probably loses the app-tools bridge (Handoff, thread tools) too (desktop 26.1021.31345, from the app's code); approvals, notifications, attachments, worktrees, plugins, skills and configured MCP servers carry over.

**`CODEX_APP_SERVER_WS_URL` (undocumented; an experiment only).** Launching the app with `CODEX_APP_SERVER_WS_URL=ws+unix://localhost/<home>/.codex/app-server-control/app-server-control.sock:/rpc` makes it connect to the daemon instead of starting its own server. It opens no new listener and sends no credentials. Investigated against desktop 26.1021.31345:

- The app skips what it normally provisions for its own server: the desktop app-tools MCP bridge (Handoff and the thread and automation tools), trusted artifact-viewer sessions, its analytics and credential-storage overrides, several environment variables (browser-use authorization, workspace verification, TeX), and local window coordination.
- It neither starts the daemon nor falls back to its own server; it reconnects with back-off and shows an error while the daemon is down.
- It applies only to launches that carry the variable. `launchctl setenv`, reapplied at each login before the app starts, covers Dock and login-item launches; launches after an update are untested.
- Features are gated on the server's version, so a daemon older than the app's bundled CLI loses newer features.

## Operating the daemon

- Nothing starts the daemon at boot; the CLI and SSH proxies start it on first use. Qualify `codex app-server daemon bootstrap` before relying on it.
- It inherits the open-file limit of whatever started it. Recent CLIs raise the soft limit to `min(hard, 4096)`; older daemons don't. Restart it from a shell with `ulimit -S -n 10240` when it reports `Too many open files`, after accounting for its loaded threads, which a restart drops.
- `serve`, the desktop app's SSH projects and the CLI all share it, so restarting it interrupts every daemon-hosted thread.
