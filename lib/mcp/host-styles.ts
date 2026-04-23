/**
 * Maps app design tokens → SEP-1865 `HostContext.styles.variables`.
 *
 * The spec defines a canonical set of CSS custom property names
 * (`--color-*`, `--font-*`, `--border-radius-*`, `--shadow-*`) that Views
 * read via `var(--…)` with their own fallbacks. This file sits at the edge
 * where the app's own token system (defined in `app/globals.css`) translates
 * to the spec's vocabulary. Add new mappings here as we expose more tokens.
 *
 * SEP-1865 §"Theming"
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";

type StyleVariables = NonNullable<
	NonNullable<McpUiHostContext["styles"]>["variables"]
>;

/**
 * Build the spec's style variable bag from the app's shadcn/Tailwind tokens.
 *
 * We use CSS `light-dark()` where possible so the View automatically follows
 * its host's color-scheme preference. For tokens the app doesn't define, the
 * Views' built-in fallbacks apply.
 */
export function buildHostStyleVariables(): StyleVariables {
	return {
		// Background colors — derived from shadcn --background / --card / --muted /
		// --accent / --destructive in app/globals.css.
		"--color-background-primary": "var(--background)",
		"--color-background-secondary": "var(--card)",
		"--color-background-tertiary": "var(--muted)",
		"--color-background-inverse": "var(--foreground)",
		"--color-background-ghost": "transparent",
		"--color-background-info": "var(--secondary)",
		"--color-background-danger": "var(--destructive)",
		"--color-background-success": "var(--primary)",
		"--color-background-warning": "var(--accent)",
		"--color-background-disabled": "var(--muted)",

		// Text colors
		"--color-text-primary": "var(--foreground)",
		"--color-text-secondary": "var(--muted-foreground)",
		"--color-text-tertiary": "var(--muted-foreground)",
		"--color-text-inverse": "var(--background)",
		"--color-text-info": "var(--primary)",
		"--color-text-danger": "var(--destructive)",
		"--color-text-success": "var(--primary)",
		"--color-text-warning": "var(--accent-foreground)",
		"--color-text-disabled": "var(--muted-foreground)",
		"--color-text-ghost": "var(--muted-foreground)",

		// Border colors
		"--color-border-primary": "var(--border)",
		"--color-border-secondary": "var(--input)",
		"--color-border-tertiary": "var(--border)",
		"--color-border-inverse": "var(--foreground)",
		"--color-border-ghost": "transparent",
		"--color-border-info": "var(--primary)",
		"--color-border-danger": "var(--destructive)",
		"--color-border-success": "var(--primary)",
		"--color-border-warning": "var(--accent)",
		"--color-border-disabled": "var(--muted)",

		// Ring (focus) colors
		"--color-ring-primary": "var(--ring)",
		"--color-ring-secondary": "var(--ring)",
		"--color-ring-inverse": "var(--background)",
		"--color-ring-info": "var(--primary)",
		"--color-ring-danger": "var(--destructive)",
		"--color-ring-success": "var(--primary)",
		"--color-ring-warning": "var(--accent)",

		// Typography — Geist is loaded in app/layout.tsx.
		"--font-sans": "var(--font-geist-sans)",
		"--font-mono": "var(--font-geist-mono)",
		"--font-weight-normal": "400",
		"--font-weight-medium": "500",
		"--font-weight-semibold": "600",
		"--font-weight-bold": "700",

		// Text sizes (rem scale matches Tailwind defaults)
		"--font-text-xs-size": "0.75rem",
		"--font-text-sm-size": "0.875rem",
		"--font-text-md-size": "1rem",
		"--font-text-lg-size": "1.125rem",
		"--font-text-xs-line-height": "1rem",
		"--font-text-sm-line-height": "1.25rem",
		"--font-text-md-line-height": "1.5rem",
		"--font-text-lg-line-height": "1.75rem",

		// Heading sizes
		"--font-heading-xs-size": "0.875rem",
		"--font-heading-sm-size": "1rem",
		"--font-heading-md-size": "1.125rem",
		"--font-heading-lg-size": "1.25rem",
		"--font-heading-xl-size": "1.5rem",
		"--font-heading-2xl-size": "1.875rem",
		"--font-heading-3xl-size": "2.25rem",
		"--font-heading-xs-line-height": "1.25rem",
		"--font-heading-sm-line-height": "1.5rem",
		"--font-heading-md-line-height": "1.75rem",
		"--font-heading-lg-line-height": "1.75rem",
		"--font-heading-xl-line-height": "2rem",
		"--font-heading-2xl-line-height": "2.25rem",
		"--font-heading-3xl-line-height": "2.5rem",

		// Radius — matches shadcn --radius-* scale.
		"--border-radius-xs": "calc(var(--radius) - 6px)",
		"--border-radius-sm": "var(--radius-sm)",
		"--border-radius-md": "var(--radius-md)",
		"--border-radius-lg": "var(--radius-lg)",
		"--border-radius-xl": "var(--radius-xl)",
		"--border-radius-full": "9999px",

		"--border-width-regular": "1px",

		// Shadows — Tailwind v4 tokens.
		"--shadow-hairline": "0 0 0 1px var(--border)",
		"--shadow-sm": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
		"--shadow-md": "0 4px 6px -1px rgb(0 0 0 / 0.1)",
		"--shadow-lg": "0 10px 15px -3px rgb(0 0 0 / 0.1)",
	};
}

/**
 * CSS injected via `HostContext.styles.css.fonts`. Geist fonts are already
 * loaded by the host page (next/font), so we don't need to import them again
 * inside the View — but the View runs in a fresh iframe with a null origin
 * and cannot access the host's font loader. Re-declare Geist via Google
 * Fonts so Views can use it identically to the host.
 */
export const HOST_FONTS_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap');
`;
