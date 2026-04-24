"use client";

/**
 * React bindings for the task registry.
 *
 * Lifecycle: one registry per MCP Client. When the client becomes ready, we
 * construct the registry, populate its task-support map from the tools list
 * the parent provider already fetched, and reattach any in-flight tasks
 * (session-pinning enables this across refreshes).
 *
 * On teardown (client disconnect, page navigation, StrictMode double-mount),
 * `registry.dispose()` cancels non-terminal handles and drops listeners.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
 */

import {
	createContext,
	type FC,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useMcpClient } from "@/components/providers/mcp-client-provider";
import { append as appendDevEvent } from "@/lib/dev-event-log";
import type { TaskHandle, TaskSnapshot } from "@/lib/mcp/tasks/handle";
import { TaskRegistry } from "@/lib/mcp/tasks/registry";

const Ctx = createContext<TaskRegistry | null>(null);

export const TaskRegistryProvider: FC<{ children: ReactNode }> = ({
	children,
}) => {
	const { client, toolUIs } = useMcpClient();
	const [registry, setRegistry] = useState<TaskRegistry | null>(null);
	// Ref-held reference to the client used to build the registry; lets the
	// effect cleanup dispose the right instance even if client flips.
	const builtForClientRef = useRef<typeof client>(null);

	useEffect(() => {
		if (!client) {
			setRegistry(null);
			return;
		}

		const r = new TaskRegistry(client);
		builtForClientRef.current = client;
		setRegistry(r);

		// Populate task-support from the tools the parent provider already
		// holds. We pull `execution.taskSupport` off each tool; missing entries
		// mean "server didn't declare" which we treat as "no task support for
		// this tool" (plain call).
		//
		// Spec: `Tool.execution.taskSupport` in `tools/list` response
		// (SDK types.d.ts client/index.d.ts:563-565).
		void client
			.listTools()
			.then((res) => {
				r.setTaskSupportMap(
					res.tools.map((t) => {
						const support = (t as { execution?: { taskSupport?: string } })
							.execution?.taskSupport;
						return [
							t.name,
							support === "required" ||
							support === "optional" ||
							support === "forbidden"
								? support
								: undefined,
						] as const;
					}),
				);
			})
			.catch(() => {
				// Best-effort; registry still works without the map — just never
				// upgrades to the task path on "auto"/"required-only" modes.
			});

		// Reattach any in-flight tasks from a prior session. This only yields
		// results when session pinning returned us a live sessionId AND tasks
		// are still running server-side. First mount after a fresh connect
		// returns an empty list.
		void r.reattachInFlight();

		// Dev-only tap: log task-status transitions into the floating event
		// stream. Gated off in production by the tree-shake in `devTapFetch`'s
		// same NODE_ENV check. We de-dupe per (taskId,status,statusMessage) so
		// the UI doesn't show dozens of identical progress lines during polling.
		let devUnsub: (() => void) | undefined;
		if (process.env.NODE_ENV !== "production") {
			const seen = new Map<string, string>();
			devUnsub = r.subscribe((snaps) => {
				for (const s of snaps) {
					const key = s.taskId ?? s.toolName;
					const sig = `${s.status}|${s.statusMessage ?? ""}`;
					if (seen.get(key) === sig) continue;
					seen.set(key, sig);
					appendDevEvent(
						JSON.stringify({
							type: "task",
							taskId: s.taskId,
							toolName: s.toolName,
							status: s.status,
							...(s.statusMessage !== undefined
								? { statusMessage: s.statusMessage }
								: {}),
						}),
					);
				}
			});
		}

		return () => {
			devUnsub?.();
			void r.dispose();
		};
	}, [client]);

	// Refresh the registry's task-support map whenever `tools/list_changed`
	// surfaces on the client provider (which refreshes `toolUIs`). The
	// upstream provider replaces the Map identity on every change, so we key
	// on its stringified names for a stable dep — cheap and reference-clean.
	const toolNamesKey = Array.from(toolUIs.keys()).sort().join("\u0000");
	useEffect(() => {
		if (!registry || !client) return;
		// The read satisfies biome's exhaustive-deps rule (it refuses deps
		// that aren't read inside the effect body even when they're the
		// intended trigger). `toolNamesKey` is derived from `toolUIs` above
		// and changes whenever the set of tool names changes.
		void toolNamesKey;
		void client
			.listTools()
			.then((res) => {
				registry.setTaskSupportMap(
					res.tools.map((t) => {
						const support = (t as { execution?: { taskSupport?: string } })
							.execution?.taskSupport;
						return [
							t.name,
							support === "required" ||
							support === "optional" ||
							support === "forbidden"
								? support
								: undefined,
						] as const;
					}),
				);
			})
			.catch(() => {
				// Best-effort; the old map stays.
			});
	}, [registry, client, toolNamesKey]);

	return <Ctx.Provider value={registry}>{children}</Ctx.Provider>;
};

/**
 * Returns the live `TaskRegistry`, or `null` if the MCP client isn't ready.
 * Callers that need the registry synchronously (e.g. inside an event handler)
 * should guard the null case rather than throwing, since MCP connection is
 * async and dialog-mounted components can render before ready.
 */
export function useTaskRegistry(): TaskRegistry | null {
	return useContext(Ctx);
}

/**
 * Subscribe to a single task handle's snapshot. Uses
 * `useSyncExternalStore` so StrictMode + concurrent renders stay consistent.
 */
export function useTask(handle: TaskHandle): TaskSnapshot {
	return useSyncExternalStore(
		(cb) => handle.subscribe(() => cb()),
		() => handle.snapshot,
		() => handle.snapshot,
	);
}

const EMPTY_SNAPSHOTS: readonly TaskSnapshot[] = Object.freeze([]);

/**
 * Subscribe to the full registry. Returns an empty array when no registry
 * is mounted so consumers can render unconditionally.
 */
export function useTaskList(): readonly TaskSnapshot[] {
	const registry = useContext(Ctx);
	return useSyncExternalStore(
		(cb) => (registry ? registry.subscribe(() => cb()) : () => {}),
		() => (registry ? registry.snapshots : EMPTY_SNAPSHOTS),
		() => EMPTY_SNAPSHOTS,
	);
}
