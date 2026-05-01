import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { childLog } from "@/lib/logger";
import { listAllTools, toolVisibilityRejection } from "@/lib/mcp/catalog";
import { modelToolResult } from "@/lib/mcp/features/tools/result";
import type { McpEventBus } from "@/lib/mcp/kernel/events";
import {
  progressFromMcp,
  type RunHandle,
  type RunPhase,
  type RunSnapshot,
  type RunSource,
  type RunToolMeta,
} from "@/lib/mcp/kernel/types";
import { isTerminalRunPhase, RunHandleImpl } from "./handle";

const log = childLog("mcp-run-registry");

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_PRUNE_AFTER_MS = 5 * 60_000;
const TERMINAL_HISTORY_CAP = 128;
const CONCURRENCY_CAP = 32;

export type RunCallMode = "auto" | "required-only" | "plain";

export interface RunCallOptions {
  readonly source: RunSource;
  readonly mode?: RunCallMode;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly ttl?: number;
  readonly pollInterval?: number;
}

export type RunRegistryListener = (snapshots: readonly RunSnapshot[]) => void;

export class RunRegistry {
  private readonly handles = new Map<string, RunHandleImpl>();
  private readonly listeners = new Set<RunRegistryListener>();
  private readonly activeRunIds = new Set<string>();
  private readonly ttlTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cachedSnapshots: readonly RunSnapshot[] = Object.freeze([]);
  private cachedTools: readonly Tool[] = [];
  private cachedToolsAt = 0;
  private seq = 0;

  constructor(
    private readonly client: Client,
    private readonly events: McpEventBus,
  ) {}

  async refreshTools(): Promise<readonly Tool[]> {
    this.cachedTools = await listAllTools(this.client);
    this.cachedToolsAt = Date.now();
    return this.cachedTools;
  }

  async getTools(): Promise<readonly Tool[]> {
    if (
      Date.now() - this.cachedToolsAt < 5_000 &&
      this.cachedTools.length > 0
    ) {
      return this.cachedTools;
    }
    return this.refreshTools();
  }

  get snapshots(): readonly RunSnapshot[] {
    return this.cachedSnapshots;
  }

  getHandle(runId: string): RunHandle | undefined {
    return this.handles.get(runId);
  }

  subscribe(listener: RunRegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async call(
    toolName: string,
    args: unknown,
    options: RunCallOptions,
  ): Promise<RunHandle> {
    const tools = await this.getTools();
    const tool = tools.find((item) => item.name === toolName);
    if (!tool) throw new Error(`Unknown MCP tool: ${toolName}`);
    const caller =
      options.source === "agent"
        ? "model"
        : options.source === "view"
          ? "app"
          : null;
    const rejection = caller ? toolVisibilityRejection(tool, caller) : null;
    if (rejection) {
      throw new McpError(ErrorCode.InvalidRequest, rejection);
    }

    if (this.activeRunIds.size >= CONCURRENCY_CAP) {
      throw new Error(`MCP run concurrency cap exceeded (${CONCURRENCY_CAP})`);
    }

    const runId = this.nextRunId();
    const ac = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) ac.abort(options.signal.reason);
      else {
        options.signal.addEventListener(
          "abort",
          () => ac.abort(options.signal?.reason),
          { once: true },
        );
      }
    }

    const handle = new RunHandleImpl(
      {
        runId,
        source: options.source,
        phase: "queued",
        toolName,
        toolMeta: toRunToolMeta(tool),
        input: args,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      async (reason) => {
        ac.abort(reason);
        this.finishRun(handle);
        const taskId = handle.snapshot.taskId;
        if (taskId) {
          await this.client.experimental.tasks
            .cancelTask(taskId)
            .catch((err) =>
              log.warn({ err, runId, taskId, reason }, "tasks/cancel failed"),
            );
        }
      },
    );
    this.handles.set(runId, handle);
    this.activeRunIds.add(runId);
    this.bindHandle(handle);
    this.emit();

    const support = tool.execution?.taskSupport;
    const taskPath =
      options.mode === "plain"
        ? false
        : options.mode === "required-only"
          ? support === "required"
          : support === "required" || support === "optional";

    if (taskPath) {
      void this.runTask(handle, tool, args, ac.signal, options);
    } else {
      void this.runPlain(handle, tool, args, ac.signal, options);
    }
    return handle;
  }

