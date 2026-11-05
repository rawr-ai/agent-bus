# Read and publish orientation

How an operator or agent reads designated context and publishes a complete directory or bulletin. The rules and limits are in [orientation](../architecture/orientation.md); the exact tool schemas are in [interfaces](../architecture/interfaces.md).

## Before you start

Use a running local `serve` and the host's MCP tools. Reading orientation needs no address. Publication needs an address already joined by your own session and the human's ordinary authority to publish. Choose the audience deliberately; do not put credentials or raw tool responses in guidance. Publication is not proof that anyone read the notification.

## Read context

1. Call `bus_orient` with your absolute `cwd`, or select a known `directory` and optional `concern`. From a shell with the installed CLI:

   ```sh
   agent-bus orient --cwd "$PWD"
   ```

   To select a known concern instead, use `agent-bus orient --directory project --concern delivery`. Expect a labelled selection, programme status, and, when selected, a directory and association page. The selected concern body is returned only when requested. Inspect `status`, `cut` and `evaluatedAt`; an aggregate `UNAVAILABLE` can still contain a separately labelled current programme at that cut. Check its `section`, `message` and `recovery`, and do not infer an omitted section is empty. *Rehearsed 2026-11-03 through the CLI and official MCP SDK on a disposable authenticated file-backed server.*

2. If `status` is `INCOMPLETE`, continue candidate discovery with the returned `next` as `candidateCursor` and the same `cwd`; continue an association page with `bus_run_query`, the page's `name`, `args`, `t` and `next`. An empty candidate page can still have a continuation. A full association row too large to return offers a new membership-projection traversal at the original `t`; never reuse the full-projection cursor for it. *Rehearsed 2026-11-03 in disposable saved-query fixtures; not a live-store observation.*

3. To join and then read, add `orient: true` to `bus_join`, or use `agent-bus join --orient` with the usual address, runtime and session flags. A returned join and unavailable orientation means the join already committed. Retry the read with `agent-bus orient`, not the join. *Rehearsed 2026-11-03 against a disposable server with its query engine unavailable.*

## Publish context

1. Generate a new operation id for each intended action:

   ```sh
   bun --no-env-file -e 'console.log(Bun.randomUUIDv7())'
   ```

   Use that UUIDv7 as `operation`; preserve it and the exact intended action for a retry. Use `expected: null` only if the scope has never been registered or published. For a replacement, read the current revision first and pass it as `expected`. *Rehearsed 2026-11-03 inside disposable integration tests.*

2. Call `bus_directory` with `from`, `session`, `operation`, `expected`, a complete `directory`, and an explicit nonempty `audience`. A directory contains `id`, `name`, `aliases` and `concerns`; each concern contains `id`, `name` and a `topic`. Optional descriptions and ordered references can identify the authoritative sources. Expect `APPLIED` and retain its revision and notification receipt. There is no directory withdrawal call. *Rehearsed 2026-11-03 through the official MCP SDK on a disposable authenticated file-backed server.*

3. Call `bus_bulletin` with the same identity and revision fields, a `scope` of `{ "kind": "programme" }` or `{ "kind": "concern", "directory": "project", "concern": "delivery" }`, and `action: "publish"` plus `body`. Only a concern publication accepts deliberate direct `recipients`; its registered topic is added by the server. Optional UTC expiry accepts at most millisecond precision. To withdraw, use `action: "withdraw"`, the current revision as `expected`, and omit body, expiry and recipients. It can be withdrawn after concern removal. Expect a retained withdrawal revision and a notification to the prior audience. *Rehearsed 2026-11-03 on the disposable file-backed provider; delivery to a topic, a direct recipient and an associated but unsubscribed address was checked independently.*

## If it fails

- `UNKNOWN` may have committed. Retry the identical action, scope, expectation, payload and audience with the same operation id; do not automatically generate a replacement id or rebase. If uncertainty persists, stop and inspect the receipt and [recover](recover.md).
- `IDENTITY_MISMATCH` means the id belongs to a different intent or publisher. Stop and inspect; do not reuse it for this action.
- `CONFLICT` means a different designation was observed after the attempt. Read the current state and deliberately decide the next action with a new operation id.
- `DAMAGE` or an unavailable query is not an empty or complete result. Keep the cut and the returned recovery route; tell the operator rather than skipping a unit. See [recover](recover.md).
- An association-bearing or orientation-requesting CLI join refuses before mutation when the fresh server's descriptors do not establish support. Reconnect to a compatible server; an absent or mismatched post-join echo instead reports uncertainty and must not be followed by an automatic rejoin. A transport failure can follow a committed ordinary join too; inspect it read-only.
