"use client";

/**
 * Browser-side MCP Client + registries for MCP Apps (SEP-1865) hosting.
 *
 * Holds a single `@modelcontextprotocol/sdk` Client connected over Streamable
 * HTTP to the same MCP server the chat backend uses. Initializes with the
 * `io.modelcontextprotocol/ui` extension capability so servers know this host
 * can render UI resources. Subscribes to list-changed notifications so all
 * mounted AppRenderers can refresh automatically.
 *
 * SEP-1865 §"Client-Server Negotiation", §"Resource Discovery", §"Visibility"
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import { UI_EXTENSION_NAME } from "@mcp-ui/client";
import {
  getToolUiResourceUri,
  isToolVisibilityAppOnly,
  isToolVisibilityModelOnly,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  LoggingMessageNotificationSchema,
  type Prompt,
  type PromptListChangedNotification,
  PromptListChangedNotificationSchema,
  type ResourceListChangedNotification,
  ResourceListChangedNotificationSchema,
  type ResourceUpdatedNotification,
  ResourceUpdatedNotificationSchema,
  type Tool,
  type ToolListChangedNotification,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { childLog, span } from "@/lib/logger";
import {
  listAllPrompts,
  listAllResources,
  listAllTools,
  type ResourceListItem,
} from "@/lib/mcp/catalog";
import { defaultHostCapabilities } from "@/lib/mcp/kernel/capabilities";
import { BrowserMcpProxyTransport } from "@/lib/mcp/proxy/browser-transport";

const log = childLog("mcp-client");

const DEFAULT_PROXY_URL = "/api/mcp/proxy";

type ConnectionStatus = "idle" | "connecting" | "ready" | "error";

export interface ToolUIInfo {
  readonly toolName: string;
  readonly resourceUri: string;
  readonly tool: Tool;
  readonly appOnly: boolean;
  readonly modelOnly: boolean;
}

export interface UIResourceInfo {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
}

export type ResourceUpdatedListener = (
  params: ResourceUpdatedNotification["params"],
) => void;
export type ToolListChangedListener = (
  params: ToolListChangedNotification["params"],
) => void;
export type ResourceListChangedListener = (
  params: ResourceListChangedNotification["params"],
) => void;
export type PromptListChangedListener = (
  params: PromptListChangedNotification["params"],
) => void;

interface McpClientContextValue {
  readonly client: Client | null;
  readonly status: ConnectionStatus;
  readonly error: Error | null;
  /** Map of tool name → UI-resource metadata for tools that declare a `ui://`. */
  readonly toolUIs: ReadonlyMap<string, ToolUIInfo>;
  /** UI resources discovered via `resources/list` that are NOT tied to a tool. */
  readonly uiResources: readonly UIResourceInfo[];
  /**
   * Server-provided prompts (base MCP `prompts/list`). Empty if the server
   * does not advertise the `prompts` capability or the call failed. Live —
   * refreshed on `prompts/list_changed`.
   */
  readonly prompts: readonly Prompt[];
  /**
   * `true` when the server advertises the base-MCP `completions` capability
   * (`completion/complete`). Consumers use this to gate argument-completion
   * UI; it's a simple presence check per spec (`capabilities.completions`
   * is an opaque object when supported).
   */
  readonly supportsCompletions: boolean;
  /**
   * Subscribe to `notifications/resources/updated` from the MCP server
   * (SEP-1865 §"Standard MCP Messages" via base MCP `resources/subscribe`).
   *
   * The provider owns a single notification handler on the client and
   * fans out to all callers — necessary because `client.setNotificationHandler`
   * replaces rather than multiplexes. Callers (typically one per mounted
   * `HostAppRenderer`) SHOULD filter by URI against their own
   * `resources/subscribe` calls.
   *
   * Returns an unsubscribe function. Calling this does NOT send
   * `resources/unsubscribe` to the server — subscribers still manage
   * upstream subscription lifecycle via the raw client.
   */
  readonly onResourceUpdated: (listener: ResourceUpdatedListener) => () => void;
  /**
   * Subscribe to base-MCP catalog invalidations. The provider owns the single
   * SDK notification handler for each method and fans out to mounted views so
   * no iframe can clobber another iframe's handler on the shared client.
   */
  readonly onToolListChanged: (listener: ToolListChangedListener) => () => void;
  readonly onResourceListChanged: (
    listener: ResourceListChangedListener,
  ) => () => void;
  readonly onPromptListChanged: (
    listener: PromptListChangedListener,
  ) => () => void;
}

const McpClientContext = createContext<McpClientContextValue | null>(null);

export interface McpClientProviderProps {
  children: ReactNode;
  /** Override the same-origin MCP proxy URL. */
  url?: string;
}

