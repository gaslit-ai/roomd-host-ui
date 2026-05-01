"use client";

/**
 * Host-side renderer for MCP Apps (SEP-1865). Drop-in replacement for
 * `@mcp-ui/client`'s `AppRenderer` that composes `AppBridge` + `AppFrame`
 * directly so the host can:
 *
 *  1. Advertise accurate {@link McpUiHostCapabilities} in the `ui/initialize`
 *     response (the upstream `AppRenderer` hardcodes only
 *     `{ openLinks, serverTools, serverResources }`).
 *  2. Handle every spec request with a typed setter — `ondownloadfile`,
 *     `onupdatemodelcontext`, `onrequestteardown`, `onrequestdisplaymode`
 *     — rather than routing them through the untyped
 *     `fallbackRequestHandler`.
 *  3. Populate `hostContext.toolInfo` so views can read the triggering
 *     tool's `{ id, tool }` directly (spec §"HostContext").
 *
 * All other behavior mirrors `AppRenderer`: it discovers the UI resource URI
 * (via tool `_meta.ui.resourceUri` if not provided), fetches its HTML, wires
 * `tools/call` / `tools/list` / `resources/*` / `prompts/list` forwarding
 * explicitly, and renders the iframe via `AppFrame`.
 *
 * Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import { AppFrame, type AppInfo, type SandboxConfig } from "@mcp-ui/client";
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
  McpUiSizeChangedNotification,
  McpUiToolInputPartialNotification,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult,
  EmptyResult,
  Implementation,
  JSONRPCRequest,
  LoggingMessageNotification,
  PromptListChangedNotification,
  ResourceListChangedNotification,
  ResourceUpdatedNotification,
  ToolListChangedNotification,
} from "@modelcontextprotocol/sdk/types.js";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createMcpAppHostController,
  type McpAppHostController,
  type McpAppHostRequestHandlerExtra,
} from "@/lib/mcp/apps/host-controller";
import {
  readResourceHtml,
  resolveToolResourceUri,
} from "@/lib/mcp/resource-loader";
import { useContainerDimensions } from "@/lib/mcp/use-container-dimensions";

type RequestHandlerExtra = McpAppHostRequestHandlerExtra;

export interface HostAppRendererHandle {
  /** Forward a `tools/list_changed` notification to the view. */
  sendToolListChanged(): void;
  /** Forward a `resources/list_changed` notification to the view. */
  sendResourceListChanged(): void;
  /** Forward a `prompts/list_changed` notification to the view. */
  sendPromptListChanged(): void;
  /** Initiate `ui/resource-teardown` (spec §"Cleanup"). */
  teardownResource(): void;
}

export interface HostAppRendererProps {
  client: Client;
  toolName: string;
  /** Pre-resolved resource URI. If omitted, we look up the tool's `_meta.ui.resourceUri`. */
  toolResourceUri?: string;
  /** Pre-fetched HTML; skips the resource read when provided. */
  html?: string;
  sandbox: SandboxConfig;

  hostInfo?: Implementation;
  hostCapabilities: McpUiHostCapabilities;
  hostContext?: McpUiHostContext;

  toolInput?: Record<string, unknown>;
  toolInputPartial?: McpUiToolInputPartialNotification["params"];
  toolResult?: CallToolResult;
  toolCancelled?: boolean;

