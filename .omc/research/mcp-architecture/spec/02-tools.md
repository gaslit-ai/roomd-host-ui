# §1.2 — Tools

> Part of the [§1 Spec inventory](./README.md). Cross-references: [§1.3 tasks](./03-tasks.md) (for `taskSupport`), [§1.6 MCP Apps](./06-mcp-apps.md) (for `_meta.ui`), [tool result modeling in proposed architecture](../architecture/tool-result-modeling.md).

**Declaration.** MCP requires each tool to include a `name` and a valid object `inputSchema`; `description`, `title`, `outputSchema`, `annotations`, `execution`, `_meta`, and `icons[]` are optional. Local schema evidence: `types.d.ts:2381-2419` (`ToolSchema`) makes `inputSchema` required and the others optional. See [MCP-TOOLS](../sources.md#mcp-tools) and [SDK-TOOL-SCHEMA](../sources.md#sdk-tool-schema).

**Listing.** `tools/list` — paginated via `cursor`/`nextCursor`. Servers MAY emit `notifications/tools/list_changed` to invalidate the client's cache; clients SHOULD listen and refetch. SDK auto-handles this if the client passes `listChanged.tools.onChanged` at construction time (`client/index.js:_setupListChangedHandler` at `:575-650`). Without that option, the notification is silently dropped.

**Calling.** `tools/call` returns a `CallToolResult`:

```text
CallToolResult {
  content: ContentBlock[],         // text | image | audio | resource_link | embedded_resource
  structuredContent?: any,         // SHOULD match Tool.outputSchema if declared
  isError?: boolean,               // true => content is an error message intended for the model
  _meta?: { ... },
}
```

`types.d.ts:2501-2620` — the `content` default is `[]` and `isError` default is `false`.

**Output-schema validation.** When a tool advertises `outputSchema`, the MCP spec says the server MUST provide structured results conforming to the schema, and clients SHOULD validate them. The installed SDK is stricter in practice: it validates in two places, once for plain `callTool` (`client/index.js:498-519`) and once inside `callToolStream` (`experimental/tasks/client.js:75-110`). See [MCP-TOOLS](../sources.md#mcp-tools), [SDK-CALLTOOL-VALIDATION](../sources.md#sdk-calltool-validation), and [SDK-TASK-STREAM-VALIDATION](../sources.md#sdk-task-stream-validation).

> ```js
> if (!result.structuredContent && !result.isError) {
>     yield { type: 'error', error: new McpError(ErrorCode.InvalidRequest,
>         `Tool ${params.name} has an output schema but did not return structured content`) };
>     return;
> }
> ```

**Annotations as hints.** `types.d.ts:2354-2367`:

> NOTE: all properties in `ToolAnnotations` are **hints**. They are not guaranteed to provide a faithful description of tool behavior (including descriptive properties like `title`). Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers.

This is a *permission*, not a prohibition. Subjective design call: hosts can use `destructiveHint` and related annotations to drive UX, such as confirmation or labels, while still treating annotations as untrusted hints rather than security decisions. The spec separately recommends confirmation prompts for sensitive operations. See [MCP-TOOLS](../sources.md#mcp-tools).

**Icons.** `types.d.ts:2408-2416` — each entry is `{ src, mimeType?, sizes?, theme? }`. Display-only; render alongside the tool name.

**`_meta`.** Free-form. SEP-1865 hangs `ui.resourceUri` and `ui.visibility` here. The MCP base spec reserves the prefix `io.modelcontextprotocol/*` and warns implementers against squatting it.