export function McpClientProvider({ children, url }: McpClientProviderProps) {
  const [client, setClient] = useState<Client | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [toolUIs, setToolUIs] = useState<Map<string, ToolUIInfo>>(new Map());
  const [uiResources, setUIResources] = useState<UIResourceInfo[]>([]);
  const [prompts, setPrompts] = useState<readonly Prompt[]>([]);
  const [supportsCompletions, setSupportsCompletions] = useState(false);

  const clientRef = useRef<Client | null>(null);

  // Per-client fan-out sets. Refs (not state) so consumers never re-render on
  // add/remove, and so one provider-level SDK handler can multiplex to every
  // mounted HostAppRenderer without handler replacement races.
  const resourceUpdatedSubsRef = useRef<Set<ResourceUpdatedListener>>(
    new Set(),
  );
  const toolListChangedSubsRef = useRef<Set<ToolListChangedListener>>(
    new Set(),
  );
  const resourceListChangedSubsRef = useRef<Set<ResourceListChangedListener>>(
    new Set(),
  );
  const promptListChangedSubsRef = useRef<Set<PromptListChangedListener>>(
    new Set(),
  );

  const onResourceUpdated = useCallback((listener: ResourceUpdatedListener) => {
    resourceUpdatedSubsRef.current.add(listener);
    return () => {
      resourceUpdatedSubsRef.current.delete(listener);
    };
  }, []);
  const onToolListChanged = useCallback((listener: ToolListChangedListener) => {
    toolListChangedSubsRef.current.add(listener);
    return () => {
      toolListChangedSubsRef.current.delete(listener);
    };
  }, []);
  const onResourceListChanged = useCallback(
    (listener: ResourceListChangedListener) => {
      resourceListChangedSubsRef.current.add(listener);
      return () => {
        resourceListChangedSubsRef.current.delete(listener);
      };
    },
    [],
  );
  const onPromptListChanged = useCallback(
    (listener: PromptListChangedListener) => {
      promptListChangedSubsRef.current.add(listener);
      return () => {
        promptListChangedSubsRef.current.delete(listener);
      };
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let hasPromptsCap = false;
    let toolRefreshSeq = 0;
    let resourceRefreshSeq = 0;
    let promptRefreshSeq = 0;
    setStatus("connecting");
    setError(null);

    const endpoint = url ?? DEFAULT_PROXY_URL;
    const transport = new BrowserMcpProxyTransport(endpoint);
    const nextClient = new Client(
      { name: "roomd-host-ui-host", version: "1.0.0" },
      {
        capabilities: defaultHostCapabilities(),
      },
    );

    const refreshTools = async (reason: string) => {
      const seq = ++toolRefreshSeq;
      const tools = await listAllTools(nextClient);
      if (disposed || seq !== toolRefreshSeq) return;
      const next = buildToolUIMap(tools);
      log.debug({ toolCount: tools.length, uiToolCount: next.size }, reason);
      setToolUIs(next);
    };

    const refreshResources = async (reason: string) => {
      const seq = ++resourceRefreshSeq;
      const resources = await listAllResources(nextClient);
      if (disposed || seq !== resourceRefreshSeq) return;
      const next = pickUIResources(resources);
      log.debug(
        {
          resourceCount: resources.length,
          uiResourceCount: next.length,
        },
        reason,
      );
      setUIResources(next);
    };

    const refreshPrompts = async (reason: string) => {
      if (!hasPromptsCap) {
        log.debug({ reason }, "prompts refresh skipped; capability missing");
        return;
      }
      const seq = ++promptRefreshSeq;
      const next = await listAllPrompts(nextClient);
      if (disposed || seq !== promptRefreshSeq) return;
      log.debug({ promptCount: next.length }, reason);
      setPrompts(next as Prompt[]);
    };

    nextClient.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async (notification) => {
        notifyListeners(
          toolListChangedSubsRef.current,
          notification.params,
          "tools list_changed listener threw",
        );
        refreshTools("tools list_changed").catch((err) => {
          log.warn({ err }, "tools list refresh failed");
        });
      },
    );

    nextClient.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async (notification) => {
        notifyListeners(
          resourceListChangedSubsRef.current,
          notification.params,
          "resources list_changed listener threw",
        );
        refreshResources("resources list_changed").catch((err) => {
          log.warn({ err }, "resources list refresh failed");
        });
      },
    );

    nextClient.setNotificationHandler(
      PromptListChangedNotificationSchema,
      async (notification) => {
        notifyListeners(
          promptListChangedSubsRef.current,
          notification.params,
          "prompts list_changed listener threw",
        );
        refreshPrompts("prompts list_changed").catch((err) => {
          log.warn({ err }, "prompts list refresh failed");
        });
      },
    );

    // `notifications/resources/updated` fan-out. The MCP SDK keeps one
    // handler per method; if a `HostAppRenderer` were to register on the
    // client directly, a subsequently-mounted one would overwrite it and
    // the first widget would stop receiving updates. We register one
    // provider-level handler and multiplex to any listeners registered
    // via `onResourceUpdated()`. Listeners are expected to filter by URI
    // against their own `resources/subscribe` calls — the server may
    // broadcast updates for URIs we never subscribed to (behavior is
    // server-defined; filter defensively).
    nextClient.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      async (notification) => {
        notifyListeners(
          resourceUpdatedSubsRef.current,
          notification.params,
          "resource-updated listener threw",
        );
      },
    );

    // Spec §"Standard MCP Messages" — `notifications/message`: the server
    // may push log entries to the host. Mirror them into our childLog so
    // dev overlays surface them, preserving the server-declared level.
    nextClient.setNotificationHandler(
      LoggingMessageNotificationSchema,
      async (notification) => {
        const params = notification.params ?? {};
        const level = (params.level ?? "info") as
          | "debug"
          | "info"
          | "notice"
          | "warning"
          | "error"
          | "critical"
          | "alert"
          | "emergency";
        const mapped: "debug" | "info" | "warn" | "error" =
          level === "debug"
            ? "debug"
            : level === "info" || level === "notice"
              ? "info"
              : level === "warning"
                ? "warn"
                : "error";
        log[mapped]({ from: params.logger, data: params.data }, "server-log");
      },
    );

    log.debug({ url: endpoint }, "connecting");

    span(log, "connect+list", { url: endpoint }, async () => {
      try {
        await nextClient.connect(transport);
        if (disposed) {
          await nextClient.close().catch(() => {});
          return;
        }
        clientRef.current = nextClient;

        // Spec §"Client-Server Negotiation": the server SHOULD echo an
        // `extensions["io.modelcontextprotocol/ui"]` entry in its
        // InitializeResult if it intends to serve UI resources. We don't
        // hard-fail if it's missing — some servers ship ui:// resources
        // without the capability echo — but we log so mismatches are
        // visible in dev.
        const serverCaps = nextClient.getServerCapabilities() as
          | (Record<string, unknown> & {
              extensions?: Record<string, unknown>;
              prompts?: Record<string, unknown>;
              completions?: Record<string, unknown>;
            })
          | undefined;
        const serverUiExt = serverCaps?.extensions?.[UI_EXTENSION_NAME];
        if (!serverUiExt) {
          log.warn(
            { url: endpoint, serverCaps },
            `server did not advertise ${UI_EXTENSION_NAME}; MCP Apps may still render if resources exist, but capability negotiation is one-sided`,
          );
        } else {
          log.debug(
            { url: endpoint, serverUiExt },
            "server advertises MCP Apps extension",
          );
        }

        // Base MCP: `prompts/list` throws on servers that don't advertise
        // the `prompts` capability (SDK asserts capability before sending).
        // We gate the call rather than try/catch so we don't spam logs when
        // prompts are simply unsupported. `completions` is a presence flag
        // we pass through for consumers that render `completion/complete`-
        // backed argument pickers.
        hasPromptsCap = serverCaps?.prompts != null;
        const hasCompletionsCap = serverCaps?.completions != null;
        const initialToolSeq = ++toolRefreshSeq;
        const initialResourceSeq = ++resourceRefreshSeq;
        const initialPromptSeq = ++promptRefreshSeq;

        const [tools, resources, promptsResult] = await Promise.all([
          listAllTools(nextClient).catch((err) => {
            log.warn({ err }, "listTools failed; treating as empty");
            return [] as Tool[];
          }),
          listAllResources(nextClient).catch((err) => {
            log.warn({ err }, "listResources failed; treating as empty");
            return [] as ResourceListItem[];
          }),
          hasPromptsCap
            ? listAllPrompts(nextClient).catch((err) => {
                log.warn({ err }, "listPrompts failed; treating as empty");
                return [] as Prompt[];
              })
            : Promise.resolve([] as Prompt[]),
        ]);

        if (disposed) return;
        const toolMap = buildToolUIMap(tools);
        const uiList = pickUIResources(resources);
        setClient(nextClient);
        if (initialToolSeq === toolRefreshSeq) {
          setToolUIs(toolMap);
        }
        if (initialResourceSeq === resourceRefreshSeq) {
          setUIResources(uiList);
        }
        if (initialPromptSeq === promptRefreshSeq) {
          setPrompts(promptsResult as Prompt[]);
        }
        setSupportsCompletions(hasCompletionsCap);
        setStatus("ready");
        log.info(
          {
            toolCount: tools.length,
            uiToolCount: toolMap.size,
            resourceCount: resources.length,
            uiResourceCount: uiList.length,
            promptCount: promptsResult.length,
            supportsCompletions: hasCompletionsCap,
          },
          "MCP client ready",
        );
      } catch (err) {
        if (disposed) return;
        if (clientRef.current === nextClient) {
          clientRef.current = null;
        }
        await nextClient
          .close()
          .catch((closeErr) =>
            log.debug({ err: closeErr }, "client close after init failure"),
          );
        // Handled path: we fall back to ToolFallback rendering and the
        // chat continues without MCP Apps support. Warn (not error) so
        // Next.js's dev overlay doesn't treat it as a fatal popup.
        log.warn(
          { err, url: endpoint },
          "MCP client init failed — MCP Apps disabled for this session",
        );
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      }
    }).catch(() => {
      // span() already logged the failure; swallow so React's effect body
      // doesn't see an unhandled rejection.
    });

    return () => {
      disposed = true;
      const c = clientRef.current;
      clientRef.current = null;
      setClient(null);
      setToolUIs(new Map());
      setUIResources([]);
      setPrompts([]);
      setSupportsCompletions(false);
      // Drop fan-out listeners; stale callbacks from unmounted iframes
      // would otherwise hold references to torn-down bridges.
      resourceUpdatedSubsRef.current.clear();
      toolListChangedSubsRef.current.clear();
      resourceListChangedSubsRef.current.clear();
      promptListChangedSubsRef.current.clear();
      if (c) {
        log.debug({ url: endpoint }, "closing MCP client");
        c.close().catch((err) => log.warn({ err }, "client close failed"));
      }
    };
  }, [url]);

  const value = useMemo<McpClientContextValue>(
    () => ({
      client,
      status,
      error,
      toolUIs,
      uiResources,
      prompts,
      supportsCompletions,
      onResourceUpdated,
      onToolListChanged,
      onResourceListChanged,
      onPromptListChanged,
    }),
    [
      client,
      status,
      error,
      toolUIs,
      uiResources,
      prompts,
      supportsCompletions,
      onResourceUpdated,
      onToolListChanged,
      onResourceListChanged,
      onPromptListChanged,
    ],
  );

  return (
    <McpClientContext.Provider value={value}>
      {children}
    </McpClientContext.Provider>
  );
}

