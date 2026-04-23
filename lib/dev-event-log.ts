/**
 * Dev-only append-only log of raw SSE `data:` lines from `/api/chat`.
 *
 * The AI SDK stream protocol delivers one JSON chunk per SSE event
 * (`data: {...}\n\n`). We capture those chunks verbatim — no parsing, no
 * reconstruction — so the dev sidebar shows exactly what the server sent.
 *
 * Module-level state is intentional: the log is a global in-memory tail,
 * mirrors a terminal scrollback. Not persisted.
 */

export interface DevEvent {
	/** Monotonic id assigned on append; stable React key. */
	readonly seq: number;
	/** Wall-clock time of append (ms since epoch). */
	readonly t: number;
	/** Raw payload from an SSE `data:` line. Usually JSON, but not parsed. */
	readonly line: string;
}

type Listener = (events: readonly DevEvent[]) => void;

let events: DevEvent[] = [];
let nextSeq = 0;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function getEvents(): readonly DevEvent[] {
	return events;
}

export function append(line: string): void {
	events = [...events, { seq: nextSeq++, t: Date.now(), line }];
	for (const l of listeners) l(events);
}

export function clear(): void {
	events = [];
	for (const l of listeners) l(events);
}

/**
 * `fetch` wrapper that tees the response body, parses SSE `data:` lines, and
 * appends each to the log. Returns the original response untouched so the
 * chat transport sees the same bytes.
 */
export const devTapFetch: typeof globalThis.fetch = async (input, init) => {
	const res = await fetch(input, init);
	if (!res.body) return res;

	const [a, b] = res.body.tee();
	void consumeSse(b);
	// The chat transport needs a Response whose body is one of the tee halves.
	// Reusing `res` would double-consume, so we rebuild it with the untouched
	// half. Headers/status/statusText copy over verbatim.
	return new Response(a, {
		headers: res.headers,
		status: res.status,
		statusText: res.statusText,
	});
};

async function consumeSse(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			// SSE events are \n\n-delimited. Each event may contain multiple
			// `data:` lines; AI SDK's protocol uses exactly one per event.
			let idx = buf.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				for (const raw of chunk.split("\n")) {
					const m = /^data:\s?(.*)$/.exec(raw);
					if (m) append(m[1]);
				}
				idx = buf.indexOf("\n\n");
			}
		}
	} catch {
		// Tap is best-effort; a broken tap must not break chat.
	}
}
