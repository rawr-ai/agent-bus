# Viewer: local public observations

The optional browser viewer's reading model, implementation boundary and limits. The public bus tools are owned by [interfaces](interfaces.md), audience and reply meaning by [messaging](messaging.md), and core connection policy by [connections](connections.md). Starting and recovering the viewer belongs in its [runbook](../runbooks/viewer.md).

## What it does

The viewer is a separate loopback process, not another `serve`. It serves built React assets and two fixed oRPC procedures, which use a narrowly scoped Effect MCP reader of the existing machine's `serve`. The reader discovers that server once and reuses one client and its tool list, so each observation is a single tool call; a failed discovery or a missing tool is discovered again on the next read. It imports no core bus, ledger, cursor or wake implementation. The core executable and its deployment are unchanged.

```mermaid
flowchart LR
  Browser[Browser contexts and conversation reader] --> Viewer[Loopback viewer: guarded assets and RPC]
  Viewer --> Reader[Fixed public MCP reader]
  Reader --> Serve[Existing machine serve]
  Serve --> Ledger[Existing store]
  classDef browser fill:#eef4f5,stroke:#3c737d,color:#203f45
  classDef existing fill:#edf4ed,stroke:#497849,color:#274127
  class Browser,Viewer,Reader browser
  class Serve,Ledger existing
```

History and current peers are independent observations. Each has its own receipt time, loading/error state, omitted-record count and last-good content. Receipt time belongs to the viewer clock, not the ledger. The primary reading units are literal topic/address contexts and observed reply groups, not a global message list. The composition location is inert and has no send path.

Submitted text search and exact participant criteria request a replacement bounded server observation, preserving its returned order. Empty form fields mean absent; other text is not trimmed or casefolded. Apply and Clear open all result groups rather than accidentally intersecting them with a previously selected local topic. Current-peer investigation uses an exactly representable address, not inferred delivery. The reader keeps the actual criteria of displayed last-good or retained data while a different request is pending or failed.

Automatic refresh is enabled for the current page session and uses one timer. History and peers skip their own already-pending automatic read independently; manual refresh may replace pending work. Explicit pause and hidden-page state suppress scheduled work, while resume or visibility restoration requests one observation without a catch-up queue. Refresh does not navigate, steal focus or force scroll. Criteria, results and pause state are not persisted across reloads.

The conversation model projects one active bounded history observation. A visible message is a node; an explicit `replyTo` is an edge to its loaded target or a reference-only missing anchor. Weakly connected components include siblings sharing a missing parent, cycles and isolated messages. A context matches any literal member but retains its whole observed component, including replies addressed elsewhere. Current peers never expand those audiences. Messages keep source order; group summaries use latest source position, not a new interpretation of timestamps. A topic context can be read as a full context flow without clicking every singleton group; that flow is not one invented conversation. Chronology remains an alternate view.

The selected message ID anchors conversation navigation, not a fabricated stable thread ID. Reply targets resolve only inside the displayed reading unit. Before a refresh renders, the reader checks whether any displayed message would disappear. If so, it retains exactly one prior bounded reading unit, either that conversation or that literal context flow, with its actual criteria and receipt time. A persistent fixed-header indicator remains visible when its fuller caveat scrolls away. Old and new units are never merged. Explicit context/conversation selection or Read context accepts the current unit; automatic and ordinary manual refresh do not discard it. Hash navigation supports local links and Back without changing the HTTP trust boundary.

Message bodies have a safe GFM Markdown view and a Source view. HTML is not interpreted, image nodes do not create image elements, and only explicit absolute HTTP(S) links can be activated by the reader. Metadata remains isolated text. Directional/control characters use visible notation. A large body's full source remains readable when its Markdown preview exceeds the client rendering limit. Light/dark appearance defaults to the system until a reader chooses; only that appearance preference is persisted, never messages.

The implementation lives under `viewer/`; `scripts/build-viewer.ts` emits the browser assets, exact asset manifest and server artifact. App composition owns shared navigation/selection, feature code owns reading surfaces, and the shared public contract owns projection. The production bootstrap creates the real typed client; Storybook injects synthetic state into the same App and production components. Browser imports of the server client surface are type-only; the production build checks the browser module graph for core/server and test-workbench imports.

## Rules

