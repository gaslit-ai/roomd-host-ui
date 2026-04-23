/**
 * Resolve a UI resource URI for a tool (or accept one explicitly) and fetch
 * its HTML payload via the MCP client.
 *
 * Extracted from `@mcp-ui/client`'s AppRenderer, since our HostAppRenderer
 * composes `AppBridge` + `AppFrame` directly and needs the same discovery.
 */

import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const MCP_APP_MIME = "text/html;profile=mcp-app";

export async function resolveToolResourceUri(
	client: Client,
	toolName: string,
): Promise<string> {
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor ? { cursor } : undefined);
		const match = page.tools.find((t) => t.name === toolName);
		if (match) {
			const uri = getToolUiResourceUri(match);
			if (!uri) {
				throw new Error(
					`Tool "${toolName}" has no UI resource (_meta.ui.resourceUri missing)`,
				);
			}
			if (!uri.startsWith("ui://")) {
				throw new Error(
					`Tool "${toolName}" has unsupported resource URI: ${uri}`,
				);
			}
			return uri;
		}
		cursor = page.nextCursor;
	} while (cursor);
	throw new Error(`Tool "${toolName}" not found on server`);
}

export async function readResourceHtml(
	client: Client,
	uri: string,
): Promise<string> {
	const result = await client.readResource({ uri });
	if (!result.contents || result.contents.length !== 1) {
		throw new Error(
			`UI resource ${uri}: expected exactly one content entry, got ${
				result.contents?.length ?? 0
			}`,
		);
	}
	const entry = result.contents[0];
	const mime = typeof entry.mimeType === "string" ? entry.mimeType : "";
	if (mime !== MCP_APP_MIME) {
		throw new Error(
			`UI resource ${uri}: unsupported MIME type "${mime}" (expected "${MCP_APP_MIME}")`,
		);
	}
	if ("text" in entry && typeof entry.text === "string") return entry.text;
	if ("blob" in entry && typeof entry.blob === "string")
		return atob(entry.blob);
	throw new Error(`UI resource ${uri}: content has neither text nor blob`);
}
