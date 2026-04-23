"use client";

/**
 * `tools.Fallback` for the message-parts registry. If a tool-call has a
 * `ui://` resource attached (per `_meta.ui.resourceUri`), render its MCP App
 * via `<AppRenderer>`. Otherwise fall through to the existing `ToolFallback`.
 *
 * Owns the View→Host request handlers prescribed by SEP-1865. Every spec
 * method is wired through the AppBridge typed setter of the same name
 * inside `HostAppRenderer` (onmessage, onopenlink, ondownloadfile,
 * onupdatemodelcontext, onrequestdisplaymode, onrequestteardown,
 * onloggingmessage) — this file supplies the callback body:
 *   ui/message                — append into thread via useAui().thread().append
 *   ui/open-link              — confirmAndOpenLink()
 *   ui/download-file          — performDownload()
 *   ui/update-model-context   — modelContextStoreRef + aui.modelContext().register
 *   ui/request-display-mode   — setDisplayMode on McpHostContextProvider
 *   notifications/message     — forwarded into childLog("mcp-apps:view")
 *
 * Host-local non-spec extensions, reverse-DNS-namespaced per SEP-1724 and
 * routed through `onFallbackRequest`. See `lib/mcp/host-identity.ts`:
 *   io.audiostudio/clipboard.read   — navigator.clipboard.readText
 *   io.audiostudio/clipboard.write  — navigator.clipboard.writeText
 *
 * Not handled from iframes (by design, per spec §"Standard MCP Messages"):
 *   sampling/createMessage, elicitation/create — Views MAY NOT send these.
 *
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import type {
	ModelContextProvider,
	ToolCallMessagePartComponent,
	ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useAui } from "@assistant-ui/react";
import type {
	McpUiAppCapabilities,
	McpUiDownloadFileRequest,
	McpUiDownloadFileResult,
	McpUiHostCapabilities,
	McpUiHostContext,
	McpUiMessageRequest,
	McpUiRequestDisplayModeRequest,
	McpUiRequestDisplayModeResult,
	McpUiResourceCsp,
	McpUiResourcePermissions,
	McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
	CallToolResult,
	JSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
	AlertCircleIcon,
	CheckIcon,
	LoaderIcon,
	XCircleIcon,
} from "lucide-react";
import {
	type FC,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { DisplayModeShell } from "@/components/mcp/display-mode-shell";
import {
	HostAppRenderer,
	type HostAppRendererHandle,
} from "@/components/mcp/host-app-renderer";
import {
	useMcpClient,
	useToolUIResource,
} from "@/components/providers/mcp-client-provider";
import { useMcpHostContext } from "@/components/providers/mcp-host-context-provider";
import { childLog } from "@/lib/logger";
import { performDownload } from "@/lib/mcp/download";
import { isUnsafeEvalAllowed } from "@/lib/mcp/flags";
import { HOST_META_KEY, HOST_METHOD } from "@/lib/mcp/host-identity";
import { confirmAndOpenLink } from "@/lib/mcp/link-confirm";
import { modelContextFromParams } from "@/lib/mcp/model-context";
import { parsePartialToolArgs } from "@/lib/mcp/partial-json";
import { useStableJson } from "@/lib/mcp/stable";
import { cn } from "@/lib/utils";

const log = childLog("mcp-apps:part");
const SANDBOX_URL_PATH = "/mcp-sandbox.html";

/**
 * Origin of the configured MCP server. Auto-added to every widget's
 * `cspResources` + `cspConnects` so companion resources from the same
 * instance, which live on the MCP server's own origin) are reachable from sibling widgets
 * — e.g. a threejs scene fetching a just-generated WAV for Web Audio
 * reactivity.
 *
 * The room is the trust boundary here: tools within a room are expected to
 * interoperate (see ROOM_INSTRUCTIONS on the server), so exposing the room's
 * own origin to every widget matches that contract. Widgets are still free
 * to declare their own tighter `_meta.ui.csp` — it merges additively with
 * this default, it doesn't restrict below it.
 */
const MCP_SERVER_ORIGIN = (() => {
	const raw = process.env.NEXT_PUBLIC_MCP_SERVER_URL ?? "";
	try {
		return new URL(raw).origin;
	} catch {
		return undefined;
	}
})();

