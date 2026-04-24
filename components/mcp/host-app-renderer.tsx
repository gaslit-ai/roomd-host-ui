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
 * `tools/call` / `resources/*` / `prompts/list` auto-forwarding (via
 * `AppBridge.connect`), and renders the iframe via `AppFrame`.
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
// AppBridge is imported directly from ext-apps rather than from @mcp-ui/client
// because @mcp-ui/client@7.0.0's CJS bundle (dist/index.js) was built against a
// pre-1.4.0 ext-apps and omits `addEventListener` on its AppBridge class; the
// ESM bundle has it but module resolution can pick the CJS path, producing
// runtime `b.addEventListener is not a function`. ext-apps 1.6.0 is the source
// of truth for AppBridge; @mcp-ui/client only retains value here as the
// provider of AppFrame + types.
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
	CallToolResult,
	EmptyResult,
	Implementation,
	JSONRPCRequest,
	LoggingMessageNotification,
	ResourceUpdatedNotification,
} from "@modelcontextprotocol/sdk/types.js";
import {
	ErrorCode,
	McpError,
	ResultSchema,
	SubscribeRequestSchema,
	UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTaskRegistry } from "@/components/mcp/tasks/context";

import {
	readResourceHtml,
	resolveToolResourceUri,
} from "@/lib/mcp/resource-loader";
import { useContainerDimensions } from "@/lib/mcp/use-container-dimensions";

type RequestHandlerExtra = {
	signal: AbortSignal;
	sessionId?: string;
};

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
}

