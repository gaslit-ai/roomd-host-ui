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

import { UI_EXTENSION_CAPABILITIES, UI_EXTENSION_NAME } from "@mcp-ui/client";
import {
	getToolUiResourceUri,
	isToolVisibilityAppOnly,
	isToolVisibilityModelOnly,
	RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	LoggingMessageNotificationSchema,
	type Prompt,
	type ResourceUpdatedNotification,
	ResourceUpdatedNotificationSchema,
	type Tool,
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

const log = childLog("mcp-client");

const DEFAULT_MCP_URL = process.env.NEXT_PUBLIC_MCP_SERVER_URL ?? "";

// Session-pin storage. Scoped per endpoint so multi-server setups don't
// cross-wire. SessionStorage (not localStorage) — sessions shouldn't
// survive browser close; they're tied to the MCP server's in-memory task
// store, which is ephemeral anyway.
const SESSION_KEY_PREFIX = "mcp:session:";

function readStoredSessionId(endpoint: string): string | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return (
			window.sessionStorage.getItem(SESSION_KEY_PREFIX + endpoint) ?? undefined
		);
	} catch {
		// Private mode or quota — no persistence, just carry on.
		return undefined;
	}
}

function writeStoredSessionId(endpoint: string, sessionId: string): void {
	if (typeof window === "undefined") return;
	try {
		window.sessionStorage.setItem(SESSION_KEY_PREFIX + endpoint, sessionId);
	} catch {
		// Best-effort; worst case is losing task continuity on refresh.
	}
}

function clearStoredSessionId(endpoint: string): void {
	if (typeof window === "undefined") return;
	try {
		window.sessionStorage.removeItem(SESSION_KEY_PREFIX + endpoint);
	} catch {
		/* noop */
	}
}

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
}

const McpClientContext = createContext<McpClientContextValue | null>(null);

export interface McpClientProviderProps {
	children: ReactNode;
	/** Override the MCP server URL (defaults to NEXT_PUBLIC_MCP_SERVER_URL). */
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

	// Hold the live Client across StrictMode double-effects and component reloads.
	const clientRef = useRef<Client | null>(null);
	const mountedRef = useRef(true);

	// Per-client fan-out set for `notifications/resources/updated`. Populated
	// via `onResourceUpdated()` returned on context. Cleared on disconnect.
	// Ref (not state) so consumers never re-render on add/remove.
	const resourceUpdatedSubsRef = useRef<Set<ResourceUpdatedListener>>(
		new Set(),
	);

