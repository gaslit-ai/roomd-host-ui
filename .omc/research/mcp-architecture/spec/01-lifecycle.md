# §1.1 — Lifecycle and capability negotiation

> Part of the [§1 Spec inventory](./README.md). Cross-references: [§1.10 capability matrix](./10-capability-matrix.md), [P1 in principles](../principles.md), [capability bundles in proposed architecture](../architecture/capability-bundles.md).

**Summary.** Every MCP session opens with `initialize` (request) -> `InitializeResult` (response) -> `notifications/initialized` (notification). Both peers declare a capabilities object. Capabilities are a negotiated contract: during operation, peers must only use successfully negotiated capabilities, and a host that advertises support should have the corresponding handler or refusal path wired. SDK-level enforcement is gated by the `enforceStrictCapabilities` option and the `assertCapabilityForMethod` / `assertRequestHandlerCapability` / `assertTaskCapability` / `assertTaskHandlerCapability` family. See [MCP-LIFECYCLE](../sources.md#mcp-lifecycle), [SDK-CAPABILITY-GUARDS](../sources.md#sdk-capability-guards), and [SDK-CAPABILITY-SCHEMAS](../sources.md#sdk-capability-schemas).

**SDK enforcement.** `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:347-453` — distinct guards for outgoing requests, incoming requests, outgoing notifications, and task-augmented requests. Note specifically `:415-438`:

> ```js
> case 'sampling/createMessage':
>     if (!this._capabilities.sampling) {
>         throw new Error(`Client does not support sampling capability (required for ${method})`);
>     }
> ...
> case 'tasks/get':
> case 'tasks/list':
> case 'tasks/result':
> case 'tasks/cancel':
>     if (!this._capabilities.tasks) {
>         throw new Error(`Client does not support tasks capability (required for ${method})`);
>     }
> ```

**Capability shape (Client).** `types.d.ts:572-615` (`ClientCapabilitiesSchema`) and `:518-544` (`ClientTasksCapabilitySchema`):

```text
ClientCapabilities = {
  experimental?: object,
  roots?: { listChanged?: boolean },
  sampling?: object,                       // §1.5
  elicitation?: { form?: {...}, url?: {...} }, // §1.4
  tasks?: {                                // §1.3
    list?: object,
    cancel?: object,
    requests?: {
      sampling?:    { createMessage?: object },
      elicitation?: { create?:        object },
    },
  },
  extensions?: Record<string, object>,    // §1.6 (SEP-1865)
}
```

**Capability shape (Server).** `types.d.ts:776-812` (`ServerCapabilitiesSchema`) and `:548-568` (`ServerTasksCapabilitySchema`):

```text
ServerCapabilities = {
  experimental?: object,
  logging?: object,
  prompts?: { listChanged?: boolean },
  resources?: { subscribe?: boolean, listChanged?: boolean },
  tools?:     { listChanged?: boolean },
  completions?: object,
  tasks?: {
    list?: object,
    cancel?: object,
	    requests?: {
	      tools?: { call?: object },
	    },
  },
  extensions?: Record<string, object>,
}
```

**Failure mode.** With `enforceStrictCapabilities: true`, the SDK throws synchronously *before* the request hits the wire when the remote peer did not advertise a needed capability. Without it, the receiver may return JSON-RPC `-32601 Method not found` (a strict server) or accept silently (a permissive one). A peer that advertises a capability and then fails to register a handler gets the worst of both: the sender is encouraged to call it, but dispatch returns `MethodNotFound` after the round trip.
