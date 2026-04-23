/**
 * Invoke an MCP prompt and plant the result in the composer.
 *
 * Called from the slash-command adapter's `execute`. The slash primitive
 * has already stripped the triggering `/query` text from the composer
 * (`TriggerPopoverResource.js` clears it before firing `onSelect`), so
 * `aui.composer().setText(text)` overwrites a clean buffer.
 *
 * Flow (matches the field consensus — Claude Code, VS Code, Goose all
 * "insert into composer" rather than replay as thread history):
 *   1. If any required arg → open the args dialog. Cancelled → abort.
 *   2. `prompts/get` on the server.
 *   3. Concatenate text blocks; multi-message prompts get role markers.
 *   4. Set the composer text. Focus stays where the user left it (in
 *      the input) — there's no `composer.focus()` API.
 */

import type { AssistantClient } from "@assistant-ui/react";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { RequestArgsFn } from "@/components/assistant-ui/prompt-arguments-dialog";
import { childLog } from "@/lib/logger";

const log = childLog("invoke-prompt");

export async function invokePrompt(
	client: Client,
	aui: AssistantClient,
	prompt: Prompt,
	onRequestArgs: RequestArgsFn,
): Promise<void> {
	const hasRequired = prompt.arguments?.some((a) => a.required) ?? false;
	let args: Record<string, string> | undefined;
	if (hasRequired) {
		const collected = await onRequestArgs(prompt);
		if (collected === null) {
			log.debug({ name: prompt.name }, "prompt cancelled by user");
			return;
		}
		args = collected;
	}

	let result: Awaited<ReturnType<Client["getPrompt"]>>;
	try {
		result = await client.getPrompt({ name: prompt.name, arguments: args });
	} catch (err) {
		log.warn({ err, name: prompt.name }, "prompts/get failed");
		return;
	}

	// `PromptMessage.content` is a single `ContentBlock`, not an array.
	// We silently drop non-text blocks in v1 (image / audio / resource /
	// resource_link) — the common case is user-text prompts, and the
	// plan treats multimodal as phase-2 material.
	const parts: Array<{ role: "user" | "assistant"; text: string }> = [];
	let skipped = 0;
	for (const msg of result.messages) {
		if (msg.content.type === "text") {
			parts.push({ role: msg.role, text: msg.content.text });
		} else {
			skipped++;
		}
	}
	if (skipped > 0) {
		log.debug(
			{ name: prompt.name, skipped, kept: parts.length },
			"dropped non-text prompt content blocks",
		);
	}
	if (parts.length === 0) {
		log.warn(
			{ name: prompt.name },
			"prompts/get returned no text — nothing to insert",
		);
		return;
	}

	const text =
		parts.length === 1
			? parts[0].text
			: parts.map((p) => `[${p.role}]\n${p.text}`).join("\n\n");

	aui.composer().setText(text);
}
