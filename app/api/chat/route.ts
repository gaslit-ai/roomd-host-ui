import { openai } from "@ai-sdk/openai";
import { frontendTools } from "@assistant-ui/react-ai-sdk";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type JSONSchema7,
  streamText,
  type ToolSet,
  type UIMessage,
} from "ai";
import { childLog, span } from "@/lib/logger";
import { getMcpHostKernel } from "@/lib/mcp/kernel/session";
import { buildMcpToolSet } from "@/lib/mcp/projections/run/ai-sdk";

const log = childLog("chat-route");

export const maxDuration = 30;

export async function POST(req: Request) {
  return span(log, "POST /api/chat", { url: req.url }, async () => {
    const {
      messages,
      system,
      tools,
    }: {
      messages: UIMessage[];
      system?: string;
      tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
    } = await req.json();

    const kernel = await getMcpHostKernel();
    const instructions = kernel.instructions;
    const serverName = kernel.serverInfo?.name ?? "MCP server";
    const frontendToolSet = frontendTools(tools ?? {});

    const combinedSystem =
      [
        instructions
          ? `## Instructions from MCP server "${serverName}"\n\n${instructions}`
          : undefined,
        system,
      ]
        .filter(Boolean)
        .join("\n\n") || undefined;

    const stream = createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        const mcpTools = await buildMcpToolSet(kernel, writer);
        const combinedTools: ToolSet = {
          ...mcpTools,
          ...frontendToolSet,
        };

        log.debug(
          {
            messageCount: messages.length,
            hasClientSystem: Boolean(system),
            hasMcpInstructions: Boolean(instructions),
            mcpToolCount: Object.keys(mcpTools).length,
            frontendToolCount: Object.keys(frontendToolSet).length,
          },
          "invoking streamText",
        );

        const result = streamText({
          model: openai.responses("gpt-5-nano"),
          messages: await convertToModelMessages(messages),
          system: combinedSystem,
          tools: combinedTools,
          providerOptions: {
            openai: {
              reasoningEffort: "medium",
              reasoningSummary: "auto",
              store: false,
            },
          },
        });

        writer.merge(
          result.toUIMessageStream({
            sendReasoning: true,
          }),
        );
      },
    });

    return createUIMessageStreamResponse({ stream });
  });
}
