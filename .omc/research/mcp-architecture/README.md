# MCP Architecture Deep Research — `audiostudio`

*A spec-by-spec audit and proposed unified Run-centric architecture.*

> Source: deep-research opus run, split into a multi-file research bundle and evidence-hardened on 2026-04-25. The original prose is no longer treated as verbatim-authoritative; corrected claims in this directory supersede the initial split.

## Evidence note

The source root for this bundle is [sources.md](./sources.md). It records the official MCP/SEP/assistant-ui references, installed package file/line evidence, current repo file/line evidence, and the subjectivity register. Normative claims should cite that catalog or a page in [spec/](./spec/). Design recommendations and risk ratings are subjective unless explicitly tied to a spec requirement.

## Where to start

- **30-second tour** — read [executive-summary.md](./executive-summary.md), then [current/gap-catalog.md](./current/gap-catalog.md). Five minutes total.
- **Why these architectural choices?** — [principles.md](./principles.md) (the 12 first principles), then [decisions.md](./decisions.md) (the three matrices that justify the largest choices).
- **What does the design look like?** — [architecture/](./architecture/), starting at its [README.md](./architecture/README.md).
- **What does the spec actually say?** — [spec/](./spec/), starting at its [README.md](./spec/README.md).
- **How do we get from here to there?** — [migration.md](./migration.md).

## Top-level files

- [executive-summary.md](./executive-summary.md) — ≈200-word framing of the problem and the proposed shape. The original opening of the report.
- [principles.md](./principles.md) — *§3*. The 12 first principles (P1–P12) that every architecture page builds on.
- [migration.md](./migration.md) — *§5*. Eight-stage rollout plan with risk levels and a test matrix.
- [schemas.md](./schemas.md) — *§6*. Consolidated TypeScript reference for every type the new architecture introduces.
- [decisions.md](./decisions.md) — *§7*. Three side-by-side matrices: shared-session option, Run vs TaskHandle, CapabilityBundle vs free-form `setRequestHandler`.
- [open-questions.md](./open-questions.md) — *§8*. Flagged uncertainties with opinionated default calls.
- [sources.md](./sources.md) — citation catalog and subjectivity register for this research bundle.

## Sub-directories

### [`spec/`](./spec/) — *§1 Spec inventory*

Per-feature breakdowns of the MCP spec, with SDK file:line citations. Read these as the canonical source for every "MCP says…" claim elsewhere in the report.

- [01-lifecycle.md](./spec/01-lifecycle.md) — initialize handshake; mutual-contract semantics; SDK enforcement points.
- [02-tools.md](./spec/02-tools.md) — `Tool` schema; `tools/list`, `tools/call`, `outputSchema`, annotations, icons, `_meta`.
- [03-tasks.md](./spec/03-tasks.md) — task lifecycle, `tasks/get`/`result`/`list`/`cancel`, the `input_required` race, TTL, `taskSupport` negotiation.
- [04-elicitation.md](./spec/04-elicitation.md) — form vs URL mode, action enum, `_meta.io.modelcontextprotocol/related-task`.
- [05-sampling.md](./spec/05-sampling.md) — `CreateMessageRequestParams`, `ModelPreferences`, host consent.
- [06-mcp-apps.md](./spec/06-mcp-apps.md) — SEP-1865 extension capability, tool linkage, View↔Host channel, view-side `assertTaskCapability` restriction.
- [07-progress.md](./spec/07-progress.md) — `_meta.progressToken`, `notifications/progress`, the ambient backchannel.
- [08-cancellation.md](./spec/08-cancellation.md) — base MCP `notifications/cancelled` vs `tasks/cancel`.
- [09-transport.md](./spec/09-transport.md) — `MCP-Session-Id` mechanics, requestor/session handling, session lifetime.
- [10-capability-matrix.md](./spec/10-capability-matrix.md) — master table: every advertised flag → methods it gates → failure-when-missing.

### [`current/`](./current/) — *§2 Current implementation map*

What the code does today, and the catalog of 20 gaps each pointing back at the file responsible.

- [file-map.md](./current/file-map.md) — file-by-file rundown: behaviour, spec sections implemented, deviations.
- [gap-catalog.md](./current/gap-catalog.md) — gap #1–#20 with link to the file responsible AND the proposed mechanism that closes it.

### [`architecture/`](./architecture/) — *§4 Proposed architecture*

The 1176-line §4 split by major component. Each page concentrates the schemas, sequence diagrams, and code skeletons relevant to one piece of the design.

- [topology.md](./architecture/topology.md) — high-level diagram + the three-option trade-off study (Option A recommended).
- [server-proxy.md](./architecture/server-proxy.md) — the `/api/mcp/proxy` design, dialog routing via SSE, refresh-resume, SSE event shape decision.
- [run-abstraction.md](./architecture/run-abstraction.md) — the `Run`, `RunPhase`, `RunSnapshot`, `RunError`, `RunToolMeta` types.
- [run-registry.md](./architecture/run-registry.md) — `RunRegistry`, `ProgressMux`, list_changed invalidation, tasks/list filter, TTL, memory & rate.
- [capability-bundles.md](./architecture/capability-bundles.md) — the `CapabilityBundle` factory and the symmetry-contract diagram. P1's enforcement mechanism.
- [tool-result-modeling.md](./architecture/tool-result-modeling.md) — `toModelOutputForRun`, schema validation pipeline, annotations as UX.
- [host-app-bridge.md](./architecture/host-app-bridge.md) — `HostAppRenderer` rewiring, `tool-input-partial` forwarding to view.
- [ui-surface.md](./architecture/ui-surface.md) — the single `data-run` AI SDK part, tray + card sharing snapshots.
- [lifecycle-sequences.md](./architecture/lifecycle-sequences.md) — every sequence diagram from §4 collected: agent tool call, view-initiated, elicitation mid-task, cancel-from-tray, refresh-resume.
- [component-touchpoints.md](./architecture/component-touchpoints.md) — §4.22 per-component "what file, what change" inventory.
- [spec-compliance.md](./architecture/spec-compliance.md) — §4.28 audit table mapping every implemented spec section to its new mechanism.

## Whole-document fallback

Historical note: the split was originally produced from a single deep-research report. This directory is now the maintained copy; use [sources.md](./sources.md) and the corrected split files as the authoritative reference.

## Reading orders for common needs

| Goal | Suggested path |
|---|---|
| Onboarding | [executive-summary](./executive-summary.md) → [principles](./principles.md) → [architecture/topology](./architecture/topology.md) → [architecture/lifecycle-sequences](./architecture/lifecycle-sequences.md) |
| Triaging a specific gap | [current/gap-catalog](./current/gap-catalog.md) → linked file in [current/file-map](./current/file-map.md) → linked principle and architecture page |
| Implementing a stage | [migration](./migration.md) → linked architecture pages → [schemas](./schemas.md) for type signatures → [component-touchpoints](./architecture/component-touchpoints.md) for the file diff list |
| Spec-compliance audit | [spec/](./spec/) (canonical citations) → [architecture/spec-compliance](./architecture/spec-compliance.md) (mapping table) |
| Justifying a design choice | [decisions](./decisions.md) → linked architecture page → [open-questions](./open-questions.md) for caveats |