  private async runPlain(
    handle: RunHandleImpl,
    tool: Tool,
    args: unknown,
    signal: AbortSignal,
    options: RunCallOptions,
  ): Promise<void> {
    handle.patch({ phase: "working" });
    try {
      const result = (await this.client.request(
        {
          method: "tools/call",
          params: {
            name: tool.name,
            arguments: args as Record<string, unknown>,
          },
        },
        CallToolResultSchema,
        {
          signal,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          onprogress: (progress) =>
            this.applyProgress(handle, progress, "working"),
        },
      )) as CallToolResult;
      this.settleResult(handle, tool, result);
    } catch (err) {
      this.settleError(handle, err, signal.aborted ? "cancelled" : "failed");
    }
  }

  private async runTask(
    handle: RunHandleImpl,
    tool: Tool,
    args: unknown,
    signal: AbortSignal,
    options: RunCallOptions,
  ): Promise<void> {
    handle.patch({ phase: "working" });
    try {
      const stream = this.client.experimental.tasks.callToolStream(
        { name: tool.name, arguments: args as Record<string, unknown> },
        CallToolResultSchema,
        {
          task: {
            ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
            ...(options.pollInterval !== undefined
              ? { pollInterval: options.pollInterval }
              : {}),
          },
          signal,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          onprogress: (progress) =>
            this.applyProgress(handle, progress, handle.snapshot.phase),
        },
      );

      for await (const message of stream) {
        if (message.type === "taskCreated" || message.type === "taskStatus") {
          const task = message.task;
          const ttlExpiresAt =
            typeof task.ttl === "number"
              ? Date.parse(task.createdAt) + task.ttl
              : undefined;
          const ttlWarningAt =
            ttlExpiresAt !== undefined
              ? Date.parse(task.createdAt) + Math.floor((task.ttl ?? 0) * 0.8)
              : undefined;
          handle.patch({
            taskId: task.taskId,
            phase: taskStatusToPhase(task.status),
            statusMessage: task.statusMessage,
            ttlExpiresAt,
            ttlWarningAt,
          });
          if (ttlWarningAt !== undefined) {
            this.scheduleTtlWarning(handle, ttlWarningAt);
          }
          continue;
        }
        if (message.type === "result") {
          this.settleResult(handle, tool, message.result as CallToolResult);
          continue;
        }
        if (message.type === "error") {
          this.settleError(handle, message.error, "failed");
        }
      }
    } catch (err) {
      this.settleError(handle, err, signal.aborted ? "cancelled" : "failed");
    }
  }

  private settleResult(
    handle: RunHandleImpl,
    tool: Tool,
    result: CallToolResult,
  ): void {
    const modeled = modelToolResult(result, tool);
    const phase: RunPhase =
      modeled.validationError || result.isError ? "failed" : "completed";
    handle.patch({
      phase,
      result: modeled.result,
      error:
        modeled.validationError ??
        (result.isError
          ? {
              message:
                firstText(result) ?? `Tool "${tool.name}" returned isError`,
            }
          : undefined),
      completedAt: Date.now(),
    });
    this.finishRun(handle);
    if (modeled.validationError) {
      handle.fail(
        new Error(handle.snapshot.error?.message ?? "MCP tool error"),
      );
    } else {
      handle.complete(result);
    }
  }

