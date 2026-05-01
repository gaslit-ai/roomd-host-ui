# `Run` abstraction

> Part of the [§4 proposed architecture](./README.md). Implements [P2 — tool execution is a single logical operation](../principles.md). Cross-references: [Run registry](./run-registry.md), [tool result modeling](./tool-result-modeling.md), [§1.2 tools](../spec/02-tools.md), [§1.3 tasks](../spec/03-tasks.md), [consolidated schema reference](../schemas.md).

## §4.5 — `Run` abstraction (TypeScript skeleton)

```ts
// lib/mcp/runs/run.ts
import type {
  CallToolResult,
  Tool,
  TaskStatus as McpTaskStatus,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Phases of a logical tool execution. Strictly more granular than MCP's
 * TaskStatus — covers both task and non-task paths, plus pre-task input
 * streaming.
 *
 * Spec refs:
 *   - §1.2 (CallToolResult) — `terminal`
 *   - §1.3 (TaskStatus) — `working`, `input_required`, `cancelled`
 *   - §1.7 (progress notifications) — `working` for plain calls too
 */
export type RunPhase =
  | "requested"      // host emitted execute(), nothing on wire yet
  | "input_streaming" // AI SDK is delta-streaming params (chat-route only)
  | "started"        // taskCreated received OR plain call sent
  | "working"        // any progress signal
  | "input_required" // task is awaiting elicit/sample; queued requests in flight
  | "completed"
  | "failed"
  | "cancelled";

export interface RunToolMeta {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly icons?: ReadonlyArray<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly hasUiResource: boolean;
  readonly hasViewBridge: boolean;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly source: "agent" | "view" | "host"; // who initiated
  readonly toolMeta: RunToolMeta;
  readonly args?: unknown;
  /** Best-effort partial (deltas during input_streaming). */
  readonly partialArgs?: unknown;
  readonly taskId?: string;          // set when task-augmented and post-create
  readonly phase: RunPhase;
  readonly statusMessage?: string;
  readonly progress?: { current: number; total?: number };
  /** Spec-shaped CallToolResult on terminal completed. */
  readonly result?: CallToolResult;
  /** RunError on terminal failed. */
  readonly error?: RunError;
  readonly startedAt: number;
  readonly terminatedAt?: number;
  readonly ttlExpiresAt?: number;
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "tool_isError"          // server returned isError: true
      | "schema_validation"     // outputSchema validation failed
      | "transport"             // wire/JSON-RPC error
      | "timeout"
      | "cancelled",
    readonly content?: CallToolResult["content"],
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
```

Compare against the existing `TaskHandle` in `lib/mcp/tasks/handle.ts:70-75`. The widening: `Run` covers plain calls too, owns `toolMeta` (so the renderer doesn't have to look it up separately), holds `partialArgs` for streaming, distinguishes `source`, and captures `RunError.kind` for renderer styling decisions.

> **See also**
> - The full schema (with all field annotations) is consolidated in [schemas.md](../schemas.md).
> - The state machine that drives `Run` instances is in [run-registry.md](./run-registry.md).
> - Tool meta extraction (annotations, icons, outputSchema) lives in [tool-result-modeling.md](./tool-result-modeling.md).
