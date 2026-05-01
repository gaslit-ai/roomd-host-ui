# §6 — Schemas (consolidated reference)

> *Editorial note: §6 of the original report. Kept as a single consolidated reference even after the rest of §4 was split, because most of these types are referenced from multiple architecture pages and a one-page lookup is faster than chasing imports across files.*

The TypeScript surface for the new architecture, with spec citations inline. Component pages in [`./architecture/`](./architecture/) link here for the canonical type shape.

```ts
// ─── lib/mcp/runs/run.ts ───────────────────────────────────────────────────
import type {
  CallToolResult,
  Tool,
  TaskStatus as McpTaskStatus,
} from "@modelcontextprotocol/sdk/types.js";

/** Spec §1.3 status enum, plus host-only pre-create marker. */
export type RunPhase =
  | "requested"        // local; no wire activity yet
  | "input_streaming"  // AI SDK is delta-streaming arguments
  | "started"          // taskCreated received, OR plain tools/call sent
  | "working"          // any progress signal (tasks/status, notifications/progress)
  | "input_required"   // mid-task elicitation/sampling pending
  | "completed"        // McpTaskStatus 'completed' OR plain call returned non-error
  | "failed"           // McpTaskStatus 'failed' OR plain call rejected, OR isError, OR schema mismatch
  | "cancelled";       // McpTaskStatus 'cancelled' OR client abort

/** Spec §1.2 — Tool annotations + execution + icons + meta. */
export interface RunToolMeta {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly icons?: ReadonlyArray<{
    src: string;
    mimeType?: string;
    sizes?: string[];
    theme?: "light" | "dark";
  }>;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  /** Spec §1.6 — _meta.ui.resourceUri presence. */
  readonly hasUiResource: boolean;
  /** Whether a HostAppRenderer is mounted for this tool right now. */
  readonly hasViewBridge: boolean;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly source: "agent" | "view" | "host";
  readonly toolMeta: RunToolMeta;
  readonly args?: unknown;
  readonly partialArgs?: unknown;
  readonly taskId?: string;
  readonly phase: RunPhase;
  readonly statusMessage?: string;
  readonly progress?: { current: number; total?: number };
  readonly result?: CallToolResult;
  readonly error?: RunError;
  readonly startedAt: number;
  readonly terminatedAt?: number;
  /** ms epoch; undefined if no TTL. */
  readonly ttlExpiresAt?: number;
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "tool_isError"
      | "schema_validation"
      | "transport"
      | "timeout"
      | "cancelled",
    readonly content?: CallToolResult["content"],
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RunError";
  }
}

export interface Run {
  readonly snapshot: RunSnapshot;
  subscribe(fn: (snap: RunSnapshot) => void): () => void;
  waitForResult(): Promise<CallToolResult>;
  cancel(reason?: string): Promise<void>;
}

// ─── lib/mcp/runs/registry.ts ──────────────────────────────────────────────
export interface RunCallInput {
  readonly toolName: string;
  readonly args: unknown;
  readonly source?: "agent" | "view" | "host";
  readonly mode?: "auto" | "required-only" | "plain";
  readonly signal?: AbortSignal;
  readonly ttl?: number;
  readonly pollInterval?: number;
  readonly timeoutMs?: number;
}

export interface RunRegistryListener {
  (snapshots: readonly RunSnapshot[]): void;
}

export interface RunRegistry {
  /** Initiate a Run. */
  call(input: RunCallInput): Run;
  /** Adopt a server-known taskId (e.g., on reattach). */
  adopt(taskId: string): Promise<Run>;
  /** Lookup. */
  get(runId: string): Run | undefined;
  /** Subscribe to the entire registry. */
  subscribe(fn: RunRegistryListener): () => void;
  /** Reattach in-flight tasks owned by this client. */
  reattachInFlight(): Promise<void>;
  /** Drop terminal Runs older than maxAgeMs; push to history ring buffer. */
  pruneTerminal(maxAgeMs: number): void;
  /** Best-effort cancellation + cleanup. */
  dispose(): Promise<void>;

  /** Notification ingress (called from CapabilityBundle handlers). */
  ingestTaskStatusNotification(p: TaskStatusNotificationParams): void;
  ingestProgressNotification(p: ProgressNotificationParams): void;
}

// ─── lib/mcp/capabilities/bundle.ts ────────────────────────────────────────
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

/** Spec §1.1 — atomic capability + handler unit. */
export interface CapabilityBundle {
  readonly capability: Partial<ClientCapabilities>;
  register(client: Client): void;
  unregister(client: Client): void;
}

export function composeCapabilities(bundles: readonly CapabilityBundle[]): {
  readonly capabilities: ClientCapabilities;
  readonly registerAll: (client: Client) => void;
  readonly unregisterAll: (client: Client) => void;
};

// ─── lib/mcp/runs/tool-result.ts ───────────────────────────────────────────
import type { ToolResultOutput } from "@ai-sdk/provider-utils";

/** Spec §1.2 — convert MCP CallToolResult → AI SDK model output. */
export function toModelOutputForRun(
  result: CallToolResult,
  toolName: string,
  outputSchemaDeclared: boolean,
): ToolResultOutput;

// ─── components/mcp/runs/context.tsx ───────────────────────────────────────
export function useRunRegistry(): RunRegistry | null;
export function useRun(runId: string): RunSnapshot | undefined;
export function useRunList(): readonly RunSnapshot[];

// ─── components/mcp/runs/run-card.tsx ──────────────────────────────────────
export interface RunCardProps {
  readonly runId: string;
}
export const RunCard: React.FC<RunCardProps>;

// ─── lib/mcp/runs/ai-sdk-adapter.ts ────────────────────────────────────────
import type { ToolSet, UIMessageStreamWriter } from "ai";

export interface WrapWithRunsOpts {
  readonly registry: RunRegistry;
  readonly writer: UIMessageStreamWriter;
}

/**
 * Spec §1.2 — wrap an AI SDK ToolSet so calls flow through the RunRegistry.
 * Preserves annotations, icons, title; honors outputSchema for validation;
 * surfaces isError as a "TOOL ERROR" content block to the model.
 */
export function wrapToolSetWithRuns(
  tools: ToolSet,
  client: Client,
  opts: WrapWithRunsOpts,
): Promise<ToolSet>;
```

