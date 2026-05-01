# §7 — Decision matrix

> *Editorial note: §7 of the original report. Three side-by-side matrices justifying the three highest-leverage architectural choices. The first matrix expands [topology.md §4.2](./architecture/topology.md#42--single-shared-session--the-trade-off-study-p3) into a single-glance comparison. Ratings such as elegance, complexity, migration risk, future extensibility, discoverability, and type safety are subjective engineering judgments; protocol compliance rows cite the spec inventory and [sources.md](./sources.md).*

| Criterion | A. Server-proxy (recommended) | B. Two clients + SSE mirror | C. All tool calls via browser |
|---|---|---|---|
| Spec compliance | full | full (with extra plumbing) | full (with extra plumbing) |
| Elegance | high — single session, single `RunRegistry` writer | medium — two writers, conflict-resolution policy needed | low — bidirectional channel, agent depends on browser |
| Performance | +1 RTT on tool calls; same-origin so no CORS | direct; SSE additions cost nothing on the request path | +1 RTT; agent latency includes browser hop |
| Complexity | medium — proxy route + SSE + dialog correlation | medium — two registries + dialog routing | high — duplex agent↔browser |
| Migration risk | medium — transport swap is the riskiest stage | low — additive | high — fundamental flow change |
| Future extensibility (multi-server) | excellent — proxy adds path-prefix | OK — each server gets a parallel SSE topic | poor — browser becomes the only peer |
| Operational footprint | one shared client + proxy | two clients + SSE | one client (browser) + bidirectional |

| Criterion | Run abstraction (recommended) | Keep TaskHandle, lift later |
|---|---|---|
| Spec compliance | unifies plain and task paths under §1.2 + §1.3 | task-only |
| UX consistency | one card surface | two card surfaces (tool-call vs task-progress) |
| Code volume | medium — full rename | low |
| Future extensibility | covers progress (§1.7), input streaming (§1.6 partials), and view-initiated runs symmetrically | requires per-feature retrofit |

| Criterion | CapabilityBundle factory (recommended) | Free-form `setRequestHandler` calls |
|---|---|---|
| Spec compliance (P1) | enforced at construction time | drift-prone (today) |
| Discoverability | bundles list at startup | scattered |
| Type safety | composeCapabilities ensures both sides | compiler can't tell |

> See also: [topology.md](./architecture/topology.md) for the long-form pros/cons of options A/B/C, [run-abstraction.md](./architecture/run-abstraction.md) for the Run vs TaskHandle widening, [capability-bundles.md](./architecture/capability-bundles.md) for the symmetry contract.
