"use client";

/**
 * Shell that wraps an MCP App View and presents it in the active display mode
 * (SEP-1865 §"Display Modes"): `inline`, `fullscreen`, or `pip`.
 *
 * **Single mount point across modes.** Switching modes must not reload the
 * iframe — the View owns live state (audio unlock, subscriptions, dirty
 * buffers). React reconciles by (component-type, position), so conditionally
 * returning a `<Dialog>` in one mode and a `<div>` in another would unmount
 * the subtree and destroy the iframe. Instead the shell renders a single DOM
 * tree in every mode: one outer container whose `position`, dimensions, and
 * chrome toggle via CSS + inline style. The `children` slot sits at a fixed
 * position in the element tree so React preserves the mount across mode
 * flips. Null placeholders are used for conditional chrome so slot indices
 * stay stable.
 *
 * PIP uses native browser primitives — `resize: both` + Pointer Events — so
 * no third-party drag/resize dependency is required. Multiple open PIPs are
 * coordinated by {@link usePipSlot} (registry in `lib/mcp/pip-registry`).
 * Fullscreen is rendered in-place as a fixed-inset surface with its own
 * backdrop + Escape-key dismiss; it deliberately does not use Radix Dialog,
 * which would portal the subtree to `document.body` and remount the iframe.
 *
 * Chrome buttons for switching modes are gated on `availableModes`, which the
 * caller computes as the intersection of host-supported modes and the View's
 * declared `appCapabilities.availableDisplayModes` — spec: "Host MUST NOT
 * switch the View to a display mode that does not appear in its
 * `appCapabilities.availableDisplayModes`, if set."
 *
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
	GripHorizontalIcon,
	Maximize2Icon,
	Minimize2Icon,
	PictureInPicture2Icon,
	XIcon,
} from "lucide-react";
import {
	type CSSProperties,
	type FC,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { usePipSlot } from "@/lib/mcp/pip-registry";
import { cn } from "@/lib/utils";

type DisplayMode = NonNullable<McpUiHostContext["displayMode"]>;

export interface DisplayModeShellProps {
	/**
	 * Stable per-widget identifier used by the PIP registry
	 * (`lib/mcp/pip-registry`) to coordinate cascade offset and stacking among
	 * multiple open PIPs. Callers should pass the tool-call id.
	 */
	slotId: string;
	mode: DisplayMode;
	title?: string;
	/** When true, wrap inline content with a visible border per `_meta.ui.prefersBorder`. */
	prefersBorder?: boolean;
	/**
	 * Modes the host chrome is allowed to switch to — typically the intersection
	 * of host-supported modes and the View's declared `availableDisplayModes`.
	 * Defaults to `["inline"]` which hides all switch affordances (View is
	 * display-mode-naive or still initializing).
	 */
	availableModes?: ReadonlyArray<DisplayMode>;
	onRequestMode: (mode: DisplayMode) => void;
	children: ReactNode;
}

const DEFAULT_MODES: ReadonlyArray<DisplayMode> = ["inline"];
const PIP_DEFAULT = { width: 480, height: 540 } as const;
const PIP_MIN = { width: 320, height: 260 } as const;
const PIP_MARGIN = 16;
const PIP_CASCADE_STEP = 24;
const PIP_Z_BASE = 50;
const FULLSCREEN_Z = 60;

