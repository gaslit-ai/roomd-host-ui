import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CancelledNotification,
  CreateMessageResult,
  ElicitResult,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolResultSchema,
  CancelledNotificationSchema,
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  ElicitRequestSchema,
  ElicitResultSchema,
  EmptyResultSchema,
  ErrorCode,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  LoggingMessageNotificationSchema,
  McpError,
  ProgressNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  TaskStatusNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { childLog } from "@/lib/logger";
import { RunRegistry } from "@/lib/mcp/projections/run/registry";
import { defaultHostCapabilities } from "./capabilities";
import { McpEventBus } from "./events";
import type { McpProjectionEvent, RunHandle } from "./types";

const log = childLog("mcp-kernel");

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "";

type PendingBrowserRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

class BrowserRequestScope {
  private readonly controller = new AbortController();
  private runHandle: RunHandle | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  setRunHandle(handle: RunHandle): void {
    this.runHandle = handle;
    if (this.controller.signal.aborted) {
      void handle.cancel(cancelReason(this.controller.signal.reason));
    }
  }

  async cancel(reason?: string): Promise<void> {
    this.controller.abort(reason);
    await this.runHandle?.cancel(reason);
  }
}

export class McpHostKernel {
  readonly events = new McpEventBus();
  readonly runs: RunRegistry;
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly pendingBrowserRequests = new Map<
    RequestId,
    PendingBrowserRequest
  >();
  private readonly activeBrowserRequests = new Map<
    RequestId,
    BrowserRequestScope
  >();
  private readyPromise: Promise<void>;
  private browserRequestSeq = 0;

  constructor(url = MCP_SERVER_URL) {
    if (!url) throw new Error("MCP_SERVER_URL is not configured");
    this.client = new Client(
      { name: "roomd-host-ui-host-kernel", version: "1.0.0" },
      {
        capabilities: defaultHostCapabilities(),
      },
    );
    this.transport = new StreamableHTTPClientTransport(new URL(url));
    this.runs = new RunRegistry(this.client, this.events);
    this.installHandlers();
    this.readyPromise = this.connect();
  }

  async ready(): Promise<this> {
    await this.readyPromise;
    return this;
  }

  get upstreamClient(): Client {
    return this.client;
  }

  get serverInfo() {
    return this.client.getServerVersion();
  }

  get serverCapabilities() {
    return this.client.getServerCapabilities();
  }

  get instructions() {
    return this.client.getInstructions();
  }

  subscribe(listener: (event: McpProjectionEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  async handleBrowserMessage(
    message: JSONRPCMessage,
  ): Promise<readonly JSONRPCMessage[]> {
    await this.ready();
    if (isResponse(message)) {
      this.resolveBrowserResponse(message);
      return [];
    }
    if (isNotification(message)) {
      await this.handleBrowserNotification(message);
      return [];
    }
    if (isRequest(message)) {
      return [await this.handleBrowserRequest(message)];
    }
    return [
      jsonRpcError(null, ErrorCode.InvalidRequest, "Invalid JSON-RPC message"),
    ];
  }

  private async connect(): Promise<void> {
    await this.client.connect(this.transport);
    await this.runs.refreshTools().catch((err) => {
      log.warn({ err }, "initial tools refresh failed");
    });
  }

  private installHandlers(): void {
    this.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode === "url") {
        return { action: "decline" } satisfies ElicitResult;
      }
      const result = await this.sendBrowserRequest(
        "elicitation/create",
        request.params,
      );
      return ElicitResultSchema.parse(result);
    });

