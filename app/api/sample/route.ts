/**
 * Server-side endpoint that services MCP sampling requests.
 *
 * Flow:
 *   1. Browser's MCP client receives a `sampling/createMessage` request from
 *      a connected MCP server.
 *   2. <SamplingApprovalDialog> collects user consent.
 *   3. On approval, the browser POSTs the sampling params to this route.
 *   4. This route translates spec-shaped `CreateMessageRequestParams` →
 *      Vercel AI SDK `generateText({...})` → translates the result back to
 *      spec-shaped `CreateMessageResult` and returns it.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25/client/sampling
 *
 * Security: user consent is the primary gate (enforced in the browser). This
 * route itself is rate-limit-naive; a production deployment should add quota
 * tracking. Servers can request arbitrary system prompts / message histories,
 * so the consent dialog is where the user reviews intent.
 *
 * Model choice: matches `/api/chat` by default (OpenAI gpt-5-mini). Subjective:
 * we honor `modelPreferences.hints[0].name` only as a hint and never actually
 * switch providers — spec allows this ("MAY use the hints to inform its
 * selection" — not MUST). A future version could map hints to concrete models.
 */

import { openai } from "@ai-sdk/openai";
import type {
	CreateMessageRequest,
	CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";
import { generateText, type ModelMessage } from "ai";
import { childLog } from "@/lib/logger";

const log = childLog("sample-route");

export const maxDuration = 60;

type SamplingParams = CreateMessageRequest["params"];

export async function POST(req: Request): Promise<Response> {
	let params: SamplingParams;
	try {
		params = (await req.json()) as SamplingParams;
	} catch {
		return json({ error: "invalid json" }, 400);
	}

	try {
		const { modelMessages, system } = toAiSdkMessages(params);

		const result = await generateText({
			// Matches /api/chat's default model. See top-of-file for hint handling.
			model: openai.responses("gpt-5-mini"),
			system,
			messages: modelMessages,
			maxOutputTokens: params.maxTokens,
			...(params.temperature !== undefined
				? { temperature: params.temperature }
				: {}),
			...(params.stopSequences && params.stopSequences.length > 0
				? { stopSequences: params.stopSequences }
				: {}),
		});

		const body: CreateMessageResult = {
			// Spec §CreateMessageResult:
			//   model  = MUST — name of the model used
			//   role   = user | assistant — assistant for LLM responses
			//   content = single ContentBlock (text typical)
			//   stopReason = optional but informative
			model: "gpt-5-mini",
			role: "assistant",
			content: { type: "text", text: result.text },
			stopReason: mapStopReason(result.finishReason),
		};

		return json(body, 200);
	} catch (err) {
		log.warn({ err }, "sampling generation failed");
		return json(
			{
				error:
					err instanceof Error ? err.message : "sampling generation failed",
			},
			500,
		);
	}
}

function toAiSdkMessages(params: SamplingParams): {
	modelMessages: ModelMessage[];
	system: string | undefined;
} {
	const modelMessages: ModelMessage[] = [];
	for (const m of params.messages) {
		// Spec content union: single block | array of blocks. Each block may be
		// text/image/audio/tool_use/tool_result. For now we handle text cleanly
		// and elide other block types — sampling is a fresh completion, not a
		// continuation of the host's tool use, so media / tool blocks are
		// uncommon. Extending is a localized change here.
		const text = extractText(m.content);
		if (text === null) continue;
		modelMessages.push({ role: m.role, content: text });
	}
	return { modelMessages, system: params.systemPrompt };
}

function extractText(content: unknown): string | null {
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			const t = extractText(block);
			if (t !== null) parts.push(t);
		}
		return parts.length > 0 ? parts.join("\n\n") : null;
	}
	if (typeof content !== "object" || content === null) return null;
	const b = content as { type?: string; text?: string };
	if (b.type === "text" && typeof b.text === "string") return b.text;
	return null;
}

// Map AI SDK finishReason → MCP CreateMessageResult.stopReason.
// Spec (types.d.ts:4331-4335) enum: maxTokens | endTurn | stopSequence — or
// any string. Unknown AI SDK reasons pass through as the raw string.
function mapStopReason(reason: string | undefined): string | undefined {
	if (!reason) return undefined;
	if (reason === "length") return "maxTokens";
	if (reason === "stop") return "endTurn";
	if (reason === "stop-sequence") return "stopSequence";
	return reason;
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