export const DisplayModeShell: FC<DisplayModeShellProps> = ({
	slotId,
	mode,
	title,
	prefersBorder,
	availableModes = DEFAULT_MODES,
	onRequestMode,
	children,
}) => {
	const canFullscreen = availableModes.includes("fullscreen");
	const canPip = availableModes.includes("pip");
	const canInline = availableModes.includes("inline");

	const isPip = mode === "pip";
	const isFullscreen = mode === "fullscreen";
	const isInline = mode === "inline";

	// PIP registry is only active when we're actually in PIP mode so that
	// inline widgets don't show up in the cascade. The shell itself stays
	// mounted across mode switches, but the *slot* comes and goes with mode.
	const { cascadeIndex, zRank, bringToFront } = usePipSlot(slotId, isPip);

	// PIP drag state. Pointer Events give us unified mouse+touch handling and
	// pointer capture so the drag survives even if the cursor briefly leaves
	// the header mid-drag.
	const containerRef = useRef<HTMLDivElement>(null);
	const dragStartRef = useRef<{
		pointerId: number;
		clientX: number;
		clientY: number;
		originX: number;
		originY: number;
	} | null>(null);
	// `null` = use default cascade anchor (bottom-right). Once the user drags
	// we switch to absolute left/top so the user's choice sticks — preserved
	// across mode flips so re-entering PIP returns to the same spot.
	const [pipPos, setPipPos] = useState<{ x: number; y: number } | null>(null);

	const clampToViewport = useCallback((x: number, y: number) => {
		const el = containerRef.current;
		if (typeof window === "undefined") return { x, y };
		const w = el?.offsetWidth ?? PIP_DEFAULT.width;
		const h = el?.offsetHeight ?? PIP_DEFAULT.height;
		const maxX = Math.max(0, window.innerWidth - w);
		const maxY = Math.max(0, window.innerHeight - h);
		return {
			x: Math.min(Math.max(0, x), maxX),
			y: Math.min(Math.max(0, y), maxY),
		};
	}, []);

	// Re-clamp on window resize so a dragged PIP doesn't end up off-screen
	// after the viewport shrinks. Only runs while a custom position is set.
	useEffect(() => {
		if (!isPip || pipPos == null) return;
		const onResize = () =>
			setPipPos((prev) => (prev ? clampToViewport(prev.x, prev.y) : prev));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [isPip, pipPos, clampToViewport]);

	// Fullscreen dismissal: Escape key. Only wired while in fullscreen AND
	// returning to inline is allowed by the View's declared capabilities.
	useEffect(() => {
		if (!isFullscreen || !canInline) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onRequestMode("inline");
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isFullscreen, canInline, onRequestMode]);

	const handlePointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			if (!isPip) return;
			if (e.button !== 0) return;
			// Let clicks on header-embedded buttons (dock, fullscreen) through.
			if ((e.target as HTMLElement).closest("button")) return;
			const el = containerRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			dragStartRef.current = {
				pointerId: e.pointerId,
				clientX: e.clientX,
				clientY: e.clientY,
				originX: rect.left,
				originY: rect.top,
			};
			e.currentTarget.setPointerCapture(e.pointerId);
		},
		[isPip],
	);

	const handlePointerMove = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			const start = dragStartRef.current;
			if (!start || start.pointerId !== e.pointerId) return;
			const dx = e.clientX - start.clientX;
			const dy = e.clientY - start.clientY;
			setPipPos(clampToViewport(start.originX + dx, start.originY + dy));
		},
		[clampToViewport],
	);

	const handlePointerUp = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			const start = dragStartRef.current;
			if (!start || start.pointerId !== e.pointerId) return;
			dragStartRef.current = null;
			try {
				e.currentTarget.releasePointerCapture(e.pointerId);
			} catch {
				// Safari can throw if capture was already released.
			}
		},
		[],
	);

	// Compute outer container styling. CSS-only mode switching keeps the
	// React element tree stable → iframe stays mounted. Width is scoped to
	// inline mode (`w-full`); PIP uses the inline-style width, fullscreen
	// uses `inset-4`, so the element never fights its own width rule.
	const outerClass = cn(
		"group/mcp-shell flex flex-col overflow-hidden bg-background",
		isInline && "relative w-full",
		isInline && prefersBorder && "rounded-lg border bg-background",
		isPip && "fixed rounded-xl border shadow-lg",
		isFullscreen && "fixed inset-4 rounded-xl border shadow-2xl sm:inset-6",
	);

	const outerStyle: CSSProperties = isPip
		? {
				zIndex: PIP_Z_BASE + zRank,
				width: PIP_DEFAULT.width,
				height: PIP_DEFAULT.height,
				minWidth: PIP_MIN.width,
				minHeight: PIP_MIN.height,
				maxWidth: "min(90vw, 1080px)",
				maxHeight: "90vh",
				resize: "both",
				...(pipPos
					? { left: pipPos.x, top: pipPos.y }
					: {
							right: PIP_MARGIN + cascadeIndex * PIP_CASCADE_STEP,
							bottom: PIP_MARGIN + cascadeIndex * PIP_CASCADE_STEP,
						}),
			}
		: isFullscreen
			? { zIndex: FULLSCREEN_Z }
			: {};

	// `role` is always set so the outer div never hits biome's
	// `noStaticElementInteractions` false positive, and so screen readers get
	// consistent semantics across modes. `dialog` for modal-ish modes,
	// `group` for inline (the widget is one logical control group).
	const outerRole: "dialog" | "group" =
		isFullscreen || isPip ? "dialog" : "group";

	// Chrome slots. Conditionals emit `null` rather than skipping so the
	// child-array index of the content `<div>` stays constant across modes —
	// React only reconciles the mounted iframe when that index is stable.
	const headerSlot =
		isPip || isFullscreen ? (
			<ShellHeader
				title={title}
				draggable={isPip}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				mode={mode}
				canFullscreen={canFullscreen}
				canPip={canPip}
				canInline={canInline}
				onRequestMode={onRequestMode}
			/>
		) : null;

	const chromeSlot =
		isInline && (canFullscreen || canPip) ? (
			<InlineChrome
				canFullscreen={canFullscreen}
				canPip={canPip}
				onRequestMode={onRequestMode}
			/>
		) : null;

	return (
		<>
			{/* Fullscreen backdrop — a sibling, not a parent of the iframe, so
			    mounting/unmounting the backdrop never touches the iframe's
			    React position. */}
			{isFullscreen ? (
				<div
					className="fixed inset-0 bg-black/60 backdrop-blur-sm"
					style={{ zIndex: FULLSCREEN_Z - 1 }}
					onClick={canInline ? () => onRequestMode("inline") : undefined}
					aria-hidden
				/>
			) : null}
			{/*
			  `onPointerDownCapture` fires for clicks on our own chrome; `onFocus`
			  covers clicks that land inside the iframe (focus bubbles to the
			  parent even from cross-origin frames), so either interaction
			  brings the PIP to the top of the stack.
			*/}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: dynamic role ("dialog" for pip/fullscreen, "group" for inline) satisfies the intent; biome can't narrow dynamic role attributes at lint time. */}
			{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: `aria-modal` is only emitted when isFullscreen=true (role="dialog"); biome can't correlate the two conditionals. */}
			<div
				ref={containerRef}
				data-slot="aui_mcp-shell"
				data-mode={mode}
				role={outerRole}
				aria-modal={isFullscreen ? true : undefined}
				aria-label={title ?? "MCP App"}
				className={outerClass}
				style={outerStyle}
				onPointerDownCapture={isPip ? bringToFront : undefined}
				onFocus={isPip ? bringToFront : undefined}
			>
				{headerSlot}
				<div
					data-slot="aui_mcp-content"
					className={cn("min-h-0 w-full", (isPip || isFullscreen) && "flex-1")}
				>
					{children}
				</div>
				{chromeSlot}
			</div>
		</>
	);
};

