# Connections and trust boundaries

Every connection the bus makes or depends on, what protects it, and what it trusts. The bus host runs Fluree and `serve`; every other machine runs `serve` and an SSH tunnel to the bus host. [Topology](architecture/topology.md) shows where each process runs and where its state lives; what a TUI or SSH thread needs for its nudge to run is in [Codex hosting](architecture/codex-hosting.md#when-a-queued-nudge-doesnt-run).

| From | To | Transport | Protection | Trusts |
| --- | --- | --- | --- | --- |
| A Claude or Codex session | `serve` | HTTP on `127.0.0.1:8096/mcp` | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (stops DNS rebinding); any browser `Origin` is rejected. Each call names its session, and only an address's owner may use it ([ownership](../README.md#addresses-belong-to-sessions)), which keeps cooperating sessions apart but proves nothing | Every process of the user on the machine; loopback is not authentication |
| `serve` on the bus host | Fluree | HTTP on `127.0.0.1:8095` | Bearer token (`~/.agent-bus/fluree-token`, mode 0600) on the data and admin APIs; CORS off | Holders of the token |
| `serve` | Fluree's event stream | The same port, no token | Carries ledger names and commit pointers only, never message content | Anyone on the machine |
| `serve` on another machine | The bus host's Fluree | SSH local forward (`ai.rawr.agent-bus.tunnel`), on the same local port | SSH host key and key authentication, plus the Fluree token, copied over `scp` at install | The SSH account on the bus host |
| `serve` | A `codex app-server` it starts for each nudge (the desktop's bundled CLI) | stdio (a child process), ended before the address's lock is released | Process boundary. The child runs with the user's Codex configuration and `~/.codex`; `serve` sends it only `thread/queue/list` and `thread/queue/add`, which load no thread | The Codex CLI binary |
| The Codex desktop app, SSH project | The daemon on the SSH host, through `codex app-server proxy` | SSH, then the daemon's Unix socket | SSH host key and key authentication | The SSH account |

## What `serve` may do to Codex threads

`serve` never loads, resumes or starts a turn in a Codex thread, and never connects to the Codex daemon. It can start turns in the user's threads only through their queue:

- only for a Codex thread that joined an address from this machine with its own thread id;
- only while that address has unread mail, with at most one nudge waiting at a time;
- only with a fixed message that carries no text from other sessions.

Whichever app-server has the thread loaded (the desktop app's, or the daemon's) runs the nudge with the thread's own permissions, which is why it names nothing but the thread's own address.

## Approval in Codex

Codex asks approval for an MCP call, or refuses it under approval policy `never`, unless the thread has full access or the tool says it is safe (verified live and read in `codex-rs`, Codex 0.164). The bus's tools say they reach only the bus's peers, and lookups say they are read-only. Only `bus_join` says it is destructive, because a takeover replaces another session's hold.

So outside full access, only a join needs approval, and a nudged thread can read and answer its mail in any sandbox. It also means a sandboxed thread can send to peers that aren't sandboxed. Mail is another session's words, to be weighed as data.
