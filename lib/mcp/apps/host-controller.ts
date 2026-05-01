import type {
  McpUiAppCapabilities,
  McpUiDownloadFileRequest,
  McpUiDownloadFileResult,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiMessageRequest,
  McpUiMessageResult,
  McpUiOpenLinkRequest,
  McpUiOpenLinkResult,
  McpUiRequestDisplayModeRequest,
  McpUiRequestDisplayModeResult,
  McpUiRequestTeardownNotification,
  McpUiToolCancelledNotification,
  McpUiToolInputPartialNotification,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  EmptyResult,
  Implementation,
  JSONRPCRequest,
  LoggingMessageNotification,
  PromptListChangedNotification,
  ResourceListChangedNotification,
  ResourceUpdatedNotification,
  Tool,
  ToolListChangedNotification,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolResultSchema,
  ErrorCode,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ReadResourceResultSchema,
  ResultSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  filterToolsForApp,
  listAllTools,
  toolVisibilityRejection,
} from "../catalog.ts";

export type McpAppHostRequestHandlerExtra = Parameters<
  Parameters<AppBridge["setRequestHandler"]>[1]
>[1];

export interface McpAppHostControllerHandlers {
  onMessage?: (
    params: McpUiMessageRequest["params"],
    extra: McpAppHostRequestHandlerExtra,
  ) => Promise<McpUiMessageResult>;
  onOpenLink?: (
    params: McpUiOpenLinkRequest["params"],
    extra: McpAppHostRequestHandlerExtra,
  ) => Promise<McpUiOpenLinkResult>;
  onDownloadFile?: (
    params: McpUiDownloadFileRequest["params"],
    extra: McpAppHostRequestHandlerExtra,
  ) => Promise<McpUiDownloadFileResult>;
  onUpdateModelContext?: (
    params: McpUiUpdateModelContextRequest["params"],
    extra: McpAppHostRequestHandlerExtra,
  ) => Promise<EmptyResult>;
  onRequestDisplayMode?: (
    params: McpUiRequestDisplayModeRequest["params"],
    extra: McpAppHostRequestHandlerExtra,
  ) => Promise<McpUiRequestDisplayModeResult>;
  onRequestTeardown?: (
    params: McpUiRequestTeardownNotification["params"],
  ) => void;
  onLoggingMessage?: (params: LoggingMessageNotification["params"]) => void;
  onAppCapabilities?: (capabilities: McpUiAppCapabilities | undefined) => void;
  onFallbackRequest?: (
    request: JSONRPCRequest,
    extra: McpAppHostRequestHandlerExtra,
  ) => Promise<unknown>;
  onError?: (err: Error) => void;
}

export interface McpAppHostControllerOptions
  extends McpAppHostControllerHandlers {
  client: Client;
  hostInfo?: Implementation;
  hostCapabilities: McpUiHostCapabilities;
  hostContext?: McpUiHostContext;
  onResourceUpdated?: (
    listener: (params: ResourceUpdatedNotification["params"]) => void,
  ) => () => void;
  onToolListChanged?: (
    listener: (params: ToolListChangedNotification["params"]) => void,
  ) => () => void;
  onResourceListChanged?: (
    listener: (params: ResourceListChangedNotification["params"]) => void,
  ) => () => void;
  onPromptListChanged?: (
    listener: (params: PromptListChangedNotification["params"]) => void,
  ) => () => void;
}

export interface McpAppHostController {
  readonly bridge: AppBridge;
  updateHandlers(handlers: McpAppHostControllerHandlers): void;
  setHostContext(hostContext: McpUiHostContext | undefined): void;
  sendToolInputPartial(
    params: McpUiToolInputPartialNotification["params"] | undefined,
  ): void;
  sendToolCancelled(
    params: McpUiToolCancelledNotification["params"] | undefined,
  ): void;
  sendToolListChanged(params?: ToolListChangedNotification["params"]): void;
  sendResourceListChanged(
    params?: ResourceListChangedNotification["params"],
  ): void;
  sendPromptListChanged(params?: PromptListChangedNotification["params"]): void;
  teardownResource(): void;
  dispose(): void;
}

