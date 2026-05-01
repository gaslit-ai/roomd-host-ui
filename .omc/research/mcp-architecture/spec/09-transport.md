# §1.9 — Streamable HTTP transport and session management

> Part of the [§1 Spec inventory](./README.md). Cross-references: [P3 in principles](../principles.md), [server-proxy transport](../architecture/server-proxy.md), [open question #1 on session pinning](../open-questions.md).

**Session-id mechanics.** Server sets `MCP-Session-Id` response header on `initialize`. Client echoes on subsequent POSTs. CORS: server MUST `Access-Control-Expose-Headers: MCP-Session-Id` for browsers. Our diagnostic fetch wrapper logs whether it is exposed (`mcp-client-provider.tsx:192-209`).

**Session and requestor isolation.** Streamable HTTP `MCP-Session-Id` is the transport's session continuity mechanism. For tasks, the spec frames visibility through the requestor's authorization context: `tasks/list` must only return tasks associated with that requestor. In our implementation, two separate clients/registries and separate session lifecycles still mean the browser tray cannot observe chat-route task handles without host-side mirroring or a shared proxy path. This is an implementation/topology fact, not a standalone MCP "per-session task visibility" rule. See [MCP-TRANSPORTS](../sources.md#mcp-transports), [MCP-TASKS](../sources.md#mcp-tasks), [REPO-CHAT-ROUTE](../sources.md#repo-chat-route), and [REPO-BROWSER-CLIENT](../sources.md#repo-browser-client).

**Session lifetime.** Server-defined. Our browser persists `sessionId` in `sessionStorage` so a refresh reattaches; the chat-route is process-scoped. There's no protocol-level "logout" — clients drop a session by closing the transport without reusing the id.
