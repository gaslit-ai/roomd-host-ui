import type {
  CallToolResult,
  ClientCapabilities,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  Progress,
  RequestId,
  ServerCapabilities,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

export type McpOperationDirection = "browser-to-host" | "host-to-upstream";

export type McpOperationStatus =
  | "queued"
  | "sent"
  | "progress"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface CapabilityLedger {
  readonly client: ClientCapabilities;
  readonly server?: ServerCapabilities;
}

export interface McpOperation {
  readonly operationId: string;
  readonly direction: McpOperationDirection;
  readonly method: string;
  readonly requestId?: RequestId;
  readonly sessionId?: string;
  readonly capabilityKey?: string;
  readonly progressToken?: string | number;
  readonly relatedTaskId?: string;
  readonly status: McpOperationStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type McpProjectionEvent =
  | {
      readonly kind: "mcp";
      readonly message: JSONRPCMessage;
    }
  | {
      readonly kind: "run";
      readonly snapshot: RunSnapshot;
    }
  | {
      readonly kind: "log";
      readonly record: McpLogRecord;
    };

export interface McpLogRecord {
  readonly id: string;
  readonly level: string;
  readonly logger?: string;
  readonly data?: unknown;
  readonly createdAt: number;
}

export type JsonRpcInbound = JSONRPCRequest | JSONRPCResponse | JSONRPCMessage;

export type RunSource = "agent" | "view" | "host";

export type RunPhase =
  | "queued"
  | "input_streaming"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunToolMeta {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly annotations?: Tool["annotations"];
  readonly icons?: Tool["icons"];
  readonly _meta?: Tool["_meta"];
  readonly execution?: Tool["execution"];
  readonly inputSchema?: Tool["inputSchema"];
  readonly outputSchema?: Tool["outputSchema"];
}

export interface RunProgress {
  readonly current: number;
  readonly total?: number;
  readonly message?: string;
}

export interface RunResult {
  readonly content: CallToolResult["content"];
  readonly structuredContent?: CallToolResult["structuredContent"];
  readonly isError: boolean;
  readonly _meta?: CallToolResult["_meta"];
}

export interface RunError {
  readonly message: string;
  readonly code?: number;
  readonly data?: unknown;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly source: RunSource;
  readonly phase: RunPhase;
  readonly toolName: string;
  readonly toolMeta: RunToolMeta;
  readonly input?: unknown;
  readonly partialArgs?: unknown;
  readonly taskId?: string;
  readonly progress?: RunProgress;
  readonly statusMessage?: string;
  readonly result?: RunResult;
  readonly error?: RunError;
  readonly ttlExpiresAt?: number;
  readonly ttlWarningAt?: number;
  readonly ttlWarningSent?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export type RunListener = (snapshot: RunSnapshot) => void;

export interface RunHandle {
  readonly snapshot: RunSnapshot;
  subscribe(listener: RunListener): () => void;
  waitForResult(): Promise<CallToolResult>;
  cancel(reason?: string): Promise<void>;
}

export interface McpFeatureAdapter {
  readonly name: string;
  readonly capabilityKey?: string;
  canHandle(method: string): boolean;
  handle(request: JSONRPCRequest): Promise<unknown>;
}

export interface McpProxyResponse {
  readonly status: number;
  readonly messages: readonly JSONRPCMessage[];
}

export function relatedTaskIdFromMeta(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as { _meta?: Record<string, unknown> })._meta;
  const related = meta?.["io.modelcontextprotocol/related-task"];
  if (!related || typeof related !== "object") return undefined;
  const taskId = (related as { taskId?: unknown }).taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

export function progressFromMcp(progress: Progress): RunProgress {
  return {
    current: progress.progress,
    ...(progress.total !== undefined ? { total: progress.total } : {}),
    ...(progress.message !== undefined ? { message: progress.message } : {}),
  };
}
