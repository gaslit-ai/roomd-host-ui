# Top-level topology and shared-session trade-off study

> Part of the [§4 proposed architecture](./README.md). Implements [P3 — logical operations span the user, not the session](../principles.md). Cross-references: [server-proxy transport details](./server-proxy.md), [§1.9 streamable HTTP](../spec/09-transport.md).

## §4.1 — Top-level topology

```mermaid
flowchart TB
    subgraph Browser["Browser (Next.js client)"]
        UI[assistant-ui Thread]
        Tray[TaskTray]
        Views[HostAppRenderer x N]
        BCli[Browser MCP Client<br/>over /api/mcp/proxy]
        BReg[RunRegistry<br/>browser slice]
        Bundles[CapabilityBundle Set<br/>elicitation form, sampling, tasks]
        UI --> BReg
        Tray --> BReg
        Views --> BCli
        BReg --> BCli
        Bundles -. capabilities + handlers .-> BCli
    end

    subgraph Server["Next.js Node runtime"]
        Chat[/api/chat/]
        Sample[/api/sample/]
        Proxy[/api/mcp/proxy/]
        SCli[Server MCP Client<br/>upstream session]
        SReg[RunRegistry<br/>shared via SSE]
        Push[/api/runs/stream/<br/>SSE per-user]
        Chat --> SReg
        SReg --> SCli
        Proxy <--> SCli
        SReg --> Push
    end

    BCli -.JSON-RPC over HTTP.-> Proxy
    Push -.SSE.-> BReg
    SCli -. Streamable HTTP .-> Server2[MCP Server]

    style SCli fill:#deecff,stroke:#333,stroke-width:2px
    style BCli fill:#deecff,stroke:#333,stroke-width:2px
    style SReg fill:#fff5d8,stroke:#333,stroke-width:2px
    style BReg fill:#fff5d8,stroke:#333,stroke-width:2px
```

The crucial topology change: the **browser Client speaks JSON-RPC to a Next.js proxy route** (`/api/mcp/proxy`), which forwards to the same `@modelcontextprotocol/sdk` `Client` the chat-route uses. There is **one** upstream `MCP-Session-Id`. Both browser and server `RunRegistry` slices observe the same session through the shared upstream client.

`/api/runs/stream` is an SSE endpoint the browser subscribes to; the server-side `RunRegistry` pushes events down it. This delivers run lifecycle to the browser without requiring the browser to issue `tasks/list` polls.

## §4.2 — Single-shared-session — the trade-off study (P3)

Three options were considered.

**Option A — Server-side proxy.** Browser Client speaks JSON-RPC to `/api/mcp/proxy`; the proxy forwards to a single server-side Client.

- Pros: one upstream session; chat-route and browser observe the same tasks, naturally; CORS goes away (server is same-origin); we can interpose middleware for capability gating, rate limiting, audit logs, OAuth.
- Cons: adds a hop; latency floor is +1 RTT; SSE delivery for `notifications/tasks/status` is doable but not free.
- Spec compliance: full. The proxy is invisible to the spec — it's a transport choice.

**Option B — Server pushes runs to browser via SSE.** Two clients, two sessions, but the chat-route emits a `RunSnapshot` event on every state change, the browser subscribes via SSE.

- Pros: minimal disruption to current code; chat-route stays as-is.
- Cons: still two clients and two local registries, so only the chat-route currently owns the handles needed to cancel chat-route tasks. The browser tray's cancel button needs a separate `/api/runs/{id}/cancel` endpoint that the chat-route services. Cumbersome. Also doesn't fix the "browser-initiated calls are invisible to the chat-route registry" symmetric problem (Views calling tools).
- Spec compliance: full, but at the cost of doubling every operational surface.

**Option C — Chat-route delegates ALL tool calling to the browser.** The agent lives server-side, but every `tools/call` proxies *back to the browser* via a long-lived bidirectional channel; the browser's Client is the single peer.

- Pros: one upstream session (the browser's); App-Views naturally see in-progress runs.
- Cons: chat-route has to drive a duplex transport into the running React process; complex; agent latency includes the browser round-trip; if the user closes the tab, agent freezes.
- Spec compliance: works, but architecturally fragile.

**Recommendation: Option A (server-side proxy).** It is the architecturally cleanest path, requires no spec contortions, and the +1 RTT cost is bounded (proxy is in-process; same-origin). Sequence diagram in [§4.3 of the lifecycle-sequences page](./lifecycle-sequences.md#full-agent-tool-call-43). For the proxy implementation details see [server-proxy.md](./server-proxy.md).

The full options-comparison table lives in [decisions.md](../decisions.md).
