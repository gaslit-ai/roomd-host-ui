/**
 * Wrap an AI SDK `ToolSet` so that tools whose MCP descriptor declares
 * `execution.taskSupport` route through the task registry, surfacing live
 * progress to the UI via `data-task-progress` / `data-task-terminal` parts.
 *
 * Why:
 *   - `@ai-sdk/mcp` materializes each tool's `execute` against its own
 *     protocol (node_modules/@ai-sdk/mcp/dist/index.mjs:1919-1980). That
 *     protocol has no task awareness — plain `tools/call` only. Servers
 *     that declare `taskSupport: "required"` reject plain calls with
 *     `-32601` (spec §Tool-Level Negotiation rule 2.iii).
 *   - Rebuilding the entire MCP tool layer would duplicate schema plumbing
 *     from `@ai-sdk/mcp`. We instead OVERLAY: keep `@ai-sdk/mcp`'s tools for
 *     non-task cases, replace only the task tools with wrappers that use the
 *     base `@modelcontextprotocol/sdk` Client's `experimental.tasks`.
 *
 * Progress surfacing:
 *   - Tool execute subscribes to the handle and writes a `data-task-progress`
 *     UI message chunk on each snapshot change. A final `data-task-terminal`
 *     marks completion. These parts are delivered via the UI stream but
 *     never fed back into model context (AI SDK's data parts are host-only
 *     by design) — so task status never pollutes the agent's reasoning.
 *
 * Spec:
 *   https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
 *   https://modelcontextprotocol.io/specification/2025-11-25/basic/tools#tool-level-task-negotiation
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolSet, UIMessageStreamWriter } from "ai";
import { dynamicTool, jsonSchema } from "ai";
import type { TaskRegistry } from "./registry";

interface WrapOpts {
	readonly registry: TaskRegistry;
	readonly writer: UIMessageStreamWriter;
}

/**
 * Data-part type names emitted by the wrapper. Must match the consumer
 * renderer in `components/message-parts/task-progress-part.tsx`.
 */
export const TASK_PROGRESS_PART_TYPE = "data-task-progress" as const;
export const TASK_TERMINAL_PART_TYPE = "data-task-terminal" as const;

export interface TaskProgressData {
	readonly taskId: string | null;
	readonly toolName: string;
	readonly status:
		| "pending"
		| "working"
		| "input_required"
		| "completed"
		| "cancelled"
		| "failed";
	readonly statusMessage?: string;
	readonly elapsedMs: number;
}

/**
 * Materialize a new tool set where any tool whose MCP descriptor advertises
 * `taskSupport !== "forbidden"` is replaced with a task-aware wrapper.
 * Non-task tools pass through from the input unchanged.
 */
export async function wrapToolSetWithTasks(
	tools: ToolSet,
	sdkClient: Client,
	opts: WrapOpts,
): Promise<ToolSet> {
	// Fetch the authoritative tool descriptors once. `@ai-sdk/mcp` doesn't
	// surface `execution.taskSupport`, so we must read it from the SDK client
	// directly (types.d.ts — tool.execution.taskSupport lives at the top-level
	// tool object in the `tools/list` response).
	let descriptors: Awaited<ReturnType<Client["listTools"]>>["tools"];
	try {
		descriptors = (await sdkClient.listTools()).tools;
	} catch {
		// Without descriptors we can't identify task tools; return as-is. The
		// agent can still call non-task tools normally; task-required ones
		// would fail at call time with -32601, which is a clear signal.
		return tools;
	}

	const out: ToolSet = { ...tools };
	for (const d of descriptors) {
		const support = (
			d as {
				execution?: { taskSupport?: "required" | "optional" | "forbidden" };
			}
		).execution?.taskSupport;
		if (!support || support === "forbidden") continue;

		// The original entry may be absent if `@ai-sdk/mcp` filtered the tool
		// (e.g., app-only visibility). Nothing to wrap in that case.
		if (!(d.name in out)) continue;

		out[d.name] = buildTaskTool(d.name, d, opts);
	}
	return out;
}

function buildTaskTool(
	name: string,
	descriptor: Awaited<ReturnType<Client["listTools"]>>["tools"][number],
	opts: WrapOpts,
): ReturnType<typeof dynamicTool> {
	const { registry, writer } = opts;
	return dynamicTool({
		description: descriptor.description ?? `MCP task tool: ${name}`,
		inputSchema: jsonSchema(descriptor.inputSchema as Record<string, unknown>),
		execute: async (args, options) => {
			const handle = registry.call(name, args, {
				signal: options.abortSignal,
				// mode "auto" matches the user's choice: upgrade every tool with
				// `required` OR `optional` task support (policy chosen at plan
				// approval; see DEFINITION-OF-COMPLETE §1).
				mode: "auto",
			});

			const startedAt = Date.now();
			// Subscribe for progress. First write fires immediately so the UI
			// picks up a "pending" placeholder even before the server issues
			// `taskCreated`.
			const writeProgress = (type: "progress" | "terminal"): void => {
				const snap = handle.snapshot;
				const payload: TaskProgressData = {
					taskId: snap.taskId,
					toolName: snap.toolName,
					status: snap.status,
					...(snap.statusMessage !== undefined
						? { statusMessage: snap.statusMessage }
						: {}),
					elapsedMs: Date.now() - startedAt,
				};
				writer.write({
					type:
						type === "progress"
							? TASK_PROGRESS_PART_TYPE
							: TASK_TERMINAL_PART_TYPE,
					// `id` is how the UI correlates multiple writes for the same
					// logical task. Use taskId once known; fall back to the
					// toolCallId for the pre-creation window.
					id: snap.taskId ?? options.toolCallId,
					data: payload,
				});
			};

			writeProgress("progress");
			const unsub = handle.subscribe(() => writeProgress("progress"));

			try {
				const result = await handle.waitForResult();
				writeProgress("terminal");
				// Return the spec-shaped `CallToolResult` verbatim; @ai-sdk/mcp's
				// convention is to wrap tool output as a plain JSON object, and
				// assistant-ui already renders `CallToolResult.content` correctly
				// through its MCP App / tool-result parts.
				return result;
			} catch (err) {
				writeProgress("terminal");
				// Re-throw: AI SDK records this as a failed tool call, model
				// sees the error in its next turn and can react.
				throw err;
			} finally {
				unsub();
			}
		},
	});
}
