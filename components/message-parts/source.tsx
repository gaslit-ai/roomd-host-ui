import type { SourceMessagePartComponent } from "@assistant-ui/react";
import { ExternalLinkIcon } from "lucide-react";

// Renders URL citations emitted by the assistant as a small footnote-style
// chip. Consecutive sources stack horizontally via flex-wrap on the parent.
export const SourcePart: SourceMessagePartComponent = ({ url, title }) => {
	const label = title ?? hostnameOf(url) ?? url;
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			data-slot="aui_message-part-source"
			className="my-1 mr-1 inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
		>
			<ExternalLinkIcon className="size-3 shrink-0" />
			<span className="truncate">{label}</span>
		</a>
	);
};

function hostnameOf(url: string): string | null {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return null;
	}
}
