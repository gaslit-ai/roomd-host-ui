# §1.6 — MCP Apps (SEP-1865)

> Part of the [§1 Spec inventory](./README.md). Cross-references: [§1.2 tools](./02-tools.md) (linkage via `_meta.ui`), [HostAppRenderer / view-initiated runs](../architecture/host-app-bridge.md), [P7 / P10 in principles](../principles.md).

**Capability negotiation.** Hosts advertise extension `io.modelcontextprotocol/ui` with MIME types they accept. The current ext-apps schema places `mimeTypes` on `McpUiClientCapabilities`; I found no primary installed-source evidence that servers must echo the same `mimeTypes` on `ServerCapabilities.extensions`. Our provider advertises client support via `UI_EXTENSION_CAPABILITIES` from `@mcp-ui/client` (`mcp-client-provider.tsx:242`). See [MCP-APPS-SPEC](../sources.md#mcp-apps-spec), [EXT-APPS-CAPABILITY](../sources.md#ext-apps-capability), and [MCP-UI-CLIENT-CAPABILITY](../sources.md#mcp-ui-client-capability).

**Tool linkage.** A tool may carry `_meta.ui.resourceUri = 'ui://...'`. The host treats that tool as "App-eligible": when called, the tool result triggers an iframe render of the named UI resource. `ui.visibility` is `['model']`, `['app']`, or both — `['app']`-only tools MUST NOT be exposed to the agent (we filter at `app/api/chat/route.ts:330-341`).

**View ↔ Host channel.** `AppBridge` (`@modelcontextprotocol/ext-apps`) is a `Protocol` subclass that runs the host side over `postMessage`. View calls go: View → AppBridge → host code (which usually proxies to the upstream MCP `Client`).

**View capability restrictions.** `ext-apps/src/app-bridge.js`:

> `assertTaskCapability(X){throw Error("Tasks are not supported in MCP Apps")}`
> `assertTaskHandlerCapability(X){throw Error("Task handlers are not supported in MCP Apps")}`

Views CANNOT initiate task-augmented requests. They send plain `tools/call`. *The host* must upgrade the call when the underlying tool advertises `taskSupport: 'required'`. Today our `host-app-renderer.tsx:442-451` does this only when `taskRegistry` is non-null; otherwise the view can fall back to AppBridge's plain forwarding. Replacing the handler can produce the documented AppBridge "handler replaced" warning. Calling that warning acceptable is a subjective maintenance trade-off, not a spec fact.

**`ui/notifications/tool-input-partial`.** Streaming partial JSON of the tool's incoming arguments (host -> view). Lets a View render an in-progress card before the agent finishes producing the call. Today `HostAppRenderer` has a `toolInputPartial` effect (`host-app-renderer.tsx:545-548`) and cancellation effect (`:550-553`), while final `toolInput` and `toolResult` are passed into `AppFrame` at `:589-594`. No caller produces partial inputs yet — gap #7. See [EXT-APPS-BRIDGE](../sources.md#ext-apps-bridge) and [REPO-HOST-APP](../sources.md#repo-host-app).

**`ui/notifications/tool-result`.** Final `CallToolResult` delivered to the view post-execution. SEP-1865 requires it AFTER `tool-input` and only "if the View is still displayed."
