# §4.28 — Spec compliance summary

> Part of the [§4 proposed architecture](./README.md). The audit table mapping every implemented spec section to the new mechanism that satisfies it. Cross-references: [§1 spec inventory](../spec/), [migration plan test matrix](../migration.md).

| § | Capability/feature | New architecture mechanism |
|---|---|---|
| [§1.1](../spec/01-lifecycle.md) | Lifecycle/capabilities | [`CapabilityBundle` factory](./capability-bundles.md); explicit form-mode `elicitation: { form: {} }`; `registerAll(client)` after connect |
| [§1.2](../spec/02-tools.md) | Tools | Wrapper preserves annotations, icons, title; honors `outputSchema` ([tool result modeling](./tool-result-modeling.md)) |
| [§1.2](../spec/02-tools.md) | `_meta.ui.resourceUri` | Already correct; preserved |
| [§1.3](../spec/03-tasks.md) | Tasks | [`RunRegistry`](./run-registry.md) with `_progressMux`, `_admitter`; `update`/`settle` discipline preserved |
| [§1.3](../spec/03-tasks.md) | TTL | `ttlExpiresAt` plus 80% warning |
| [§1.3](../spec/03-tasks.md) | `tasks/list` | Filtered to ours via persisted set |
| [§1.4](../spec/04-elicitation.md) | Elicitation form | [Bundle pattern](./capability-bundles.md); `_meta.relatedTask` surfaced as inline badge |
| [§1.4](../spec/04-elicitation.md) | Elicitation URL | Out of scope; advertise only `form` |
| [§1.5](../spec/05-sampling.md) | Sampling | [Bundle pattern](./capability-bundles.md); consent dialog unchanged |
| [§1.6](../spec/06-mcp-apps.md) | MCP Apps | `oncalltool` → `runRegistry.call`; `tool-input-partial` forwarded ([host-app-bridge](./host-app-bridge.md)) |
| [§1.7](../spec/07-progress.md) | Progress | `notifications/progress` muxed via `progressToken→runId` ([run-registry](./run-registry.md)) |
| [§1.8](../spec/08-cancellation.md) | Cancellation | Bilateral; tray cancel propagates to chat card via `AbortSignal` |
| [§1.9](../spec/09-transport.md) | Streamable HTTP | Single shared session via [`/api/mcp/proxy`](./server-proxy.md) |
