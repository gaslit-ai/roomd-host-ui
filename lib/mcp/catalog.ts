import {
  isToolVisibilityAppOnly,
  isToolVisibilityModelOnly,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ListPromptsResult,
  ListResourcesResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

export type ResourceListItem = ListResourcesResult["resources"][number];
export type PromptListItem = ListPromptsResult["prompts"][number];
export type ToolCaller = "model" | "app";

export async function listAllTools(
  client: Client,
  options?: RequestOptions,
): Promise<readonly Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(
      cursor ? { cursor } : undefined,
      options,
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export async function listAllResources(
  client: Client,
  options?: RequestOptions,
): Promise<readonly ResourceListItem[]> {
  const resources: ResourceListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listResources(
      cursor ? { cursor } : undefined,
      options,
    );
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  return resources;
}

export async function listAllPrompts(
  client: Client,
  options?: RequestOptions,
): Promise<readonly PromptListItem[]> {
  const prompts: PromptListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listPrompts(
      cursor ? { cursor } : undefined,
      options,
    );
    prompts.push(...page.prompts);
    cursor = page.nextCursor;
  } while (cursor);
  return prompts;
}

export function isToolVisibleToModel(tool: Partial<Tool>): boolean {
  return !isToolVisibilityAppOnly(tool);
}

export function isToolVisibleToApp(tool: Partial<Tool>): boolean {
  return !isToolVisibilityModelOnly(tool);
}

export function filterToolsForModel(tools: readonly Tool[]): Tool[] {
  return tools.filter(isToolVisibleToModel);
}

export function filterToolsForApp(tools: readonly Tool[]): Tool[] {
  return tools.filter(isToolVisibleToApp);
}

export function toolVisibilityRejection(
  tool: Partial<Tool>,
  caller: ToolCaller,
): string | null {
  const name = typeof tool.name === "string" ? tool.name : "(unknown)";
  if (caller === "model" && !isToolVisibleToModel(tool)) {
    return `Tool "${name}" is app-only and is not visible to the model`;
  }
  if (caller === "app" && !isToolVisibleToApp(tool)) {
    return `Tool "${name}" is model-only and is not visible to MCP Apps`;
  }
  return null;
}
