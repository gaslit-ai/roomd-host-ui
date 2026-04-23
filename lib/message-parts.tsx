import type { MessagePrimitive } from "@assistant-ui/react";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Reasoning, ReasoningGroup } from "@/components/assistant-ui/reasoning";
import { FilePart } from "@/components/message-parts/file";
import { ImagePart } from "@/components/message-parts/image";
import { McpAppToolFallback } from "@/components/message-parts/mcp-app-part";
import { SourcePart } from "@/components/message-parts/source";

/**
 * Registry of part renderers. To add a new part type, add a key. To give a
 * specific tool a custom UI, either drop it into `tools.by_name` here OR
 * register `makeAssistantToolUI({ toolName, render })` at the provider
 * level. The library handles ordering and auto-grouping.
 *
 * For dev-time inspection of the raw message tree, see the floating DEV
 * sidebar at `components/debug/dev-sidebar.tsx`.
 */
export const messageParts: MessagePrimitive.Parts.Props["components"] = {
	Text: MarkdownText,
	Reasoning,
	ReasoningGroup,
	Source: SourcePart,
	Image: ImagePart,
	File: FilePart,
	tools: {
		Fallback: McpAppToolFallback,
		// by_name: { get_weather: WeatherToolUI, ... }
	},
};
