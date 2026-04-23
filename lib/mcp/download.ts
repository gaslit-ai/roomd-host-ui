/**
 * Host-mediated file downloads for MCP Apps (SEP-1865 §"ui/download-file").
 *
 * Views run in a sandboxed iframe where direct downloads are blocked; the host
 * accepts an `EmbeddedResource | ResourceLink` payload and triggers the
 * browser's download flow after user confirmation.
 */

import type {
	EmbeddedResource,
	ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";

export type DownloadContent = EmbeddedResource | ResourceLink;

function filenameFromUri(uri: string): string {
	try {
		const parsed = new URL(uri);
		const last = parsed.pathname.split("/").filter(Boolean).pop();
		if (last) return decodeURIComponent(last);
	} catch {
		const tail = uri.split("/").filter(Boolean).pop();
		if (tail) return tail;
	}
	return "download";
}

function base64ToBlob(b64: string, mimeType: string | undefined): Blob {
	const binary = atob(b64);
	const len = binary.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type: mimeType ?? "application/octet-stream" });
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.rel = "noopener";
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoke after the click handler has kicked off the download.
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function resourceLinkToBlob(link: ResourceLink): Promise<Blob> {
	const res = await fetch(link.uri, { credentials: "omit" });
	if (!res.ok) {
		throw new Error(
			`Failed to fetch ${link.uri}: ${res.status} ${res.statusText}`,
		);
	}
	return res.blob();
}

function embeddedToBlob(embedded: EmbeddedResource): Blob {
	const r = embedded.resource;
	if ("blob" in r) {
		return base64ToBlob(r.blob, r.mimeType);
	}
	return new Blob([r.text], { type: r.mimeType ?? "text/plain" });
}

function describeContent(content: DownloadContent): string {
	if (content.type === "resource_link") {
		return `${content.name ?? filenameFromUri(content.uri)}${
			content.size ? ` (${content.size} bytes)` : ""
		}`;
	}
	const r = content.resource;
	return `${filenameFromUri(r.uri)}${r.mimeType ? ` — ${r.mimeType}` : ""}`;
}

/**
 * Confirm + execute a `ui/download-file` request from a View.
 *
 * Returns the spec-shaped result: `{ isError?: true }` on user decline or
 * fetch failure, `{}` on success.
 */
export async function performDownload(
	contents: readonly DownloadContent[],
): Promise<{ isError?: boolean }> {
	if (contents.length === 0) return {};

	const summary = contents.map(describeContent).join("\n  - ");
	const confirmed =
		typeof window !== "undefined" &&
		window.confirm(
			`This app wants to download ${contents.length} file${
				contents.length === 1 ? "" : "s"
			}:\n\n  - ${summary}\n\nAllow?`,
		);
	if (!confirmed) return { isError: true };

	for (const content of contents) {
		try {
			if (content.type === "resource_link") {
				const blob = await resourceLinkToBlob(content);
				triggerBrowserDownload(
					blob,
					content.name ?? filenameFromUri(content.uri),
				);
			} else {
				const blob = embeddedToBlob(content);
				triggerBrowserDownload(blob, filenameFromUri(content.resource.uri));
			}
		} catch {
			return { isError: true };
		}
	}
	return {};
}