// ---------------------------------------------------------------------------
// Shell chrome — stateless presentation
// ---------------------------------------------------------------------------

interface ShellHeaderProps {
	title?: string;
	draggable: boolean;
	onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
	onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
	onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
	mode: DisplayMode;
	canFullscreen: boolean;
	canPip: boolean;
	canInline: boolean;
	onRequestMode: (mode: DisplayMode) => void;
}

const ShellHeader: FC<ShellHeaderProps> = ({
	title,
	draggable,
	onPointerDown,
	onPointerMove,
	onPointerUp,
	mode,
	canFullscreen,
	canPip,
	canInline,
	onRequestMode,
}) => (
	<div
		data-slot="aui_mcp-shell-header"
		className={cn(
			"flex shrink-0 items-center justify-between gap-1 border-b bg-muted/40 px-2 py-1 text-sm",
			draggable && "cursor-grab touch-none select-none active:cursor-grabbing",
		)}
		onPointerDown={draggable ? onPointerDown : undefined}
		onPointerMove={draggable ? onPointerMove : undefined}
		onPointerUp={draggable ? onPointerUp : undefined}
		onPointerCancel={draggable ? onPointerUp : undefined}
	>
		<div className="flex min-w-0 items-center gap-1">
			{draggable ? (
				<GripHorizontalIcon
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-hidden
				/>
			) : null}
			<span className="truncate font-medium">{title ?? "MCP App"}</span>
		</div>
		<div className="flex shrink-0 items-center gap-1">
			{mode === "fullscreen" && canPip ? (
				<ModeButton
					icon={<PictureInPicture2Icon className="size-3.5" />}
					label="Pop out"
					onClick={() => onRequestMode("pip")}
				/>
			) : null}
			{mode === "pip" && canFullscreen ? (
				<ModeButton
					icon={<Maximize2Icon className="size-3.5" />}
					label="Fullscreen"
					onClick={() => onRequestMode("fullscreen")}
				/>
			) : null}
			{canInline ? (
				<ModeButton
					icon={
						mode === "pip" ? (
							<XIcon className="size-4" />
						) : (
							<Minimize2Icon className="size-3.5" />
						)
					}
					label="Dock"
					onClick={() => onRequestMode("inline")}
				/>
			) : null}
		</div>
	</div>
);

