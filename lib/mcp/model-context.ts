/**
 * Convert a View's `ui/update-model-context` payload into an assistant-ui
 * {@link ModelContext}. Per SEP-1865 §"ui/update-model-context", the host
 * defers sending to the model until the next user message and keeps only the
 * last update.
 */

import type { ModelContext } from "@assistant-ui/react";
import type { McpUiUpdateModelContextRequest } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

function textOfBlock(block: ContentBlock): string | undefined {
	if (block.type === "text") return block.text;
	if (block.type === "resource") {
		const r = block.resource;
		if ("text" in r) return r.text;
	}
	return undefined;
}

export function modelContextFromParams(
	params: McpUiUpdateModelContextRequest["params"] | null,
): ModelContext {
	if (!params) return {};
	const parts: string[] = [];
	if (params.content) {
		for (const block of params.content) {
			const text = textOfBlock(block);
			if (text) parts.push(text);
		}
	}
	if (params.structuredContent) {
		parts.push(
			`<structured-context>${JSON.stringify(params.structuredContent)}</structured-context>`,
		);
	}
	return parts.length > 0 ? { system: parts.join("\n\n") } : {};
}
