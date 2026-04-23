/**
 * Picture-in-picture slot registry for MCP App Views.
 *
 * SEP-1865 §"HostContext" defines `displayMode` as per-View: each View owns
 * its own mode, and `ui/request-display-mode` is scoped to a single View.
 * When multiple Views declare PIP and the user pops more than one out, the
 * host needs to place them without overlap. This module is the shared state
 * that coordinates them.
 *
 * Design: module-level singleton with `useSyncExternalStore` reactivity.
 * There is exactly one PIP workspace per window, so a context provider would
 * be ceremony without value. Reactivity is driven by a version counter;
 * `getSnapshot` returns a fresh frozen array each bump so React's
 * identity check fires and every mounted `usePipSlot` recomputes.
 *
 *   cascadeIndex → order among currently-open slots (0..n-1); drives the
 *                  default bottom-right cascade offset.
 *   zRank        → stacking order; highest rank renders on top. Click or
 *                  pointer-down on a PIP bumps it to the top of the stack.
 *
 * Ranks are normalized to 0..n-1 on every change so they don't grow
 * unbounded across long sessions.
 */

import { useEffect, useSyncExternalStore } from "react";

interface PipSlot {
	readonly id: string;
	readonly registeredAt: number;
	readonly zRank: number;
}

let slots: ReadonlyArray<PipSlot> = Object.freeze([]);
const listeners = new Set<() => void>();
let registrationCounter = 0;

function notify(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot(): ReadonlyArray<PipSlot> {
	return slots;
}

function getServerSnapshot(): ReadonlyArray<PipSlot> {
	return EMPTY;
}

const EMPTY: ReadonlyArray<PipSlot> = Object.freeze([]);

function normalizeZRanks(
	next: ReadonlyArray<Omit<PipSlot, "zRank"> & { zRank: number }>,
): ReadonlyArray<PipSlot> {
	// Re-rank 0..n-1 by current zRank ordering — keeps numbers bounded and
	// lets us use `zRank` directly as a z-index offset without ever growing.
	const byRank = [...next].sort((a, b) => a.zRank - b.zRank);
	const rankById = new Map<string, number>();
	for (let i = 0; i < byRank.length; i++) {
		rankById.set(byRank[i].id, i);
	}
	return Object.freeze(
		next.map((slot) =>
			Object.freeze({ ...slot, zRank: rankById.get(slot.id) ?? 0 }),
		),
	);
}

function register(id: string): void {
	if (slots.some((s) => s.id === id)) return; // idempotent for StrictMode double-mounts
	registrationCounter += 1;
	const topRank = slots.length; // goes to the top on registration
	slots = normalizeZRanks([
		...slots,
		{ id, registeredAt: registrationCounter, zRank: topRank },
	]);
	notify();
}

function unregister(id: string): void {
	if (!slots.some((s) => s.id === id)) return;
	slots = normalizeZRanks(slots.filter((s) => s.id !== id));
	notify();
}

function bringToFront(id: string): void {
	const current = slots.find((s) => s.id === id);
	if (!current) return;
	// Only bump if not already top.
	const topRank = slots.reduce((max, s) => Math.max(max, s.zRank), -1);
	if (current.zRank === topRank) return;
	// Assign a rank above the current top; normalizeZRanks compresses
	// back to 0..n-1.
	slots = normalizeZRanks(
		slots.map((s) => (s.id === id ? { ...s, zRank: topRank + 1 } : s)),
	);
	notify();
}

export interface PipSlotInfo {
	/** Position among currently-open PIPs in registration order (0..n-1). */
	readonly cascadeIndex: number;
	/** Stacking rank; highest renders on top. */
	readonly zRank: number;
	/** Bump this PIP to the top of the stack. Idempotent when already on top. */
	bringToFront(): void;
}

/**
 * Register a PIP slot for the lifetime of the calling component *while `active`
 * is true*. `id` must be stable across re-renders (use the tool-call id).
 * Returns cascade + z-rank information that reacts to other PIPs opening,
 * closing, or focusing.
 *
 * `active` lets the calling shell keep its DOM mounted across display-mode
 * changes (so the iframe isn't reloaded) while still only registering into
 * the PIP layout ledger when the View is actually displayed as PIP.
 */
export function usePipSlot(id: string, active: boolean): PipSlotInfo {
	const snapshot = useSyncExternalStore(
		subscribe,
		getSnapshot,
		getServerSnapshot,
	);

	useEffect(() => {
		if (!active) return;
		register(id);
		return () => {
			unregister(id);
		};
	}, [id, active]);

	const byRegistration = [...snapshot].sort(
		(a, b) => a.registeredAt - b.registeredAt,
	);
	const self = snapshot.find((s) => s.id === id);
	const cascadeIndex = Math.max(
		0,
		byRegistration.findIndex((s) => s.id === id),
	);

	return {
		cascadeIndex,
		zRank: self?.zRank ?? 0,
		bringToFront: () => bringToFront(id),
	};
}