/** Root context accessor. Throws if used outside the provider. */
export function useMcpClient(): McpClientContextValue {
  const ctx = useContext(McpClientContext);
  if (!ctx) {
    throw new Error("useMcpClient must be used within <McpClientProvider>");
  }
  return ctx;
}

/** Lookup `_meta.ui.resourceUri` for a tool. `undefined` if none. */
export function useToolUIResource(toolName: string): ToolUIInfo | undefined {
  const { toolUIs } = useMcpClient();
  return toolUIs.get(toolName);
}

/** Standalone UI resources (from `resources/list`, not tied to tools). */
export function useUIResources(): readonly UIResourceInfo[] {
  const { uiResources } = useMcpClient();
  return uiResources;
}

/** MCP prompts from `prompts/list`. Empty until the client is ready. */
export function useMcpPrompts(): readonly Prompt[] {
  const { prompts } = useMcpClient();
  return prompts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildToolUIMap(tools: readonly Tool[]): Map<string, ToolUIInfo> {
  const map = new Map<string, ToolUIInfo>();
  for (const tool of tools) {
    const resourceUri = getToolUiResourceUri(tool);
    if (!resourceUri) continue;
    map.set(tool.name, {
      toolName: tool.name,
      resourceUri,
      tool,
      appOnly: isToolVisibilityAppOnly(tool),
      modelOnly: isToolVisibilityModelOnly(tool),
    });
  }
  return map;
}

function pickUIResources(
  resources: readonly ResourceListItem[],
): UIResourceInfo[] {
  const out: UIResourceInfo[] = [];
  for (const r of resources) {
    if (!r.uri.startsWith("ui://")) continue;
    if (r.mimeType && r.mimeType !== RESOURCE_MIME_TYPE) continue;
    out.push({
      uri: r.uri,
      name: r.name ?? r.uri,
      title: r.title,
      description: r.description,
    });
  }
  return out;
}

function notifyListeners<T>(
  listeners: ReadonlySet<(params: T) => void>,
  params: T,
  failureMessage: string,
): void {
  for (const cb of listeners) {
    try {
      cb(params);
    } catch (err) {
      log.warn({ err }, failureMessage);
    }
  }
}
