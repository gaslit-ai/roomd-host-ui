# §1.4 — Elicitation

> Part of the [§1 Spec inventory](./README.md). Cross-references: [§1.3 tasks](./03-tasks.md) (queued mid-task via `_meta.io.modelcontextprotocol/related-task`), [capability bundles](../architecture/capability-bundles.md), [server-proxy dialog routing](../architecture/server-proxy.md#cross-routebrowser-dialog-routing-419).

**Capability advertisement.** Client capabilities `elicitation` is an object that can contain `form: { applyDefaults?: boolean }` and `url: object`. The installed SDK treats bare `elicitation: {}` as form-mode support for backward compatibility, while URL mode is supported only when `url` is explicitly declared (`client/index.js:60-79`). Our current browser and chat-route declarations use bare `{}` (`mcp-client-provider.tsx:251`, `app/api/chat/route.ts:150`); the recommended shape is still `elicitation: { form: {} }` because it states our real surface and avoids relying on backward-compat inference. If a server requires URL-mode elicitation, this host should fail closed until URL mode is implemented. See [MCP-ELICITATION](../sources.md#mcp-elicitation) and [SDK-ELICITATION-MODES](../sources.md#sdk-elicitation-modes).

**Schema (request).** `types.d.ts:5091-5213` — discriminated union of form vs. URL mode. Form mode params:

```text
ElicitRequestFormParams {
  message: string,
  requestedSchema: JSONSchema (object), // primitive props only — string/number/boolean/array-of-string
  _meta?: { 'io.modelcontextprotocol/related-task'?: { taskId } }
}
```

URL mode is server-defined redirect-back, out of scope today (gap to flag).

**Schema (result).** `types.d.ts:5381+`:

```text
ElicitResult = { action: 'accept', content: Record<string, primitive | string[]> }
             | { action: 'decline' }
             | { action: 'cancel' }
```

Three actions, distinct semantics: `decline` = user said no; `cancel` = interrupted (Esc, page nav, modal dismiss). Servers MAY treat them differently. We comply with this distinction at `elicitation-dialog.tsx:113-117`.

**`_meta.io.modelcontextprotocol/related-task`.** `types.d.ts:6` defines `RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task'`. When elicitation arrives *inside* a task, this `_meta` carries `{ taskId }`. Our dialog reads it for display (`elicitation-dialog.tsx:142-143`).
