import type { FileMessagePartComponent } from "@assistant-ui/react";
import { FileIcon } from "lucide-react";

// Renders file payloads emitted by the assistant. Content is base64 plus a
// MIME type — expose as a download link rather than trying to render inline.
export const FilePart: FileMessagePartComponent = ({
	filename,
	data,
	mimeType,
}) => {
	const href = `data:${mimeType};base64,${data}`;
	const displayName = filename ?? `file.${extensionFor(mimeType)}`;
	return (
		<a
			href={href}
			download={displayName}
			data-slot="aui_message-part-file"
			className="my-2 inline-flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm transition-colors hover:bg-muted"
		>
			<FileIcon className="size-4 shrink-0 text-muted-foreground" />
			<span className="truncate">{displayName}</span>
			<span className="text-muted-foreground text-xs">{mimeType}</span>
		</a>
	);
};

function extensionFor(mimeType: string): string {
	const subtype = mimeType.split("/")[1] ?? "bin";
	return subtype.split("+")[0] ?? "bin";
}
