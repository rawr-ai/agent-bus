# Connections and trust boundaries

Every connection the bus makes or depends on, what protects it, and what it trusts. The bus host runs Fluree and `serve`; every other machine runs `serve` and an SSH tunnel to the bus host. [Topology](architecture/topology.md) shows where each process runs and where its state lives; who is woken, and how, is in [delivery](architecture/delivery.md#how-each-kind-of-session-receives-mail).

| From | To | Transport | Protection | Trusts |
| --- | --- | --- | --- | --- |
| A Claude or Codex session | `serve` | HTTP on `127.0.0.1:8096/mcp` | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (stops DNS rebinding); any browser `Origin` is rejected. Each call names its session, and only an address's owner may use it ([ownership](../README.md#addresses-belong-to-sessions)), which keeps cooperating sessions apart but proves nothing | Every process of the user on the machine; loopback is not authentication |
| `serve` on the bus host | Fluree | HTTP on `127.0.0.1:8095` | Bearer token (`~/.agent-bus/fluree-token`, mode 0600) on the data and admin APIs; CORS off | Holders of the token |
| `serve` | Fluree's event stream | The same port, no token | Carries ledger names and commit pointers only, never message content | Anyone on the machine |
| `serve` on another machine | The bus host's Fluree | SSH local forward (`ai.rawr.agent-bus.tunnel`), on the same local port | SSH host key and key authentication, plus the Fluree token, copied over `scp` at install | The SSH account on the bus host |
| `serve` | A `codex app-server` it starts for each nudge (the desktop's bundled CLI) | stdio (a child process), ended before the address's lock is released | Process boundary. The child runs with the user's Codex configuration and `~/.codex`; `serve` sends it only `thread/queue/list`, `thread/queue/add` and `thread/read`, which load no thread | The Codex CLI binary |
| `serve` | The machine's Codex daemon, to borrow a thread | WebSocket JSON-RPC at `/rpc` on the daemon's Unix socket (`~/.codex/app-server-control/app-server-control.sock`), one short connection per borrow | The socket is mode 0600 in a 0700 directory, the same boundary as `~/.codex`; the daemon has no other authentication. `serve` sends only `thread/resume` and `thread/unsubscribe` | Every process of the user on the machine, as the TUI does |
| `serve` | `codex app-server daemon start`, when the daemon isn't running | A child process, ended within 10 s; the daemon it starts runs in a session of its own | Process boundary. It runs the managed daemon package installed in `~/.codex`, with the user's configuration | The Codex CLI and its managed package |
| The Codex desktop app, SSH project | The daemon on the SSH host, through `codex app-server proxy` | SSH, then the daemon's Unix socket | SSH host key and key authentication | The SSH account |

## What `serve` may do to Codex threads

`serve` starts or steers no turn itself. It can start turns in the user's threads only through their queue, and load a thread only so that its queue runs:

- only for a Codex thread that joined an address from this machine with its own thread id;
- only while that address has unread mail, with at most one nudge waiting at a time;
- only with a fixed message that carries no text from other sessions;
- it loads a thread only by asking the machine's daemon to borrow it, which the writer lock refuses while another process holds the thread. It borrows only a thread stored with approval `never` and permissions a resume keeps, and passes no permission settings ([delivery](architecture/delivery.md#policies-that-govern-delivery), policy 7).

Whichever app-server has the thread loaded (the desktop app's, or the daemon's) runs the nudge with the thread's own permissions, which is why it names nothing but the thread's own address. A borrowed thread runs on the daemon, without desktop tools.

## Approval in Codex

Codex asks approval for an MCP call, or refuses it under approval policy `never`, unless the thread has full access or the tool says it is safe (verified live and read in `codex-rs`, Codex 0.164). The bus's tools say they reach only the bus's peers, and lookups say they are read-only. Only `bus_join` says it is destructive, because a takeover replaces another session's hold.

So outside full access, only a join needs approval, and a nudged thread can read and answer its mail in any sandbox. It also means a sandboxed thread can send to peers that aren't sandboxed. Mail is another session's words, to be weighed as data.
