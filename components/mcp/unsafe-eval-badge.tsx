"use client";

/**
 * Visible dev indicator rendered in the app header whenever the
 * `NEXT_PUBLIC_DANGEROUSLY_ALLOW_UNSAFE_EVAL` flag is on.
 *
 * Rationale:
 *   - The flag relaxes the MCP Apps sandbox CSP to permit `'unsafe-eval'`.
 *   - Users and reviewers need an obvious signal that this is active — but
 *     not so loud it looks like a runtime error. A small chip with hover
 *     explanation hits that balance.
 *   - Renders nothing when the flag is off, so production builds without the
 *     env var show zero chrome.
 *
 * See `@/lib/mcp/flags.ts` for the flag definition + threat model.
 */

import { ShieldAlertIcon } from "lucide-react";
import type { FC } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { isUnsafeEvalAllowed } from "@/lib/mcp/flags";

export const UnsafeEvalBadge: FC = () => {
	if (!isUnsafeEvalAllowed()) return null;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					data-slot="mcp-unsafe-eval-badge"
					role="status"
					aria-label="Unsafe eval allowed in MCP App sandbox (dev mode)"
					className="inline-flex cursor-help items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 text-xs dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300"
				>
					<ShieldAlertIcon className="size-3" aria-hidden />
					<span>Unsafe eval</span>
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-xs text-left">
				<p className="font-medium">MCP App sandbox allows dynamic eval</p>
				<p className="mt-1 text-muted-foreground">
					The sandbox CSP includes{" "}
					<code className="rounded bg-muted px-1 py-0.5 text-[10px]">
						'unsafe-eval'
					</code>{" "}
					so widgets that call{" "}
					<code className="rounded bg-muted px-1 py-0.5 text-[10px]">
						new Function(…)
					</code>{" "}
					or{" "}
					<code className="rounded bg-muted px-1 py-0.5 text-[10px]">
						eval(…)
					</code>{" "}
					can run. This is less secure — only use with MCP servers you trust.
				</p>
				<p className="mt-1 text-muted-foreground">
					Disable by unsetting{" "}
					<code className="rounded bg-muted px-1 py-0.5 text-[10px]">
						NEXT_PUBLIC_DANGEROUSLY_ALLOW_UNSAFE_EVAL
					</code>
					.
				</p>
			</TooltipContent>
		</Tooltip>
	);
};
