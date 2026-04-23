"use client";

/**
 * Popover body for the slash-command typeahead. Positioned absolutely
 * above the composer shell — the primitive does NOT portal. Chips render
 * one item per row with label + description; `data-highlighted` reflects
 * the keyboard focus managed by the primitive.
 *
 * Paired with `ComposerPrimitive.Unstable_SlashCommandRoot` in the
 * enclosing composer; only renders when a `/` trigger is active in the
 * input (the primitive gates visibility via `detectTrigger`).
 */

import { ComposerPrimitive } from "@assistant-ui/react";
import type { FC } from "react";
import { cn } from "@/lib/utils";

export const SlashCommandPopover: FC = () => {
	return (
		<ComposerPrimitive.Unstable_TriggerPopoverPopover
			className={cn(
				"absolute bottom-full left-0 z-30 mb-1 flex w-full max-w-md flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md",
				"data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
				"data-[state=open]:animate-in data-[state=open]:fade-in-0",
			)}
		>
			<ComposerPrimitive.Unstable_TriggerPopoverItems className="flex max-h-72 flex-col overflow-y-auto p-1">
				{(items) =>
					items.length === 0 ? (
						<div className="px-3 py-2 text-muted-foreground text-sm">
							No matching prompts
						</div>
					) : (
						items.map((item) => (
							<ComposerPrimitive.Unstable_TriggerPopoverItem
								key={item.id}
								item={item}
								className={cn(
									"flex cursor-pointer flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-sm outline-none",
									"hover:bg-accent hover:text-accent-foreground",
									"data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
								)}
							>
								<div className="flex w-full items-center gap-2">
									{item.icon ? (
										// biome-ignore lint/performance/noImgElement: icons come from arbitrary MCP servers; next/image needs an allowlist of remote domains we can't enumerate at build time.
										<img
											src={item.icon}
											alt=""
											className="size-4 shrink-0 rounded-sm"
										/>
									) : (
										<span
											aria-hidden="true"
											className="inline-block size-4 shrink-0 rounded-sm bg-muted"
										/>
									)}
									<span className="truncate font-medium">{item.label}</span>
									<span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
										{item.id}
									</span>
								</div>
								{item.description ? (
									<div className="line-clamp-2 pl-6 text-muted-foreground text-xs">
										{item.description}
									</div>
								) : null}
							</ComposerPrimitive.Unstable_TriggerPopoverItem>
						))
					)
				}
			</ComposerPrimitive.Unstable_TriggerPopoverItems>
		</ComposerPrimitive.Unstable_TriggerPopoverPopover>
	);
};
