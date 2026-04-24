import type { MessagePrimitive } from "@assistant-ui/react";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Reasoning, ReasoningGroup } from "@/components/assistant-ui/reasoning";
import { FilePart } from "@/components/message-parts/file";
import { ImagePart } from "@/components/message-parts/image";
import { McpAppToolFallback } from "@/components/message-parts/mcp-app-part";
import { SourcePart } from "@/components/message-parts/source";
import { TaskProgressPart } from "@/components/message-parts/task-progress-part";

/**
 * Registry of part renderers. To add a new part type, add a key. To give a
 * specific tool a custom UI, either drop it into `tools.by_name` here OR
 * register `makeAssistantToolUI({ toolName, render })` at the provider
 * level. The library handles ordering and auto-grouping.
 *
 * Data parts come from AI SDK stream writes — `data-<name>` is mapped to
 * `{type: "data", name: "<name>"}` by assistant-ui's runtime
 * (@assistant-ui/react-ai-sdk/.../convertMessage.js:147-153). `task-progress`
 * and `task-terminal` originate from `lib/mcp/tasks/ai-sdk-adapter.ts`.
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
	data: {
		by_name: {
			"task-progress": TaskProgressPart,
			"task-terminal": TaskProgressPart,
		},
	},
};