	const onResourceUpdated = useCallback((listener: ResourceUpdatedListener) => {
		resourceUpdatedSubsRef.current.add(listener);
		return () => {
			resourceUpdatedSubsRef.current.delete(listener);
		};
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		setStatus("connecting");
		setError(null);

		const endpoint = url ?? DEFAULT_MCP_URL;
		// Diagnostic fetch wrapper: logs the handshake exchange so we can see
		// which header the server requires vs. returns. Spec §"Session Management"
		// (2025-11-25): the server MUST set `MCP-Session-Id` on the initialize
		// response header; browsers only expose it to JS if the server includes
		// `Access-Control-Expose-Headers: MCP-Session-Id` (CORS). If it's
		// missing from the exposed set, every subsequent POST reverts to "no
		// session", and a spec-compliant server responds 400.
		// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management
		const tracingFetch: typeof fetch = async (input, init) => {
			const resp = await fetch(input, init);
			if (process.env.NEXT_PUBLIC_LOG_LEVEL === "debug") {
				const exposed = resp.headers.get("access-control-expose-headers");
				const sid = resp.headers.get("mcp-session-id");
				log.debug(
					{
						url: typeof input === "string" ? input : input.toString(),
						method: init?.method ?? "GET",
						status: resp.status,
						sessionIdExposed: Boolean(sid),
						accessControlExposeHeaders: exposed,
					},
					"MCP fetch",
				);
			}
			return resp;
		};
		// MCP 2025-11-25 §Session Management: sessionIds enable a client to
		// resume a session after a page reload. We stash the server-issued id
		// in sessionStorage and pass it back on the next mount. The SDK's
		// `StreamableHTTPClientTransport` accepts a `sessionId` option
		// (streamableHttp.d.ts:87-90) and updates its internal tracking from
		// the `MCP-Session-Id` response header on subsequent roundtrips.
		const storedSessionId = readStoredSessionId(endpoint);
		const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
			fetch: tracingFetch,
			...(storedSessionId ? { sessionId: storedSessionId } : {}),
		});
		const nextClient = new Client(
			{ name: "audiostudio-host", version: "1.0.0" },
			{
				// Advertise MCP Apps + Tasks + Elicitation + Sampling capabilities.
				//
				// Spec §"Client (Host) Capabilities" (SEP-1865 + 2025-11-25):
				// - `extensions`: `UI_EXTENSION_CAPABILITIES` from @mcp-ui/client
				//   → `{ "io.modelcontextprotocol/ui": { mimeTypes: [...] } }`.
				// - `tasks`: participation in MCP 2025-11-25 Tasks. The nested
				//   `requests.elicitation.create` / `requests.sampling.createMessage`
				//   advertise that we WILL handle server-initiated requests that
				//   arrive over a task's blocking `tasks/result` response
				//   (shared/protocol.js:586-591 + 289 + 378-388).
				// - `elicitation`: standalone (non-task) elicitation.
				// - `sampling`: standalone LLM-in-the-loop; server may request a
				//   sample from us outside a task.
				//
				// Subjective: we advertise sampling even though the approval modal
				// is the minimum UX — spec-correct refusal requires us to HANDLE
				// the request and return `decline`, not ignore it entirely.
				capabilities: {
					extensions: UI_EXTENSION_CAPABILITIES,
					tasks: {
						list: {},
						cancel: {},
						requests: {
							elicitation: { create: {} },
							sampling: { createMessage: {} },
						},
					},
					elicitation: {},
					sampling: {},
				},
				// Library auto-handles list-changed notifications; we refresh our
				// local registries in the callback. Spec §"Lifecycle & notifications".
				listChanged: {
					tools: {
						onChanged: (err, tools) => {
							if (err) {
								log.warn({ err }, "tools list refresh failed");
								return;
							}
							if (!mountedRef.current || !tools) return;
							const next = buildToolUIMap(tools);
							log.debug(
								{ toolCount: tools.length, uiToolCount: next.size },
								"tools list_changed",
							);
							setToolUIs(next);
						},
					},
					resources: {
						onChanged: (err, resources) => {
							if (err) {
								log.warn({ err }, "resources list refresh failed");
								return;
							}
							if (!mountedRef.current || !resources) return;
							const next = pickUIResources(resources);
							log.debug(
								{
									resourceCount: resources.length,
									uiResourceCount: next.length,
								},
								"resources list_changed",
							);
							setUIResources(next);
						},
					},
					prompts: {
						onChanged: (err, next) => {
							if (err) {
								log.warn({ err }, "prompts list refresh failed");
								return;
							}
							if (!mountedRef.current || !next) return;
							log.debug({ promptCount: next.length }, "prompts list_changed");
							setPrompts(next);
						},
					},
				},
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
				for (const cb of resourceUpdatedSubsRef.current) {
					try {
						cb(notification.params);
					} catch (err) {
						log.warn(
							{ err, uri: notification.params.uri },
							"resource-updated listener threw",
						);
					}
				}
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
				if (!mountedRef.current) {
					await nextClient.close().catch(() => {});
					return;
				}

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
				const hasPromptsCap = serverCaps?.prompts != null;
				const hasCompletionsCap = serverCaps?.completions != null;

				// TODO(mcp-apps): CORS fallback to server-proxy.
				// SEP-1865 doesn't mandate browser-side connections; if the MCP server
				// at localhost:8090 (or any remote) rejects browser CORS, this try/catch
				// lands in the `error` state and MCP Apps won't render. Planned wiring:
				// swap the StreamableHTTPClientTransport for a custom Transport that
				// POSTs JSON-RPC frames to `/api/mcp/proxy` (a new Next.js route that
				// forwards to the server-side MCP client already open in /api/chat).
				// Public hooks stay unchanged.

				const [tools, resources, promptsResult] = await Promise.all([
					nextClient.listTools().catch((err) => {
						log.warn({ err }, "listTools failed; treating as empty");
						return { tools: [] };
					}),
					nextClient.listResources().catch((err) => {
						log.warn({ err }, "listResources failed; treating as empty");
						return { resources: [] };
					}),
					hasPromptsCap
						? nextClient.listPrompts().catch((err) => {
								log.warn({ err }, "listPrompts failed; treating as empty");
								return { prompts: [] as Prompt[] };
							})
						: Promise.resolve({ prompts: [] as Prompt[] }),
				]);

				if (!mountedRef.current) return;
				const toolMap = buildToolUIMap(tools.tools);
				const uiList = pickUIResources(resources.resources);
				clientRef.current = nextClient;
				setClient(nextClient);
				setToolUIs(toolMap);
				setUIResources(uiList);
				setPrompts(promptsResult.prompts as Prompt[]);
				setSupportsCompletions(hasCompletionsCap);
				setStatus("ready");
				// Session pinning: persist whatever sessionId the transport
				// settled on after `initialize`. We do this AFTER connect() so
				// the server-assigned id is authoritative (the stored value may
				// have been rotated out by the server if it didn't match).
				const settledSessionId = (
					transport as unknown as { sessionId?: string }
				).sessionId;
				if (settledSessionId) {
					writeStoredSessionId(endpoint, settledSessionId);
				}
				log.info(
					{
						toolCount: tools.tools.length,
						uiToolCount: toolMap.size,
						resourceCount: resources.resources.length,
						uiResourceCount: uiList.length,
						promptCount: promptsResult.prompts.length,
						supportsCompletions: hasCompletionsCap,
					},
					"MCP client ready",
				);
			} catch (err) {
				if (!mountedRef.current) return;
				// Handled path: we fall back to ToolFallback rendering and the
				// chat continues without MCP Apps support. Warn (not error) so
				// Next.js's dev overlay doesn't treat it as a fatal popup.
				log.warn(
					{ err, url: endpoint },
					"MCP client init failed — MCP Apps disabled for this session",
				);
				// Session pinning: if initialize failed with a stored session,
				// it may be a dead sessionId from a previous server run. Clear
				// so the next mount attempts a fresh handshake.
				if (storedSessionId) {
					clearStoredSessionId(endpoint);
				}
				setError(err instanceof Error ? err : new Error(String(err)));
				setStatus("error");
			}
		}).catch(() => {
			// span() already logged the failure; swallow so React's effect body
			// doesn't see an unhandled rejection.
		});

		return () => {
			mountedRef.current = false;
			const c = clientRef.current;
			clientRef.current = null;
			setClient(null);
			setPrompts([]);
			setSupportsCompletions(false);
			// Drop fan-out listeners; stale callbacks from unmounted iframes
			// would otherwise hold references to torn-down bridges.
			resourceUpdatedSubsRef.current.clear();
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

type ResourceListItem = {
	readonly uri: string;
	readonly name?: string;
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
};

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
