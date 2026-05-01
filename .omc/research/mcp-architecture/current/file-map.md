# Current implementation — file-by-file

> Part of the [§2 current implementation map](./README.md). Each entry: what the file does, which spec sections from [`../spec/`](../spec/) it covers, and the deviations from spec / known gaps. Gap numbers cross-link to [`gap-catalog.md`](./gap-catalog.md). Line citations were re-checked on 2026-04-25 against the current checkout; see [../sources.md](../sources.md).

## §2.1 — `lib/mcp/tasks/handle.ts`

**What it does.** Defines `TaskSnapshot` (immutable shape) and `TaskHandle` (interface) plus `TaskHandleImpl` (the in-memory state machine). The split `update()` (UI-only) vs `settle()` (terminal authority) is documented at `:9-23` and is *correct* — it solves the input_required race described in [§1.3](../spec/03-tasks.md).

**Spec sections implemented.** [§1.3](../spec/03-tasks.md) (Tasks lifecycle, status enum). [§1.8](../spec/08-cancellation.md) (cancellation flips local state pre-roundtrip).

**Deviations.** Adds host-only `'pending'` status (`:42-48`). This is fine but needs a comment that this status never leaves the host.

**Code references.** `:39-48` (status enum); `:57-66` (snapshot); `:86-235` (impl); `:122-153` (`waitForResult` and `cancel`); `:165-235` (`update`/`settle`).

## §2.2 — `lib/mcp/tasks/registry.ts`

**What it does.** Owns the single `notifications/tasks/status` handler on a `Client` (`:95-117`), translates `callToolStream` messages to handle updates (`:341-441`), exposes `attach()` for in-flight resumption (`:216-271`), tracks task-support metadata (`:129-138`).

**Spec sections implemented.** [§1.3](../spec/03-tasks.md) fully (Tasks). [§1.8](../spec/08-cancellation.md) partially (cancellation). [§1.9](../spec/09-transport.md) partially (session reattach via sessionId pinning is in `mcp-client-provider.tsx`, not here).

