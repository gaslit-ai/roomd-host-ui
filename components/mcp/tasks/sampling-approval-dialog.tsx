"use client";

/**
 * User-approval modal for `sampling/createMessage` requests.
 *
 * Spec §"Sampling" (2025-11-25): servers MAY request that the host invoke its
 * LLM and return the response. Hosts MUST obtain user consent before invoking
 * the LLM on behalf of a server — this dialog is that consent step. On
 * approval, we proxy the request to `/api/sample` (Anthropic/OpenAI-backed)
 * and return the CreateMessageResult; on rejection, the SDK's request path
 * sees a rejection with error code -32000 and the server learns the user
 * declined.
 *
 * https://modelcontextprotocol.io/specification/2025-11-25/client/sampling
 *
 * Subjective UX: we show the proposed messages raw (role + text-or-elided-
 * media) so the user can see what the server wants to send. Advanced gating
 * (per-server policy, always-allow toggles) is explicitly out of scope — the
 * consent model here is per-request, which is spec-correct baseline.
 */

import type {
	CreateMessageRequest,
	CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
	createContext,
	type FC,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { childLog } from "@/lib/logger";

const log = childLog("sampling");

type SamplingParams = CreateMessageRequest["params"];

export type RequestSamplingFn = (
	params: SamplingParams,
) => Promise<CreateMessageResult>;

/**
 * Spec-sanctioned rejection signal. When the handler throws with this shape,
 * the SDK maps it to a JSON-RPC error the server can inspect.
 */
export class SamplingDeclinedError extends Error {
	readonly code = -32000;
	constructor(message = "Sampling declined by user") {
		super(message);
		this.name = "SamplingDeclinedError";
	}
}

const Ctx = createContext<RequestSamplingFn | null>(null);

export function useRequestSampling(): RequestSamplingFn {
	const fn = useContext(Ctx);
	if (!fn) {
		throw new Error(
			"useRequestSampling must be used inside <SamplingApprovalProvider>",
		);
	}
	return fn;
}

interface Pending {
	readonly params: SamplingParams;
	readonly resolve: (r: CreateMessageResult) => void;
	readonly reject: (e: Error) => void;
}

export const SamplingApprovalProvider: FC<{ children: ReactNode }> = ({
	children,
}) => {
	const [pending, setPending] = useState<Pending | null>(null);

	const requestSampling = useCallback<RequestSamplingFn>((params) => {
		return new Promise<CreateMessageResult>((resolve, reject) => {
			setPending({ params, resolve, reject });
		});
	}, []);

	const approveAndClose = useCallback(async () => {
		// Snapshot + clear BEFORE the network call so a second approve can't
		// double-fire; if /api/sample rejects, we still reject the original
		// promise (the server sees the error) — we don't try to re-open.
		const p = pending;
		if (!p) return;
		setPending(null);
		try {
			const res = await fetch("/api/sample", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(p.params),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`sample ${res.status}: ${text || res.statusText}`);
			}
			const body = (await res.json()) as CreateMessageResult;
			p.resolve(body);
		} catch (err) {
			log.warn({ err }, "sampling request failed");
			p.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}, [pending]);

	const rejectAndClose = useCallback(() => {
		setPending((p) => {
			p?.reject(new SamplingDeclinedError());
			return null;
		});
	}, []);

	return (
		<Ctx.Provider value={requestSampling}>
			{children}
			<Dialog
				open={pending !== null}
				onOpenChange={(open) => {
					// Backdrop / Escape = implicit decline. Spec doesn't distinguish
					// explicit vs implicit sampling rejection, so both surface as
					// SamplingDeclinedError to the server.
					if (!open) rejectAndClose();
				}}
			>
				<DialogContent className="sm:max-w-lg">
					{pending ? (
						<SamplingApprovalBody
							params={pending.params}
							onApprove={approveAndClose}
							onReject={rejectAndClose}
						/>
					) : null}
				</DialogContent>
			</Dialog>
		</Ctx.Provider>
	);
};

const SamplingApprovalBody: FC<{
	readonly params: SamplingParams;
	readonly onApprove: () => void;
	readonly onReject: () => void;
}> = ({ params, onApprove, onReject }) => {
	const relatedTaskId =
		params._meta?.["io.modelcontextprotocol/related-task"]?.taskId;
	const modelHint = params.modelPreferences?.hints?.[0]?.name;

	return (
		<div className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>Allow server to use your LLM?</DialogTitle>
				<DialogDescription>
					A connected MCP server is asking to run a completion on your behalf.
					Review the request and approve or decline.
				</DialogDescription>
				<div className="flex flex-wrap gap-3 text-muted-foreground text-xs">
					{relatedTaskId ? (
						<span className="font-mono">task {relatedTaskId}</span>
					) : null}
					{modelHint ? <span>model hint: {modelHint}</span> : null}
					<span>maxTokens: {params.maxTokens}</span>
				</div>
			</DialogHeader>
			{params.systemPrompt ? (
				<section className="flex flex-col gap-1">
					<h3 className="font-semibold text-xs uppercase tracking-wide">
						System
					</h3>
					<p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded border bg-muted/30 p-2 text-xs">
						{params.systemPrompt}
					</p>
				</section>
			) : null}
			<section className="flex flex-col gap-2">
				<h3 className="font-semibold text-xs uppercase tracking-wide">
					Messages
				</h3>
				<div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
					{params.messages.map((m) => (
						<MessagePreview
							// Content-derived key: biome rejects array index as key.
							// The messages array is immutable within a single approval
							// request and rarely contains exact duplicates. We salt
							// with role+first-char-of-content to tolerate accidental
							// collisions in synthetic test cases.
							key={messageKey(m)}
							role={m.role}
							content={m.content}
						/>
					))}
				</div>
			</section>
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onReject}>
					Decline
				</Button>
				<Button type="button" onClick={onApprove}>
					Approve
				</Button>
			</DialogFooter>
		</div>
	);
};

const MessagePreview: FC<{
	role: "user" | "assistant";
	content: SamplingParams["messages"][number]["content"];
}> = ({ role, content }) => {
	const text = extractPreviewText(content);
	return (
		<div className="rounded border bg-muted/30 p-2 text-xs">
			<div className="mb-1 font-semibold text-muted-foreground uppercase tracking-wide">
				{role}
			</div>
			<div className="whitespace-pre-wrap break-words">{text}</div>
		</div>
	);
};

function extractPreviewText(
	content: SamplingParams["messages"][number]["content"],
): string {
	// The content union covers text, image, audio, tool_use, tool_result, and
	// arrays of blocks. For the approval modal we only need enough to judge
	// the intent — elide media to bracketed placeholders.
	if (Array.isArray(content)) {
		return content.map((c) => previewOne(c)).join("\n\n");
	}
	return previewOne(content);
}

function messageKey(m: SamplingParams["messages"][number]): string {
	// Hash is overkill for a half-dozen items; slicing content gives a
	// stable-enough key without adding a dependency. Including the role
	// prevents user↔assistant duplicates from colliding on identical text.
	const text = extractPreviewText(m.content).slice(0, 48);
	return `${m.role}:${text}`;
}

function previewOne(block: unknown): string {
	if (typeof block !== "object" || block === null) return "[unknown]";
	const b = block as { type?: string; text?: string; name?: string };
	if (b.type === "text" && typeof b.text === "string") return b.text;
	if (b.type === "image") return "[image]";
	if (b.type === "audio") return "[audio]";
	if (b.type === "tool_use") return `[tool_use: ${b.name ?? ""}]`;
	if (b.type === "tool_result") return "[tool_result]";
	return `[${b.type ?? "unknown"}]`;
}