const DEFAULT_HOST_INFO: Implementation = {
	name: "audiostudio-host",
	version: "1.0.0",
};

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
	} = props;

	const [bridge, setBridge] = useState<AppBridge | null>(null);
	const [html, setHtml] = useState<string | null>(htmlProp ?? null);
	const taskRegistry = useTaskRegistry();
	// `viewInitialized` flips true only after the View sends
	// `ui/notifications/initialized`. Until then the transport is attached but
	// the View hasn't completed its handshake, so host→view notifications like
	// `tool-input-partial` would throw "Not connected" (during streaming, when
	// `bridge.connect()` may not have run yet) or arrive before the View has
	// handlers installed. Gating sends on this flag naturally queues the
	// latest value — when init completes, the effect re-runs and sends it.
	const [viewInitialized, setViewInitialized] = useState(false);

	// Latest-ref pattern: handler + config changes don't tear down the bridge.
	// `hostCapabilities` is captured at bridge creation (spec's `ui/initialize`
	// response is immutable post-handshake); `hostContext` updates propagate
	// via `setHostContext()` in a separate effect.
	const onMessageRef = useRef(onMessage);
	const onOpenLinkRef = useRef(onOpenLink);
	const onDownloadFileRef = useRef(onDownloadFile);
	const onUpdateModelContextRef = useRef(onUpdateModelContext);
	const onRequestDisplayModeRef = useRef(onRequestDisplayMode);
	const onRequestTeardownRef = useRef(onRequestTeardown);
	const onLoggingMessageRef = useRef(onLoggingMessage);
	const onAppCapabilitiesRef = useRef(onAppCapabilities);
	const onFallbackRequestRef = useRef(onFallbackRequest);
	const onErrorRef = useRef(onError);
	const hostCapabilitiesRef = useRef(hostCapabilities);
	const hostContextRef = useRef(hostContext);
	useEffect(() => {
		onMessageRef.current = onMessage;
		onOpenLinkRef.current = onOpenLink;
		onDownloadFileRef.current = onDownloadFile;
		onUpdateModelContextRef.current = onUpdateModelContext;
		onRequestDisplayModeRef.current = onRequestDisplayMode;
		onRequestTeardownRef.current = onRequestTeardown;
		onLoggingMessageRef.current = onLoggingMessage;
		onAppCapabilitiesRef.current = onAppCapabilities;
		onFallbackRequestRef.current = onFallbackRequest;
		onErrorRef.current = onError;
		hostCapabilitiesRef.current = hostCapabilities;
		hostContextRef.current = hostContext;
	});

	// --- Bridge lifecycle ----------------------------------------------------
	useEffect(() => {
		setViewInitialized(false);
		const initialCaps = hostCapabilitiesRef.current;
		const initialCtx = hostContextRef.current;
		const b = new AppBridge(
			client,
			hostInfo ?? DEFAULT_HOST_INFO,
			initialCaps,
			initialCtx ? { hostContext: initialCtx } : undefined,
		);

		// Request/notification handlers. AppBridge.connect() auto-wires the
		// methods it owns (oncalltool, onlistresources, onlistresourcetemplates,
		// onreadresource, onlistprompts, and the list_changed relays); we set
		// the remaining ones here.
		b.onmessage = async (params, extra) => {
			const cb = onMessageRef.current;
			if (!cb)
				throw new McpError(
					ErrorCode.MethodNotFound,
					"ui/message not supported",
				);
			return cb(params, extra);
		};
		b.onopenlink = async (params, extra) => {
			const cb = onOpenLinkRef.current;
			if (!cb)
				throw new McpError(
					ErrorCode.MethodNotFound,
					"ui/open-link not supported",
				);
			return cb(params, extra);
		};
		b.ondownloadfile = async (params, extra) => {
			const cb = onDownloadFileRef.current;
			if (!cb)
				throw new McpError(
					ErrorCode.MethodNotFound,
					"ui/download-file not supported",
				);
			return cb(params, extra);
		};
		b.onupdatemodelcontext = async (params, extra) => {
			const cb = onUpdateModelContextRef.current;
			if (!cb)
				throw new McpError(
					ErrorCode.MethodNotFound,
					"ui/update-model-context not supported",
				);
			return cb(params, extra);
		};
		b.onrequestdisplaymode = async (params, extra) => {
			const cb = onRequestDisplayModeRef.current;
			if (!cb)
				throw new McpError(
					ErrorCode.MethodNotFound,
					"ui/request-display-mode not supported",
				);
			return cb(params, extra);
		};
		b.onloggingmessage = (params) => {
			onLoggingMessageRef.current?.(params);
		};

		// `resources/subscribe` and `resources/unsubscribe` — SEP-1865 lists
		// `resources/read` as the only resource method views are guaranteed to
		// call, but the base MCP spec subscribe/unsubscribe methods are how
		// views track mutable resources like `<scheme>://sessions/.../state`
		// that the server updates via `notifications/resources/updated`.
		// `AppBridge.connect()` auto-wires `onlistresources`, `onreadresource`,
		// and `onlistresourcetemplates` but NOT subscribe/unsubscribe, so we
		// register them explicitly.
		//
		// We register unconditionally rather than gating on
		// `client.getServerCapabilities()?.resources?.subscribe`: roomd-style
		// pass-through servers may strip capability bits while still forwarding
		// the underlying request, so the capability flag is an unreliable
		// signal. If the upstream server genuinely lacks subscribe support,
		// `client.request()` will reject with the server's error and we
		// propagate that to the view — same outcome as falling through to
		// `fallbackRequestHandler`, but via the correct error path.
		//
		// Use `ResultSchema` (loose) rather than `EmptyResultSchema` (strict)
		// when validating the upstream response. SEP-1865 + base MCP say
		// `resources/subscribe` returns an empty result, but some servers
		// (observed in roomd pass-through) return `{ ok: true }` or other
		// extra keys. A strict validator throws `Unrecognized key: 'ok'`,
		// which surfaces on the view as a -32603 and aborts the subscription.
		// `ResultSchema` (`z.looseObject`) tolerates extra keys while still
		// requiring a valid JSON-RPC result envelope. We discard the body
		// anyway — subscribe is effectively fire-and-await-ack.
		const subscribedUris = new Set<string>();
		b.setRequestHandler(SubscribeRequestSchema, async (req, extra) => {
			await client.request(
				{ method: "resources/subscribe", params: req.params },
				ResultSchema,
				{ signal: extra.signal },
			);
			subscribedUris.add(req.params.uri);
			return {};
		});
		b.setRequestHandler(UnsubscribeRequestSchema, async (req, extra) => {
			await client.request(
				{ method: "resources/unsubscribe", params: req.params },
				ResultSchema,
				{ signal: extra.signal },
			);
			subscribedUris.delete(req.params.uri);
			return {};
		});

		// Register the provider-side fan-out listener BEFORE the bridge
		// connects, so updates that arrive between subscribe-ack and first
		// notification can't race past us. Filter on URIs the view
		// specifically asked for — the provider broadcasts every update it
		// sees, and other widgets on this client may subscribe to disjoint
		// URIs.
		//
		// The cast on `notification()` is deliberate: AppBridge types the
		// argument as a union of the notifications it knows about (tool-input,
		// host-context-changed, list_changed relays, etc.) which omits base
		// MCP notifications like `resources/updated`. The underlying
		// Protocol class accepts any JSON-RPC notification — this is a
		// type-level restriction, not a runtime one. SEP-1865 §"Standard
		// MCP Messages" explicitly allows base MCP notifications to flow
		// through the host↔view bridge.
		type BridgeNotification = Parameters<typeof b.notification>[0];
		const unsubscribeFanOut = onResourceUpdated?.((params) => {
			if (!subscribedUris.has(params.uri)) return;
			b.notification({
				method: "notifications/resources/updated",
				params,
			} as unknown as BridgeNotification).catch((err) => {
				const e = err instanceof Error ? err : new Error(String(err));
				onErrorRef.current?.(e);
			});
		});

		// Note on `tools/list` from view → host: deliberately NOT wired.
		// SEP-1865 §"Standard MCP Messages" specs only `tools/call` on the
		// view side; tool catalog reaches the view via host-pushed
		// `notifications/tools/list_changed` (see `sendToolListChanged`
		// on the imperative handle). A view calling `tools/list` falls
		// through to `fallbackRequestHandler` → `MethodNotFound`, which
		// matches ext-apps 1.6.0's default behavior.

		// `ui/notifications/request-teardown` — spec: "host decides whether to
		// proceed." We surface the notification to the caller; if they don't
		// supply a handler, we silently accept (no-op).
		const onRequestTeardownEvt = (
			params: McpUiRequestTeardownNotification["params"],
		) => onRequestTeardownRef.current?.(params);
		b.addEventListener("requestteardown", onRequestTeardownEvt);

		// `ui/notifications/initialized` — spec §"Lifecycle" fires once after
		// the View's `ui/initialize` handshake completes. At this point
		// `bridge.getAppCapabilities()` returns the View's declared capabilities
		// (including `availableDisplayModes`), which chrome uses to gate
		// mode-switch affordances.
		//
		// Use addEventListener (not the `oninitialized` setter) so we compose
		// with @mcp-ui/client's AppFrame, which assigns its own `oninitialized`
		// slot during its mount effect. Setter-assignment replaces (last wins);
		// our callback would silently clobber AppFrame's init-ready bookkeeping
		// and break downstream handlers, including `resources/subscribe`
		// dispatch, because the bridge would never transition to ready.
		const onInitializedEvt = () => {
			setViewInitialized(true);
			onAppCapabilitiesRef.current?.(b.getAppCapabilities());

			// Task-aware `oncalltool` override. SEP-1865 §App class asserts tasks
			// are not supported on the VIEW side (app-bridge.js: `assertTaskCapability
			// — "Tasks are not supported in MCP Apps"`), so Views send plain
			// `tools/call` requests regardless of whether the upstream tool is
			// task-required. The host bridge is responsible for upgrading the
			// call when the tool advertises `taskSupport !== "forbidden"`.
			//
			// Why wire here (not before connect): `AppBridge.connect()` auto-sets
			// `oncalltool` when constructed with a non-null client. Its setter
			// runs AFTER our effect body (connect fires from an AppFrame child
			// effect). The `initialized` event fires post-connect, so reassigning
			// oncalltool here wins. Radix-style `warnIfRequestHandlerReplaced`
			// logs once per mount — documented behavior, not a bug.
			//
			// Views do NOT receive `notifications/tasks/status` (same spec
			// constraint); the host's task tray is the only progress UI.
			if (taskRegistry) {
				b.oncalltool = async (params, extra) => {
					const handle = taskRegistry.call(
						params.name,
						params.arguments ?? {},
						{ signal: extra?.signal, mode: "auto" },
					);
					return handle.waitForResult();
				};
			}
		};
		b.addEventListener("initialized", onInitializedEvt);

		b.fallbackRequestHandler = (async (req: JSONRPCRequest, extra) => {
			const cb = onFallbackRequestRef.current;
			if (cb) return cb(req, extra);
			throw new McpError(
				ErrorCode.MethodNotFound,
				`No handler for method: ${req.method}`,
			);
		}) as typeof b.fallbackRequestHandler;

		setBridge(b);

		return () => {
			b.removeEventListener("requestteardown", onRequestTeardownEvt);
			b.removeEventListener("initialized", onInitializedEvt);
			unsubscribeFanOut?.();
			// Release any still-subscribed URIs upstream so the server doesn't
			// keep a dangling subscription for this client. Fire-and-forget:
			// failures are terminal (bridge torn down) and safe to swallow.
			for (const uri of subscribedUris) {
				client
					.request(
						{ method: "resources/unsubscribe", params: { uri } },
						ResultSchema,
					)
					.catch(() => {});
			}
			subscribedUris.clear();
			// Close the underlying transport; errors here are terminal-only and safe to swallow.
			b.close().catch(() => {});
		};
	}, [client, hostInfo, onResourceUpdated, taskRegistry]);

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
		if (!bridge || !effectiveHostContext) return;
		// `AppBridge.setHostContext` diffs against the previous value and
		// only emits `ui/notifications/host-context-changed` when fields
		// actually change, so handing it a new object identity each render
		// is cheap — no redundant notifications hit the view.
		bridge.setHostContext(effectiveHostContext);
	}, [bridge, effectiveHostContext]);

	// --- Streaming / lifecycle side-effects ---------------------------------
	// Host→View notifications must wait until the View has sent
	// `ui/notifications/initialized` — before that, `bridge.notification()`
	// throws "Not connected" (transport attached in a later effect pass by
	// AppFrame) or, worse, fires before the View has registered handlers.
	// The `viewInitialized` gate defers sends; when the flag flips, React
	// re-runs these effects and the latest value is dispatched automatically.
	useEffect(() => {
		if (!bridge || !viewInitialized || !toolInputPartial) return;
		bridge.sendToolInputPartial(toolInputPartial);
	}, [bridge, viewInitialized, toolInputPartial]);

	useEffect(() => {
		if (!bridge || !viewInitialized || !toolCancelled) return;
		bridge.sendToolCancelled({});
	}, [bridge, viewInitialized, toolCancelled]);

	// --- Imperative handle ---------------------------------------------------
	useImperativeHandle(
		ref,
		() => ({
			sendToolListChanged: () => bridge?.sendToolListChanged(),
			sendResourceListChanged: () => bridge?.sendResourceListChanged(),
			sendPromptListChanged: () => bridge?.sendPromptListChanged(),
			// SEP-1865 §Cleanup: "Host SHOULD wait for a response before
			// tearing down the resource (to prevent data loss)." We await
			// the view's response and surface failures via `onError` rather
			// than dropping them; callers that don't care can ignore the
			// returned promise.
			teardownResource: () => {
				bridge?.teardownResource({}).catch((err) => {
					const e = err instanceof Error ? err : new Error(String(err));
					onErrorRef.current?.(e);
				});
			},
		}),
		[bridge],
	);

	if (!bridge || html === null) return null;

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
				appBridge={bridge}
				toolInput={toolInput}
				toolResult={toolResult}
				onSizeChanged={onSizeChanged}
				onInitialized={onInitialized}
				onError={onError}
			/>
		</div>
	);
});
