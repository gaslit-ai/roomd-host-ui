"use client";

/**
 * Standalone UI resource browser.
 *
 * SEP-1865 says "UI resources are primarily discovered through tool metadata"
 * but does NOT preclude servers from exposing `ui://` resources directly via
 * `resources/list`. When that happens, the user may want to open them
 * independently — this panel provides the entrypoint.
 *
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import { AppRenderer } from "@mcp-ui/client";
import { LayersIcon } from "lucide-react";
import { type FC, useMemo, useState } from "react";
import {
	type UIResourceInfo,
	useMcpClient,
	useUIResources,
} from "@/components/providers/mcp-client-provider";
import { useMcpHostContext } from "@/components/providers/mcp-host-context-provider";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { childLog } from "@/lib/logger";
import { isUnsafeEvalAllowed } from "@/lib/mcp/flags";
import { confirmAndOpenLink } from "@/lib/mcp/link-confirm";

const log = childLog("mcp-apps:resource-panel");
const SANDBOX_URL_PATH = "/mcp-sandbox.html";
const STANDALONE_TOOL_NAME = "__ui_resource__";

export const ResourceUIPanel: FC = () => {
	const resources = useUIResources();
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<UIResourceInfo | null>(null);

	if (resources.length === 0) return null;

	return (
		<>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger asChild>
					<Button variant="outline" size="sm" className="gap-2">
						<LayersIcon className="size-4" />
						UI Resources ({resources.length})
					</Button>
				</DialogTrigger>
				<DialogContent className="max-w-xl">
					<DialogHeader>
						<DialogTitle>UI Resources</DialogTitle>
					</DialogHeader>
					<ul className="flex flex-col gap-1">
						{resources.map((resource) => (
							<li key={resource.uri}>
								<button
									type="button"
									onClick={() => {
										log.debug({ uri: resource.uri }, "open resource");
										setSelected(resource);
										setOpen(false);
									}}
									className="flex w-full flex-col items-start gap-0.5 rounded-md border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
								>
									<span className="font-medium">
										{resource.title ?? resource.name}
									</span>
									<span className="truncate text-muted-foreground text-xs">
										{resource.uri}
									</span>
									{resource.description ? (
										<span className="text-muted-foreground text-xs">
											{resource.description}
										</span>
									) : null}
								</button>
							</li>
						))}
					</ul>
				</DialogContent>
			</Dialog>

			{selected ? (
				<ResourceUIViewer
					resource={selected}
					onClose={() => {
						log.debug({ uri: selected.uri }, "close resource");
						setSelected(null);
					}}
				/>
			) : null}
		</>
	);
};

// ---------------------------------------------------------------------------
// Viewer dialog — mounts AppRenderer against a synthetic tool for a resource.
// ---------------------------------------------------------------------------

interface ViewerProps {
	resource: UIResourceInfo;
	onClose: () => void;
}

const ResourceUIViewer: FC<ViewerProps> = ({ resource, onClose }) => {
	const { client } = useMcpClient();
	const { hostContext } = useMcpHostContext();

	const sandboxUrl = useMemo(() => {
		if (typeof window === "undefined") return undefined;
		const url = new URL(SANDBOX_URL_PATH, window.location.origin);
		const clientLevel = process.env.NEXT_PUBLIC_LOG_LEVEL;
		if (clientLevel) url.searchParams.set("logLevel", clientLevel);
		if (isUnsafeEvalAllowed()) url.searchParams.set("unsafeEval", "1");
		return url;
	}, []);

	if (!client || !sandboxUrl) return null;

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-h-[90vh] max-w-[90vw] overflow-hidden p-0 sm:max-w-[90vw]">
				<DialogHeader className="border-b px-4 py-2">
					<DialogTitle className="text-sm">
						{resource.title ?? resource.name}
					</DialogTitle>
				</DialogHeader>
				<div className="h-[80vh] w-full">
					<AppRenderer
						client={client}
						// Standalone UI resources have no tool context. AppRenderer
						// requires a `toolName`; we supply a sentinel that a compliant
						// View will see in hostContext.toolInfo and know to treat as
						// standalone. Per spec §"Host Context" toolInfo is optional, so
						// non-aware Views will simply ignore it.
						toolName={STANDALONE_TOOL_NAME}
						toolResourceUri={resource.uri}
						sandbox={{ url: sandboxUrl }}
						hostContext={hostContext}
						onOpenLink={async ({ url }) => {
							await confirmAndOpenLink(url);
							return {};
						}}
						onError={(err) =>
							log.warn({ err, uri: resource.uri }, "resource viewer error")
						}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
};
