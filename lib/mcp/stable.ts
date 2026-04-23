import { useRef } from "react";

/**
 * Returns a stable reference to `value` across renders, replacing it only
 * when its JSON serialization changes. Useful at the edge between assistant-ui
 * (which rebuilds message-part objects freely) and library APIs that dispatch
 * on reference equality — notably `@mcp-ui/client`'s `<AppFrame>` useEffects
 * keyed on `[toolInput]` and `[toolResult]`, which would otherwise re-emit
 * `ui/notifications/tool-input` and `ui/notifications/tool-result` on every
 * parent re-render.
 *
 * JSON equality is good enough for the MCP-Apps case: tool inputs and results
 * are JSON-serializable by protocol definition.
 */
export function useStableJson<T>(value: T): T {
	const ref = useRef<{ value: T; serialized: string } | null>(null);
	const serialized = JSON.stringify(value);
	if (ref.current && ref.current.serialized === serialized) {
		return ref.current.value;
	}
	ref.current = { value, serialized };
	return value;
}
