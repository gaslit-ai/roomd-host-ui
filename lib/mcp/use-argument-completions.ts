"use client";

/**
 * React hook over MCP `completion/complete` for a single prompt argument.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion
 *
 * Hook behavior maps one-to-one to the spec's normative SHOULDs for clients:
 * - **Debounce** rapid requests — 150ms `setTimeout` per key change.
 * - **Cache** results — in-hook LRU keyed by `(argName, value, contextSig)`,
 *   soft cap at 64 entries per hook instance (ample for a dialog session).
 * - **Handle missing/partial results gracefully** — any error resolves to an
 *   empty values list with `error` surfaced for telemetry only; the UI hides
 *   the dropdown rather than surfacing a toast.
 *
 * The spec also says "clients should include previous completions in the
 * `context.arguments` object." We filter out empty values before sending so
 * the server doesn't interpret an unfilled field as `""`.
 *
 * Capability-gated — when the server doesn't advertise `completions`
 * (see `capabilities.completions` in `ServerCapabilities`), the hook is a
 * no-op passthrough: no state transitions, no requests.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useEffect, useRef, useState } from "react";
import { useMcpClient } from "@/components/providers/mcp-client-provider";
import { childLog } from "@/lib/logger";

const log = childLog("completions");

const DEBOUNCE_MS = 150;
const CACHE_CAP = 64;

export interface ArgumentCompletionsState {
	readonly values: readonly string[];
	readonly hasMore: boolean;
	readonly loading: boolean;
	/** Present if the last fetch errored. UI hides the dropdown; diagnostic only. */
	readonly error: Error | null;
}

const EMPTY: ArgumentCompletionsState = {
	values: [],
	hasMore: false,
	loading: false,
	error: null,
};

interface CacheEntry {
	readonly values: readonly string[];
	readonly hasMore: boolean;
}

export function useArgumentCompletions(
	promptName: string,
	argName: string,
	value: string,
	contextArgs: Record<string, string>,
	enabled: boolean,
): ArgumentCompletionsState {
	const { client, supportsCompletions } = useMcpClient();
	const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
	const [state, setState] = useState<ArgumentCompletionsState>(EMPTY);

	// Stable cache/dep key — encodes every input that affects the wire call.
	// `contextSig` filters empty values (an unset arg is not `""` per spec)
	// and sorts for stability across re-renders that hand us new object refs
	// with the same contents.
	const contextSig = stableContextSig(contextArgs);
	const key = `${argName}\u0000${value}\u0000${contextSig}`;

	// Hold the live inputs in a ref so the effect can read them without
	// depending on `contextArgs` (unstable object identity). `key` covers the
	// semantic change set; the ref is just for reading the raw values at fire
	// time. This keeps the effect from re-running on parent re-renders that
	// pass a new-but-equivalent `contextArgs` object.
	const liveRef = useRef({ client, promptName, argName, value, contextArgs });
	liveRef.current = { client, promptName, argName, value, contextArgs };

	useEffect(() => {
		if (!enabled || !supportsCompletions || !client) {
			setState(EMPTY);
			return;
		}

		const cached = cacheRef.current.get(key);
		if (cached) {
			// Move-to-end for basic LRU behavior.
			cacheRef.current.delete(key);
			cacheRef.current.set(key, cached);
			setState({
				values: cached.values,
				hasMore: cached.hasMore,
				loading: false,
				error: null,
			});
			return;
		}

		setState((s) => ({ ...s, loading: true, error: null }));
		const ac = new AbortController();
		const timer = setTimeout(() => {
			void runFetch(ac, key, cacheRef, setState, liveRef.current);
		}, DEBOUNCE_MS);

		return () => {
			clearTimeout(timer);
			ac.abort();
		};
	}, [key, enabled, supportsCompletions, client]);

	return state;
}

async function runFetch(
	ac: AbortController,
	key: string,
	cacheRef: React.RefObject<Map<string, CacheEntry>>,
	setState: React.Dispatch<React.SetStateAction<ArgumentCompletionsState>>,
	live: {
		client: Client | null;
		promptName: string;
		argName: string;
		value: string;
		contextArgs: Record<string, string>;
	},
): Promise<void> {
	const { client, promptName, argName, value, contextArgs } = live;
	if (!client) return;

	const filledSiblings = filterFilled(contextArgs);

	try {
		const result = await client.complete(
			{
				ref: { type: "ref/prompt", name: promptName },
				argument: { name: argName, value },
				...(Object.keys(filledSiblings).length > 0
					? { context: { arguments: filledSiblings } }
					: {}),
			},
			{ signal: ac.signal },
		);
		if (ac.signal.aborted) return;

		const entry: CacheEntry = {
			values: result.completion.values,
			hasMore: result.completion.hasMore ?? false,
		};
		const cache = cacheRef.current;
		if (cache) {
			if (cache.size >= CACHE_CAP) {
				const first = cache.keys().next().value;
				if (first !== undefined) cache.delete(first);
			}
			cache.set(key, entry);
		}
		setState({
			values: entry.values,
			hasMore: entry.hasMore,
			loading: false,
			error: null,
		});
	} catch (err) {
		if (ac.signal.aborted) return;
		// Spec: "Handle missing or partial results gracefully." We surface
		// nothing to the user — the dropdown simply won't show — but log for
		// diagnostics. JSON-RPC codes we might see:
		//   -32601 method-not-found (capability lied; shouldn't happen given gate)
		//   -32602 invalid params (bad prompt name / missing args)
		//   -32603 internal error
		const e = err instanceof Error ? err : new Error(String(err));
		log.warn(
			{ err: e, promptName, argName },
			"completion/complete failed — dropdown suppressed",
		);
		setState({ values: [], hasMore: false, loading: false, error: e });
	}
}

function filterFilled(
	contextArgs: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(contextArgs)) {
		if (typeof v === "string" && v !== "") out[k] = v;
	}
	return out;
}

function stableContextSig(contextArgs: Record<string, string>): string {
	const entries = Object.entries(contextArgs)
		.filter(([, v]) => typeof v === "string" && v !== "")
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	// JSON is sufficient — strings can't contain `\u0000` trivially, and the
	// sorted entry array is a stable canonical form.
	return JSON.stringify(entries);
}