1. The existing `serve` remains the only store owner. Viewer business calls are exactly `bus_history` and `bus_peers`. Protocol discovery and cancellation are transport machinery, not permission to forward another business operation. No viewer join, inbox read, wait, wake, send, public SPARQL, store fallback or browser-selected upstream exists.
2. Viewer and upstream destinations are server-owned loopback addresses. The viewer binds `127.0.0.1`, requires its exact Host and same Origin when Origin is present, rejects foreign and `null` origins, and serves no permissive CORS response. Origin-less local clients remain allowed; this is not user authentication. It refuses to start on a port another process holds on `127.0.0.1`, `0.0.0.0` or `[::]`, rather than taking that owner's loopback traffic.
3. One guarded handler serves only the generated asset allowlist and the exact RPC leaves. RPC is POST-only JSON. Method, body, input and concurrency checks precede business work. Unknown fields cannot select tools, headers, paths or a destination. Environment files are not part of the supported launch path.
4. Runtime validation and explicit nested projection establish the browser DTO. Unknown extra fields are discarded. Invalid records and all raw rows sharing a duplicate valid identity are omitted with a count, never silently replaced by an arbitrary winner. Invalid envelopes, excess counts or response-byte limits make the resource unavailable rather than truncating it. No raw upstream response, diagnostic, private cause or parse value enters browser errors or logs.
5. History is a bounded newest or best-match selection, returned chronologically. Preserve the returned message order and literal audience. Neither a full nor a short result proves completeness or exhaustion. Context grouping is a projection of explicit reply references, not topic co-occurrence, subject similarity or body mentions. Select whole observed components before filtering their messages away. Missing anchors are not fabricated messages or proof of deletion. Exact participant matching is not a recipient inbox or a subscription expansion. Current peer subscriptions never rewrite historical audiences.
6. Reading, routing, reply linkage, acceptance and completion are different facts. Do not infer read/delivery/completion, verified identity, online state, historical membership or deletion from these observations. Origin describes recorded message provenance, not the sender's current working state.
7. Failed refreshes preserve independently labeled last-good data with its actual criteria and receipt time, never relabeled as matching a new request. A failed lookup is not an empty success; an all-omitted observation is not an ordinary empty result. Request generations, cancellation and per-resource deadlines prevent stale results and endless loading. Preserve reading position, focus and explicit selection rather than replacing them with new data. No messages are persisted in browser storage or accumulated into an unbounded archive.
8. The application owns the native async/Effect boundary, safe error classification, interruption and shutdown. Stop intake, cancel active requests, await dependency cleanup and runtime disposal. Do not hide defects inside an expected upstream error or rely on TypeScript as output validation.
9. Markdown changes presentation, not trust. No raw HTML/MDX, executable playground, automatic image/media request, prefetch or message-controlled local/custom-protocol navigation exists. Unsupported destinations are inert rather than empty/self links. Checked Markdown task items are read-only sender-authored content, never inferred bus task state. Source with controls exposed is not claimed as byte-identical clipboard data.

## Why

Topic/address context and explicit reply groups let a reader follow actual coordination without reconstructing it from isolated global rows. Context flow also works when senders supplied no reply links. A directory of current peers cannot explain historical recipients from present subscriptions. A complete pinned historical audit product would require a different public capability and its own decision.

A separate viewer process avoids expanding the deployed bus server's browser surface or granting its store capability to a UI. Fixed public procedures are smaller and more auditable than generic MCP forwarding. Native oRPC plus an explicit application-owned Effect edge preserves the existing runtime without adopting an unqualified bridge package, alternate Effect major, ambient context bridge or prototype extension.

The existing Bun build tool handles this bounded browser application. A generated asset manifest avoids a filesystem catch-all and keeps static assets behind the same guard as data. No framework migration, database, auth subsystem, global client store, telemetry service or persistent installation is required.

## Limits

- This is a local observer for any client that can reach its loopback boundary, not a per-address confidentiality or authenticated multi-user product. Public message text, notes and allowed provenance can themselves contain sensitive content; projection is not a secret detector.
- There is no complete-history pagination, exact-ID lookup, pinned snapshot, total, historical membership or delivery/read evidence. Search has the upstream [full-text limits](../platforms/fluree.md#full-text-search), including index-startup and historical-gap uncertainty. Empty results do not establish that a historical match does not exist.
- Observed reply groups are not complete threads, even when every visible parent resolves. A latest window can omit a quiet topic's older exchange or later replies. Context flow includes matching groups' differently addressed replies without claiming that they were sent to the selected topic.
- Automatic refresh is periodic observation, not a push stream or proof that every intermediate message was seen. A hidden, paused or retained reading may be stale; its own receipt time and persistent retained-state label remain the evidence. Applying criteria is a new server selection, not pagination or a merged archive. Reload does not restore search or a retained reading unit.
- Markdown previews have a bounded parsing workload; long full source is not discarded. HTTP(S)-only links are a scheme policy, not a guarantee that a destination is reputable. Remote images remain omitted even when the same image could be fetched manually elsewhere.
- Limits and launch settings belong to the [viewer interface catalogue](interfaces.md#viewer); the [runbook](../runbooks/viewer.md#if-it-fails) covers failures. Oversized responses fail visibly, not partially truncated text.
- Bun binds `127.0.0.1` even when another process holds the port on `0.0.0.0` or `[::]`, so the viewer checks those addresses first by binding and releasing each at once; nothing is served there. The check and the real bind are not atomic, so a process that takes the port between them is not detected.
- The shipped browser and server artifacts share one local release. Runtime dependencies increase this private package's install footprint even though the core executable does not import the viewer. Public hosting, merging, deployment of the core bus or persistent service installation are separate decisions.

## Rests on

The current [public tool contracts](interfaces.md#bus_history), [messaging model](messaging.md) and [core trust boundary](connections.md#rules); the [Fluree search findings](../platforms/fluree.md#full-text-search); exact dependencies pinned in `package.json` and `bun.lock`; and the viewer's projection, host, wire, lifecycle, build and browser verification. Installed external platform behavior is distinguished from agent-bus policy in [platforms](../platforms/README.md).

## History

The [preparation frame](../frames/agent-bus-viewer.md) records the accepted product/team boundary. The [implementation and qualification frame](../frames/agent-bus-viewer-release.md) records discovery, alternatives, exact compatibility experiments and release evidence.
The [workbench frame](../frames/viewer-workbench.md) records the owner-directed Storybook, Stagehand and local caching qualification.