interface InlineChromeProps {
	canFullscreen: boolean;
	canPip: boolean;
	onRequestMode: (mode: DisplayMode) => void;
}

const InlineChrome: FC<InlineChromeProps> = ({
	canFullscreen,
	canPip,
	onRequestMode,
}) => (
	// Hover/focus-reveal: chrome stays hidden at rest so it doesn't obscure
	// the ToolStatusHeader text, fades in when the widget is hovered or
	// receives keyboard focus. `pointer-events-none` on the wrapper with
	// `pointer-events-auto` on each button means the overlay never swallows
	// clicks on the underlying iframe.
	<div
		data-slot="aui_mcp-inline-chrome"
		className="pointer-events-none absolute top-1 right-1 z-10 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-focus-within/mcp-shell:opacity-100 group-hover/mcp-shell:opacity-100"
	>
		{canPip ? (
			<ModeButton
				icon={<PictureInPicture2Icon className="size-3.5" />}
				label="Pop out"
				className="pointer-events-auto bg-background/80 shadow-sm backdrop-blur-sm"
				onClick={() => onRequestMode("pip")}
			/>
		) : null}
		{canFullscreen ? (
			<ModeButton
				icon={<Maximize2Icon className="size-3.5" />}
				label="Fullscreen"
				className="pointer-events-auto bg-background/80 shadow-sm backdrop-blur-sm"
				onClick={() => onRequestMode("fullscreen")}
			/>
		) : null}
	</div>
);

interface ModeButtonProps {
	icon: ReactNode;
	label: string;
	className?: string;
	onClick: () => void;
}

const ModeButton: FC<ModeButtonProps> = ({
	icon,
	label,
	className,
	onClick,
}) => (
	<Button
		size="icon"
		variant="ghost"
		className={cn("size-6", className)}
		onClick={onClick}
		aria-label={label}
		title={label}
	>
		{icon}
	</Button>
);
