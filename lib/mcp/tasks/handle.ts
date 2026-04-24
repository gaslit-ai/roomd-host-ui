/**
 * TaskHandle — observable object wrapping one MCP task's lifecycle.
 *
 * Sits over the SDK's `experimental.tasks.callToolStream`. Stream messages
 * (`taskCreated` → `taskStatus`* → `result` | `error`) drive the authoritative
 * terminal state; supplementary push notifications (`notifications/tasks/status`
 * fanned out by TaskRegistry) accelerate intermediate UI updates but don't
 * carry terminal data.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
 * SDK ref: node_modules/@modelcontextprotocol/sdk/dist/esm/shared/responseMessage.d.ts
 *
 * The public surface is intentionally minimal — `subscribe` returns a snapshot
 * on each change, `waitForResult` is a promise convenience, `cancel` issues
 * `tasks/cancel`. Input collection for `input_required` status does NOT live
 * here: per SDK behavior (shared/protocol.js:586-591), `input_required` drains
 * queued server-initiated requests (`elicitation/create`, `sampling/createMessage`)
 * over the blocking `tasks/result` response. Those are caught by the
 * RequestDialogHandler — the handle just reflects status for observability.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Spec: types.d.ts:1038-1044 — canonical task status enum.
export type TaskStatus =
	| "pending" // local state; before server issues taskId
	| "working"
	| "input_required"
	| "completed"
	| "failed"
	| "cancelled";

/**
 * Immutable snapshot shape a consumer (React hook, observer) sees.
 *
 * Subjective: we expose a *flat* snapshot rather than a live object so
 * `useSyncExternalStore` can deduplicate via reference equality. The live
 * handle mutates internally; consumers always see a fresh frozen object.
 */
export interface TaskSnapshot {
	readonly taskId: string | null;
	readonly toolName: string;
	readonly status: TaskStatus;
	readonly statusMessage?: string;
	readonly result?: CallToolResult;
	readonly error?: Error;
	readonly startedAt: number;
	readonly terminatedAt?: number;
}

export type TaskListener = (snap: TaskSnapshot) => void;

export interface TaskHandle {
	readonly snapshot: TaskSnapshot;
	subscribe(fn: TaskListener): () => void;
	waitForResult(): Promise<CallToolResult>;
	cancel(reason?: string): Promise<void>;
}

/**
 * Internal helper used by TaskRegistry. Consumers of this module should only
 * ever touch the `TaskHandle` interface.
 *
 * Subjective: using a class (rather than a closure) keeps the object identity
 * stable across subscriptions and gives us an explicit `update()` seam the
 * registry can call from both stream-message and notification-fan-out code
 * paths without exposing a mutation API publicly.
 */
export class TaskHandleImpl implements TaskHandle {
	private _snap: TaskSnapshot;
	private readonly _listeners = new Set<TaskListener>();
	private readonly _waiters: Array<{
		resolve: (r: CallToolResult) => void;
		reject: (e: unknown) => void;
	}> = [];
	private readonly _cancelFn: (reason?: string) => Promise<void>;
	private readonly _abortFn: (reason?: string) => void;

	constructor(params: {
		toolName: string;
		cancel: (reason?: string) => Promise<void>;
		abort: (reason?: string) => void;
	}) {
		this._cancelFn = params.cancel;
		this._abortFn = params.abort;
		this._snap = Object.freeze({
			taskId: null,
			toolName: params.toolName,
			status: "pending",
			startedAt: Date.now(),
		});
	}

	get snapshot(): TaskSnapshot {
		return this._snap;
	}

	subscribe(fn: TaskListener): () => void {
		this._listeners.add(fn);
		return () => {
			this._listeners.delete(fn);
		};
	}

	waitForResult(): Promise<CallToolResult> {
		// If already terminal, resolve/reject synchronously via a microtask.
		const s = this._snap;
		if (isTerminal(s.status)) {
			return s.result
				? Promise.resolve(s.result)
				: Promise.reject(s.error ?? new Error(`Task ${s.status}`));
		}
		return new Promise<CallToolResult>((resolve, reject) => {
			this._waiters.push({ resolve, reject });
		});
	}

	async cancel(reason?: string): Promise<void> {
		// Flip local state to cancelled optimistically so UI reacts without
		// waiting for server confirmation — server-side update will overwrite
		// with the authoritative lastUpdatedAt / statusMessage.
		// Spec: §Task Cancellation rule 2 — the boundary commits `cancelled`
		// before sending the response, so this is race-safe in practice.
		this._abortFn(reason);
		await this._cancelFn(reason).catch(() => {
			// `tasks/cancel` failures are logged by the registry; we still want
			// to flip local state so the caller's UI isn't stuck.
		});
		if (!isTerminal(this._snap.status)) {
			this.update({ status: "cancelled", terminatedAt: Date.now() });
			this.rejectWaiters(new Error(reason ?? "Task cancelled"));
		}
	}

	/** Registry-internal. Merges partial state and notifies listeners. */
	update(patch: Partial<Omit<TaskSnapshot, "toolName" | "startedAt">>): void {
		this._snap = Object.freeze({ ...this._snap, ...patch });
		for (const l of this._listeners) l(this._snap);
		if (isTerminal(this._snap.status)) {
			if (this._snap.result) {
				this.resolveWaiters(this._snap.result);
			} else if (this._snap.error) {
				this.rejectWaiters(this._snap.error);
			} else if (this._snap.status === "cancelled") {
				this.rejectWaiters(new Error("Task cancelled"));
			} else {
				this.rejectWaiters(
					new Error(`Task ${this._snap.status} with no result`),
				);
			}
		}
	}

	private resolveWaiters(r: CallToolResult): void {
		const ws = this._waiters.splice(0, this._waiters.length);
		for (const w of ws) w.resolve(r);
	}

	private rejectWaiters(e: unknown): void {
		const ws = this._waiters.splice(0, this._waiters.length);
		for (const w of ws) w.reject(e);
	}
}

export function isTerminal(s: TaskStatus): boolean {
	return s === "completed" || s === "failed" || s === "cancelled";
}
