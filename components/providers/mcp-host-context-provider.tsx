"use client";

/**
 * HostContext provider for MCP Apps (SEP-1865 §"Host Context").
 *
 * Provides the host-wide slice of `McpUiHostContext` — theme, locale,
 * timezone, device capabilities, and the host-supported `availableDisplayModes`
 * list. These fields are identical for every mounted View, so they live on a
 * single React context here.
 *
 * **Not here:** per-View fields — `displayMode`, `toolInfo`, and
 * `containerDimensions` are View-scoped per spec (each View's
 * `ui/initialize` response carries its own mode) and are merged in at the
 * call-site (`mcp-app-part.tsx`).
 *
 * Reactively updates on:
 *   - theme change (prefers-color-scheme)
 *   - viewport resize (device capabilities — future)
 *
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
	createContext,
	type ReactNode,
	useContext,
	useMemo,
	useSyncExternalStore,
} from "react";
import { childLog } from "@/lib/logger";
import { buildHostStyleVariables, HOST_FONTS_CSS } from "@/lib/mcp/host-styles";

const log = childLog("mcp-apps:host-context");

type DisplayMode = NonNullable<McpUiHostContext["displayMode"]>;

const AVAILABLE_DISPLAY_MODES: DisplayMode[] = ["inline", "fullscreen", "pip"];

interface McpHostContextValue {
	readonly hostContext: McpUiHostContext;
}

const McpHostContext = createContext<McpHostContextValue | null>(null);

export interface McpHostContextProviderProps {
	children: ReactNode;
}

export function McpHostContextProvider({
	children,
}: McpHostContextProviderProps) {
	const prefersDark = useSyncExternalStore(
		subscribeDarkMode,
		getDarkModeSnapshot,
		getDarkModeServerSnapshot,
	);

	const hostContext = useMemo<McpUiHostContext>(() => {
		const theme = prefersDark ? "dark" : "light";
		log.debug({ theme }, "host context rebuilt");
		return buildHostContext(theme);
	}, [prefersDark]);

	const value = useMemo<McpHostContextValue>(
		() => ({ hostContext }),
		[hostContext],
	);

	return (
		<McpHostContext.Provider value={value}>{children}</McpHostContext.Provider>
	);
}

export function useMcpHostContext(): McpHostContextValue {
	const ctx = useContext(McpHostContext);
	if (!ctx) {
		throw new Error(
			"useMcpHostContext must be used within <McpHostContextProvider>",
		);
	}
	return ctx;
}

// ---------------------------------------------------------------------------
// HostContext construction
// ---------------------------------------------------------------------------

function buildHostContext(theme: "light" | "dark"): McpUiHostContext {
	const isBrowser = typeof window !== "undefined";
	const locale = isBrowser ? navigator.language : "en-US";
	const timeZone = isBrowser
		? Intl.DateTimeFormat().resolvedOptions().timeZone
		: "UTC";
	const touch = isBrowser ? navigator.maxTouchPoints > 0 : false;
	const hover = isBrowser ? matchMedia("(hover: hover)").matches : true;

	return {
		theme,
		styles: {
			variables: buildHostStyleVariables(),
			css: { fonts: HOST_FONTS_CSS },
		},
		availableDisplayModes: AVAILABLE_DISPLAY_MODES,
		locale,
		timeZone,
		userAgent: "roomd-host-ui/1.0 assistant-ui",
		platform: "web",
		deviceCapabilities: { touch, hover },
		// TODO(mcp-apps): safeAreaInsets.
		// SEP-1865 §"HostContext": only meaningful on native platforms. Web has
		// `env(safe-area-inset-*)` but the host doesn't own that measurement.
		// Planned wiring: when a React Native host is added, populate from
		// react-native-safe-area-context's useSafeAreaInsets().
	};
}

// ---------------------------------------------------------------------------
// prefers-color-scheme external store
// ---------------------------------------------------------------------------

function subscribeDarkMode(callback: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	const mq = window.matchMedia("(prefers-color-scheme: dark)");
	mq.addEventListener("change", callback);
	return () => mq.removeEventListener("change", callback);
}

function getDarkModeSnapshot(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getDarkModeServerSnapshot(): boolean {
	return false;
}
