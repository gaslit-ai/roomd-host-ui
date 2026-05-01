# Executive summary

> Front matter from the deep-research opus run. ~200 words. The full report is split across this directory; see [README.md](./README.md) for navigation.

`audiostudio` runs MCP clients in both the chat route and the browser: the chat route owns module-scoped MCP/task clients, while the browser provider creates its own Streamable HTTP client and session pinning [sources: REPO-CHAT-ROUTE, REPO-BROWSER-CLIENT](./sources.md#repo-evidence). Tools, tasks, elicitation, sampling, MCP App Views, and the assistant-ui transcript are currently glued together by ad-hoc wiring that handles the happy path but produces five evidence-backed risk categories: (1) cross-registry blindness between chat-route runs and the browser tray; (2) MCP App Views can miss task-required-tool upgrades when `taskRegistry` is absent; (3) the chat-route advertises `elicitation`/`sampling`/`tasks.requests.*` capabilities but has no matching request handlers; (4) `Tool.outputSchema`, `structuredContent`, `isError`, and annotations are not modeled as richly as the MCP tools spec and installed SDK support; (5) the UI splits one logical operation across message parts, progress rows, and TaskTray [sources: MCP-LIFECYCLE, MCP-TOOLS, REPO-HOST-APP, REPO-AI-ADAPTER, REPO-UI-SURFACES](./sources.md).

The proposed architecture collapses browser and server MCP access behind a server-proxied transport, introduces a `Run` abstraction for every tool call, adds a registry-driven `CapabilityBundle` factory that pairs capability advertisement with handlers, and uses one Run-surface React layer for inline message rendering and the persistent tray. This paragraph is a design recommendation, not a protocol requirement; see the subjectivity register in [sources.md](./sources.md#subjectivity-register).

What follows is the full report.

---

# MCP Architecture Deep Research — `audiostudio`
*A spec-by-spec audit and proposed unified Run-centric architecture*

> Historical note: this section began as front matter from the first deep-research pass. The maintained, corrected version is the split research bundle in this directory, backed by [sources.md](./sources.md).

---

## Where to read next

Pick a starting point based on what you need:

- **First-time orientation:** [README.md](./README.md) — top-level navigation with section blurbs.
- **What does the spec actually say?** [spec/](./spec/) — per-feature breakdowns with SDK file:line citations.
- **What does the code actually do today?** [current/](./current/) — file-by-file implementation map and the gap catalog.
- **Why the redesign?** [principles.md](./principles.md) — the 12 first principles driving every architectural decision.
- **What is the proposed shape?** [architecture/](./architecture/) — one page per major component (Run, Registry, Capability bundles, Server proxy, etc.).
- **How do we get from here to there?** [migration.md](./migration.md) — eight-stage rollout plan.
- **What contracts does the new code expose?** [schemas.md](./schemas.md) — consolidated TypeScript reference.
- **Why these choices?** [decisions.md](./decisions.md) — three decision matrices.
- **What's still uncertain?** [open-questions.md](./open-questions.md) — flagged uncertainties.