  private settleError(
    handle: RunHandleImpl,
    err: unknown,
    phase: Extract<RunPhase, "failed" | "cancelled">,
  ): void {
    const error = err instanceof Error ? err : new Error(String(err));
    handle.patch({
      phase,
      error: {
        message: error.message,
        code: (err as { code?: number })?.code,
        data: (err as { data?: unknown })?.data,
      },
      completedAt: Date.now(),
    });
    this.finishRun(handle);
    if (phase === "cancelled") handle.fail(new Error("Run cancelled"));
    else handle.fail(error);
  }

  private applyProgress(
    handle: RunHandleImpl,
    progress: Progress,
    phase: RunPhase,
  ): void {
    handle.patch({
      phase: isTerminalRunPhase(phase) ? handle.snapshot.phase : phase,
      progress: progressFromMcp(progress),
      statusMessage: progress.message ?? handle.snapshot.statusMessage,
    });
  }

  private finishRun(handle: RunHandleImpl): void {
    this.activeRunIds.delete(handle.snapshot.runId);
    const timer = this.ttlTimers.get(handle.snapshot.runId);
    if (timer) clearTimeout(timer);
    this.ttlTimers.delete(handle.snapshot.runId);
    this.prune();
  }

  private scheduleTtlWarning(handle: RunHandleImpl, warningAt: number): void {
    if (this.ttlTimers.has(handle.snapshot.runId)) return;
    const delay = Math.max(0, warningAt - Date.now());
    const timer = setTimeout(() => {
      if (isTerminalRunPhase(handle.snapshot.phase)) return;
      handle.patch({
        ttlWarningSent: true,
        statusMessage:
          handle.snapshot.statusMessage ??
          "Run is nearing the server-declared task TTL",
      });
    }, delay);
    this.ttlTimers.set(handle.snapshot.runId, timer);
  }

  private bindHandle(handle: RunHandleImpl): void {
    handle.subscribe((snapshot) => {
      this.emit();
      this.events.emit({ kind: "run", snapshot });
    });
    this.events.emit({ kind: "run", snapshot: handle.snapshot });
  }

  private emit(): void {
    const snapshots = [...this.handles.values()].map(
      (handle) => handle.snapshot,
    );
    this.cachedSnapshots = Object.freeze(snapshots);
    for (const listener of this.listeners) listener(this.cachedSnapshots);
  }

  private prune(): void {
    const now = Date.now();
    const terminal = [...this.handles.values()]
      .filter((handle) => isTerminalRunPhase(handle.snapshot.phase))
      .sort((a, b) => a.snapshot.updatedAt - b.snapshot.updatedAt);
    for (const handle of terminal) {
      const completedAt =
        handle.snapshot.completedAt ?? handle.snapshot.updatedAt;
      if (now - completedAt > TERMINAL_PRUNE_AFTER_MS) {
        this.handles.delete(handle.snapshot.runId);
      }
    }
    const remainingTerminal = [...this.handles.values()]
      .filter((handle) => isTerminalRunPhase(handle.snapshot.phase))
      .sort((a, b) => a.snapshot.updatedAt - b.snapshot.updatedAt);
    while (remainingTerminal.length > TERMINAL_HISTORY_CAP) {
      const oldest = remainingTerminal.shift();
      if (oldest) this.handles.delete(oldest.snapshot.runId);
    }
    this.emit();
  }

  private nextRunId(): string {
    this.seq += 1;
    return `run_${Date.now().toString(36)}_${this.seq.toString(36)}`;
  }
}

function toRunToolMeta(tool: Tool): RunToolMeta {
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title,
    description: tool.description,
    annotations: tool.annotations,
    icons: tool.icons,
    _meta: tool._meta,
    execution: tool.execution,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  };
}

function taskStatusToPhase(status: string): RunPhase {
  switch (status) {
    case "input_required":
      return "input_required";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "working";
  }
}

function firstText(result: CallToolResult): string | undefined {
  const text = result.content.find((item) => item.type === "text");
  return text?.type === "text" ? text.text : undefined;
}
