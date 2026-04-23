/**
 * Host-identity constants — the single source of truth for every namespace
 * this host claims in the MCP Apps wire format.
 *
 * SEP-1724 (the MCP extensions spec that SEP-1865 rides on) reserves
 * reverse-DNS keys for third-party metadata and method names. Every field
 * this host authors — custom JSON-RPC methods routed through
 * `AppBridge.fallbackRequestHandler`, custom `_meta` keys on tool results,
 * custom extension identifiers — MUST be prefixed with our reverse-DNS
 * namespace to avoid collisions with spec-reserved keys or keys from other
 * hosts/servers.
 *
 * Consumers SHOULD NOT hardcode the namespace string. Add a new constant
 * here and import it. Changing the namespace is then a one-line change.
 *
 * Why `io.audiostudio`: matches the repo name; not registered anywhere
 * authoritative but collisions are unlikely and the prefix is human-readable.
 *
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

/** Root reverse-DNS namespace for everything this host owns. */
export const HOST_NAMESPACE = "io.audiostudio" as const;

/** Build a reverse-DNS-namespaced identifier (`io.audiostudio/<path>`). */
function ns<P extends string>(path: P): `${typeof HOST_NAMESPACE}/${P}` {
	return `${HOST_NAMESPACE}/${path}` as const;
}

/**
 * Custom JSON-RPC methods the host handles for Views via
 * `AppBridge.fallbackRequestHandler`. These are NOT part of SEP-1865's
 * "Standard MCP Messages" — they're host-local extensions under the
 * `{@link HOST_NAMESPACE}` prefix (per SEP-1724 reverse-DNS convention).
 *
 * Views feature-detect by sending the request and catching `MethodNotFound`,
 * or by inspecting advertised capabilities (if this host grows capability
 * entries for its custom methods later).
 */
export const HOST_METHOD = {
	/** Read text from the host's clipboard. Returns `{ text: string }`. */
	CLIPBOARD_READ: ns("clipboard.read"),
	/** Write text to the host's clipboard. Params `{ text: string }`, returns `{}`. */
	CLIPBOARD_WRITE: ns("clipboard.write"),
} as const;

export type HostMethod = (typeof HOST_METHOD)[keyof typeof HOST_METHOD];

/**
 * Custom `_meta` keys the host injects on MCP payloads (e.g., into a
 * `CallToolResult._meta` before forwarding via `ui/notifications/tool-result`).
 *
 * These MUST stay namespaced so servers and other hosts don't see us silently
 * shadowing spec-defined keys like `_meta.ui.*`.
 */
export const HOST_META_KEY = {
	/** Assistant-UI's per-tool-call artifact attached by a `ToolCallMessagePartProps` consumer. */
	ARTIFACT: ns("artifact"),
} as const;

export type HostMetaKey = (typeof HOST_META_KEY)[keyof typeof HOST_META_KEY];
