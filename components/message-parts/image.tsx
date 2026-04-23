import type { ImageMessagePartComponent } from "@assistant-ui/react";

// Renders inline images emitted by the assistant. The `image` field may be a
// URL or a data URI, so a plain <img> is the safe default.
export const ImagePart: ImageMessagePartComponent = ({ image, filename }) => {
	return (
		<div
			data-slot="aui_message-part-image"
			className="my-2 overflow-hidden rounded-lg border bg-muted/30"
		>
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img
				src={image}
				alt={filename ?? "Image"}
				className="max-h-[512px] w-auto max-w-full"
			/>
			{filename ? (
				<p className="border-t px-3 py-1.5 text-muted-foreground text-xs">
					{filename}
				</p>
			) : null}
		</div>
	);
};
