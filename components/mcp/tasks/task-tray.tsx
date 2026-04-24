"use client";

/**
 * Permanent chrome component that lists active + recently-terminal tasks.
 * Mounts once at the app root (inside `TaskRegistryProvider`). Renders
 * nothing when `handles.length === 0` — zero visual cost at rest.
 *
 * Subjective UX: always-visible row in the top-right corner. Shows tool
 * name, spinner, statusMessage, elapsed time, and a cancel button for
 * non-terminal tasks. Terminal tasks linger for 5 seconds then drop out
 * of the tray (state is still retained in the registry for telemetry).
 *
 * Spec: no MCP mandate on task-progress UX — servers publish status
 * updates; how the host surfaces them is host policy.
 */

import {
	CheckIcon,
	CircleAlertIcon,
	CircleXIcon,
	ListTodoIcon,
	Loader2Icon,
	XIcon,
} from "lucide-react";
import { type FC, useCallback, useEffect, useState } from "react";
import { useTaskList, useTaskRegistry } from "@/components/mcp/tasks/context";
import { Button } from "@/components/ui/button";
import type { TaskSnapshot } from "@/lib/mcp/tasks/handle";
import { isTerminal } from "@/lib/mcp/tasks/handle";
import { cn } from "@/lib/utils";

// Subjective: linger terminal tasks for 5s so a flash-completion still
// surfaces. Tune based on feel.
const TERMINAL_LINGER_MS = 5_000;

export const TaskTray: FC = () => {
	const snapshots = useTaskList();
	const visible = useVisibleTasks(snapshots);
	const [expanded, setExpanded] = useState(false);

	if (visible.length === 0) return null;

	const active = visible.filter((s) => !isTerminal(s.status));
	const badge = active.length > 0 ? active.length : undefined;

	return (
		<div
			data-slot="task-tray"
			className="pointer-events-none fixed top-4 right-4 z-40 flex w-80 flex-col gap-1"
		>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => setExpanded((v) => !v)}
				className="pointer-events-auto ml-auto flex items-center gap-2 shadow-sm"
			>
				<ListTodoIcon className="size-4" />
				<span>Tasks</span>
				{badge !== undefined ? (
					<span className="rounded-full bg-primary px-1.5 text-primary-foreground text-xs">
						{badge}
					</span>
				) : null}
			</Button>
			{expanded ? (
				<div className="pointer-events-auto flex max-h-96 flex-col gap-1 overflow-y-auto rounded-md border bg-popover p-2 shadow-md">
					{visible.map((snap) => (
						<TaskRow
							key={snap.taskId ?? snap.toolName + snap.startedAt}
							snap={snap}
						/>
					))}
				</div>
			) : null}
		</div>
	);
};

/**
 * Derive the tray-visible set: active tasks + terminal tasks within the
 * linger window. Triggers a re-render every 1s while any terminal task is
 * in its linger window so stale ones drop out without external events.
 */
function useVisibleTasks(
	all: readonly TaskSnapshot[],
): readonly TaskSnapshot[] {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		// Pulse if any terminal task is still in its linger window.
		const now = Date.now();
		const hasLingering = all.some(
			(s) =>
				isTerminal(s.status) &&
				s.terminatedAt !== undefined &&
				now - s.terminatedAt < TERMINAL_LINGER_MS,
		);
		if (!hasLingering) return;
		const id = setInterval(() => setTick((t) => t + 1), 1_000);
		return () => clearInterval(id);
	}, [all]);
	// `tick` intentionally referenced so `useEffect` dep-array doesn't warn.
	void tick;

	const now = Date.now();
	return all.filter(
		(s) =>
			!isTerminal(s.status) ||
			s.terminatedAt === undefined ||
			now - s.terminatedAt < TERMINAL_LINGER_MS,
	);
}

const TaskRow: FC<{ snap: TaskSnapshot }> = ({ snap }) => {
	const registry = useTaskRegistry();
	const terminal = isTerminal(snap.status);

	const onCancel = useCallback(() => {
		if (!registry || !snap.taskId) return;
		const handle = registry.getHandle(snap.taskId);
		if (handle) void handle.cancel("user");
	}, [registry, snap.taskId]);

	return (
		<div
			className={cn(
				"flex items-center gap-2 rounded px-2 py-1.5 text-xs",
				terminal && "opacity-60",
			)}
		>
			<StatusIcon status={snap.status} />
			<div className="min-w-0 flex-1">
				<div className="truncate font-mono font-medium">{snap.toolName}</div>
				<div className="truncate text-muted-foreground">
					{snap.statusMessage ?? defaultStatusMessage(snap.status)}
				</div>
			</div>
			<span className="shrink-0 text-muted-foreground">
				{formatElapsed(Date.now() - snap.startedAt)}
			</span>
			{!terminal && snap.taskId ? (
				<button
					type="button"
					onClick={onCancel}
					className="rounded p-1 hover:bg-muted"
					aria-label="Cancel task"
				>
					<XIcon className="size-3.5" />
				</button>
			) : null}
		</div>
	);
};

const StatusIcon: FC<{ status: TaskSnapshot["status"] }> = ({ status }) => {
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

function defaultStatusMessage(status: TaskSnapshot["status"]): string {
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
