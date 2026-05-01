# §1 — Spec inventory

> *Editorial note: the original §1 was a single 326-line section. It is split here by MCP feature, one page per subsection, plus a master capability matrix.*

This section walks every MCP feature touching tools and tasks. Each subsection ties protocol claims to primary MCP pages and installed SDK file/line evidence. The full citation index is [../sources.md](../sources.md).

## Pages

- [§1.1 — Lifecycle and capability negotiation](./01-lifecycle.md) — the mutual-contract foundation; SDK enforcement points; `ClientCapabilities` and `ServerCapabilities` shapes.
- [§1.2 — Tools](./02-tools.md) — declaration, listing, calling, output-schema validation, annotations, icons, `_meta`.
- [§1.3 — Tasks](./03-tasks.md) — status enum, lifecycle, `tasks/get`/`tasks/result`/`tasks/list`/`tasks/cancel`, the `input_required` race, TTL, `taskSupport` negotiation.
- [§1.4 — Elicitation](./04-elicitation.md) — capability advertisement, form vs URL mode, `_meta.io.modelcontextprotocol/related-task`.
- [§1.5 — Sampling](./05-sampling.md) — capability negotiation, request/response shape, consent model.
- [§1.6 — MCP Apps (SEP-1865)](./06-mcp-apps.md) — extension capability, tool linkage, View↔Host channel, view-side restrictions.
- [§1.7 — Progress (base MCP, non-task)](./07-progress.md) — `_meta.progressToken`, `notifications/progress`, the ambient backchannel.
- [§1.8 — Cancellation](./08-cancellation.md) — base MCP `notifications/cancelled` vs `tasks/cancel`.
- [§1.9 — Streamable HTTP transport and session management](./09-transport.md) — `MCP-Session-Id` mechanics, requestor/session handling, session lifetime.
- [§1.10 — Capability matrix (master)](./10-capability-matrix.md) — every advertised flag mapped to the methods it gates and the failure mode when missing.

## Cross-references

Each spec page is the canonical citation source for the rest of the report:

- The [problem statement](../principles.md) cites these by section number.
- The [proposed architecture](../architecture/) cites them when justifying mechanisms.
- The [current implementation map](../current/file-map.md) cross-links each file to the spec sections it implements.
