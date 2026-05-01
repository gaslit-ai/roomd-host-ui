# §1.3 — Tasks

> Part of the [§1 Spec inventory](./README.md). Cross-references: [§1.2 tools](./02-tools.md) (for `taskSupport`), [§1.4 elicitation](./04-elicitation.md) and [§1.5 sampling](./05-sampling.md) (delivered through the `input_required` race), [Run abstraction](../architecture/run-abstraction.md), [Run registry](../architecture/run-registry.md).

**Status enum.** `types.d.ts:1026-1032`:

```text
TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'
```

Note that the spec status enum has *no* `'pending'`. Our `TaskHandle` adds a local `'pending'` only as a pre-`taskCreated` marker — see `lib/mcp/tasks/handle.ts:42-48`. This is reasonable but should be flagged as host-side-only.

**Task schema.** `types.d.ts:1036-1050`:

```text
Task {
  taskId: string,
  status: TaskStatus,
  ttl: number | null,         // ms remaining; null means no TTL
  createdAt: string,          // ISO8601
  lastUpdatedAt: string,
  pollInterval?: number,      // ms; server's preferred poll cadence
  statusMessage?: string,
}
```

**Lifecycle.** A request that opts into the task path (the request includes a `params.task` object) follows: client sends the request → server creates a task → server returns `CreateTaskResult` with the initial `Task` object → client polls `tasks/get` until terminal OR the task hits `input_required` → on `input_required` the client calls `tasks/result` (which long-polls and *also* drains queued elicitation/sampling requests delivered as side-channel messages) → on `completed` the client calls `tasks/result` to fetch the actual result.

**`tasks/get`.** `types.d.ts:1149-1196`. Returns the live `Task` object. No payload.

**`tasks/result`.** `types.d.ts:1200-1241`. Returns the typed result of the *original* request (e.g., `CallToolResult` for a `tools/call` task). Long-polling: blocks until terminal-or-timeout, AND on `input_required` returns a special envelope through which the SDK pushes `elicitation/create` and `sampling/createMessage` server→client requests over the same HTTP response stream.

**Critical mechanic — the input_required race.** Read `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:586-591`:

> ```js
> // When input_required, call tasks/result to deliver queued messages
> // (elicitation, sampling) via SSE and block until terminal
> if (task.status === 'input_required') {
>     const result = await this.getTaskResult({ taskId }, resultSchema, options);
>     yield { type: 'result', result };
>     return;
> }
> ```

The SDK detects `input_required`, swaps polling for a single blocking `tasks/result` call that drains queued server-initiated requests, and yields the eventual `result` directly. This is also why our `TaskHandleImpl` correctly distinguishes `update()` (UI-only push notification) from `settle()` (terminal authority): a status notification can mark a task `completed` *before* `tasks/result` returns the payload, and conflating them produces a "completed but no payload" race that we already documented in `lib/mcp/tasks/handle.ts:9-23`.

**`tasks/list`.** `types.d.ts:1245-1295`. Paginated enumeration of tasks visible to the requestor. The spec's security section says returned tasks must be associated with the requestor's authorization context; that is stronger and more precise than "server-wide" or "per-session". Our reattach loop in `registry.ts:299-313` adopts every non-terminal task returned by the current client, so the host should still filter to task ids it created when using shared clients or reconnect flows. See [MCP-TASKS](../sources.md#mcp-tasks).

**`tasks/cancel`.** `types.d.ts:1299-1316`. The server commits the transition to `cancelled` synchronously (rule 2 — "the boundary transitions to `cancelled` before responding"), so subsequent push notifications and `tasks/result` see `cancelled`. Our `TaskHandleImpl.cancel()` flips local state pre-roundtrip (`handle.ts:135-153`) which is spec-friendly.

**`notifications/tasks/status`.** `types.d.ts:1116-1145`:

```text
TaskStatusNotification {
  method: 'notifications/tasks/status',
  params: TaskStatusNotificationParams = Task & {
    _meta?: { progressToken?, 'io.modelcontextprotocol/related-task'? },
  }
}
```

Push-only — UI metadata, no payload. Our registry installs a single handler at `registry.ts:95-117`.

**TTL.** `Task.ttl` is `number | null`. If `null`, no TTL applies. If a number, it represents the remaining lifetime. We have *no* TTL handling — gap #10. Subjective UX recommendation: surface a warning around 80% of TTL so users are not surprised by task expiry.

**Tool-level task negotiation.** `types.d.ts:2371-2406` (`ToolExecutionSchema`):

```text
Tool.execution.taskSupport ∈ { 'optional' | 'required' | 'forbidden' | undefined }
```

Semantics (per spec / SDK behavior at `client/index.js:490-558`):

| `taskSupport` | client `callTool` | client `callToolStream` (i.e., `task: {}`) |
|---|---|---|
| `undefined` or absent | OK (plain) | OK; SDK sets `task: undefined`, falls through to plain |
| `'optional'` | OK (plain) | OK; SDK auto-sets `task: {}` and runs the task path |
| `'required'` | **rejected by SDK** with `InvalidRequest` ("requires task-based execution") | OK; required path |
| `'forbidden'` | OK (plain) | server SHOULD reject; SDK MAY hide the task option |

The SDK pre-caches the required/known sets in `cacheToolMetadata` (`:539-558`), called from `listTools()`. This is why our task-aware tool wrapper is necessary: `@ai-sdk/mcp` calls `callTool` directly (`@ai-sdk/mcp/dist/index.mjs:1947-1958`), which the SDK auto-rejects for `taskSupport: 'required'` tools.
