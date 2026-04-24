import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import { frontendTools } from "@assistant-ui/react-ai-sdk";
import { isToolVisibilityAppOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
import { wrapToolSetWithTasks } from "@/lib/mcp/tasks/ai-sdk-adapter";
import { TaskRegistry } from "@/lib/mcp/tasks/registry";

const log = childLog("chat-route");

export const maxDuration = 30;

/**
 * URLs of MCP servers to connect to. Today this is a single roomd endpoint,
 * but the route is structured so adding more servers is a one-line change.
 * Each server contributes its tools to the combined tool set and its
 * `InitializeResult.instructions` to the system prompt, labeled by the
 * server's self-reported name.
 */
const MCP_SERVER_URLS: readonly string[] = [process.env.MCP_SERVER_URL ?? ""];

interface ServerInstructions {
	/** Server-reported name from `InitializeResult.serverInfo.name`. */
	readonly name: string;
	/** Raw instructions string from `InitializeResult.instructions`. */
	readonly instructions: string;
}

let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;
let cachedMCPTools: ToolSet | null = null;

// Null = never fetched. After first attempt, holds the resolved list (may be
// empty). Instructions + serverInfo.name are connection-scoped constants, so
// caching across requests is correct; the only refresh path is a server
// restart, which also restarts this Node process.
let cachedInstructions: ReadonlyArray<ServerInstructions> | null = null;

/**
 * Module-scoped SDK client + task registry — the "task-capable peer" of
 * `@ai-sdk/mcp`'s tool layer. We keep ONE connection for the life of the
 * process so:
 *   - Advertising task/elicitation/sampling capabilities happens once at
 *     handshake (the client must advertise BEFORE the server knows it can
 *     route elicitation/sampling requests back through `tasks/result`).
 *   - The `TaskRegistry` owns a single `notifications/tasks/status` handler;
 *     we don't want per-request handlers fighting each other.
 *   - `wrapToolSetWithTasks` runs off the same `listTools()` source as
 *     `@ai-sdk/mcp`'s internal call, avoiding divergent tool metadata views.
 *
 * Spec §Tasks: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
 * Spec §Sampling: https://modelcontextprotocol.io/specification/2025-11-25/client/sampling
 * Spec §Elicitation: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
 */
let cachedTaskClient: Client | null = null;
let cachedTaskRegistry: TaskRegistry | null = null;

async function getMCPTools(): Promise<ToolSet> {
	if (cachedMCPTools) return cachedMCPTools;

	// One @ai-sdk/mcp client per server URL, merged into a single tool set.
	// With one configured URL today this is effectively a singleton; written
	// as a loop so a second entry in MCP_SERVER_URLS drops in unchanged.
	const merged: ToolSet = {};
	for (const url of MCP_SERVER_URLS) {
		try {
			await span(log, "getMCPTools", { url }, async () => {
				mcpClient = await createMCPClient({
					transport: { type: "http", url },
				});
				const rawTools = await mcpClient.tools();
				const filtered = filterModelVisibleTools(rawTools);
				Object.assign(merged, filtered);
				log.debug(
					{
						url,
						totalTools: Object.keys(rawTools).length,
						modelVisibleTools: Object.keys(filtered).length,
						appOnlyStripped:
							Object.keys(rawTools).length - Object.keys(filtered).length,
					},
					"MCP tools registered",
				);
			});
		} catch (err) {
			log.warn(
				{ err, url },
				"MCP server connect failed — skipping this server's tools",
			);
		}
	}
	cachedMCPTools = merged;
	return merged;
}

/**
 * Read `InitializeResult.instructions` + `serverInfo.name` from every
 * configured MCP server via the reference SDK. Also elevates the client to
 * module scope so the task registry can reuse it.
 *
 * `@ai-sdk/mcp` parses but discards `instructions` (its public surface only
 * exposes `serverInfo`), so we open a `@modelcontextprotocol/sdk` client
 * alongside it to extract both fields AND provide the task/elicitation/
 * sampling-aware channel for `wrapToolSetWithTasks`. One extra initialize
 * per server on cold start, cached for the lifetime of the process.
 *
 * Returns one entry per server that both (a) responded and (b) supplied a
 * non-empty instructions string. Servers that advertise no instructions are
 * omitted rather than returned with empty strings — the caller is building a
 * prompt, not a diagnostic log.
 */
async function getMCPInstructions(): Promise<
	ReadonlyArray<ServerInstructions>
> {
	if (cachedInstructions !== null) return cachedInstructions;
	const collected: ServerInstructions[] = [];
	for (const url of MCP_SERVER_URLS) {
		try {
			await span(log, "getMCPInstructions", { url }, async () => {
				const client = new Client(
					{ name: "audiostudio-chat-route", version: "1.0.0" },
					{
						// Advertise every capability our route CAN service. Spec
						// requires advertisement before the corresponding wire
						// method is permitted:
						//   - tasks.list / tasks.cancel                 → client-initiated
						//   - tasks.requests.elicitation.create         → accept server→us elicitation
						//     mid-task (drained over tasks/result)
						//   - tasks.requests.sampling.createMessage     → accept server→us sampling
						//   - elicitation{} / sampling{}                → standalone (non-task)
						capabilities: {
							tasks: {
								list: {},
								cancel: {},
								requests: {
									elicitation: { create: {} },
									sampling: { createMessage: {} },
								},
							},
							elicitation: {},
							sampling: {},
						},
					},
				);
				const transport = new StreamableHTTPClientTransport(new URL(url));
				await client.connect(transport);
				const instructions = client.getInstructions();
				const name = client.getServerVersion()?.name;
				// Hold the client; DO NOT close. Registry tracks this client for
				// the process lifetime. The prior code closed after reading
				// instructions; we now need the same client for task routing.
				cachedTaskClient = client;
				cachedTaskRegistry = new TaskRegistry(client);
				// Seed the registry's task-support map so `mode: "auto"` can
				// distinguish task-capable tools from plain ones.
				try {
					const toolsList = await client.listTools();
					cachedTaskRegistry.setTaskSupportMap(
						toolsList.tools.map((t) => {
							const support = (
								t as {
									execution?: {
										taskSupport?: "required" | "optional" | "forbidden";
									};
								}
							).execution?.taskSupport;
							return [t.name, support] as const;
						}),
					);
				} catch (err) {
					log.warn({ err }, "task registry: listTools seed failed");
				}
				log.debug(
					{
						url,
						serverName: name,
						hasInstructions: Boolean(instructions),
						len: instructions?.length ?? 0,
					},
					"MCP instructions fetched",
				);
				if (instructions && instructions.length > 0) {
					collected.push({ name: name ?? url, instructions });
				}
			});
		} catch (err) {
			log.warn(
				{ err, url },
				"MCP instructions fetch failed — skipping this server's instructions",
			);
		}
	}
	cachedInstructions = collected;
	return collected;
}

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

		const [mcpTools, mcpInstructionsList] = await Promise.all([
			getMCPTools(),
			getMCPInstructions(),
		]);
		const frontendToolSet = frontendTools(tools ?? {});

		// MCP spec: `InitializeResult.instructions` "MAY be added to the system
		// prompt." Each server gets its own labeled section (using the server's
		// self-reported `serverInfo.name`) so the model can attribute advice to
		// its source if servers give conflicting guidance. Client-supplied
		// `system` follows, since content later in the prompt is weighted more
		// heavily by most models.
		const combinedSystem =
			[
				...mcpInstructionsList.map(
					(s) =>
						`## Instructions from MCP server "${s.name}"\n\n${s.instructions}`,
				),
				system,
			]
				.filter(Boolean)
				.join("\n\n") || undefined;

		// Build the UI message stream ourselves so our task-aware tool
		// wrappers have a `UIMessageStreamWriter` to emit `data-task-progress`
		// parts on. `streamText(...).toUIMessageStreamResponse(...)` can't
		// expose the writer to tools because tool.execute is called BEFORE
		// the UI response is constructed. `createUIMessageStream` flips the
		// order: execute is given a writer and we merge streamText's output
		// into it.
		const stream = createUIMessageStream({
			originalMessages: messages,
			execute: async ({ writer }) => {
				let combinedTools: ToolSet = {
					...mcpTools,
					...frontendToolSet,
				};
				if (cachedTaskClient && cachedTaskRegistry) {
					combinedTools = await wrapToolSetWithTasks(
						combinedTools,
						cachedTaskClient,
						{
							registry: cachedTaskRegistry,
							writer,
						},
					);
				}

				log.debug(
					{
						messageCount: messages.length,
						hasClientSystem: Boolean(system),
						mcpServersWithInstructions: mcpInstructionsList.map((s) => ({
							name: s.name,
							len: s.instructions.length,
						})),
						toolNames: Object.keys(combinedTools),
						mcpToolCount: Object.keys(mcpTools).length,
						frontendToolCount: Object.keys(frontendToolSet).length,
						taskWrappersActive: Boolean(cachedTaskClient && cachedTaskRegistry),
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
							// `store: false` is the SDK-blessed path for multi-turn
							// reasoning in our setup (client echoes full history back;
							// threads can branch and merge; we're not using OpenAI's
							// server-side `conversation`).
							//
							// When `store: false` AND the model is a reasoning model,
							// `@ai-sdk/openai` auto-adds `include:
							// ["reasoning.encrypted_content"]` to the request
							// (dist/index.js:4761-4764). The response then carries
							// `encrypted_content` on each reasoning part, which the
							// provider rehydrates into assistant `ReasoningPart`s and
							// re-sends inline as `{ type: "reasoning", encrypted_content,
							// summary }` on subsequent turns (dist/index.js:2975-2988).
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

/**
 * Strip tools whose MCP `_meta.ui.visibility` is `["app"]` from the model's
 * tool set. SEP-1865 §"Visibility": app-only tools MUST NOT be exposed to the
 * agent; they remain reachable by MCP Apps via AppRenderer's auto-forwarding
 * to the browser-side client.
 *
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */
function filterModelVisibleTools(tools: ToolSet): ToolSet {
	const filtered: ToolSet = {};
	for (const [name, tool] of Object.entries(tools)) {
		// `@ai-sdk/mcp` preserves `_meta` on the tool object; the helper reads
		// both the new nested and deprecated flat visibility formats.
		if (isToolVisibilityAppOnly(tool as { _meta?: Record<string, unknown> })) {
			continue;
		}
		filtered[name] = tool;
	}
	return filtered;
}