export const McpAppToolFallback: ToolCallMessagePartComponent = (props) => {
	const {
		toolName,
		toolCallId,
		args,
		argsText,
		result,
		status,
		isError,
		artifact,
	} = props;
	const uiInfo = useToolUIResource(toolName);
	const { client } = useMcpClient();

	// No UI resource on this tool, or client not ready → fall back to the
	// existing JSON collapsible. This is also the MCP-server-offline path
	// since `client` is null while the provider is connecting or errored.
	if (!uiInfo || !client) {
		log.debug(
			{
				toolName,
				toolCallId,
				hasUIResource: Boolean(uiInfo),
				hasClient: Boolean(client),
			},
			"rendering ToolFallback (non-UI tool or client not ready)",
		);
		return <ToolFallback {...props} />;
	}

	log.debug(
		{
			toolName,
			toolCallId,
			resourceUri: uiInfo.resourceUri,
			status: status?.type,
		},
		"rendering AppRenderer",
	);

	return (
		<McpAppPartInner
			client={client}
			toolName={toolName}
			toolCallId={toolCallId}
			args={args}
			argsText={argsText}
			result={result}
			isError={isError}
			artifact={artifact}
			status={status}
			uiInfo={uiInfo}
		/>
	);
};

// ---------------------------------------------------------------------------
// Inner component — only mounted once we have a ready client + UI resource.
// ---------------------------------------------------------------------------

interface InnerProps {
	client: NonNullable<ReturnType<typeof useMcpClient>["client"]>;
	toolName: string;
	toolCallId: string;
	args: unknown;
	argsText: string;
	result: unknown;
	isError: boolean | undefined;
	artifact: unknown;
	status: ToolCallMessagePartProps["status"];
	uiInfo: NonNullable<ReturnType<typeof useToolUIResource>>;
}