const DEFAULT_HOST_INFO: Implementation = {
  name: "audiostudio-host",
  version: "1.0.0",
};

export function createMcpAppHostController(
  options: McpAppHostControllerOptions,
): McpAppHostController {
  const { client } = options;
  let handlers = pickHandlers(options);
  let disposed = false;
  let initialized = false;
  let cachedTools: readonly Tool[] | null = null;

  // SDK(@modelcontextprotocol/ext-apps AppBridge): passing null disables automatic forwarding and requires manual handlers. See node_modules/@modelcontextprotocol/ext-apps/dist/src/app-bridge.d.ts:219.
  const bridge = new AppBridge(
    null,
    options.hostInfo ?? DEFAULT_HOST_INFO,
    options.hostCapabilities,
    options.hostContext ? { hostContext: options.hostContext } : undefined,
  );

  const reportBridgeError = (err: unknown) => {
    if (disposed) return;
    const e = err instanceof Error ? err : new Error(String(err));
    handlers.onError?.(e);
  };

  const readAllTools = async (signal?: AbortSignal) => {
    if (cachedTools) return cachedTools;
    const tools = await listAllTools(client, signal ? { signal } : undefined);
    cachedTools = tools;
    return tools;
  };

  const getAppCallableTool = async (name: string, signal?: AbortSignal) => {
    const tools = await readAllTools(signal);
    const tool = tools.find((item) => item.name === name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown MCP tool: ${name}`);
    }

    // SPEC(SEP-1865 §Visibility): app calls must be rejected when "app" visibility is absent. See https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx#L22.
    const rejection = toolVisibilityRejection(tool, "app");
    if (rejection) {
      throw new McpError(ErrorCode.InvalidRequest, rejection);
    }
    return tool;
  };

  bridge.onmessage = async (params, extra) => {
    const cb = handlers.onMessage;
    if (!cb)
      throw new McpError(ErrorCode.MethodNotFound, "ui/message not supported");
    return cb(params, extra);
  };
  bridge.onopenlink = async (params, extra) => {
    const cb = handlers.onOpenLink;
    if (!cb)
      throw new McpError(
        ErrorCode.MethodNotFound,
        "ui/open-link not supported",
      );
    return cb(params, extra);
  };
  bridge.ondownloadfile = async (params, extra) => {
    const cb = handlers.onDownloadFile;
    if (!cb)
      throw new McpError(
        ErrorCode.MethodNotFound,
        "ui/download-file not supported",
      );
    return cb(params, extra);
  };
  bridge.onupdatemodelcontext = async (params, extra) => {
    const cb = handlers.onUpdateModelContext;
    if (!cb)
      throw new McpError(
        ErrorCode.MethodNotFound,
        "ui/update-model-context not supported",
      );
    return cb(params, extra);
  };
  bridge.onrequestdisplaymode = async (params, extra) => {
    const cb = handlers.onRequestDisplayMode;
    if (!cb)
      throw new McpError(
        ErrorCode.MethodNotFound,
        "ui/request-display-mode not supported",
      );
    return cb(params, extra);
  };
  bridge.onloggingmessage = (params) => {
    handlers.onLoggingMessage?.(params);
  };

  bridge.oncalltool = async (params, extra) => {
    const tool = await getAppCallableTool(params.name, extra?.signal);
    return client.request(
      {
        method: "tools/call",
        params: {
          name: tool.name,
          arguments: params.arguments ?? {},
        },
      },
      CallToolResultSchema,
      { signal: extra?.signal },
    );
  };
  bridge.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    const tools = filterToolsForApp(await readAllTools(extra.signal));
    return ListToolsResultSchema.parse({ tools });
  });
  bridge.onlistresources = async (params, extra) =>
    client.request(
      { method: "resources/list", params },
      ListResourcesResultSchema,
      { signal: extra.signal },
    );
  bridge.onlistresourcetemplates = async (params, extra) =>
    client.request(
      { method: "resources/templates/list", params },
      ListResourceTemplatesResultSchema,
      { signal: extra.signal },
    );
  bridge.onreadresource = async (params, extra) =>
    client.request(
      { method: "resources/read", params },
      ReadResourceResultSchema,
      { signal: extra.signal },
    );
  bridge.onlistprompts = async (params, extra) =>
    client.request(
      { method: "prompts/list", params },
      ListPromptsResultSchema,
      { signal: extra.signal },
    );

  const subscribedUris = new Set<string>();

  // SPEC(SEP-1865 §Standard MCP Messages): apps may use MCP resource reads and notifications through the bridge. See https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx#L30.
  // OPINION(codebase): use loose ResultSchema for subscribe acks to preserve existing tolerance for pass-through servers with extra keys. See components/mcp/host-app-renderer.tsx:439.
  bridge.setRequestHandler(SubscribeRequestSchema, async (req, extra) => {
    await client.request(
      { method: "resources/subscribe", params: req.params },
      ResultSchema,
      { signal: extra.signal },
    );
    subscribedUris.add(req.params.uri);
    return {};
  });
  bridge.setRequestHandler(UnsubscribeRequestSchema, async (req, extra) => {
    await client.request(
      { method: "resources/unsubscribe", params: req.params },
      ResultSchema,
      { signal: extra.signal },
    );
    subscribedUris.delete(req.params.uri);
    return {};
  });

  type BridgeNotification = Parameters<typeof bridge.notification>[0];
  const pending = createPendingState();

  const flushPending = () => {
    if (pending.hasToolListChanged) {
      const params = pending.toolListChanged;
      pending.hasToolListChanged = false;
      sendToolListChanged(params);
    }
    if (pending.hasResourceListChanged) {
      const params = pending.resourceListChanged;
      pending.hasResourceListChanged = false;
      sendResourceListChanged(params);
    }
    if (pending.hasPromptListChanged) {
      const params = pending.promptListChanged;
      pending.hasPromptListChanged = false;
      sendPromptListChanged(params);
    }
    if (pending.hasToolInputPartial) {
      const params = pending.toolInputPartial;
      pending.hasToolInputPartial = false;
      sendToolInputPartial(params);
    }
    if (pending.hasToolCancelled) {
      const params = pending.toolCancelled;
      pending.hasToolCancelled = false;
      sendToolCancelled(params);
    }
  };

  function sendToolListChanged(params?: ToolListChangedNotification["params"]) {
    cachedTools = null;
    if (!initialized) {
      pending.hasToolListChanged = true;
      pending.toolListChanged = params;
      return;
    }
    bridge.sendToolListChanged(params).catch(reportBridgeError);
  }

  function sendResourceListChanged(
    params?: ResourceListChangedNotification["params"],
  ) {
    if (!initialized) {
      pending.hasResourceListChanged = true;
      pending.resourceListChanged = params;
      return;
    }
    bridge.sendResourceListChanged(params).catch(reportBridgeError);
  }

  function sendPromptListChanged(
    params?: PromptListChangedNotification["params"],
  ) {
    if (!initialized) {
      pending.hasPromptListChanged = true;
      pending.promptListChanged = params;
      return;
    }
    bridge.sendPromptListChanged(params).catch(reportBridgeError);
  }

  function sendToolInputPartial(
    params: McpUiToolInputPartialNotification["params"] | undefined,
  ) {
    if (!params) {
      pending.hasToolInputPartial = false;
      pending.toolInputPartial = undefined;
      return;
    }
    if (!initialized) {
      pending.hasToolInputPartial = true;
      pending.toolInputPartial = params;
      return;
    }
    bridge.sendToolInputPartial(params).catch(reportBridgeError);
  }

  function sendToolCancelled(
    params: McpUiToolCancelledNotification["params"] | undefined,
  ) {
    if (!params) {
      pending.hasToolCancelled = false;
      pending.toolCancelled = undefined;
      return;
    }
    if (!initialized) {
      pending.hasToolCancelled = true;
      pending.toolCancelled = params;
      return;
    }
    bridge.sendToolCancelled(params).catch(reportBridgeError);
  }

  const unsubscribeFanOut = options.onResourceUpdated?.((params) => {
    if (!subscribedUris.has(params.uri)) return;
    // SPEC(SEP-1865 §Standard MCP Messages): base MCP notifications can flow through host-to-view forwarding. See https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx#L30.
    bridge
      .notification({
        method: "notifications/resources/updated",
        params,
      } as unknown as BridgeNotification)
      .catch(reportBridgeError);
  });
  const unsubscribeToolListChanged =
    options.onToolListChanged?.(sendToolListChanged);
  const unsubscribeResourceListChanged = options.onResourceListChanged?.(
    sendResourceListChanged,
  );
  const unsubscribePromptListChanged = options.onPromptListChanged?.(
    sendPromptListChanged,
  );

  const onRequestTeardownEvt = (
    params: McpUiRequestTeardownNotification["params"],
  ) => handlers.onRequestTeardown?.(params);
  bridge.addEventListener("requestteardown", onRequestTeardownEvt);

  const onInitializedEvt = () => {
    initialized = true;
    handlers.onAppCapabilities?.(bridge.getAppCapabilities());
    flushPending();
  };
  // SDK(@modelcontextprotocol/ext-apps AppBridge): initialized listeners compose with AppFrame, while the deprecated oninitialized setter is last-wins. See node_modules/@modelcontextprotocol/ext-apps/dist/src/app-bridge.d.ts:389.
  bridge.addEventListener("initialized", onInitializedEvt);

  bridge.fallbackRequestHandler = (async (
    req: JSONRPCRequest,
    extra: McpAppHostRequestHandlerExtra,
  ) => {
    const cb = handlers.onFallbackRequest;
    if (cb) return cb(req, extra);
    throw new McpError(
      ErrorCode.MethodNotFound,
      `No handler for method: ${req.method}`,
    );
  }) as typeof bridge.fallbackRequestHandler;

  return {
    bridge,
    updateHandlers(nextHandlers) {
      handlers = { ...nextHandlers };
    },
    setHostContext(hostContext) {
      if (!hostContext) return;
      bridge.setHostContext(hostContext);
    },
    sendToolInputPartial,
    sendToolCancelled,
    sendToolListChanged,
    sendResourceListChanged,
    sendPromptListChanged,
    teardownResource() {
      // SPEC(SEP-1865 §Lifecycle): hosts must not send host-to-view messages before initialized. See https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx#L28.
      if (!initialized) return;
      bridge.teardownResource({}).catch(reportBridgeError);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bridge.removeEventListener("requestteardown", onRequestTeardownEvt);
      bridge.removeEventListener("initialized", onInitializedEvt);
      unsubscribeFanOut?.();
      unsubscribeToolListChanged?.();
      unsubscribeResourceListChanged?.();
      unsubscribePromptListChanged?.();
      for (const uri of subscribedUris) {
        client
          .request(
            { method: "resources/unsubscribe", params: { uri } },
            ResultSchema,
          )
          .catch(() => {});
      }
      subscribedUris.clear();
      bridge.close().catch(() => {});
    },
  };
}

function pickHandlers(
  options: McpAppHostControllerOptions,
): McpAppHostControllerHandlers {
  return {
    onMessage: options.onMessage,
    onOpenLink: options.onOpenLink,
    onDownloadFile: options.onDownloadFile,
    onUpdateModelContext: options.onUpdateModelContext,
    onRequestDisplayMode: options.onRequestDisplayMode,
    onRequestTeardown: options.onRequestTeardown,
    onLoggingMessage: options.onLoggingMessage,
    onAppCapabilities: options.onAppCapabilities,
    onFallbackRequest: options.onFallbackRequest,
    onError: options.onError,
  };
}

function createPendingState() {
  return {
    hasToolListChanged: false,
    toolListChanged: undefined as
      | ToolListChangedNotification["params"]
      | undefined,
    hasResourceListChanged: false,
    resourceListChanged: undefined as
      | ResourceListChangedNotification["params"]
      | undefined,
    hasPromptListChanged: false,
    promptListChanged: undefined as
      | PromptListChangedNotification["params"]
      | undefined,
    hasToolInputPartial: false,
    toolInputPartial: undefined as
      | McpUiToolInputPartialNotification["params"]
      | undefined,
    hasToolCancelled: false,
    toolCancelled: undefined as
      | McpUiToolCancelledNotification["params"]
      | undefined,
  };
}
