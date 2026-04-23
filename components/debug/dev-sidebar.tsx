"use client";

/**
 * Dev-only floating toggle + right-aligned slide-out panel that tails the
 * raw SSE event stream from `/api/chat`. Pattern mirrors TanStack Query
 * Devtools / Redux DevTools — a small chrome button that doesn't take chat
 * real estate until opened.
 *
 * Each line is a verbatim `data:` payload from the AI SDK stream protocol,
 * rendered one-per-row. Nothing is parsed or aggregated; the point is to
 * see what the server actually sent.
 *
 * Renders nothing in production builds.
 */

import { BugIcon, XIcon } from "lucide-react";
import { type FC, useState, useSyncExternalStore } from "react";
import {
	clear,
	type DevEvent,
	getEvents,
	subscribe,
} from "@/lib/dev-event-log";
import { cn } from "@/lib/utils";

export const DevSidebar: FC = () => {
	if (process.env.NODE_ENV === "production") return null;
	return <DevSidebarImpl />;
};

const DevSidebarImpl: FC = () => {
	const [open, setOpen] = useState(false);
	const events = useSyncExternalStore(subscribe, getEvents, getEvents);

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="fixed bottom-4 left-4 z-50 flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 font-mono text-xs shadow-md transition-colors hover:bg-muted"
				aria-label={open ? "Close dev panel" : "Open dev panel"}
				aria-expanded={open}
			>
				<BugIcon className="size-3.5" />
				<span>DEV</span>
				{events.length > 0 ? (
					<span className="text-muted-foreground">({events.length})</span>
				) : null}
			</button>
			<aside
				aria-hidden={!open}
				// `inert` removes the panel from focus order when closed; without
				// it, Tab would hit buttons translated off-screen.
				inert={!open}
				className={cn(
					"fixed top-0 right-0 z-40 flex h-full w-[560px] max-w-[95vw] flex-col border-l bg-background shadow-2xl transition-transform",
					open ? "translate-x-0" : "translate-x-full",
				)}
			>
				<header className="flex items-center justify-between gap-2 border-b px-4 py-2">
					<div className="flex items-center gap-2">
						<BugIcon className="size-4 text-muted-foreground" />
						<h2 className="font-semibold text-sm">Event stream</h2>
						<span className="text-muted-foreground text-xs">
							{events.length} event{events.length === 1 ? "" : "s"}
						</span>
					</div>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={clear}
							className="rounded px-2 py-1 text-muted-foreground text-xs hover:bg-muted"
						>
							Clear
						</button>
						<button
							type="button"
							onClick={() => setOpen(false)}
							className="rounded p-1 hover:bg-muted"
							aria-label="Close"
						>
							<XIcon className="size-4" />
						</button>
					</div>
				</header>
				<EventList events={events} />
			</aside>
		</>
	);
};

const EventList: FC<{ events: readonly DevEvent[] }> = ({ events }) => {
	if (events.length === 0) {
		return (
			<div className="flex-1 p-4 text-muted-foreground text-xs italic">
				No events yet. Send a message to see the stream.
			</div>
		);
	}

	// `flex-col-reverse` keeps the viewport anchored to the newest entry
	// without JS: the scrollbar's "bottom" is the start of the DOM order, so
	// new items pushed onto the front stay in view. We feed the array in
	// reverse so visual order matches append order (oldest → newest,
	// top → bottom).
	return (
		<div className="flex flex-1 flex-col-reverse overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-relaxed">
			<div>
				{events.map((e) => (
					<div key={e.seq} className="border-border/50 border-b px-1 py-0.5">
						{e.line}
					</div>
				))}
			</div>
		</div>
	);
};