**Deviations.**
- `attach()` toolName is `(attached)` placeholder (`:223`) — task list returns no tool name, so we can't recover it without a server-side `task.toolName` extension. Acceptable but ugly.
- `dispose()` cancels every non-terminal handle (`:315-337`) but doesn't `removeNotificationHandler` (acknowledged TODO at `:332-336`). Innocuous in practice because Client teardown drops handlers.
- No memory pruning. Terminal handles linger forever in `_handles` (gap #19).
- No global ceiling / rate limit (gap #20).
- `reattachInFlight` adopts every non-terminal task returned by this client's `tasks/list` (`:299-313`). The spec scopes lists by requestor authorization context, but the host should still filter to task ids it created — see gap #9.

## §2.3 — `lib/mcp/tasks/ai-sdk-adapter.ts`

**What it does.** `wrapToolSetWithTasks` overlays AI SDK tools with task-aware versions when the underlying MCP tool advertises `taskSupport !== 'forbidden'` (`:65-100`). Each wrapped tool subscribes to its `TaskHandle` and writes `data-task-progress` parts to the UI message stream (`:102-169`).

**Spec sections implemented.** [§1.2](../spec/02-tools.md) (tool calling), [§1.3](../spec/03-tasks.md) (auto-upgrade to task path).

**Deviations.**
- **Ignores `outputSchema`** (`:111-167`) — passes raw `inputSchema` only into `jsonSchema(...)`. Tools with outputs aren't validated. Gap #3.
- **Drops annotations** — the `dynamicTool({...})` call at `:108-167` includes `description` and `inputSchema` but not `title`, `annotations.*`, or `icons`. Gap #6.
- **Returns raw `CallToolResult`** at `:158`. The `dynamicTool` `toModelOutput` is unset, so AI SDK falls back to JSON-shaped output, which differs from `@ai-sdk/mcp`'s own `mcpToModelOutput` helper (`@ai-sdk/mcp/dist/index.mjs:1605-1628`) that converts `content[]` to AI SDK content blocks. Gap #4.
- **`isError: true` does NOT throw.** A tool that returns `isError: true` is the spec's way of saying "the call ran but the result is an error message intended for the model." Today we resolve normally and the model sees the JSON object — the agent likely ignores the `isError` flag and treats the body as truth.

## §2.4 — `components/mcp/tasks/context.tsx`

**What it does.** React provider that builds a `TaskRegistry` per `Client`, seeds the task-support map from `listTools()`, reattaches in-flight tasks on mount, and refreshes the support map when the provider's `toolUIs` name set changes (`components/mcp/tasks/context.tsx:123-135`).

**Spec sections implemented.** [§1.1](../spec/01-lifecycle.md) (lifecycle wiring), [§1.3](../spec/03-tasks.md) (registry binding).

**Deviations.**
- Ignores `Tool.outputSchema` (we don't pass it forward to the registry, which doesn't store it either).
- Re-fetches the entire tools list inside `setTaskSupportMap` callbacks instead of accepting the cached list. Pretty minor.
- Current refresh is indirectly keyed off UI tool names, so non-UI tool changes or taskSupport-only changes can miss the effect. See [REPO-TASK-CONTEXT](../sources.md#repo-task-context).

## §2.5 — `components/mcp/tasks/request-dialog-handler.tsx`

**What it does.** Owns the **browser** Client's `setRequestHandler` for `elicitation/create` and `sampling/createMessage` (`:63-104`). Wires them to dialog providers.

**Spec sections implemented.** [§1.4](../spec/04-elicitation.md), [§1.5](../spec/05-sampling.md).

**Deviations.** Mounted ONLY on the browser. The chat-route Client advertises these capabilities but registers no handlers. Gap #2.

## §2.6 — `components/mcp/tasks/elicitation-dialog.tsx`

**What it does.** Schema-driven form modal. Form mode only.

**Spec sections implemented.** [§1.4](../spec/04-elicitation.md) (form mode + action enum).

**Deviations.** URL mode falls through to `decline` (`:81-87`). Since we only implement form mode, we should advertise explicit `elicitation: { form: {} }` and omit URL support. Bare `elicitation: {}` works today as SDK backward-compatible form mode, but it is less self-documenting.

## §2.7 — `components/mcp/tasks/sampling-approval-dialog.tsx`

**What it does.** User-consent modal that previews proposed messages, POSTs to `/api/sample` on approval.

**Spec sections implemented.** [§1.5](../spec/05-sampling.md) (consent model, request shape).

**Deviations.** Renders text-only previews (`:255-262`); image/audio/tool blocks become bracketed placeholders. Acceptable.

## §2.8 — `app/api/sample/route.ts`

**What it does.** Proxies sampling to `gpt-5-mini` via `generateText`.

**Spec sections implemented.** [§1.5](../spec/05-sampling.md).

**Deviations.** Doesn't honor `modelPreferences.hints[0].name` to switch providers (acknowledged at `:21-24`).

## §2.9 — `app/api/chat/route.ts`

**What it does.** AI SDK chat endpoint. Lazily builds an MCP client (via `@ai-sdk/mcp`) for tools, plus a parallel `@modelcontextprotocol/sdk` Client for tasks/elicitation/sampling routing (`:122-205`). Wraps tools with task wrappers (`:249-264`). Calls `streamText` and merges into `createUIMessageStream`.

**Spec sections implemented.** [§1.1](../spec/01-lifecycle.md), [§1.2](../spec/02-tools.md), [§1.3](../spec/03-tasks.md) (partial).

**Deviations.**
- Module-scoped Client (`:65-66`) means **ONE** session for ALL chat requests across the entire process. Tasks initiated by user A's chat are in the same session as user B's. (Single-tenant assumption; document.)
- Doesn't honor `tools/list_changed` (`mcpTools` cached forever at `:69-104`). Gap #8.
- Advertises `tasks.requests.elicitation.create` etc. (`:140-153`) but registers no handlers on the chat-route client. Gap #2.

## §2.10 — `components/providers/mcp-client-provider.tsx`

**What it does.** Browser Client construction with capability advertisement, sessionId pinning, three list-changed handlers, two notification handlers (`resources/updated` fanout, `notifications/message`).

**Spec sections implemented.** [§1.1](../spec/01-lifecycle.md), [§1.6](../spec/06-mcp-apps.md), [§1.9](../spec/09-transport.md), parts of [§1.7](../spec/07-progress.md).

**Deviations.** None major. Solid file. Note that `extensions: UI_EXTENSION_CAPABILITIES` is the client-side MCP Apps negotiation surface (`:242`) — that part is right.

## §2.11 — `components/mcp/host-app-renderer.tsx`

**What it does.** SEP-1865 view renderer. Owns AppBridge wiring, dispatches view-initiated requests through the browser Client.

**Spec sections implemented.** [SEP-1865 / §1.6](../spec/06-mcp-apps.md) fully.

**Deviations.**
- View-initiated `tools/call` for `taskSupport: required` tools is upgraded *only* if `taskRegistry` is non-null (`:442-451`). When it is null (e.g., during reconnect window) the call falls through to AppBridge's auto-wired plain `oncalltool` and gets `-32601` from the server. Gap #1.
- The fallback assignment uses setter-style (`b.oncalltool = ...`) which logs the radix warn-if-replaced once per mount; minor.
- No `tool-input-partial` forwarding to the view (gap #7) — the bridge has the method, but the renderer's `useEffect` only fires on the prop, and no caller produces partial inputs today.

## §2.12 — `components/mcp/tasks/task-tray.tsx`

**What it does.** Permanent chrome listing active + recently-terminal tasks. Cancel button per row. Mounted at root inside `TaskRegistryProvider`.

**Spec sections implemented.** None — tray is host UX policy.

**Deviations.** None. The bug is *who feeds it*: only the browser registry (gap #18 — agent tasks live in chat-route's session, invisible to the browser registry).

## §2.13 — `app/assistant.tsx`

**What it does.** Mounts the provider tree. `TaskTray` IS mounted at `:105`. (Brief gap #17 says it isn't; brief is stale on this point — corrected here.)