const McpAppPartInner: FC<InnerProps> = ({
	client,
	toolName,
	toolCallId,
	args,
	argsText,
	result,
	isError,
	artifact,
	status,
	uiInfo,
}) => {
	const appRef = useRef<HostAppRendererHandle>(null);
	const aui = useAui();
	const { onResourceUpdated } = useMcpClient();
	const { hostContext } = useMcpHostContext();
	const [error, setError] = useState<Error | null>(null);

	// SEP-1865 §"HostContext" — `displayMode` is per-View: each View's
	// `ui/initialize` response carries its own mode. Hosting it in component
	// state keeps concurrent tool calls independent (flipping one widget to
	// PIP no longer flips the rest).
	type ModeValue = NonNullable<McpUiHostContext["displayMode"]>;
	const [displayMode, setDisplayModeState] = useState<ModeValue>("inline");

	// SEP-1865 §"Display Modes": "Host MUST NOT switch the View to a display
	// mode that does not appear in its `appCapabilities.availableDisplayModes`,
	// if set." Track what the View declared (via `ui/initialize`) so the host
	// chrome only offers modes the View actually supports. `null` = not yet
	// initialized; `[]` = View explicitly advertised an empty list (treat as
	// "View is display-mode-naive, only allow inline").
	const [viewAvailableDisplayModes, setViewAvailableDisplayModes] =
		useState<ReadonlyArray<ModeValue> | null>(null);

	// Latest-ref pattern: `setDisplayMode` and `onAppCapabilities` need to
	// read current `displayMode`/`viewAvailableDisplayModes` without including
	// them in useCallback deps (which would churn identity on every mode flip
	// and cause DisplayModeShell / HostAppRenderer to re-render needlessly).
	const displayModeRef = useRef<ModeValue>(displayMode);
	const viewModesRef = useRef<ReadonlyArray<ModeValue> | null>(
		viewAvailableDisplayModes,
	);
	useEffect(() => {
		displayModeRef.current = displayMode;
		viewModesRef.current = viewAvailableDisplayModes;
	});

	// Authoritative display-mode setter — used by both host chrome clicks and
	// the `onrequestdisplaymode` handler from the View. Gates by the
	// intersection of host-supported AND view-declared modes (spec §"Display
	// Modes": "Host MUST NOT switch the View to a display mode that does not
	// appear in its appCapabilities.availableDisplayModes, if set"), and on
	// rejection returns the current mode ("If the requested mode is not
	// available, Host SHOULD return the current display mode in the response").
	// Host chrome pre-filters via `chromeAvailable` so only View-initiated
	// requests ever hit the rejection branch.
	const hostAvailableModes = hostContext.availableDisplayModes ?? ["inline"];
	const setDisplayMode = useCallback(
		(next: ModeValue): ModeValue => {
			const viewModes = viewModesRef.current;
			const allowed = viewModes
				? hostAvailableModes.filter((m) => viewModes.includes(m))
				: hostAvailableModes;
			if (!allowed.includes(next)) {
				log.debug(
					{
						toolCallId,
						requested: next,
						current: displayModeRef.current,
						hostAvailableModes,
						viewModes,
					},
					"display mode rejected — not in host∩view intersection",
				);
				return displayModeRef.current;
			}
			setDisplayModeState(next);
			return next;
		},
		[hostAvailableModes, toolCallId],
	);

	const onAppCapabilities = useCallback(
		(caps: McpUiAppCapabilities | undefined) => {
			const declared = caps?.availableDisplayModes;
			const normalized = Array.isArray(declared)
				? (declared as ReadonlyArray<ModeValue>)
				: null;
			setViewAvailableDisplayModes(normalized);
			log.debug(
				{ toolCallId, declared: normalized },
				"view declared availableDisplayModes",
			);

			// If our "inline" default isn't in the View's declared list, flip
			// to a valid one before the View ever renders in an undeclared mode
			// (spec §"Display Modes"). Prefer inline when available (least
			// surprising), otherwise take the first declared mode.
			if (normalized && !normalized.includes(displayModeRef.current)) {
				const fallback = normalized.includes("inline")
					? "inline"
					: normalized[0];
				if (fallback) {
					log.debug(
						{
							toolCallId,
							from: displayModeRef.current,
							to: fallback,
							declared: normalized,
						},
						"auto-flipping initial display mode into view-declared list",
					);
					setDisplayModeState(fallback);
				}
			}
		},
		[toolCallId],
	);

	// View-scoped model-context store for `ui/update-model-context` (spec:
	// "only the last update received" is forwarded; updates are deferred
	// until the next user message). We register a ModelContextProvider with
	// assistant-ui so the latest payload is merged into the outgoing system
	// prompt on the next `/api/chat` call. See lib/mcp/model-context.ts.
	const modelContextStoreRef = useRef<{
		current: McpUiUpdateModelContextRequest["params"] | null;
		subs: Set<() => void>;
	} | null>(null);
	if (modelContextStoreRef.current === null) {
		modelContextStoreRef.current = { current: null, subs: new Set() };
	}

	useEffect(() => {
		const store = modelContextStoreRef.current;
		if (!store) return;
		const provider: ModelContextProvider = {
			getModelContext: () => {
				const ctx = modelContextFromParams(store.current);
				log.debug(
					{
						toolCallId,
						hasStoredParams: Boolean(store.current),
						returnedSystemLen: ctx.system?.length ?? 0,
					},
					"ModelContextProvider.getModelContext read",
				);
				return ctx;
			},
			subscribe: (cb) => {
				store.subs.add(cb);
				return () => {
					store.subs.delete(cb);
				};
			},
		};
		log.debug({ toolCallId }, "ModelContextProvider registered");
		const unregister = aui.modelContext().register(provider);
		return () => {
			log.debug({ toolCallId }, "ModelContextProvider unregistered");
			unregister();
		};
	}, [aui, toolCallId]);

	// Spec §"Container Dimensions": prefersBorder is read from resource _meta
	// but surfaced to the host by the View in its appCapabilities or the
	// resource itself. AppRenderer handles the border side via its default
	// chrome; we honor tool metadata's prefersBorder if present.
	const prefersBorder = readPrefersBorder(uiInfo.tool);

	// Surface our toolResult to AppRenderer as a CallToolResult
	// (SEP-1865 §"ui/notifications/tool-result").
	//
	// MCP-sourced tools already return spec-compliant `CallToolResult`
	// ({ content, structuredContent?, isError?, _meta? }) — assistant-ui
	// passes that object through verbatim as `result`. Naively re-wrapping it
	// in `{ content: [{ type: "text", text: JSON.stringify(result) }] }` would
	// double-encode, burying the real `content[0].text` one level deeper and
	// breaking any widget that does `JSON.parse(content[0].text)` — which is
	// the text-block contract SEP-1865 MVP endorses (cf. ace-step's
	// player.html).
	//
	// So: pass through when `result` is already a CallToolResult. Only wrap
	// when it's raw structured data (legacy path for tools that don't return
	// MCP-shaped results). When passing through, best-effort populate
	// `structuredContent` by JSON-parsing the first text block, so widgets
	// that prefer structuredContent also get a useful payload.
	//
	// useStableJson: @mcp-ui/client's AppFrame re-emits `ui/notifications/
	// tool-result` on every reference change of this prop. SEP-1865 §Lifecycle
	// says tool-input is sent "at most once" — tool-result implicitly the
	// same. Assistant-ui can rebuild the parts tree on unrelated renders, so
	// we pin a stable reference by value to keep AppFrame to one emit per
	// value change.
	const toolResult = useStableJson(
		useMemo<CallToolResult | undefined>(() => {
			if (result === undefined) return undefined;

			// `artifact` is assistant-ui's host-side field (attached via the
			// tool handler's addResult). It isn't part of the tool server's
			// `_meta`, so we namespace it under a reverse-DNS key to match
			// the SEP-1724 / SEP-1865 convention. The key itself lives in
			// `lib/mcp/host-identity.ts` alongside every other host-owned
			// namespace identifier — don't hardcode the string here.
			const ARTIFACT_META_KEY = HOST_META_KEY.ARTIFACT;

			if (isCallToolResult(result)) {
				const enrichedStructured =
					result.structuredContent ??
					extractStructuredFromContent(result.content);
				return {
					...result,
					isError: isError ?? result.isError ?? false,
					...(enrichedStructured !== undefined
						? { structuredContent: enrichedStructured }
						: {}),
					...(artifact
						? {
								_meta: {
									...(result._meta ?? {}),
									[ARTIFACT_META_KEY]: artifact,
								},
							}
						: {}),
				} satisfies CallToolResult;
			}

			// Legacy path: `result` is raw structured data (string or plain
			// object). Wrap into a CallToolResult so the widget still receives
			// something coherent.
			const text = typeof result === "string" ? result : JSON.stringify(result);
			return {
				content: [{ type: "text", text }],
				structuredContent:
					result && typeof result === "object"
						? (result as Record<string, unknown>)
						: undefined,
				isError: isError ?? false,
				...(artifact ? { _meta: { [ARTIFACT_META_KEY]: artifact } } : {}),
			};
		}, [result, isError, artifact]),
	);

	// Spec §Lifecycle: `ui/notifications/tool-input` is sent "at most once"
	// with the COMPLETE arguments. While the tool call is still streaming,
	// `args` grows chunk-by-chunk — passing it through would cause
	// @mcp-ui/client's AppFrame to emit tool-input N times with incomplete
	// args. Gate on terminal status so AppFrame fires exactly once when
	// streaming finishes. Partial updates during streaming go through
	// `toolInputPartial` below, which is the spec-sanctioned channel.
	const finalArgs =
		status?.type === "complete" || status?.type === "incomplete"
			? (args as Record<string, unknown>)
			: undefined;
	const toolInput = useStableJson(finalArgs);

	// `argsText` streams partial JSON while the model is emitting the tool
	// call. Spec §"ui/notifications/tool-input-partial": "arguments object
	// represents best-effort recovery of incomplete JSON, with unclosed
	// structures automatically closed to produce valid JSON." A raw
	// `JSON.parse` throws on every incomplete chunk, so `parsePartialToolArgs`
	// (wrapping assistant-stream's `parsePartialJsonObject`) walks the input
	// and balances unclosed braces/brackets/strings to emit a best-effort
	// partial object on each tick. Views get live progressive rendering of
	// tool args instead of a single update at completion.
	const toolInputPartial = useMemo(() => {
		if (status?.type !== "running") return undefined;
		if (!argsText || argsText === JSON.stringify(args)) return undefined;
		const parsed = parsePartialToolArgs(argsText);
		return parsed ? { arguments: parsed } : undefined;
	}, [status?.type, argsText, args]);

	const toolCancelled =
		status?.type === "incomplete" && status.reason === "cancelled";

	// --- View → Host callbacks -----------------------------------------------

	const onOpenLink = useCallback(
		async (params: { url: string }) => {
			log.debug({ toolCallId, url: params.url }, "ui/open-link");
			await confirmAndOpenLink(params.url);
			return {};
		},
		[toolCallId],
	);

	const onMessage = useCallback(
		async (params: McpUiMessageRequest["params"]) => {
			log.debug(
				{ toolCallId, role: params.role, contentBlocks: params.content.length },
				"ui/message",
			);
			try {
				// The View provides ContentBlock[] per MCP spec (text|image|audio
				// …). assistant-ui's AppendMessage.content is a union with overlap
				// at the `text` case. Pass through as-is; assistant-ui ignores
				// unknown content parts. Spec §"ui/message".
				aui.thread().append({
					role: params.role,
					content: params.content as never,
				});
				return {};
			} catch (err) {
				log.warn({ err, toolCallId }, "ui/message append failed");
				return { isError: true };
			}
		},
		[aui, toolCallId],
	);

	const onLoggingMessage = useCallback(
		(params: { level?: string; data?: unknown; logger?: string }) => {
			const level = (params.level ?? "info") as
				| "trace"
				| "debug"
				| "info"
				| "warn"
				| "error"
				| "fatal";
			log[level]?.(
				{ toolCallId, toolName, from: params.logger, data: params.data },
				"view-log",
			);
		},
		[toolCallId, toolName],
	);

	const onRequestDisplayMode = useCallback(
		async (
			params: McpUiRequestDisplayModeRequest["params"],
		): Promise<McpUiRequestDisplayModeResult> => {
			const applied = setDisplayMode(params.mode);
			log.debug(
				{ toolCallId, requested: params.mode, applied },
				"display mode negotiated",
			);
			return { mode: applied };
		},
		[setDisplayMode, toolCallId],
	);

	const onUpdateModelContext = useCallback(
		async (params: McpUiUpdateModelContextRequest["params"]) => {
			const store = modelContextStoreRef.current;
			if (store) {
				store.current = params;
				for (const cb of store.subs) cb();
			}
			log.debug(
				{
					toolCallId,
					hasContent: Boolean(params.content?.length),
					hasStructured: Boolean(params.structuredContent),
				},
				"ui/update-model-context persisted for next turn",
			);
			return {};
		},
		[toolCallId],
	);

	const onDownloadFile = useCallback(
		async (
			params: McpUiDownloadFileRequest["params"],
		): Promise<McpUiDownloadFileResult> => {
			const contents = Array.isArray(params.contents) ? params.contents : [];
			log.debug({ toolCallId, count: contents.length }, "ui/download-file");
			return performDownload(contents);
		},
		[toolCallId],
	);

	const onRequestTeardown = useCallback(() => {
		// Spec §"Request teardown": host decides. We respect the view's request
		// by initiating teardown — assistant-ui will unmount the part on the
		// next render pass.
		log.debug({ toolCallId }, "view requested teardown; honoring");
		appRef.current?.teardownResource();
	}, [toolCallId]);

	// Fallback handler is reserved for host-local extensions under our
	// reverse-DNS namespace (see `lib/mcp/host-identity.ts`). Every SEP-1865
	// method has a typed setter above; this path only handles methods
	// prefixed with `HOST_NAMESPACE`. A View feature-detects by calling and
	// catching `MethodNotFound`.
	const onFallbackRequest = useCallback(
		async (request: JSONRPCRequest) => {
			log.debug(
				{ toolCallId, method: request.method, id: request.id },
				"fallback request",
			);
			switch (request.method) {
				case HOST_METHOD.CLIPBOARD_WRITE: {
					const params = (request.params ?? {}) as { text?: string };
					if (typeof params.text !== "string") {
						throw new McpError(
							ErrorCode.InvalidParams,
							`${HOST_METHOD.CLIPBOARD_WRITE} requires text: string`,
						);
					}
					await navigator.clipboard.writeText(params.text);
					log.debug({ toolCallId, len: params.text.length }, "clipboard write");
					return { success: true };
				}
				case HOST_METHOD.CLIPBOARD_READ: {
					const text = await navigator.clipboard.readText();
					log.debug({ toolCallId, len: text.length }, "clipboard read");
					return { text };
				}
				default:
					log.warn(
						{ toolCallId, method: request.method },
						"unknown fallback method",
					);
					throw new McpError(
						ErrorCode.MethodNotFound,
						`Unknown method: ${request.method}`,
					);
			}
		},
		[toolCallId],
	);

	// --- Server → View relay -------------------------------------------------
	// `AppBridge.connect()` (from @modelcontextprotocol/ext-apps) auto-wires
	// the list-changed relays when a `client` is passed: it calls
	// `client.setNotificationHandler` for `tools/list_changed`,
	// `resources/list_changed`, and `prompts/list_changed`, and forwards each
	// to the View via the matching `send*ListChanged` on the bridge. We don't
	// duplicate that here. To force-notify the View from a non-MCP source,
	// call `appRef.current?.sendToolListChanged()` (etc.) directly.

	// Spec §"Cleanup": send ui/resource-teardown before we unmount.
	useEffect(() => {
		return () => {
			log.debug({ toolCallId, toolName }, "tearing down MCP App view");
			appRef.current?.teardownResource();
		};
	}, [toolCallId, toolName]);

	// Pre-read the UI resource so we can extract `_meta.ui.csp` and forward
	// the allowed origins to the sandbox page via URL params. This is a
	// workaround for an @mcp-ui/client bug where AppRenderer does not pass
	// the resource CSP through to AppFrame → `ui/notifications/sandbox-
	// resource-ready`. Without it, our sandbox receives `params.csp =
	// undefined` and falls to the restrictive default (e.g. `media-src
	// 'self' data:`), which blocks cross-origin audio/images the server
	// explicitly allowlisted in the resource metadata.
	// TODO(mcp-ui): remove once @mcp-ui/client forwards `_meta.ui.csp` AND
	// `_meta.ui.permissions`. The permissions half of this read is also
	// consumed by `HostCapabilities.sandbox.permissions` below (SEP-1865
	// §"Host Capabilities"), so keep the pre-read even if the CSP forwarder
	// eventually lands upstream — we need the same data for capability
	// advertisement.
	const [resourceSandbox, setResourceSandbox] = useState<
		ResourceSandboxConfig | "loading"
	>("loading");
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const read = await client.readResource({ uri: uiInfo.resourceUri });
				if (cancelled) return;
				setResourceSandbox({
					csp: readResourceCsp(read),
					permissions: readResourcePermissions(read),
				});
			} catch (err) {
				if (cancelled) return;
				log.warn(
					{ err, uri: uiInfo.resourceUri },
					"resource prefetch failed; sandbox will use bridge/default CSP + no permissions",
				);
				setResourceSandbox({ csp: null, permissions: null });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [client, uiInfo.resourceUri]);

	const resourceCsp =
		resourceSandbox === "loading" ? "loading" : resourceSandbox.csp;
	const resourcePermissions =
		resourceSandbox === "loading" ? null : resourceSandbox.permissions;

	const sandboxUrl = useMemo(() => {
		if (typeof window === "undefined") return undefined;
		if (resourceCsp === "loading") return undefined;
		// Spec §"UIResourceMeta.domain" permits per-View dedicated origins.
		// If the resource declares one, respect it; else use the bundled page.
		const domain = readResourceDomain(uiInfo.tool);
		const base = domain
			? safeUrl(`https://${domain}${SANDBOX_URL_PATH}`)
			: new URL(SANDBOX_URL_PATH, window.location.origin);
		if (!base) return new URL(SANDBOX_URL_PATH, window.location.origin);
		// Propagate the host's log level into the sandbox page so its inline
		// logger can match. See public/mcp-sandbox.html for details.
		const clientLevel = process.env.NEXT_PUBLIC_LOG_LEVEL;
		if (clientLevel) base.searchParams.set("logLevel", clientLevel);
		// Opt the sandbox CSP into 'unsafe-eval' when the dev flag is on. The
		// flag's risks + the visible header badge live in @/lib/mcp/flags.ts.
		if (isUnsafeEvalAllowed()) base.searchParams.set("unsafeEval", "1");
		// CSP workaround (see comment on resourceCsp above). The MCP server's
		// own origin is always added to resource + connect lists so intra-room
		// fetches work out of the box (see MCP_SERVER_ORIGIN block above).
		const mergeWithServerOrigin = (
			values: readonly string[] | undefined,
		): readonly string[] | undefined => {
			if (!MCP_SERVER_ORIGIN) return values;
			if (!values || values.length === 0) return [MCP_SERVER_ORIGIN];
			return values.includes(MCP_SERVER_ORIGIN)
				? values
				: [...values, MCP_SERVER_ORIGIN];
		};
		const set = (param: string, values: readonly string[] | undefined) => {
			if (values && values.length > 0) {
				base.searchParams.set(param, values.join(","));
			}
		};
		set("cspResources", mergeWithServerOrigin(resourceCsp?.resourceDomains));
		set("cspConnects", mergeWithServerOrigin(resourceCsp?.connectDomains));
		set("cspFrames", resourceCsp?.frameDomains);
		set("cspBases", resourceCsp?.baseUriDomains);
		return base;
	}, [uiInfo.tool, resourceCsp]);

	// Spec §"Host Capabilities" — advertise exactly what we handle so views
	// can feature-detect accurately. Upstream AppRenderer hardcodes a subset;
	// HostAppRenderer lets us pass the real set.
	//
	// `sandbox.{csp,permissions}` carries the values the host actually
	// GRANTED for this view (per-view, per spec). Our current policy is
	// "forward whatever the resource declared in `_meta.ui.{csp,permissions}`
	// to the sandbox iframe" — so the granted set equals `resourceCsp`
	// (loaded above) and `resourcePermissions`. Fields are omitted when
	// nothing was declared, which the spec treats as the default restrictive
	// policy (no external connects, no camera/mic/geo/clipboard).
	const fullHostCapabilities = useMemo<McpUiHostCapabilities>(() => {
		const cspGranted =
			resourceCsp && resourceCsp !== "loading" ? resourceCsp : null;
		const sandbox: McpUiHostCapabilities["sandbox"] | undefined =
			cspGranted || resourcePermissions
				? {
						...(cspGranted ? { csp: cspGranted } : {}),
						...(resourcePermissions
							? { permissions: resourcePermissions }
							: {}),
					}
				: undefined;
		return {
			openLinks: {},
			downloadFile: {},
			serverTools: { listChanged: true },
			serverResources: { listChanged: true },
			logging: {},
			updateModelContext: { text: {}, structuredContent: {} },
			message: { text: {} },
			...(sandbox ? { sandbox } : {}),
		};
	}, [resourceCsp, resourcePermissions]);

	// Spec §"HostContext.toolInfo" — inject per-view toolInfo so views can
	// adapt to the triggering tool without an extra round-trip. The global
	// hostContext from McpHostContextProvider is theme/display/locale-only.
	const viewHostContext = useMemo<McpUiHostContext>(
		() => ({
			...hostContext,
			displayMode,
			toolInfo: { id: toolCallId, tool: uiInfo.tool },
		}),
		[hostContext, displayMode, toolCallId, uiInfo.tool],
	);

	if (!sandboxUrl) return null;

	// Host chrome only offers modes that (a) the host supports AND (b) the
	// View declared. Before initialization we don't know the View's list, so
	// show only `inline` (the safe default) until `ui/notifications/initialized`
	// fires. Matches the intersection enforced by `setDisplayMode` above.
	const chromeAvailable: ModeValue[] = viewAvailableDisplayModes
		? hostAvailableModes.filter((mode) =>
				viewAvailableDisplayModes.includes(mode),
			)
		: ["inline"];

	// SEP-1865 §"Container Dimensions": when the host gives the View fixed
	// dimensions (PIP, fullscreen), the View should fill — stretch the iframe
	// wrapper to the shell's full height. Inline stays flexible so the View's
	// `size-changed` notifications grow it naturally.
	const isHostSized = displayMode === "pip" || displayMode === "fullscreen";

	return (
		<DisplayModeShell
			slotId={toolCallId}
			mode={displayMode}
			title={uiInfo.tool.title ?? uiInfo.tool.name}
			prefersBorder={prefersBorder}
			availableModes={chromeAvailable}
			onRequestMode={setDisplayMode}
		>
			<div
				className={cn("flex w-full flex-col", isHostSized && "h-full min-h-0")}
			>
				<ToolStatusHeader
					toolName={toolName}
					status={status}
					argsTextLength={argsText?.length ?? 0}
				/>
				<div
					className={cn(
						"w-full",
						isHostSized ? "min-h-0 flex-1" : "min-h-[240px]",
					)}
				>
					<HostAppRenderer
						ref={appRef}
						client={client}
						toolName={toolName}
						toolResourceUri={uiInfo.resourceUri}
						sandbox={{ url: sandboxUrl }}
						toolInput={toolInput}
						toolInputPartial={toolInputPartial}
						toolResult={toolResult}
						toolCancelled={toolCancelled}
						hostCapabilities={fullHostCapabilities}
						hostContext={viewHostContext}
						onOpenLink={onOpenLink}
						onMessage={onMessage}
						onLoggingMessage={onLoggingMessage}
						onRequestDisplayMode={onRequestDisplayMode}
						onUpdateModelContext={onUpdateModelContext}
						onDownloadFile={onDownloadFile}
						onRequestTeardown={onRequestTeardown}
						onAppCapabilities={onAppCapabilities}
						onFallbackRequest={onFallbackRequest}
						onResourceUpdated={onResourceUpdated}
						onError={(err) => {
							log.error({ err, toolCallId, toolName }, "HostAppRenderer error");
							setError(err);
						}}
					/>
					{error ? (
						<p className="px-3 py-1.5 text-destructive text-xs">
							MCP App error: {error.message}
						</p>
					) : null}
				</div>
			</div>
		</DisplayModeShell>
	);
};

