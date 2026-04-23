/**
 * assistant-ui slash-command adapter backed by live MCP prompts.
 *
 * Plugs into `ComposerPrimitive.Unstable_SlashCommandRoot`. The adapter
 * contract is synchronous by design (the primitive reads it on every
 * keystroke — see `@assistant-ui/core/dist/adapters/trigger.d.ts`); we
 * hold the live prompt list in React state via `useMcpPrompts` and
 * return it directly.
 *
 * v1 is flat — no categories. Multi-server grouping flips `categories()`
 * to per-server sections without reshaping the items.
 */

import type {
	Unstable_SlashCommandAdapter,
	Unstable_SlashCommandItem,
} from "@assistant-ui/core";
import { type AssistantClient, useAui } from "@assistant-ui/react";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useMemo } from "react";
import type { RequestArgsFn } from "@/components/assistant-ui/prompt-arguments-dialog";
import { useMcpClient } from "@/components/providers/mcp-client-provider";
import { invokePrompt } from "@/lib/mcp/invoke-prompt";

export function useSlashCommandAdapter(
	onRequestArgs: RequestArgsFn,
): Unstable_SlashCommandAdapter {
	const aui = useAui();
	const { client, prompts } = useMcpClient();

	return useMemo(
		() => buildAdapter(client, aui, prompts, onRequestArgs),
		[client, aui, prompts, onRequestArgs],
	);
}

function buildAdapter(
	client: Client | null,
	aui: AssistantClient,
	prompts: readonly Prompt[],
	onRequestArgs: RequestArgsFn,
): Unstable_SlashCommandAdapter {
	const items: Unstable_SlashCommandItem[] = client
		? prompts.map((p) => promptToItem(client, aui, p, onRequestArgs))
		: [];

	return {
		// Flat v1 — the primitive renders items directly when categories is
		// empty (see `TriggerPopoverResource.js` search-mode fallback).
		categories: () => [],
		categoryItems: () => items,
		// The primitive calls `search("")` on open to populate the initial
		// list in flat mode; returning all items is required for the menu
		// to appear at all. A non-empty query does a simple case-insensitive
		// substring match over the fields a user would type against.
		search: (query) => {
			const q = query.trim().toLowerCase();
			if (q === "") return items;
			return items.filter((item) => matches(item, q));
		},
	};
}

function promptToItem(
	client: Client,
	aui: AssistantClient,
	prompt: Prompt,
	onRequestArgs: RequestArgsFn,
): Unstable_SlashCommandItem {
	return {
		id: prompt.name,
		type: "mcp-prompt",
		label: prompt.title ?? prompt.name,
		description: prompt.description,
		icon: prompt.icons?.[0]?.src,
		execute: () => {
			void invokePrompt(client, aui, prompt, onRequestArgs);
		},
	};
}

function matches(item: Unstable_SlashCommandItem, q: string): boolean {
	if (item.id.toLowerCase().includes(q)) return true;
	if (item.label.toLowerCase().includes(q)) return true;
	if (item.description?.toLowerCase().includes(q)) return true;
	return false;
}
