/**
 * User-confirmation gate for `ui/open-link`.
 *
 * SEP-1865 §"ui/open-link"
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 *
 * Security rules in the host also require explicit user approval for following
 * links emitted by untrusted content. We show the full URL in the confirm so
 * the user can spot look-alike domains.
 *
 * Per-origin consent is remembered for the tab's session (sessionStorage). The
 * spec permits hosts to remember approvals; we scope to origin (not full URL)
 * so an approved domain won't re-prompt on every deep link, but a different
 * domain still forces a fresh decision.
 */

import { childLog } from "@/lib/logger";

const log = childLog("mcp-apps:link");

const CONSENT_KEY_PREFIX = "mcp-apps:link-consent:";

function consentKey(origin: string): string {
	return `${CONSENT_KEY_PREFIX}${origin}`;
}

function isOriginApproved(origin: string): boolean {
	if (typeof sessionStorage === "undefined") return false;
	try {
		return sessionStorage.getItem(consentKey(origin)) === "allow";
	} catch {
		return false;
	}
}

function rememberOriginApproval(origin: string): void {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.setItem(consentKey(origin), "allow");
	} catch {
		// Quota / private-mode — ignore; worst case is an extra prompt next time.
	}
}

export async function confirmAndOpenLink(url: string): Promise<boolean> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		log.warn({ url }, "ui/open-link rejected — invalid URL");
		return false;
	}

	// Only http(s) and mailto are allowed through; reject javascript:, data:,
	// file:, etc. at the host edge as a defense-in-depth layer on top of CSP.
	if (
		parsed.protocol !== "http:" &&
		parsed.protocol !== "https:" &&
		parsed.protocol !== "mailto:"
	) {
		log.warn(
			{ url, protocol: parsed.protocol },
			"ui/open-link rejected — disallowed protocol",
		);
		return false;
	}

	// mailto: URLs don't carry a meaningful origin (`null`); always prompt.
	const origin = parsed.protocol === "mailto:" ? null : parsed.origin;

	if (origin && isOriginApproved(origin)) {
		log.debug(
			{ url: parsed.toString(), origin },
			"ui/open-link auto-approved (origin remembered)",
		);
		window.open(parsed.toString(), "_blank", "noopener,noreferrer");
		return true;
	}

	const remembered = origin
		? `\n\n(Allowing will remember ${origin} for this tab's session.)`
		: "";
	const message = `An MCP App in this conversation wants to open:\n\n${parsed.toString()}${remembered}\n\nAllow?`;
	if (typeof window === "undefined" || !window.confirm(message)) {
		log.debug({ url: parsed.toString() }, "ui/open-link denied by user");
		return false;
	}

	if (origin) rememberOriginApproval(origin);
	log.debug({ url: parsed.toString() }, "ui/open-link approved; opening");
	window.open(parsed.toString(), "_blank", "noopener,noreferrer");
	return true;
}