// ---------------------------------------------------------------------------
// Status header — persistent chrome above the widget iframe so the user has
// a visible cue that a tool is being called (running state) / was used
// (complete / incomplete). Mirrors the iconography of assistant-ui's default
// ToolFallback so the experience is consistent between widget and JSON paths.
// ---------------------------------------------------------------------------

interface ToolStatusHeaderProps {
	toolName: string;
	status: ToolCallMessagePartProps["status"];
	argsTextLength: number;
}

const ToolStatusHeader: FC<ToolStatusHeaderProps> = ({
	toolName,
	status,
	argsTextLength,
}) => {
	const statusType = status?.type ?? "complete";
	const isRunning = statusType === "running";
	const isIncomplete = statusType === "incomplete";
	const isCancelled =
		isIncomplete &&
		status?.type === "incomplete" &&
		status.reason === "cancelled";
	const isError = isIncomplete && !isCancelled;

	const { Icon, label } = isRunning
		? { Icon: LoaderIcon, label: "Calling tool" }
		: isCancelled
			? { Icon: XCircleIcon, label: "Cancelled" }
			: isError
				? { Icon: AlertCircleIcon, label: "Tool failed" }
				: { Icon: CheckIcon, label: "Used tool" };

	return (
		<div
			data-slot="aui_mcp-tool-status"
			className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs"
		>
			<Icon
				className={cn(
					"size-3.5 shrink-0",
					isRunning && "animate-spin",
					isError && "text-destructive",
					isCancelled && "text-muted-foreground",
				)}
				aria-hidden
			/>
			<span
				className={cn(
					"font-medium",
					isCancelled && "text-muted-foreground line-through",
					isError && "text-destructive",
				)}
			>
				{label}:
			</span>
			<code className="truncate font-mono text-muted-foreground">
				{toolName}
			</code>
			{isRunning && argsTextLength > 0 ? (
				<span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
					streaming {argsTextLength} chars…
				</span>
			) : null}
		</div>
	);
};