    this.client.setRequestHandler(
      CreateMessageRequestSchema,
      async (request) => {
        if (request.params.tools || request.params.toolChoice) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "sampling.tools is not supported by this host",
          );
        }
        const result = await this.sendBrowserRequest(
          "sampling/createMessage",
          request.params,
        );
        return CreateMessageResultSchema.parse(result) as CreateMessageResult;
      },
    );

    this.forwardNotification(ProgressNotificationSchema);
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async (notification) => {
        await this.runs.refreshTools().catch((err) => {
          log.warn({ err }, "tools refresh failed");
        });
        this.events.emit({
          kind: "mcp",
          message: { jsonrpc: "2.0", ...notification },
        });
      },
    );
    this.forwardNotification(ResourceListChangedNotificationSchema);
    this.forwardNotification(PromptListChangedNotificationSchema);
    this.forwardNotification(ResourceUpdatedNotificationSchema);
    this.forwardNotification(TaskStatusNotificationSchema);
    this.client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      async (notification) => {
        this.events.emit({
          kind: "log",
          record: {
            id: `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
            level: notification.params.level,
            logger: notification.params.logger,
            data: notification.params.data,
            createdAt: Date.now(),
          },
        });
        this.events.emit({
          kind: "mcp",
          message: { jsonrpc: "2.0", ...notification },
        });
      },
    );
  }

  private forwardNotification(
    schema: Parameters<Client["setNotificationHandler"]>[0],
  ) {
    this.client.setNotificationHandler(schema, async (notification) => {
      this.events.emit({
        kind: "mcp",
        message: { jsonrpc: "2.0", ...notification },
      });
    });
  }

  private async sendBrowserRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = `browser_${++this.browserRequestSeq}`;
    const message: JSONRPCRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: params as Record<string, unknown>,
    };
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingBrowserRequests.set(id, { resolve, reject });
    });
    this.events.emit({ kind: "mcp", message });
    return result;
  }

  private resolveBrowserResponse(response: JSONRPCResponse): void {
    if (response.id === undefined) return;
    const pending = this.pendingBrowserRequests.get(response.id);
    if (!pending) return;
    this.pendingBrowserRequests.delete(response.id);
    if ("error" in response) {
      pending.reject(new Error(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  private async handleBrowserNotification(
    message: JSONRPCMessage,
  ): Promise<void> {
    if (!("method" in message)) return;
    if (message.method === "notifications/initialized") return;
    if (message.method === "notifications/cancelled") {
      await this.handleBrowserCancellation(
        CancelledNotificationSchema.parse(message),
      );
      return;
    }
    await this.client.notification(message as never).catch((err) => {
      log.warn(
        { err, method: message.method },
        "browser notification rejected",
      );
    });
  }

  private async handleBrowserCancellation(
    notification: CancelledNotification,
  ): Promise<void> {
    const { requestId, reason } = notification.params;
    if (requestId === undefined) return;

    const pending = this.pendingBrowserRequests.get(requestId);
    if (pending) {
      this.pendingBrowserRequests.delete(requestId);
      pending.reject(new Error(reason ?? "Browser request cancelled"));
    }

    const active = this.activeBrowserRequests.get(requestId);
    if (active) {
      await active
        .cancel(reason)
        .catch((err) =>
          log.warn({ err, requestId, reason }, "browser cancellation failed"),
        );
    }
  }

  private async handleBrowserRequest(
    request: JSONRPCRequest,
  ): Promise<JSONRPCMessage> {
    const scope = new BrowserRequestScope();
    this.activeBrowserRequests.set(request.id, scope);
    try {
      const result = await this.dispatchBrowserRequest(request, scope);
      return { jsonrpc: "2.0", id: request.id, result } as JSONRPCMessage;
    } catch (err) {
      const error =
        err instanceof McpError
          ? err
          : McpError.fromError(
              ErrorCode.InternalError,
              err instanceof Error ? err.message : String(err),
            );
      return jsonRpcError(request.id, error.code, error.message, error.data);
    } finally {
      this.activeBrowserRequests.delete(request.id);
    }
  }

  private async dispatchBrowserRequest(
    request: JSONRPCRequest,
    scope: BrowserRequestScope,
  ): Promise<unknown> {
    switch (request.method) {
      case "initialize": {
        const params = request.params as
          | { protocolVersion?: string }
          | undefined;
        const requested = params?.protocolVersion;
        const protocolVersion =
          requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
        return InitializeResultSchema.parse({
          protocolVersion,
          capabilities: this.serverCapabilities ?? {},
          serverInfo: this.serverInfo ?? {
            name: "roomd-host-ui-mcp-proxy",
            version: "1.0.0",
          },
          instructions: this.instructions,
        });
      }
      case "ping":
        return {};
      case "tools/list":
        return this.client.listTools(request.params as never);
      case "tools/call": {
        const params = request.params as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (!params?.name) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "tools/call requires name",
          );
        }
        const handle = await this.runs.call(
          params.name,
          params.arguments ?? {},
          {
            source: "view",
            mode: "auto",
            signal: scope.signal,
          },
        );
        scope.setRunHandle(handle);
        return handle.waitForResult();
      }
      case "resources/list":
        return this.client.listResources(request.params as never);
      case "resources/templates/list":
        return this.client.listResourceTemplates(request.params as never);
      case "resources/read":
        return this.client.readResource(request.params as never);
      case "resources/subscribe":
      case "resources/unsubscribe":
        return this.client.request(
          { method: request.method, params: request.params as never },
          ResultSchema,
        );
      case "prompts/list":
        return this.client.listPrompts(request.params as never);
      case "prompts/get":
        return this.client.getPrompt(request.params as never);
      case "completion/complete":
        return this.client.complete(request.params as never);
      case "logging/setLevel":
        return this.client.request(
          { method: "logging/setLevel", params: request.params as never },
          EmptyResultSchema,
        );
      case "tasks/list":
        return this.client.experimental.tasks.listTasks(
          (request.params as { cursor?: string } | undefined)?.cursor,
        );
      case "tasks/get":
        return this.client.experimental.tasks.getTask(
          (request.params as { taskId: string }).taskId,
        );
      case "tasks/result":
        return this.client.experimental.tasks.getTaskResult(
          (request.params as { taskId: string }).taskId,
          CallToolResultSchema,
        );
      case "tasks/cancel":
        return this.client.experimental.tasks.cancelTask(
          (request.params as { taskId: string }).taskId,
        );
      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `No handler for method: ${request.method}`,
        );
    }
  }
}

let kernelPromise: Promise<McpHostKernel> | null = null;

export async function getMcpHostKernel(): Promise<McpHostKernel> {
  if (!kernelPromise) {
    const promise = Promise.resolve()
      .then(() => new McpHostKernel())
      .then((kernel) => kernel.ready())
      .catch((err) => {
        if (kernelPromise === promise) kernelPromise = null;
        throw err;
      });
    kernelPromise = promise;
  }
  return kernelPromise;
}

function isRequest(message: JSONRPCMessage): message is JSONRPCRequest {
  return "method" in message && "id" in message;
}

function isNotification(message: JSONRPCMessage): boolean {
  return "method" in message && !("id" in message);
}

function isResponse(message: JSONRPCMessage): message is JSONRPCResponse {
  return "id" in message && ("result" in message || "error" in message);
}

function jsonRpcError(
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown,
): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    ...(id !== null ? { id } : {}),
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function cancelReason(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  if (reason === undefined) return "cancelled";
  return String(reason);
}
