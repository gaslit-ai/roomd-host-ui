/**
 * `useContainerDimensions` — observe the size of a host-owned container
 * element and surface it as `HostContext.containerDimensions` for a
 * SEP-1865 View.
 *
 * SEP-1865 §"Container Dimensions" defines two modes per-axis:
 *   - Fixed    (`width` / `height`)   — host controls; view fills
 *   - Flexible (`maxWidth` / `maxHeight`) — view determines, up to limit
 *   - Unbounded (field omitted)        — view determines, no limit
 *
 * This host is a chat UI: wrapper width is constrained by CSS (fixed
 * visually) but vertical space is effectively unbounded (the thread
 * scrolls). We therefore report `maxWidth` from the observed wrapper and
 * leave height unbounded, letting the View send `ui/notifications/size-changed`
 * notifications to grow into the space it needs.
 *
 * Updates are emitted via `ResizeObserver` and rAF-throttled so bursty
 * resize events (window drag, layout settle) coalesce into at most one
 * `setHostContext` call per frame. `AppBridge.setHostContext` then diffs
 * against the previous value and only pushes
 * `ui/notifications/host-context-changed` when the numbers actually change,
 * so redundant frames are cheap.
 */

import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { type RefObject, useEffect, useState } from "react";

export type ContainerDimensions = NonNullable<
	McpUiHostContext["containerDimensions"]
>;

/**
 * Observe `ref`'s bounding box and return a `containerDimensions` object
 * suitable for merging into `HostContext`. Returns `undefined` until the
 * first measurement lands (avoids sending a zero-valued initial update).
 */
export function useContainerDimensions(
	ref: RefObject<HTMLElement | null>,
): ContainerDimensions | undefined {
	const [dims, setDims] = useState<ContainerDimensions | undefined>(undefined);

	useEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;

		let pending: number | null = null;
		let latest: { width: number; height: number } | null = null;

		const flush = () => {
			pending = null;
			if (!latest) return;
			const { width } = latest;
			// Flexible width (`maxWidth`), unbounded height. See file header for
			// rationale. If the host layout ever gives views a fixed height too,
			// add `maxHeight: height` here.
			const nextMaxWidth = Math.round(width);
			setDims((prev) => {
				// `ContainerDimensions` is an intersection of two unions
				// (`{height|maxHeight} & {width|maxWidth}`), so TypeScript can't
				// narrow `prev.maxWidth` via optional chain — use an `in` guard
				// to read the current flexible-width value.
				const prevMaxWidth =
					prev && "maxWidth" in prev ? prev.maxWidth : undefined;
				return prevMaxWidth === nextMaxWidth ? prev : { maxWidth: nextMaxWidth };
			});
		};

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			const box = entry.contentBoxSize?.[0];
			latest = box
				? { width: box.inlineSize, height: box.blockSize }
				: {
						width: entry.contentRect.width,
						height: entry.contentRect.height,
					};
			if (pending === null) pending = requestAnimationFrame(flush);
		});

		observer.observe(el);
		return () => {
			observer.disconnect();
			if (pending !== null) cancelAnimationFrame(pending);
		};
	}, [ref]);

	return dims;
}
