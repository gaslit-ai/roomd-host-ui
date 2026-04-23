"use client";

/**
 * Modal that collects arguments for an MCP prompt before invocation.
 *
 * Exposes a promise-based API: `usePromptArgsDialog()` returns a stable
 * `requestArgs(prompt)` function. The slash-command adapter calls it from
 * an `execute` handler; the promise resolves with the entered values or
 * `null` on cancel/escape/backdrop-click.
 *
 * Each input is an ARIA combobox backed by `completion/complete` when the
 * server advertises the `completions` capability. Sibling values flow in
 * as `context.arguments` so a server can make downstream suggestions depend
 * on upstream picks (spec §"Requesting Completions").
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion
 */

import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import {
	createContext,
	type FC,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useRef,
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
import { Input } from "@/components/ui/input";
import { useArgumentCompletions } from "@/lib/mcp/use-argument-completions";
import { cn } from "@/lib/utils";

export type PromptArgs = Record<string, string>;

/**
 * Called by the slash-command adapter to request arguments for a prompt.
 * Resolves with the collected values, or `null` if the user cancelled.
 * Stable across renders (backed by a ref), so callers can safely depend
 * on the returned function in `useMemo`/`useCallback`.
 */
export type RequestArgsFn = (prompt: Prompt) => Promise<PromptArgs | null>;

const Ctx = createContext<RequestArgsFn | null>(null);

export function usePromptArgsDialog(): RequestArgsFn {
	const fn = useContext(Ctx);
	if (!fn) {
		throw new Error(
			"usePromptArgsDialog must be used inside <PromptArgsDialogProvider>",
		);
	}
	return fn;
}

interface PendingRequest {
	readonly prompt: Prompt;
	readonly resolve: (value: PromptArgs | null) => void;
}

export const PromptArgsDialogProvider: FC<{ children: ReactNode }> = ({
	children,
}) => {
	const [pending, setPending] = useState<PendingRequest | null>(null);

	// Keep the callback identity stable so memoized consumers (the slash
	// adapter) don't re-create themselves every render. Reading `pending`
	// inside would break that; instead we only reference the stable setter.
	const requestArgs = useCallback<RequestArgsFn>((prompt) => {
		return new Promise((resolve) => {
			setPending({ prompt, resolve });
		});
	}, []);

	const handleSubmit = useCallback((values: PromptArgs) => {
		setPending((p) => {
			p?.resolve(values);
			return null;
		});
	}, []);

	const handleCancel = useCallback(() => {
		setPending((p) => {
			p?.resolve(null);
			return null;
		});
	}, []);

	return (
		<Ctx.Provider value={requestArgs}>
			{children}
			<PromptArgsDialog
				pending={pending}
				onSubmit={handleSubmit}
				onCancel={handleCancel}
			/>
		</Ctx.Provider>
	);
};

interface PromptArgsDialogProps {
	readonly pending: PendingRequest | null;
	readonly onSubmit: (values: PromptArgs) => void;
	readonly onCancel: () => void;
}

const PromptArgsDialog: FC<PromptArgsDialogProps> = ({
	pending,
	onSubmit,
	onCancel,
}) => {
	return (
		<Dialog
			open={pending !== null}
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<DialogContent
				className="sm:max-w-md"
				// Escape layering: if any combobox inside the dialog is open,
				// swallow Escape here so Radix's DismissableLayer doesn't close
				// the whole dialog. The combobox's own `onKeyDown` still runs
				// (Radix doesn't `stopPropagation`) and closes its popover on
				// the same press. A second Escape — with no combobox open —
				// falls through and dismisses the dialog as normal.
				onEscapeKeyDown={(e) => {
					const open = (
						e.target as Element | null
					)?.ownerDocument?.querySelector?.(
						'[role="combobox"][aria-expanded="true"]',
					);
					if (open) e.preventDefault();
				}}
			>
				{pending ? (
					<PromptArgsForm
						key={pending.prompt.name}
						prompt={pending.prompt}
						onSubmit={onSubmit}
						onCancel={onCancel}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
};

interface PromptArgsFormProps {
	readonly prompt: Prompt;
	readonly onSubmit: (values: PromptArgs) => void;
	readonly onCancel: () => void;
}

const PromptArgsForm: FC<PromptArgsFormProps> = ({
	prompt,
	onSubmit,
	onCancel,
}) => {
	const args = prompt.arguments ?? [];
	// Controlled: siblings need to observe each other (for context.arguments
	// in completion/complete). A single record keyed by arg name is the
	// natural shape.
	const [values, setValues] = useState<PromptArgs>({});
	const [error, setError] = useState<string | null>(null);

	const setValue = useCallback((name: string, v: string) => {
		setValues((prev) => ({ ...prev, [name]: v }));
	}, []);

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const missing: string[] = [];
		const result: PromptArgs = {};
		for (const arg of args) {
			const v = values[arg.name]?.trim() ?? "";
			if (v === "") {
				if (arg.required) missing.push(arg.name);
				// Skip optional empties — MCP servers apply their own defaults.
				continue;
			}
			result[arg.name] = v;
		}
		if (missing.length > 0) {
			setError(`Required: ${missing.join(", ")}`);
			return;
		}
		onSubmit(result);
	};

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>{prompt.title ?? prompt.name}</DialogTitle>
				{prompt.description ? (
					<DialogDescription>{prompt.description}</DialogDescription>
				) : null}
			</DialogHeader>
			<div className="flex flex-col gap-3">
				{args.map((arg, idx) => (
					<PromptArgInput
						key={arg.name}
						arg={arg}
						autoFocus={idx === 0}
						value={values[arg.name] ?? ""}
						onChange={setValue}
						promptName={prompt.name}
						siblings={values}
					/>
				))}
			</div>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit">Run</Button>
			</DialogFooter>
		</form>
	);
};

type PromptArgument = NonNullable<Prompt["arguments"]>[number];

interface PromptArgInputProps {
	readonly arg: PromptArgument;
	readonly autoFocus: boolean;
	readonly value: string;
	readonly onChange: (name: string, value: string) => void;
	readonly promptName: string;
	readonly siblings: PromptArgs;
}

const PromptArgInput: FC<PromptArgInputProps> = ({
	arg,
	autoFocus,
	value,
	onChange,
	promptName,
	siblings,
}) => {
	const inputId = useId();
	const listboxId = useId();
	const [focused, setFocused] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const listboxRef = useRef<HTMLDivElement>(null);

	// Siblings OTHER than this arg — our own value shouldn't leak into
	// `context.arguments` (it's sent as `argument.value`).
	const contextArgs = omitKey(siblings, arg.name);

	const { values, hasMore, loading } = useArgumentCompletions(
		promptName,
		arg.name,
		value,
		contextArgs,
		focused,
	);

	const hasResults = values.length > 0;
	const open = focused && (hasResults || loading);

	// Reset the highlight whenever the result set changes. Clamp to the
	// new length so arrow-keying into an old index is impossible.
	useEffect(() => {
		setHighlight((h) => (h >= values.length ? 0 : h));
	}, [values.length]);

	const pick = useCallback(
		(v: string) => {
			onChange(arg.name, v);
			setFocused(false);
		},
		[arg.name, onChange],
	);

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (!open) return;
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setHighlight((h) => Math.min(h + 1, Math.max(values.length - 1, 0)));
				break;
			case "ArrowUp":
				e.preventDefault();
				setHighlight((h) => Math.max(h - 1, 0));
				break;
			case "Enter":
				if (hasResults) {
					e.preventDefault();
					pick(values[highlight]);
				}
				break;
			case "Escape":
				// Close only the popover. The enclosing Radix Dialog is kept
				// open by its `onEscapeKeyDown` prop which preventDefaults when
				// ANY combobox is `aria-expanded="true"` (Radix's internal
				// DismissableLayer then skips dismissing). A second Escape —
				// after this one flipped `focused` to false — finds no open
				// combobox and dismisses the dialog normally.
				e.preventDefault();
				setFocused(false);
				break;
		}
	};

	const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
		// Keep open when focus moved into our listbox (option click). The
		// `mousedown` preventDefault on options blocks the blur in most
		// cases, but belt-and-suspenders keeps tab-into-listbox safe too.
		if (listboxRef.current?.contains(e.relatedTarget as Node | null)) return;
		setFocused(false);
	};

	return (
		<div className="relative flex flex-col gap-1.5">
			<label htmlFor={inputId} className="font-medium text-sm">
				{arg.name}
				{arg.required ? (
					<span className="ml-1 text-destructive" aria-hidden="true">
						*
					</span>
				) : null}
			</label>
			{arg.description ? (
				<p className="text-muted-foreground text-xs">{arg.description}</p>
			) : null}
			<Input
				id={inputId}
				name={arg.name}
				autoFocus={autoFocus}
				aria-required={arg.required ?? false}
				role="combobox"
				aria-expanded={open}
				aria-autocomplete="list"
				aria-controls={open ? listboxId : undefined}
				aria-activedescendant={
					open && hasResults ? `${listboxId}-opt-${highlight}` : undefined
				}
				value={value}
				onChange={(e) => onChange(arg.name, e.target.value)}
				onFocus={() => setFocused(true)}
				onBlur={onBlur}
				onKeyDown={onKeyDown}
				autoComplete="off"
			/>
			{open ? (
				// Combobox listbox: WAI-ARIA 1.2 allows `role="listbox"` on a
				// non-focusable container with `role="option"` children when
				// virtual focus is managed via `aria-activedescendant` on the
				// textbox. Using <div>s (not <ul>/<li>) avoids biome's a11y
				// rule conflating this with the interactive listbox/widget
				// pattern it knows. Behaviorally identical for SRs.
				<div
					ref={listboxRef}
					id={listboxId}
					role="listbox"
					className="absolute top-full right-0 left-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
				>
					{hasResults ? (
						// biome-ignore-start lint/a11y/useKeyWithClickEvents: ARIA
						// combobox pattern — keyboard selection is handled on the
						// textbox via ArrowUp/ArrowDown/Enter; options expose click
						// for mouse users only and never hold focus.
						values.map((v, i) => (
							<div
								key={v}
								id={`${listboxId}-opt-${i}`}
								role="option"
								aria-selected={i === highlight}
								// `tabIndex={-1}` keeps options programmatically focusable
								// without stealing tab order — the combobox pattern uses
								// virtual focus via `aria-activedescendant`, so the textbox
								// stays keyboard-focused while these render the highlight.
								tabIndex={-1}
								// Prevent blur BEFORE click so focus stays in the input.
								onMouseDown={(e) => e.preventDefault()}
								onMouseEnter={() => setHighlight(i)}
								onClick={() => pick(v)}
								className={cn(
									"cursor-pointer rounded px-2 py-1 text-sm outline-none",
									i === highlight
										? "bg-accent text-accent-foreground"
										: "hover:bg-accent/50",
								)}
							>
								{v}
							</div>
						))
						// biome-ignore-end lint/a11y/useKeyWithClickEvents: see above
					) : loading ? (
						<div
							className="px-2 py-1 text-muted-foreground text-xs italic"
							aria-hidden="true"
						>
							Loading…
						</div>
					) : null}
					{hasMore && hasResults ? (
						<div
							className="mt-1 border-t px-2 py-1 text-muted-foreground text-xs italic"
							aria-hidden="true"
						>
							More results on server — type to narrow
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
};

function omitKey(
	record: Record<string, string>,
	key: string,
): Record<string, string> {
	const { [key]: _omit, ...rest } = record;
	return rest;
}