// ---------------------------------------------------------------------------
// Resource CSP + permissions (pre-read workaround for @mcp-ui/client bug
// around CSP forwarding; also reused to populate `HostCapabilities.sandbox`
// so Views can feature-detect what was granted per SEP-1865 §"Host
// Capabilities".)
// ---------------------------------------------------------------------------

/**
 * Local DTO holding both halves of a pre-read UI resource's sandbox config.
 * The CSP and permissions shapes are the SEP-1865 wire types imported from
 * ext-apps — no parallel definitions. Keeps us shape-compatible with
 * `HostCapabilities.sandbox.{csp,permissions}` without spread-copy contortions.
 */
interface ResourceSandboxConfig {
	readonly csp: McpUiResourceCsp | null;
	readonly permissions: McpUiResourcePermissions | null;
}

/**
 * Extract the `_meta.ui.csp` domain lists from a `resources/read` response,
 * or `null` if the resource didn't declare any. SEP-1865
 * §"McpUiResourceCsp" — only scalar-string arrays, no further shape checks.
 */
function readResourceCsp(result: {
	contents?: ReadonlyArray<{ _meta?: Record<string, unknown> }>;
}): McpUiResourceCsp | null {
	const content = result?.contents?.[0];
	if (!content) return null;
	const uiMeta = (content._meta as { ui?: { csp?: unknown } } | undefined)?.ui
		?.csp;
	if (!uiMeta || typeof uiMeta !== "object") return null;
	const take = (key: string): string[] | undefined => {
		const v = (uiMeta as Record<string, unknown>)[key];
		if (!Array.isArray(v)) return undefined;
		const out = v.filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		);
		return out.length > 0 ? out : undefined;
	};
	const csp: McpUiResourceCsp = {
		resourceDomains: take("resourceDomains"),
		connectDomains: take("connectDomains"),
		frameDomains: take("frameDomains"),
		baseUriDomains: take("baseUriDomains"),
	};
	const hasAny =
		csp.resourceDomains ||
		csp.connectDomains ||
		csp.frameDomains ||
		csp.baseUriDomains;
	return hasAny ? csp : null;
}

