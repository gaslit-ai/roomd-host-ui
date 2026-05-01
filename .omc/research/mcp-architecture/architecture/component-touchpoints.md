# §4.22 — Per-component inventory

> Part of the [§4 proposed architecture](./README.md). The "what file, what change" cheat sheet that the [migration plan](../migration.md) consumes. For each new or significantly-modified component, the touchpoints. Cross-references: [current implementation file map](../current/file-map.md) for the existing file's behaviour.

## §4.22.1 — `lib/mcp/runs/run.ts` (NEW)

Replaces `lib/mcp/tasks/handle.ts:39-260`.

- Extends snapshot to cover `phase`, `partialArgs`, `progress`, `toolMeta`, `ttlExpiresAt`.
- Keeps the dual `update`/`settle` discipline that handle.ts already documents at `:9-23`. Migration: `update` → `_mut.update`, `settle` → `_mut.settle`; only the `RunRegistry` reaches `_mut`.

See [run-abstraction.md](./run-abstraction.md) for the full type sketch.

## §4.22.2 — `lib/mcp/runs/registry.ts` (REPLACES `lib/mcp/tasks/registry.ts`)

- Adds `ProgressMux`, `ConcurrencyLimit`, `RingBuffer` for terminal history.
- `setRequestHandler` on `tasks/result` etc. moves into the `tasksBundle` capability bundle, ensuring P1.

See [run-registry.md](./run-registry.md) for the implementation.

## §4.22.3 — `lib/mcp/runs/ai-sdk-adapter.ts` (REPLACES `lib/mcp/tasks/ai-sdk-adapter.ts`)

- Pre-reads `outputSchema` and registers it with the registry's validator cache.
- Preserves annotations/icons by passing through to the `dynamicTool`'s `description` augmentation AND surfacing on the wrapper's `_meta`.
- Adds `toModelOutput: toModelOutputForRun(...)` (gap #4).
- Single `data-run` write per snapshot change, keyed on `id = runId` (gap #13).
- On `RunError("tool_isError")`, calls `throw err` (so AI SDK records as failed).
- On `RunError("schema_validation")`, also throws.

See [tool-result-modeling.md](./tool-result-modeling.md) for `toModelOutputForRun`.

## §4.22.4 — `app/api/mcp/proxy/route.ts` (NEW)

The transport collapse. Implementation sketch:

```ts
// app/api/mcp/proxy/route.ts
import { NextRequest } from "next/server";
import { sharedClient } from "@/lib/mcp/server-client";

export async function POST(req: NextRequest): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id") ?? undefined;
  const body = await req.json(); // JSON-RPC frame
  const result = await sharedClient.protocolForward(body, { sessionId });
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sharedClient.sessionId ?? "",
      "access-control-expose-headers": "mcp-session-id",
    },
  });
}

// SSE downstream is at /api/mcp/proxy/sse for server→client requests
// (sampling/createMessage, elicitation/create, notifications/tasks/status).
```

The tricky part is server→client requests: the server-side Client receives them; the proxy must replay them down the SSE channel to the browser, await a response, and reply upstream. We implement this with a dialog-id correlation — same pattern as in [server-proxy.md "Cross-route/browser dialog routing"](./server-proxy.md#cross-routebrowser-dialog-routing-419).

## §4.22.5 — `app/api/runs/stream/route.ts` (NEW)

```ts
// app/api/runs/stream/route.ts
export async function GET(req: NextRequest): Promise<Response> {
  const stream = sharedRunRegistry.subscribeSSE(req.signal);
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}
```

## §4.22.6 — `components/providers/mcp-client-provider.tsx` (MODIFIED)

- Transport URL changes to `/api/mcp/proxy`.
- Capability declaration becomes `composeCapabilities([elicitationFormBundle({...}), samplingBundle({...}), tasksBundle({...}), mcpUiBundle()])`.
- After connect, calls `registerAll(client)`; before close, `unregisterAll(client)`.

See [capability-bundles.md](./capability-bundles.md).

## §4.22.7 — `components/mcp/runs/context.tsx` (REPLACES `components/mcp/tasks/context.tsx`)

- Exposes `useRun(runId)`, `useRunList()`, `useRunRegistry()`.
- The browser registry mirror subscribes to `/api/runs/stream` and *also* drives local browser-initiated runs through the proxy.

## §4.22.8 — `components/mcp/runs/dialog-handler.tsx` (REPLACES `request-dialog-handler.tsx`)

- Same dialog providers, but the elicitation/sampling handlers come from the bundles, not from `setRequestHandler` directly.

## §4.22.9 — `components/mcp/runs/run-card.tsx` (NEW)

The single inline message-part renderer. Reads `Run.snapshot.toolMeta.annotations`, `phase`, `progress`. Has a click-to-confirm gate when `destructiveHint`.

See [ui-surface.md](./ui-surface.md).

## §4.22.10 — `components/mcp/runs/task-tray.tsx` (RENAME of `components/mcp/tasks/task-tray.tsx`)

- Now lists `Run` snapshots regardless of source.
- Cancel button calls `run.cancel()`.
- A row that's `phase: 'input_required'` shows a "Open input form" link that re-opens the dialog if it was dismissed.

## §4.22.11 — `components/mcp/host-app-renderer.tsx` (MODIFIED)

- `oncalltool` becomes UNCONDITIONAL `runRegistry.call(...).waitForResult()`. Drops the `taskRegistry ? ...` gate at `:442-451`.
- Adds `useEffect` that subscribes to "matched run by tool name" and forwards `partialArgs` via `bridge.sendToolInputPartial`. P10.
- On run-cancel, also calls `bridge.sendToolCancelled({reason})`.

See [host-app-bridge.md](./host-app-bridge.md).

## §4.22.12 — `app/api/chat/route.ts` (MODIFIED)

- Removes the parallel SDK Client construction at `:122-205`. The chat-route uses the *same* `sharedClient` as `/api/mcp/proxy`.
- Uses `wrapToolSetWithRuns` instead of `wrapToolSetWithTasks`.
- Wires `ToolListChangedNotificationSchema` to invalidate `cachedMCPTools`.

See [run-registry.md "tools/list_changed honored on chat route"](./run-registry.md#toolslist_changed-honored-on-chat-route-gap-8).
