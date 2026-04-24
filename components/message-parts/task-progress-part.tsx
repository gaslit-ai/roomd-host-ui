"use client";

/**
 * Renderer for `data-task-progress` / `data-task-terminal` UI message parts.
 *
 * The chat route wraps task-capable MCP tools (`lib/mcp/tasks/ai-sdk-adapter.ts`)
 * and writes a progress part on every `TaskRegistry` snapshot change. assistant-ui's
 * AI SDK runtime converts `type: "data-<name>"` parts into `{type: "data", name,
 * data}` (see `@assistant-ui/react-ai-sdk/dist/ui/utils/convertMessage.js:147-153`),
 * so the renderer registered under `name: "task-progress"` fires for our parts.
 *
 * Subjective: progress appears as a compact inline line — tool name, status,
 * statusMessage, elapsed time. Tool-call bubbles render separately; this part
 * lives alongside them. Terminal parts collapse the line to a muted checkmark.
 */

import {
	CheckIcon,
	CircleAlertIcon,
	CircleXIcon,
	Loader2Icon,
} from "lucide-react";
import type { FC } from "react";
import type {
	TASK_PROGRESS_PART_TYPE,
	TASK_TERMINAL_PART_TYPE,
	TaskProgressData,
} from "@/lib/mcp/tasks/ai-sdk-adapter";
import { cn } from "@/lib/utils";

// Unused at runtime but pins a type reference so the part-type strings stay
// in lockstep with the adapter's constants.
type _UnusedTypeCheck =
	| typeof TASK_PROGRESS_PART_TYPE
	| typeof TASK_TERMINAL_PART_TYPE;

interface TaskProgressPartProps {
	readonly type: "data";
	readonly name: string;
	readonly data: TaskProgressData;
}

export const TaskProgressPart: FC<TaskProgressPartProps> = ({ name, data }) => {
	const terminal = name === "task-terminal";
	const { status, toolName, statusMessage, elapsedMs } = data;

	return (
		<div
			data-slot="task-progress"
			className={cn(
				"my-1 flex items-center gap-2 rounded border bg-muted/30 px-3 py-1.5 text-xs",
				terminal && status === "completed" && "opacity-60",
			)}
		>
			<StatusIcon status={status} />
			<span className="font-mono font-medium">{toolName}</span>
			<span className="text-muted-foreground">
				{statusMessage ?? defaultStatusMessage(status)}
			</span>
			<span className="ml-auto shrink-0 text-muted-foreground">
				{formatElapsed(elapsedMs)}
			</span>
		</div>
	);
};

const StatusIcon: FC<{ status: TaskProgressData["status"] }> = ({ status }) => {
	const cls = "size-3.5 shrink-0";
	switch (status) {
		case "completed":
			return <CheckIcon className={cn(cls, "text-emerald-600")} />;
		case "failed":
			return <CircleXIcon className={cn(cls, "text-destructive")} />;
		case "cancelled":
			return <CircleAlertIcon className={cn(cls, "text-muted-foreground")} />;
		case "input_required":
			return <CircleAlertIcon className={cn(cls, "text-amber-600")} />;
		default:
			return <Loader2Icon className={cn(cls, "animate-spin text-primary")} />;
	}
};

function defaultStatusMessage(status: TaskProgressData["status"]): string {
	switch (status) {
		case "pending":
			return "queued…";
		case "working":
			return "working…";
		case "input_required":
			return "waiting for your input";
		case "completed":
			return "done";
		case "cancelled":
			return "cancelled";
		case "failed":
			return "failed";
	}
}

function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}