/**
 * Extract the `_meta.ui.permissions` flags from a `resources/read` response.
 * Each declared permission becomes a present-but-empty object, matching the
 * SEP-1865 `McpUiResourcePermissions` shape (keys are advisory — the browser
 * still enforces Permission Policy on the iframe's `allow` attribute).
 *
 * Returns `null` when the resource declared none so the caller can omit
 * `sandbox.permissions` entirely from `HostCapabilities`.
 */
function readResourcePermissions(result: {
	contents?: ReadonlyArray<{ _meta?: Record<string, unknown> }>;
}): McpUiResourcePermissions | null {
	const content = result?.contents?.[0];
	if (!content) return null;
	const uiMeta = (
		content._meta as { ui?: { permissions?: unknown } } | undefined
	)?.ui?.permissions;
	if (!uiMeta || typeof uiMeta !== "object") return null;
	const declared = (key: keyof McpUiResourcePermissions): boolean =>
		Object.hasOwn(uiMeta, key);
	// Each declared permission becomes a present-but-empty object, matching
	// SEP-1865 `McpUiResourcePermissions`. Empty-object presence is the spec
	// idiom for "this permission is declared" — values are reserved for
	// future extension.
	const permissions: McpUiResourcePermissions = {
		...(declared("camera") ? { camera: {} } : {}),
		...(declared("microphone") ? { microphone: {} } : {}),
		...(declared("geolocation") ? { geolocation: {} } : {}),
		...(declared("clipboardWrite") ? { clipboardWrite: {} } : {}),
	};
	const hasAny =
		permissions.camera ||
		permissions.microphone ||
		permissions.geolocation ||
		permissions.clipboardWrite;
	return hasAny ? permissions : null;
}

