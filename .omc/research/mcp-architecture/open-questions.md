# §8 — Open questions

> *Editorial note: §8 of the original report. The flagged uncertainties are items where the spec is silent, the trade-off is non-obvious, or the work is deferred. Each question pairs with a subjective default call. See [sources.md](./sources.md) for citations and the subjectivity register.*

1. **Server-proxy session pinning across Next.js cold-starts.** When the Next runtime cycles (e.g., serverless cold start), the singleton `Client` reconnects with a fresh `MCP-Session-Id`. The browser's stored session is now invalid. We currently clear stored session on connect failure (`mcp-client-provider.tsx:472-475`). With the proxy, the browser is talking to Next.js, not to the upstream, so the proxy needs to detect upstream session resets and either issue a fresh `MCP-Session-Id` (forcing the browser to discard its tasks) or transparently re-initialize and warn callers. **Subjective call:** force browser to discard, since in-flight tasks often live in upstream RAM and may not survive upstream restart.

   See: [server-proxy.md](./architecture/server-proxy.md), [§1.9 transport](./spec/09-transport.md).

2. **`tasks/list` and requestor/user boundaries.** The tasks spec requires `tasks/list` to return only tasks associated with the requestor's authorization context, not a server-wide list. Our proposed shared upstream client is single-tenant-friendly; multi-tenant deployments would need requestor-bound upstream sessions or an authorization-aware proxy filter.

   See: [topology.md](./architecture/topology.md), [§1.9 transport](./spec/09-transport.md).

3. **Elicitation URL mode.** Out of scope today. Bare `elicitation: {}` currently means form-mode support in the installed SDK, but we should advertise `elicitation: { form: {} }` because it explicitly matches our implementation. If a server only supports URL-mode elicitation, it cannot ask us for input. **Subjective call:** fail-closed until URL mode is implemented.

4. **`AppBridge.oncalltool` and the handler replace warning.** Current code overrides only when `taskRegistry` is present (`host-app-renderer.tsx:442-451`). The proposed architecture makes that routing unconditional after the View's `initialized` event, which can log a "handler replaced" warning. **Subjective call:** acceptable noise; alternatively, fork `AppBridge.connect()` to skip the auto-wire. The fork does not look worth the maintenance burden today.

   See: [host-app-bridge.md](./architecture/host-app-bridge.md), [§1.6 MCP Apps](./spec/06-mcp-apps.md).

5. **Concurrency limit for view-initiated runs vs agent runs.** Should they share one ceiling or have separate? **Subjective call:** share. A user can overload their own session either way; one limit keeps the mental model simple.

   See: [run-registry.md "Memory and rate"](./architecture/run-registry.md#memory-and-rate-p9-gaps-19-20).

6. **Sampling tools field.** [§1.5](./spec/05-sampling.md) includes `tools` and `toolChoice` on `CreateMessageRequestParams` when the client declares `sampling.tools`. `app/api/sample/route.ts:51-58` ignores them, so we should not advertise `sampling.tools` yet. Honoring them requires translating MCP tool definitions to AI SDK tool definitions for the *server-requested* sampling call, which is non-trivial. Out of scope until a server actually requests it.

7. **Resource subscriptions + run lifetime.** A Run that creates a side effect on a server (e.g., produces a `<scheme>://sessions/.../state`) may need the host to subscribe so the View sees updates after run completion. Today subscribe/unsubscribe proxying is in `host-app-renderer.tsx:347-365`. The Run abstraction could retain subscriptions past terminal, but auto-unsubscribe risks losing reactivity for in-View workflows that outlive the run. **Subjective call:** keep subscription managed by the View; the Run does not couple to it.

8. **Progress percent UX vs status message.** When both are present, which takes precedence in the renderer? `notifications/progress` carries `{ progress, total, message? }`; `notifications/tasks/status` carries `statusMessage`. **Subjective call:** show the progress bar and the message; if both present, message wins for the line, progress drives the bar.

   See: [run-registry.md "notifications/progress integration"](./architecture/run-registry.md#notificationsprogress-integration-p5-gap-5), [ui-surface.md](./architecture/ui-surface.md).

9. **Cross-origin upstream MCP servers.** With the server proxy, the browser doesn't talk to upstream directly — CORS is moot. But the *server-side* shared client still does, and will respect the upstream's auth model (OAuth bearer tokens are passed unchanged). Per-tenant auth would need request-scoped credentials propagated through the proxy.

10. **`Tool._meta` is a record of unknown.** AI SDK's `dynamicTool` has no first-class field for it. We'd attach it as `(tool as any)._meta = ...` (today's pattern at `@ai-sdk/mcp/dist/index.mjs:1977`). Document this as a known type-system gap.

---

# End of report

## Summary of relevant absolute file paths

- `/Users/aiSandbox/github/audiostudio/lib/mcp/tasks/handle.ts`
- `/Users/aiSandbox/github/audiostudio/lib/mcp/tasks/registry.ts`
- `/Users/aiSandbox/github/audiostudio/lib/mcp/tasks/ai-sdk-adapter.ts`
- `/Users/aiSandbox/github/audiostudio/components/mcp/tasks/context.tsx`
- `/Users/aiSandbox/github/audiostudio/components/mcp/tasks/request-dialog-handler.tsx`
- `/Users/aiSandbox/github/audiostudio/components/mcp/tasks/elicitation-dialog.tsx`
- `/Users/aiSandbox/github/audiostudio/components/mcp/tasks/sampling-approval-dialog.tsx`
- `/Users/aiSandbox/github/audiostudio/components/mcp/tasks/task-tray.tsx`
- `/Users/aiSandbox/github/audiostudio/components/mcp/host-app-renderer.tsx`
- `/Users/aiSandbox/github/audiostudio/components/providers/mcp-client-provider.tsx`
- `/Users/aiSandbox/github/audiostudio/app/api/chat/route.ts`
- `/Users/aiSandbox/github/audiostudio/app/api/sample/route.ts`
- `/Users/aiSandbox/github/audiostudio/app/assistant.tsx`
- `/Users/aiSandbox/github/audiostudio/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js`
- `/Users/aiSandbox/github/audiostudio/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`
- `/Users/aiSandbox/github/audiostudio/node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/client.js`
- `/Users/aiSandbox/github/audiostudio/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`
- `/Users/aiSandbox/github/audiostudio/node_modules/@modelcontextprotocol/ext-apps/dist/src/app-bridge.d.ts`
- `/Users/aiSandbox/github/audiostudio/node_modules/@modelcontextprotocol/ext-apps/dist/src/app-bridge.js`
- `/Users/aiSandbox/github/audiostudio/node_modules/@ai-sdk/mcp/dist/index.mjs`
- `/Users/aiSandbox/github/audiostudio/node_modules/@ai-sdk/provider-utils/dist/index.d.ts`
- `/Users/aiSandbox/github/audiostudio/node_modules/ai/dist/index.d.ts`
- `/Users/aiSandbox/github/audiostudio/node_modules/@assistant-ui/react/dist/primitives/message/MessagePartsGrouped.d.ts`

### Critical files for implementation
- /Users/aiSandbox/github/audiostudio/lib/mcp/tasks/registry.ts
- /Users/aiSandbox/github/audiostudio/lib/mcp/tasks/ai-sdk-adapter.ts
- /Users/aiSandbox/github/audiostudio/app/api/chat/route.ts
