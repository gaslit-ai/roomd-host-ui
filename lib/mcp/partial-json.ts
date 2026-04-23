/**
 * Best-effort parse of a partial tool-args JSON string for
 * `ui/notifications/tool-input-partial`.
 *
 * SEP-1865 §"ui/notifications/tool-input-partial":
 *   "The arguments object represents best-effort recovery of incomplete
 *    JSON, with unclosed structures automatically closed to produce valid
 *    JSON."
 *
 * A raw `JSON.parse(argsText)` throws for every incomplete chunk during
 * streaming, so views see nothing until the full object arrives — the exact
 * opposite of "progressive". `parsePartialJsonObject` from
 * `assistant-stream/utils` implements the auto-close: it walks the input,
 * balances unclosed braces/brackets/strings, and returns a best-effort
 * object (or `undefined` if not even partially parseable).
 *
 * This is the spec-prescribed behavior. Use this function — not
 * `JSON.parse` — everywhere we decode `ToolCallMessagePartProps.argsText`.
 */

import { parsePartialJsonObject } from "assistant-stream/utils";

/**
 * Parse a (possibly-incomplete) JSON string emitted by an in-flight tool
 * call. Returns a plain object on success, `undefined` otherwise.
 *
 * The caller is responsible for gating on tool-call streaming status
 * (spec §Lifecycle: `tool-input-partial` fires only while `running`).
 */
export function parsePartialToolArgs(
	argsText: string | undefined,
): Record<string, unknown> | undefined {
	if (!argsText) return undefined;
	const parsed = parsePartialJsonObject(argsText);
	if (!parsed || typeof parsed !== "object") return undefined;
	// `parsePartialJsonObject` returns an object branded with a symbol-keyed
	// partial-meta slot; callers don't need that, so widen back to a plain
	// record for the wire payload.
	return parsed as Record<string, unknown>;
}
