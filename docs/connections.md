# Connections and trust boundaries

Every connection the bus makes or depends on, what protects it, and what it trusts. The bus host runs Fluree and `serve`; every other machine runs `serve` and an SSH tunnel to the bus host.

| From | To | Transport | Protection | Trusts |
| --- | --- | --- | --- | --- |
| A Claude or Codex session | `serve` | HTTP on `127.0.0.1:8096/mcp` | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (stops DNS rebinding); any browser `Origin` is rejected. Each call names its session, and only an address's owner may use it ([ownership](../README.md#addresses-belong-to-sessions)), which keeps cooperating sessions apart but proves nothing | Every process of the user on the machine; loopback is not authentication |
| `serve` on the bus host | Fluree | HTTP on `127.0.0.1:8095` | Bearer token (`~/.agent-bus/fluree-token`, mode 0600) on the data and admin APIs; CORS off | Holders of the token |
| `serve` | Fluree's event stream | The same port, no token | Carries ledger names and commit pointers only, never message content | Anyone on the machine |
| `serve` on another machine | The bus host's Fluree | SSH local forward (`ai.rawr.agent-bus.tunnel`), on the same local port | SSH host key and key authentication, plus the Fluree token, copied over `scp` at install | The SSH account on the bus host |
| `serve` | A `codex app-server` it starts for each nudge (the desktop's bundled CLI) | stdio (a child process), ended before the address's lock is released | Process boundary. The child runs with the user's Codex configuration and `~/.codex`; `serve` sends it only `thread/queue/list` and `thread/queue/add`, which load no thread | The Codex CLI binary |
| The Codex desktop app, SSH project | The daemon on the SSH host, through `codex app-server proxy` | SSH, then the daemon's Unix socket | SSH host key and key authentication | The SSH account |
| A Codex `Stop` hook (`agent-bus codex-stop-hook`) | `serve` | HTTP on loopback, as a session | As for sessions; reads as the hook's own thread, so only the addresses that thread owns, and only when the hook's transcript is that thread's | Every process of the user on the machine |

## What `serve` may do to Codex threads

`serve` never loads, resumes or starts a turn in a Codex thread, and never connects to the Codex daemon. It can start turns in the user's threads only through their queue:

- only for a Codex thread that joined an address from this machine with its own thread id;
- only while that address has unread mail, with at most one nudge waiting at a time;
- only with a fixed message that carries no text from other sessions.

Whichever app-server has the thread loaded (the desktop app's, or the daemon's) runs the nudge with the thread's own permissions, which is why it names nothing but the thread's own address.

## When a nudge is queued but doesn't run

A nudge runs only where the thread is loaded, so for TUI and SSH threads it depends on the Codex daemon:

- **`serve` has to reach the thread's queue.** It needs a queue-capable Codex CLI (`serve --codex`, by default the desktop's bundled one), run as the same user with the same Codex home, on the machine that owns the thread. For a desktop SSH project, that is the SSH host. The queue methods are experimental, so the CLI's protocol has to match the daemon's.
- **A daemon restart unloads its threads.** Their nudges wait, and their mail stays unread, until each thread is reopened, which runs the nudge.
- **Nothing starts the daemon at boot;** the CLI and SSH proxies start it on first use. It inherits the open-file limit of whatever started it. When it reports `Too many open files` (in `~/.codex/app-server-control/app-server.log`), restart it from a shell with `ulimit -S -n 10240`, remembering that a restart unloads its threads.
