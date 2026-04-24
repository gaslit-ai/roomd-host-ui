/**
 * TaskRegistry — per-Client task orchestrator.
 *
 * Responsibilities:
 *   1. Own the single `notifications/tasks/status` handler on the Client and
 *      fan out to per-task `TaskHandle`s.
 *   2. Run `callToolStream` for tool invocations, translating stream messages
 *      into handle updates.
 *   3. Auto-upgrade calls to the task path when the tool's
 *      `execution.taskSupport` is `"required"` or `"optional"` — consistent
 *      "every call is observable" UX. Callers may opt out via `mode: "plain"`.
 *   4. Expose list/attach/dispose for reconnection and teardown.
 *
 * Works identically in Node (chat route) and the browser (provider).
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
 * SDK internals referenced:
 *   - experimental/tasks/client.js (callToolStream, getTask, cancelTask, listTasks)
 *   - shared/protocol.js:551-592 (stream machinery, input_required auto-drain)
 *   - shared/protocol.js:623-629 (strict-capability assertion)
 *   - types.d.ts:1038-1050 (Task schema), 1116-1145 (TaskStatusNotificationSchema)
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	type CallToolResult,
	CallToolResultSchema,
	type ListTasksResult,
	TaskStatusNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { childLog } from "@/lib/logger";
import {
	isTerminal,
	type TaskHandle,
	TaskHandleImpl,
	type TaskSnapshot,
	type TaskStatus,
} from "./handle";

const log = childLog("task-registry");

// Subjective: the SDK default request timeout is 60s (shared/protocol.js:712).
// Long-running tasks trivially exceed that. We widen to 10 minutes and enable
// `resetTimeoutOnProgress` so stuck tasks still eventually time out, while a
// healthy task emitting progress stays alive indefinitely.
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export type TaskCallMode =
	// Upgrade every tool that advertises `taskSupport: "required" | "optional"`.
	// Matches the SDK's own default (`client/index.js:551`). Gives consistent
	// progress UX at the cost of polling latency for fast tools.
	| "auto"
	// Upgrade only `taskSupport: "required"` tools. Plain `callTool` otherwise.
	| "required-only"
	// Always plain `callTool`. If the tool is `required`, server responds
	// `-32601`; the handle reflects that failure.
	| "plain";

export interface TaskCallOptions {
	readonly mode?: TaskCallMode;
	readonly ttl?: number;
	readonly pollInterval?: number;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export type TaskRegistryListener = (snapshots: readonly TaskSnapshot[]) => void;

export class TaskRegistry {
	private readonly _handles = new Map<string, TaskHandleImpl>();
	// Handles before `taskCreated` fires have no taskId yet — track them by
	// internal stream id so `dispose()` can reach them.
	private readonly _pendingHandles = new Set<TaskHandleImpl>();
	private _cachedSnapshots: readonly TaskSnapshot[] = [];
	private readonly _listeners = new Set<TaskRegistryListener>();
	private _disposed = false;

	/**
	 * Toolset task-support lookup. Populated by the caller after `listTools`.
	 * Subjective: we don't auto-fetch — the caller (the MCP client provider,
	 * or the chat-route) already fetches tools and has the richer metadata,
	 * so the registry just reads a map. Keeps this module React-free.
	 */
	private readonly _taskSupportByTool = new Map<
		string,
		"required" | "optional" | "forbidden"
	>();

	constructor(private readonly client: Client) {
		// Spec §Notifications (2025-11-25): servers MAY emit
		// `notifications/tasks/status` at any point during a task's lifecycle.
		// Single-registration pattern mirrors our resources-updated fan-out
		// (mcp-client-provider.tsx:239-253) — `setNotificationHandler` replaces
		// rather than multiplexes, so we own it here and dispatch to handles.
		client.setNotificationHandler(
			TaskStatusNotificationSchema,
			async (notification) => {
				const { taskId, status, statusMessage, lastUpdatedAt } =
					notification.params;
				const handle = this._handles.get(taskId);
				if (!handle) {
					// Notification for a task we don't own (e.g., from another
					// client on the same session, or one we haven't seen the
					// create message for yet). Silent.
					log.debug({ taskId, status }, "status for unknown task");
					return;
				}
				handle.update({
					status: status as TaskStatus,
					...(statusMessage !== undefined ? { statusMessage } : {}),
					...(isTerminal(status as TaskStatus)
						? { terminatedAt: Date.parse(lastUpdatedAt) || Date.now() }
						: {}),
				});
				this.emit();
			},
		);
	}

	/**
	 * Populate the task-support map from a tools list. The registry uses this
	 * to decide whether to upgrade a call to the task path in `"auto"` /
	 * `"required-only"` modes. Callers should invoke after `listTools` and on
	 * every `tools/list_changed`.
	 *
	 * Spec: `Tool.execution.taskSupport` — `"required" | "optional" | "forbidden"`.
	 * SDK ref: client/index.d.ts:563-565.
	 */
	setTaskSupportMap(
		entries: Iterable<
			readonly [string, "required" | "optional" | "forbidden" | undefined]
		>,
	): void {
		this._taskSupportByTool.clear();
		for (const [name, support] of entries) {
			if (support !== undefined) this._taskSupportByTool.set(name, support);
		}
	}

	/** Primary entrypoint. Returns a handle that reflects task state live. */
	call(name: string, args: unknown, opts: TaskCallOptions = {}): TaskHandle {
		if (this._disposed)
			throw new Error("TaskRegistry.call on a disposed registry");

		const mode = opts.mode ?? "auto";
		const support = this._taskSupportByTool.get(name);
		const useTaskPath =
			mode === "plain"
				? false
				: mode === "required-only"
					? support === "required"
					: // "auto"
						support === "required" || support === "optional";

		const ac = new AbortController();
		// Chain caller signal so external abort triggers internal abort.
		if (opts.signal) {
			if (opts.signal.aborted) ac.abort(opts.signal.reason);
			else
				opts.signal.addEventListener(
					"abort",
					() => ac.abort(opts.signal?.reason),
					{
						once: true,
					},
				);
		}

		const handle = new TaskHandleImpl({
			toolName: name,
			abort: (reason) => ac.abort(reason),
			cancel: async (reason) => {
				const tid = handle.snapshot.taskId;
				if (!tid) return; // not yet created
				// Spec §Task Cancellation: clients MAY send `tasks/cancel` for
				// any task they created within the session. Server transitions
				// to `cancelled` synchronously (rule 2).
				await this.client.experimental.tasks
					.cancelTask(tid)
					.catch((err) =>
						log.warn({ err, taskId: tid, reason }, "cancel failed"),
					);
			},
		});

		if (useTaskPath) {
			this._pendingHandles.add(handle);
			void this.runTaskStream(handle, name, args as Record<string, unknown>, {
				ttl: opts.ttl,
				pollInterval: opts.pollInterval,
				timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				signal: ac.signal,
			});
		} else {
			void this.runPlainCall(handle, name, args as Record<string, unknown>, {
				timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				signal: ac.signal,
			});
		}

		this.emit();
		return handle;
	}

	/**
	 * Adopt an in-flight server task we didn't create (e.g., discovered via
	 * `tasks/list` after a reload). Polls once via `tasks/get` to seed state,
	 * then relies on push notifications to advance. Unlike `call`, there's no
	 * stream to drive terminal completion, so we start a shadow poll that
	 * calls `tasks/result` (blocking) to deliver the final result.
	 *
	 * Spec: `tasks/get` + `tasks/result` enable resumption as long as the
	 * sessionId is preserved (see streamable-HTTP session pinning in the
	 * client provider).
	 */
	async attach(taskId: string): Promise<TaskHandle> {
		if (this._disposed)
			throw new Error("TaskRegistry.attach on a disposed registry");
		const existing = this._handles.get(taskId);
		if (existing) return existing;

		const ac = new AbortController();
		const toolName = "(attached)";
		try {
			const t = await this.client.experimental.tasks.getTask(taskId);
			// The Task schema doesn't carry the tool name directly; it lives on
			// the original request (ttl/pollInterval/statusMessage are all we
			// get). We leave toolName as a placeholder — UI surfaces it via
			// task.taskId while we wait on terminal data.
			void t;
		} catch (err) {
			log.warn({ err, taskId }, "attach: tasks/get failed");
		}

		const handle = new TaskHandleImpl({
			toolName,
			abort: (reason) => ac.abort(reason),
			cancel: async (reason) => {
				await this.client.experimental.tasks
					.cancelTask(taskId)
					.catch((err) =>
						log.warn({ err, taskId, reason }, "attach cancel failed"),
					);
			},
		});
		handle.update({ taskId, status: "working" });
		this._handles.set(taskId, handle);

		// Drive terminal state via blocking `tasks/result`. The SDK does this
		// internally inside callToolStream; for attach we do it manually.
		void this.client.experimental.tasks
			.getTaskResult(taskId, CallToolResultSchema)
			.then((result) => {
				handle.update({
					status: "completed",
					result: result as CallToolResult,
					terminatedAt: Date.now(),
				});
				this.emit();
			})
			.catch((err) => {
				handle.update({
					status: "failed",
					error: err instanceof Error ? err : new Error(String(err)),
					terminatedAt: Date.now(),
				});
				this.emit();
			});

		this.emit();
		return handle;
	}

	/** Snapshot of all known handles. Reference-stable until state changes. */
	get snapshots(): readonly TaskSnapshot[] {
		return this._cachedSnapshots;
	}

	/** Live handle lookup by taskId. Returns undefined before `taskCreated`. */
	getHandle(taskId: string): TaskHandle | undefined {
		return this._handles.get(taskId);
	}

	subscribe(fn: TaskRegistryListener): () => void {
		this._listeners.add(fn);
		return () => {
			this._listeners.delete(fn);
		};
	}

	/** Server-wide task enumeration. */
	async listServerTasks(cursor?: string): Promise<ListTasksResult> {
		return this.client.experimental.tasks.listTasks(cursor);
	}

	/**
	 * Adopt every non-terminal server task. Used on reconnect (session pinned)
	 * to re-populate the tray after a refresh.
	 */
	async reattachInFlight(): Promise<void> {
		try {
			const { tasks } = await this.listServerTasks();
			for (const t of tasks) {
				if (
					!isTerminal(t.status as TaskStatus) &&
					!this._handles.has(t.taskId)
				) {
					await this.attach(t.taskId);
				}
			}
		} catch (err) {
			log.warn({ err }, "reattachInFlight failed");
		}
	}

	async dispose(): Promise<void> {
		if (this._disposed) return;
		this._disposed = true;
		// Best-effort cancel on every non-terminal handle. Swallow errors —
		// teardown shouldn't block or throw.
		const cancels: Promise<unknown>[] = [];
		for (const h of this._handles.values()) {
			if (!isTerminal(h.snapshot.status)) cancels.push(h.cancel("disposed"));
		}
		for (const h of this._pendingHandles) {
			// No taskId yet — just abort the stream so the SDK's generator exits.
			if (!isTerminal(h.snapshot.status)) cancels.push(h.cancel("disposed"));
		}
		await Promise.allSettled(cancels);
		this._handles.clear();
		this._pendingHandles.clear();
		this._listeners.clear();
		this._cachedSnapshots = [];
		// Notification handler is scoped to the Client — it will be cleaned up
		// when the Client closes. We don't removeNotificationHandler here because
		// dispose is often called just-before-close; the small race window is
		// harmless (handler no-ops on unknown taskIds).
	}

	// ─── Internals ──────────────────────────────────────────────────────────

	private async runTaskStream(
		handle: TaskHandleImpl,
		name: string,
		args: Record<string, unknown>,
		opts: {
			ttl?: number;
			pollInterval?: number;
			timeoutMs: number;
			signal: AbortSignal;
		},
	): Promise<void> {
		try {
			// Spec §Clients MAY supply `task` to request task-augmented execution.
			// SDK threads `options.task` directly into the request (shared/protocol.js:613).
			const stream = this.client.experimental.tasks.callToolStream(
				{ name, arguments: args },
				CallToolResultSchema,
				{
					task: {
						...(opts.ttl !== undefined ? { ttl: opts.ttl } : {}),
						...(opts.pollInterval !== undefined
							? { pollInterval: opts.pollInterval }
							: {}),
					},
					signal: opts.signal,
					timeout: opts.timeoutMs,
					// Progress resets the timer: a healthy task stays alive as long
					// as the server emits status updates. (Subjective — matches how
					// Claude Code handles its own long-tool path.)
					resetTimeoutOnProgress: true,
				},
			);

			for await (const msg of stream) {
				switch (msg.type) {
					case "taskCreated": {
						const t = msg.task;
						handle.update({
							taskId: t.taskId,
							status: t.status as TaskStatus,
							statusMessage: t.statusMessage,
						});
						this._pendingHandles.delete(handle);
						this._handles.set(t.taskId, handle);
						this.emit();
						break;
					}
					case "taskStatus": {
						const t = msg.task;
						handle.update({
							status: t.status as TaskStatus,
							statusMessage: t.statusMessage,
						});
						this.emit();
						break;
					}
					case "result": {
						handle.update({
							status: "completed",
							result: msg.result as CallToolResult,
							terminatedAt: Date.now(),
						});
						this.emit();
						break;
					}
					case "error": {
						handle.update({
							status: "failed",
							error: msg.error,
							terminatedAt: Date.now(),
						});
						this.emit();
						break;
					}
				}
			}
		} catch (err) {
			// Abort from the caller's signal lands here as DOMException/AbortError —
			// map to `cancelled` rather than `failed` for UX clarity.
			const aborted =
				opts.signal.aborted ||
				(err as { name?: string })?.name === "AbortError";
			handle.update({
				status: aborted ? "cancelled" : "failed",
				error: err instanceof Error ? err : new Error(String(err)),
				terminatedAt: Date.now(),
			});
			this._pendingHandles.delete(handle);
			this.emit();
		}
	}

	private async runPlainCall(
		handle: TaskHandleImpl,
		name: string,
		args: Record<string, unknown>,
		opts: { timeoutMs: number; signal: AbortSignal },
	): Promise<void> {
		handle.update({ status: "working" });
		try {
			const result = await this.client.callTool(
				{ name, arguments: args },
				CallToolResultSchema,
				{ signal: opts.signal, timeout: opts.timeoutMs },
			);
			handle.update({
				status: "completed",
				result: result as CallToolResult,
				terminatedAt: Date.now(),
			});
		} catch (err) {
			const aborted =
				opts.signal.aborted ||
				(err as { name?: string })?.name === "AbortError";
			handle.update({
				status: aborted ? "cancelled" : "failed",
				error: err instanceof Error ? err : new Error(String(err)),
				terminatedAt: Date.now(),
			});
		} finally {
			this.emit();
		}
	}

	private emit(): void {
		const snaps: TaskSnapshot[] = [];
		for (const h of this._handles.values()) snaps.push(h.snapshot);
		for (const h of this._pendingHandles) snaps.push(h.snapshot);
		this._cachedSnapshots = Object.freeze(snaps) as readonly TaskSnapshot[];
		for (const l of this._listeners) l(this._cachedSnapshots);
	}
}
