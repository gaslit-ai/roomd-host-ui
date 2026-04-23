/**
 * MCP Apps runtime flags.
 *
 * Centralized so every caller reads the same truth and we keep the checks
 * greppable. Each flag is deliberately off by default — opt-in via env var.
 *
 * Flags are read at module evaluation time; change them and restart `next
 * dev`. We intentionally don't re-read on every call to avoid divergent
 * behavior within a single browser session.
 */

/**
 * DANGEROUSLY allow the MCP Apps sandbox CSP to include `'unsafe-eval'`.
 *
 * Why it exists: SEP-1865's `McpUiResourceCsp` has no knob for servers to
 * declare "my widget needs eval()". Generative widgets (those that run
 * LLM-produced code via `new Function(...)` or `eval(...)`) therefore can't
 * work under a spec-default CSP. This flag opts the whole sandbox into a
 * permissive CSP for dev.
 *
 * Risk: a malicious or buggy MCP server's widget HTML can execute arbitrary
 * JS inside its sandboxed iframe. The iframe is still origin-isolated and
 * can't reach the host's DOM, localStorage, or cookies — but it can exfiltrate
 * whatever the user interacts with inside the widget. Only enable against
 * MCP servers you trust.
 *
 * When enabled, the `<UnsafeEvalBadge>` renders a visible indicator in the
 * header.
 */
export function isUnsafeEvalAllowed(): boolean {
	return isTruthy(process.env.NEXT_PUBLIC_DANGEROUSLY_ALLOW_UNSAFE_EVAL);
}

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}
