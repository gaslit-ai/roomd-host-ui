# §1.7 — Progress (base MCP, non-task)

> Part of the [§1 Spec inventory](./README.md). Cross-references: [§1.3 tasks](./03-tasks.md) (the structured progress channel), [P5 in principles](../principles.md), [progress mux in proposed architecture](../architecture/run-registry.md#notificationsprogress-integration-p5-gap-5).

**Mechanism.** `_meta.progressToken` on a request -> server emits zero-or-more `notifications/progress` with that token. SDK auto-installs the `progressToken` from the `onprogress` option (`shared/protocol.js:643-651`). Independent of tasks: servers may send progress against any request, not only task requests. See [MCP-PROGRESS](../sources.md#mcp-progress) and [SDK-PROGRESS-REQUEST](../sources.md#sdk-progress-request).

**Schema.** `notifications/progress` params: `{ progressToken: string|number, progress: number, total?: number, message?: string }`.

**Capability requirement.** None — `assertNotificationCapability` lists `notifications/progress` as "always allowed" (`client/index.js:404-406`). So progress is the ambient backchannel; tasks are the structured one.

**Our usage.** Zero. We pass `resetTimeoutOnProgress: true` to the SDK so a healthy task stays alive (registry.ts:368-370), but we never *consume* a progress event for plain (non-task) tools — gap #5. The SDK simply discards them when no `onprogress` is set.
