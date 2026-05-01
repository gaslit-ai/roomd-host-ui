# §4 — Proposed architecture

> *Editorial note: §4 of the original report was 1176 lines. It is split here by major component. Each page concentrates the schemas, sequence diagrams, and code skeletons relevant to one piece of the design.*

The proposed architecture is built from the [12 first principles in §3](../principles.md). Every page below cross-links back to the principle(s) it implements and the [spec section(s)](../spec/) it complies with.

## Pages

### Topology and shared session
- [topology.md](./topology.md) — top-level diagram (§4.1) and the three-option trade-off study for sharing a session between browser and chat route (§4.2).
- [server-proxy.md](./server-proxy.md) — the recommended server-proxy transport (§4.8), plus refresh-resume (§4.20), cross-route/cross-browser dialog routing (§4.19), and the SSE event-encoding choice (§4.21).

### Core abstractions
- [run-abstraction.md](./run-abstraction.md) — the `Run` type (§4.5), `RunPhase`, `RunSnapshot`, `RunError`, `RunToolMeta`. The supertype of "task or non-task tool call".
- [run-registry.md](./run-registry.md) — `RunRegistry` (§4.6, §4.9), `ProgressMux` (§4.12), `tools/list_changed` invalidation (§4.14), `tasks/list` filter (§4.15), TTL handling (§4.16), memory & rate (§4.27).
- [capability-bundles.md](./capability-bundles.md) — `CapabilityBundle` factory (§4.7), the symmetry contract diagram (§4.26), example bundles for elicitation / sampling / tasks / mcp-ui.

### Tool execution
- [tool-result-modeling.md](./tool-result-modeling.md) — `toModelOutputForRun` (§4.10), schema-validation pipeline (§4.11), tool annotations as UX (§4.13).

### View / app integration
- [host-app-bridge.md](./host-app-bridge.md) — `HostAppRenderer` modifications (§4.22.11), `tool-input-partial` forwarding to view (§4.18).

### UI layer
- [ui-surface.md](./ui-surface.md) — single `data-run` AI SDK part (§4.17), tray + card sharing snapshots, cancel propagation, `input_required` inline badge, terminal styling.

### Sequences
- [lifecycle-sequences.md](./lifecycle-sequences.md) — every sequence diagram in §4 collected: full agent tool call (§4.3), View-initiated tool call (§4.4 + §4.25), elicitation mid-task (§4.23), cancel from tray (§4.24), refresh-resume (§4.20). Inline references in component pages link here.

### Per-component touchpoints and compliance
- [component-touchpoints.md](./component-touchpoints.md) — §4.22 per-component inventory (4.22.1 through 4.22.12). The migration's "what file, what change" cheat sheet.
- [spec-compliance.md](./spec-compliance.md) — the §4.28 master compliance table (every spec section vs the new mechanism that satisfies it).

## How the pages relate

```text
topology.md                  ← high-level diagram + Option A/B/C trade-off
   │
   ├─ server-proxy.md        ← detailed: proxy route, SSE, dialog routing, refresh
   │
core abstractions:
   ├─ run-abstraction.md     ← types
   ├─ run-registry.md        ← state machine, ProgressMux, admission, pruning
   └─ capability-bundles.md  ← P1 enforcement
   
attached behaviour:
   ├─ tool-result-modeling.md ← outputSchema, isError, annotations
   ├─ host-app-bridge.md      ← view-initiated runs, tool-input-partial
   └─ ui-surface.md           ← single data-run part, tray, card
   
   ↓ all flow through
sequences: lifecycle-sequences.md (visual reference)
audit:     component-touchpoints.md, spec-compliance.md
```