## Where each type is used

| Type | Defined for | Used by |
|---|---|---|
| `RunPhase`, `RunSnapshot`, `RunToolMeta`, `RunError`, `Run` | [run-abstraction.md](./architecture/run-abstraction.md) | [run-registry.md](./architecture/run-registry.md), [ui-surface.md](./architecture/ui-surface.md), [host-app-bridge.md](./architecture/host-app-bridge.md) |
| `RunCallInput`, `RunRegistryListener`, `RunRegistry` | [run-registry.md](./architecture/run-registry.md) | [topology.md](./architecture/topology.md), [server-proxy.md](./architecture/server-proxy.md), every consumer |
| `CapabilityBundle`, `composeCapabilities` | [capability-bundles.md](./architecture/capability-bundles.md) | [run-registry.md](./architecture/run-registry.md) (the `tasksBundle` installs the notification handlers it consumes) |
| `toModelOutputForRun` | [tool-result-modeling.md](./architecture/tool-result-modeling.md) | `wrapToolSetWithRuns` ([component-touchpoints §4.22.3](./architecture/component-touchpoints.md#4223-libmcprunsai-sdk-adapterts-replaces-libmcptasksai-sdk-adapterts)) |
| `useRunRegistry`, `useRun`, `useRunList`, `RunCard` | [ui-surface.md](./architecture/ui-surface.md) | tray, message-card, host-app renderer |
| `wrapToolSetWithRuns` (impl) | [tool-result-modeling.md](./architecture/tool-result-modeling.md) | `app/api/chat/route.ts` ([component-touchpoints §4.22.12](./architecture/component-touchpoints.md#42212-appapichatroutets-modified)) |
