import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  dynamicTool,
  jsonSchema,
  type ToolSet,
  type UIMessageStreamWriter,
} from "ai";
import { isToolVisibleToModel } from "@/lib/mcp/catalog";
import { mcpToModelOutput } from "@/lib/mcp/features/tools/result";
import type { McpHostKernel } from "@/lib/mcp/kernel/session";
import type { RunSnapshot } from "@/lib/mcp/kernel/types";
import { DATA_RUN_PART_TYPE, toDataRunPart } from "./ui-stream";

export async function buildMcpToolSet(
  kernel: McpHostKernel,
  writer: UIMessageStreamWriter,
): Promise<ToolSet> {
  const tools = await kernel.runs.getTools();
  const out: ToolSet = {};
  for (const descriptor of tools) {
    if (!isToolVisibleToModel(descriptor)) continue;
    out[descriptor.name] = buildMcpTool(kernel, descriptor, writer) as never;
  }
  return out;
}

function buildMcpTool(
  kernel: McpHostKernel,
  descriptor: Tool,
  writer: UIMessageStreamWriter,
) {
  const tool = dynamicTool({
    title: descriptor.title ?? descriptor.annotations?.title,
    description: descriptor.description,
    inputSchema: jsonSchema(descriptor.inputSchema),
    toModelOutput: mcpToModelOutput as never,
    execute: async (args, options) => {
      const handle = await kernel.runs.call(descriptor.name, args, {
        source: "agent",
        mode: "auto",
        signal: options.abortSignal,
      });
      const write = (snapshot: RunSnapshot) => {
        writer.write(toDataRunPart(snapshot, options.toolCallId));
      };
      write(handle.snapshot);
      const unsubscribe = handle.subscribe(write);
      try {
        return await handle.waitForResult();
      } finally {
        unsubscribe();
      }
    },
  });
  return {
    ...tool,
    _meta: descriptor._meta,
    annotations: descriptor.annotations,
    icons: descriptor.icons,
    execution: descriptor.execution,
    outputSchema: descriptor.outputSchema,
    __mcpPartType: DATA_RUN_PART_TYPE,
  };
}