// ---------------------------------------------------------------------------
// CallToolResult helpers
// ---------------------------------------------------------------------------

/**
 * A `result` is a `CallToolResult` iff it has a `content` array. We don't
 * require every optional field — `structuredContent`, `_meta`, and `isError`
 * can all be absent on a spec-compliant result.
 */
function isCallToolResult(value: unknown): value is CallToolResult {
	return (
		!!value &&
		typeof value === "object" &&
		Array.isArray((value as { content?: unknown }).content)
	);
}

/**
 * Best-effort extraction of `structuredContent` from a CallToolResult's text
 * blocks: if the first text block parses as a JSON object, use it. Enables
 * graceful support for text-only servers whose widgets look in
 * `structuredContent` rather than re-parsing `content[0].text` themselves.
 */
function extractStructuredFromContent(
	content: CallToolResult["content"] | undefined,
): Record<string, unknown> | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		try {
			const parsed = JSON.parse(block.text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Not JSON — try the next block.
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function readPrefersBorder(tool: unknown): boolean | undefined {
	const meta = readToolUiMeta(tool);
	return meta?.prefersBorder;
}

function readResourceDomain(tool: unknown): string | undefined {
	return readToolUiMeta(tool)?.domain;
}

function readToolUiMeta(tool: unknown):
	| {
			prefersBorder?: boolean;
			domain?: string;
	  }
	| undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const meta = (tool as { _meta?: { ui?: Record<string, unknown> } })._meta?.ui;
	if (!meta) return undefined;
	return {
		prefersBorder:
			typeof meta.prefersBorder === "boolean" ? meta.prefersBorder : undefined,
		domain: typeof meta.domain === "string" ? meta.domain : undefined,
	};
}

function safeUrl(input: string): URL | undefined {
	try {
		return new URL(input);
	} catch {
		return undefined;
	}
}
