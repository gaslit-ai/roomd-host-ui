import type { UIMessageChunk } from "ai";
import type { RunSnapshot } from "@/lib/mcp/kernel/types";

export const DATA_RUN_PART_TYPE = "data-run" as const;

export interface DataRunPartData {
  readonly runId: string;
  readonly toolCallId?: string;
  readonly source: RunSnapshot["source"];
  readonly phase: RunSnapshot["phase"];
  readonly toolName: string;
  readonly toolMeta: RunSnapshot["toolMeta"];
  readonly taskId?: string;
  readonly partialArgs?: unknown;
  readonly progress?: RunSnapshot["progress"];
  readonly statusMessage?: string;
  readonly result?: RunSnapshot["result"];
  readonly error?: RunSnapshot["error"];
  readonly ttlExpiresAt?: number;
  readonly ttlWarningAt?: number;
  readonly ttlWarningSent?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export function toDataRunPart(
  snapshot: RunSnapshot,
  toolCallId?: string,
): UIMessageChunk {
  const data: DataRunPartData = {
    runId: snapshot.runId,
    toolCallId,
    source: snapshot.source,
    phase: snapshot.phase,
    toolName: snapshot.toolName,
    toolMeta: snapshot.toolMeta,
    taskId: snapshot.taskId,
    partialArgs: snapshot.partialArgs,
    progress: snapshot.progress,
    statusMessage: snapshot.statusMessage,
    result: snapshot.result,
    error: snapshot.error,
    ttlExpiresAt: snapshot.ttlExpiresAt,
    ttlWarningAt: snapshot.ttlWarningAt,
    ttlWarningSent: snapshot.ttlWarningSent,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    completedAt: snapshot.completedAt,
  };
  return {
    type: DATA_RUN_PART_TYPE,
    id: snapshot.runId,
    data,
  } as UIMessageChunk;
}