  onMessage?: (
    params: McpUiMessageRequest["params"],
    extra: RequestHandlerExtra,
  ) => Promise<McpUiMessageResult>;
  onOpenLink?: (
    params: McpUiOpenLinkRequest["params"],
    extra: RequestHandlerExtra,
  ) => Promise<McpUiOpenLinkResult>;
  onDownloadFile?: (
    params: McpUiDownloadFileRequest["params"],
    extra: RequestHandlerExtra,
  ) => Promise<McpUiDownloadFileResult>;
  onUpdateModelContext?: (
    params: McpUiUpdateModelContextRequest["params"],
    extra: RequestHandlerExtra,
  ) => Promise<EmptyResult>;
  onRequestDisplayMode?: (
    params: McpUiRequestDisplayModeRequest["params"],
    extra: RequestHandlerExtra,
  ) => Promise<McpUiRequestDisplayModeResult>;
  onRequestTeardown?: (
    params: McpUiRequestTeardownNotification["params"],
  ) => void;
  onLoggingMessage?: (params: LoggingMessageNotification["params"]) => void;
  onSizeChanged?: (params: McpUiSizeChangedNotification["params"]) => void;
  onInitialized?: (info: AppInfo) => void;
  /**
   * Fires once after the View completes the `ui/initialize` handshake, with
   * the capabilities declared in its `ui/initialize` request params. Host
   * chrome uses this to gate mode-switch UI to modes the View declared in
   * `availableDisplayModes` (SEP-1865 §"Display Modes": "Host MUST NOT
   * switch the View to a display mode that does not appear in its
   * `appCapabilities.availableDisplayModes`, if set").
   */
  onAppCapabilities?: (capabilities: McpUiAppCapabilities | undefined) => void;
  onFallbackRequest?: (
    request: JSONRPCRequest,
    extra: RequestHandlerExtra,
  ) => Promise<unknown>;
  onError?: (err: Error) => void;
  /**
   * Subscribe to `notifications/resources/updated` from the MCP server
   * and forward to the mounted iframe. Typically `McpClientProvider.onResourceUpdated`.
   *
   * When provided, HostAppRenderer also wires `resources/subscribe` and
   * `resources/unsubscribe` handlers on the bridge — those requests from
   * the view are forwarded to the upstream MCP client, and only matching
   * URIs are relayed back to the view.
   *
   * If omitted, subscribe/unsubscribe fall through to `onFallbackRequest`
   * (and, absent one, `MethodNotFound`), matching pre-wired behavior.
   */
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

export const HostAppRenderer = forwardRef<
  HostAppRendererHandle,
  HostAppRendererProps
>(function HostAppRenderer(props, ref) {
  const {
    client,
    toolName,
    toolResourceUri,
    html: htmlProp,
    sandbox,
    hostInfo,
    hostCapabilities,
    hostContext,
    toolInput,
    toolInputPartial,
    toolResult,
    toolCancelled,
    onMessage,
    onOpenLink,
    onDownloadFile,
    onUpdateModelContext,
    onRequestDisplayMode,
    onRequestTeardown,
    onLoggingMessage,
    onSizeChanged,
    onInitialized,
    onAppCapabilities,
    onFallbackRequest,
    onError,
    onResourceUpdated,
    onToolListChanged,
    onResourceListChanged,
    onPromptListChanged,
  } = props;

  const [controller, setController] = useState<McpAppHostController | null>(
    null,
  );
  const controllerRef = useRef<McpAppHostController | null>(null);
  const [html, setHtml] = useState<string | null>(htmlProp ?? null);
  const latestControllerInputsRef = useRef({
    hostCapabilities,
    hostContext,
    handlers: {
      onMessage,
      onOpenLink,
      onDownloadFile,
      onUpdateModelContext,
      onRequestDisplayMode,
      onRequestTeardown,
      onLoggingMessage,
      onAppCapabilities,
      onFallbackRequest,
      onError,
    },
  });
  const onErrorRef = useRef(onError);
  useEffect(() => {
    latestControllerInputsRef.current = {
      hostCapabilities,
      hostContext,
      handlers: {
        onMessage,
        onOpenLink,
        onDownloadFile,
        onUpdateModelContext,
        onRequestDisplayMode,
        onRequestTeardown,
        onLoggingMessage,
        onAppCapabilities,
        onFallbackRequest,
        onError,
      },
    };
    onErrorRef.current = onError;
  });

  // --- Controller lifecycle ------------------------------------------------
  useEffect(() => {
    const initial = latestControllerInputsRef.current;
    const next = createMcpAppHostController({
      client,
      hostInfo,
      hostCapabilities: initial.hostCapabilities,
      hostContext: initial.hostContext,
      ...initial.handlers,
      onResourceUpdated,
      onToolListChanged,
      onResourceListChanged,
      onPromptListChanged,
    });
    controllerRef.current = next;
    setController(next);

    return () => {
      next.dispose();
      if (controllerRef.current === next) {
        controllerRef.current = null;
      }
    };
  }, [
    client,
    hostInfo,
    onResourceUpdated,
    onToolListChanged,
    onResourceListChanged,
    onPromptListChanged,
  ]);

  useEffect(() => {
    controller?.updateHandlers({
      onMessage,
      onOpenLink,
      onDownloadFile,
      onUpdateModelContext,
      onRequestDisplayMode,
      onRequestTeardown,
      onLoggingMessage,
      onAppCapabilities,
      onFallbackRequest,
      onError,
    });
  }, [
    controller,
    onMessage,
    onOpenLink,
    onDownloadFile,
    onUpdateModelContext,
    onRequestDisplayMode,
    onRequestTeardown,
    onLoggingMessage,
    onAppCapabilities,
    onFallbackRequest,
    onError,
  ]);

  // --- Resource fetch ------------------------------------------------------
  useEffect(() => {
    if (htmlProp !== undefined) {
      setHtml(htmlProp);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const uri =
          toolResourceUri ?? (await resolveToolResourceUri(client, toolName));
        const resolved = await readResourceHtml(client, uri);
        if (!cancelled) setHtml(resolved);
      } catch (err) {
        if (cancelled) return;
        const e = err instanceof Error ? err : new Error(String(err));
        onErrorRef.current?.(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, toolName, toolResourceUri, htmlProp]);

  // --- Host context updates ------------------------------------------------
  //
  // SEP-1865 §"Container Dimensions": the host communicates the space it
  // gives the View via `hostContext.containerDimensions`. That value is
  // layout-specific and not something the caller of HostAppRenderer can
  // know, so we measure our own wrapper element (`frameContainerRef`)
  // below and merge the result into whatever host context was passed in.
  // If the caller explicitly set `containerDimensions`, ours wins — only
  // this component knows the actual iframe container's size.
  const frameContainerRef = useRef<HTMLDivElement>(null);
  const containerDimensions = useContainerDimensions(frameContainerRef);
  const effectiveHostContext = useMemo<McpUiHostContext | undefined>(() => {
    if (!hostContext && !containerDimensions) return undefined;
    return {
      ...hostContext,
      ...(containerDimensions ? { containerDimensions } : {}),
    };
  }, [hostContext, containerDimensions]);
  useEffect(() => {
    controller?.setHostContext(effectiveHostContext);
  }, [controller, effectiveHostContext]);

  // --- Streaming / lifecycle side-effects ---------------------------------
  useEffect(() => {
    controller?.sendToolInputPartial(toolInputPartial);
  }, [controller, toolInputPartial]);

  useEffect(() => {
    controller?.sendToolCancelled(toolCancelled ? {} : undefined);
  }, [controller, toolCancelled]);

  // --- Imperative handle ---------------------------------------------------
  useImperativeHandle(
    ref,
    () => ({
      sendToolListChanged: () => controllerRef.current?.sendToolListChanged(),
      sendResourceListChanged: () =>
        controllerRef.current?.sendResourceListChanged(),
      sendPromptListChanged: () =>
        controllerRef.current?.sendPromptListChanged(),
      teardownResource: () => {
        controllerRef.current?.teardownResource();
      },
    }),
    [],
  );

  if (!controller || html === null) return null;

  // The wrapping div exists purely so we own a DOM node to observe for
  // `containerDimensions` (see `frameContainerRef` above). AppFrame
  // already renders its own layout div internally; ours is layout-neutral
  // (`display: contents`-equivalent via `width/height: 100%`) so it
  // doesn't change the visual layout the caller's parent imposes.
  return (
    <div
      ref={frameContainerRef}
      style={{ width: "100%", height: "100%", display: "flex" }}
    >
      <AppFrame
        html={html}
        sandbox={sandbox}
        appBridge={controller.bridge}
        toolInput={toolInput}
        toolResult={toolResult}
        onSizeChanged={onSizeChanged}
        onInitialized={onInitialized}
        onError={onError}
      />
    </div>
  );
});
