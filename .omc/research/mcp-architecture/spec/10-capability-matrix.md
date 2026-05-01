# §1.10 — Capability matrix (master)

> Part of the [§1 Spec inventory](./README.md). The single canonical lookup table for "what must be paired with a live handler, route, or refusal path when a peer advertises X". Cross-references: [P1 in principles](../principles.md), [capability bundles](../architecture/capability-bundles.md), [current implementation gap-to-file map](../current/gap-catalog.md).

| Capability | Server advertises | Client advertises | Methods that DEPEND on advertisement | Failure when missing |
|---|---|---|---|---|
| `tools` | yes | n/a | `tools/list`, `tools/call`, `notifications/tools/list_changed` | server: `-32601`; SDK throws on assert |
| `tools.listChanged` | optional flag | n/a | server emits `tools/list_changed` | client never refetches |
| `resources` | yes | n/a | `resources/list`, `resources/read`, `resources/templates/list`, `resources/subscribe` (gated by `resources.subscribe`) | server: `-32601` |
| `resources.subscribe` | flag | n/a | `resources/subscribe`, `resources/unsubscribe`, `notifications/resources/updated` | server rejects subscribe |
| `prompts` | yes | n/a | `prompts/list`, `prompts/get`, `notifications/prompts/list_changed` | client refrains; ours guards by reading `serverCapabilities?.prompts` |
| `completions` | yes | n/a | `completion/complete` | client refrains |
| `logging` | yes | n/a | `logging/setLevel`, `notifications/message` | n/a; we listen unconditionally — spec-permissive |
| `tasks` (server) | object | n/a | required for task-augmented requests when `taskSupport: 'required'`; otherwise enables `optional` upgrades | client falls back to plain |
| `tasks.list` (server) | flag | n/a | `tasks/list` | not enumerable |
| `tasks.cancel` (server) | flag | n/a | `tasks/cancel` | cancel ignored |
| `tasks.requests.tools.call` (server) | flag | n/a | accepts `task: {}` on `tools/call` | server rejects auto-upgrade |
| `tasks` (client) | n/a | object | client may call `tasks/get`/list/result/cancel | SDK throws on assert |
| `tasks.requests.elicitation.create` (client) | n/a | flag | server may issue task-augmented `elicitation/create` requests to this client | server cannot rely on task-augmented elicitation |
| `tasks.requests.sampling.createMessage` (client) | n/a | flag | server may issue task-augmented `sampling/createMessage` requests to this client | server cannot rely on task-augmented sampling |
| `elicitation` (client) | n/a | object (form / url) | client SHOULD handle `elicitation/create` | SDK throws |
| `sampling` (client) | n/a | object | client SHOULD handle `sampling/createMessage` | SDK throws |
| `roots` (client) | n/a | object (`listChanged` flag) | server may call `roots/list`; client emits list_changed | n/a |
| `extensions["io.modelcontextprotocol/ui"]` | no installed-source `mimeTypes` echo found | `mimeTypes` | host may render UI resources referenced by this server's tools/resources when client supports the extension | host falls back to standard MCP results |

The crucial property of this matrix: **every "advertised" entry in column 2 or 3 is a promise that must be paired with a live handler or a deliberate, spec-shaped refusal path**. Today, our chat-route advertises `tasks.requests.elicitation.create`, `tasks.requests.sampling.createMessage`, `elicitation`, and `sampling` (`route.ts:141-152`) but registers no `setRequestHandler` for any of them. That violates the negotiated-capability intent documented in [MCP-LIFECYCLE](../sources.md#mcp-lifecycle) and is caught structurally by [SDK-CAPABILITY-GUARDS](../sources.md#sdk-capability-guards) only when the handler/capability pair is modeled together.
