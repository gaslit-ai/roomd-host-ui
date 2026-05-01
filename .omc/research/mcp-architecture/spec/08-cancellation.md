# §1.8 — Cancellation

> Part of the [§1 Spec inventory](./README.md). Cross-references: [§1.3 tasks](./03-tasks.md) (`tasks/cancel`), [P12 in principles](../principles.md), [cancel-from-tray sequence](../architecture/lifecycle-sequences.md#cancel-from-tray).

**Base MCP cancellation.** `notifications/cancelled` carries `{ requestId, reason? }`. Either side may send it; the receiver should attempt to abort and free resources. SDK fires this automatically when an `AbortSignal` aborts (`shared/protocol.js:670-687`). See [MCP-CANCELLATION](../sources.md#mcp-cancellation).

**Task cancellation.** `tasks/cancel { taskId }` is a *request*, not a notification, so it has a result. Returns synchronously after the server commits the transition. Distinct from the request-level `notifications/cancelled` — task cancel applies to the entire task lifecycle, request cancel applies to the in-flight HTTP message.
