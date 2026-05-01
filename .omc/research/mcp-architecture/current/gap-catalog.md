# §2.14 — Gap-to-file map

> Part of the [§2 current implementation map](./README.md). The 30-second tour of what's broken. Each row links to the file responsible (in [`file-map.md`](./file-map.md)) and to the principle / proposed mechanism that addresses it. Supporting source groups are listed in [../sources.md](../sources.md).

| # | Gap | Primary file(s) | Addressed by |
|---|---|---|---|
| 1 | App Views can't trigger task tools | `host-app-renderer.tsx:442-451` (current override is incomplete and flag-gated) | [P7](../principles.md), [host-app-bridge §4.22.11](../architecture/host-app-bridge.md) |
| 2 | Chat-route advertises but doesn't handle | `app/api/chat/route.ts:140-153`; needs handler registrations | [P1](../principles.md), [capability bundles](../architecture/capability-bundles.md) |
| 3 | `outputSchema` ignored | `lib/mcp/tasks/ai-sdk-adapter.ts:108-167` | [P8](../principles.md), [tool result modeling §4.10–4.11](../architecture/tool-result-modeling.md) |
| 4 | `structuredContent`/`isError` not surfaced | same | [P4](../principles.md), [tool result modeling](../architecture/tool-result-modeling.md) |
| 5 | `notifications/progress` not wired | nowhere (would belong in `registry.ts`) | [P5](../principles.md), [progress mux §4.12](../architecture/run-registry.md#notificationsprogress-integration-p5-gap-5) |
| 6 | Annotations stripped | `ai-sdk-adapter.ts:108` | [P6](../principles.md), [annotations as UX §4.13](../architecture/tool-result-modeling.md#tool-annotations-as-ux-p6-gap-6) |
| 7 | `tool-input-partial` not forwarded | `host-app-renderer.tsx`; needs producer | [P10](../principles.md), [§4.18 tool-input-partial to view](../architecture/host-app-bridge.md#tool-input-partial-to-view-p10-gap-7) |
| 8 | `tools/list_changed` not honored on route | `app/api/chat/route.ts:68-104` (module cache) | [§4.14 list_changed honored on chat route](../architecture/run-registry.md#toolslist_changed-honored-on-chat-route-gap-8) |
| 9 | `tasks/list` not filtered | `registry.ts:299-313` | [§4.15 tasks/list filter](../architecture/run-registry.md#taskslist-filter-gap-9) |
| 10 | TTL warning/cleanup | `registry.ts` (no TTL handling) | [§4.16 TTL warning + cleanup](../architecture/run-registry.md#ttl-warning--cleanup-gap-10) |
| 11 | Capability/handler symmetry mismatch | `route.ts`, `mcp-client-provider.tsx` | [P1](../principles.md), [capability bundles](../architecture/capability-bundles.md) |
| 12 | Three disconnected surfaces | `lib/message-parts.tsx:25`, `task-progress-part.tsx:43`, `task-tray.tsx:36`, `thread.tsx:236` | [P11](../principles.md), [UI surface unification §4.17](../architecture/ui-surface.md) |
| 13 | Duplicate progress rows | `ai-sdk-adapter.ts:124-149` (separate progress/terminal part types instead of one stable `data-run` type/id) | [P11 / §4.17](../architecture/ui-surface.md) |
| 14 | Tray cancel not reflected in chat card | `task-tray.tsx:118-122`; no cross-binding | [P12](../principles.md), [cancel-from-tray sequence](../architecture/lifecycle-sequences.md#cancel-from-tray) |
| 15 | `input_required` modal but no inline indicator | `elicitation-dialog.tsx`; nothing emits an inline tool-card update | [§4.17 input_required inline](../architecture/ui-surface.md) |
| 16 | Terminal vs progress visual sameness | `task-progress-part.tsx` (referenced by `ai-sdk-adapter.ts:43-44`) | [§4.17 terminal styling](../architecture/ui-surface.md) |
| 17 | TaskTray not mounted | **stale**: tray *is* mounted at `assistant.tsx:105` | n/a |
| 18 | Cross-registry blindness | `app/api/chat/route.ts:40`, `app/api/chat/route.ts:65`, `mcp-client-provider.tsx:217`, `mcp-client-provider.tsx:221` (separate clients/registries/session lifecycles) | [P3](../principles.md), [server-proxy transport](../architecture/server-proxy.md) |
| 19 | Memory leak | `registry.ts` (no terminal pruning) | [P9](../principles.md), [§4.27 memory & rate](../architecture/run-registry.md#memory-and-rate-p9-gaps-19-20) |
| 20 | Global task ceiling | `registry.ts` (no admission control) | [P9](../principles.md), [§4.27 memory & rate](../architecture/run-registry.md#memory-and-rate-p9-gaps-19-20) |
