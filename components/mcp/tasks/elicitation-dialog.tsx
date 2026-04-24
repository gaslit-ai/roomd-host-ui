"use client";

/**
 * Schema-driven modal for MCP `elicitation/create` requests.
 *
 * Renders a form derived from `params.requestedSchema` (spec
 * types.d.ts:4966-5063) and resolves with the spec-shaped ElicitResult:
 *   - `{ action: "accept", content: {...} }` on submit
 *   - `{ action: "decline" }` when the user declines (explicit button)
 *   - `{ action: "cancel" }` on Escape / backdrop / unmount
 *
 * Spec §"Elicitation Action Responses":
 * https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
 * The three actions have distinct semantics — servers MAY treat `decline`
 * differently from `cancel` (user refusal vs. interrupted). The promise
 * resolves; it never rejects.
 *
 * When this elicitation arrives inside a task (spec `_meta` carries
 * `io.modelcontextprotocol/related-task.taskId`), we surface the task id in
 * the header so the user knows which background work is waiting on them.
 */

import type {
	ElicitRequest,
	ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
	createContext,
	type FC,
	type ReactNode,
	useCallback,
	useContext,
	useId,
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

type ElicitParams = ElicitRequest["params"];
// Form-mode is the only one we implement today; URL-mode requires a
// redirect-back flow that's out of scope. We fall through to `cancel` if
// a URL request arrives.
type FormElicitParams = Extract<ElicitParams, { requestedSchema: unknown }>;

export type RequestElicitationFn = (
	params: ElicitParams,
) => Promise<ElicitResult>;

const Ctx = createContext<RequestElicitationFn | null>(null);

export function useRequestElicitation(): RequestElicitationFn {
	const fn = useContext(Ctx);
	if (!fn) {
		throw new Error(
			"useRequestElicitation must be used inside <ElicitationDialogProvider>",
		);
	}
	return fn;
}

interface Pending {
	readonly params: ElicitParams;
	readonly resolve: (r: ElicitResult) => void;
}

export const ElicitationDialogProvider: FC<{ children: ReactNode }> = ({
	children,
}) => {
	const [pending, setPending] = useState<Pending | null>(null);

	const requestElicitation = useCallback<RequestElicitationFn>((params) => {
		return new Promise<ElicitResult>((resolve) => {
			// URL-mode — we don't support it today; refuse per spec's
			// "unsupported mode" path and let the server handle gracefully.
			if ("mode" in params && params.mode === "url") {
				resolve({ action: "decline" });
				return;
			}
			setPending({ params, resolve });
		});
	}, []);

	const resolveAndClose = useCallback((result: ElicitResult) => {
		setPending((p) => {
			p?.resolve(result);
			return null;
		});
	}, []);

	return (
		<Ctx.Provider value={requestElicitation}>
			{children}
			<ElicitationDialog pending={pending} onResolve={resolveAndClose} />
		</Ctx.Provider>
	);
};

const ElicitationDialog: FC<{
	readonly pending: Pending | null;
	readonly onResolve: (r: ElicitResult) => void;
}> = ({ pending, onResolve }) => {
	return (
		<Dialog
			open={pending !== null}
			onOpenChange={(open) => {
				// Escape / backdrop / close button — MCP treats this as `cancel`,
				// distinct from an explicit decline.
				if (!open) onResolve({ action: "cancel" });
			}}
		>
			<DialogContent className="sm:max-w-md">
				{pending && "requestedSchema" in pending.params ? (
					<ElicitationForm
						key={JSON.stringify(pending.params.requestedSchema)}
						params={pending.params as FormElicitParams}
						onResolve={onResolve}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
};

const ElicitationForm: FC<{
	readonly params: FormElicitParams;
	readonly onResolve: (r: ElicitResult) => void;
}> = ({ params, onResolve }) => {
	const { message, requestedSchema } = params;
	const required = new Set(requestedSchema.required ?? []);
	const fields = Object.entries(requestedSchema.properties);
	const [values, setValues] = useState<Record<string, unknown>>({});
	const [error, setError] = useState<string | null>(null);

	const relatedTaskId =
		params._meta?.["io.modelcontextprotocol/related-task"]?.taskId;

	const setValue = useCallback((name: string, v: unknown) => {
		setValues((prev) => ({ ...prev, [name]: v }));
	}, []);

	const handleAccept = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		// Validate required
		const missing: string[] = [];
		const content: Record<string, string | number | boolean | string[]> = {};
		for (const [name, _field] of fields) {
			const raw = values[name];
			if (
				raw === undefined ||
				raw === "" ||
				(Array.isArray(raw) && raw.length === 0)
			) {
				if (required.has(name)) missing.push(name);
				continue;
			}
			content[name] = raw as string | number | boolean | string[];
		}
		if (missing.length > 0) {
			setError(`Required: ${missing.join(", ")}`);
			return;
		}
		onResolve({ action: "accept", content });
	};

	return (
		<form onSubmit={handleAccept} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>Input required</DialogTitle>
				<DialogDescription>{message}</DialogDescription>
				{relatedTaskId ? (
					<p className="font-mono text-muted-foreground text-xs">
						task {relatedTaskId}
					</p>
				) : null}
			</DialogHeader>
			<div className="flex flex-col gap-3">
				{fields.map(([name, field]) => (
					<FieldRow
						key={name}
						name={name}
						required={required.has(name)}
						field={field}
						value={values[name]}
						onChange={setValue}
					/>
				))}
			</div>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			<DialogFooter>
				<Button
					type="button"
					variant="outline"
					onClick={() => onResolve({ action: "decline" })}
				>
					Decline
				</Button>
				<Button type="submit">Submit</Button>
			</DialogFooter>
		</form>
	);
};

// ─── Field renderers ─────────────────────────────────────────────────────────
//
// Spec form-schema union (types.d.ts:4966-5063):
//   - string with enum+enumNames / enum / oneOf[{const,title}]
//   - string with format (date, date-time, email, uri) + minLength / maxLength
//   - array of strings (enum)
//   - array with items.anyOf[{const,title}]
//   - boolean
//   - number | integer with min/max
//
// Subjective: for arrays we use a native `<select multiple>` — functional and
// keyboard-accessible; a fancy tag-picker is not worth the dependency for
// the modest cardinality these tend to have.

type SchemaField = FormElicitParams["requestedSchema"]["properties"][string];

const FieldRow: FC<{
	name: string;
	required: boolean;
	field: SchemaField;
	value: unknown;
	onChange: (name: string, v: unknown) => void;
}> = ({ name, required, field, value, onChange }) => {
	const id = useId();
	const title = "title" in field && field.title ? field.title : name;
	const description = "description" in field ? field.description : undefined;

	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="font-medium text-sm">
				{title}
				{required ? (
					<span className="ml-1 text-destructive" aria-hidden="true">
						*
					</span>
				) : null}
			</label>
			{description ? (
				<p className="text-muted-foreground text-xs">{description}</p>
			) : null}
			<FieldInput
				id={id}
				name={name}
				field={field}
				value={value}
				onChange={onChange}
			/>
		</div>
	);
};

const FieldInput: FC<{
	id: string;
	name: string;
	field: SchemaField;
	value: unknown;
	onChange: (name: string, v: unknown) => void;
}> = ({ id, name, field, value, onChange }) => {
	// Boolean → checkbox
	if (field.type === "boolean") {
		return (
			<label
				htmlFor={id}
				className="flex cursor-pointer items-center gap-2 text-sm"
			>
				<input
					id={id}
					type="checkbox"
					checked={value === true}
					onChange={(e) => onChange(name, e.target.checked)}
					className="size-4"
				/>
				yes
			</label>
		);
	}

	// Number / integer
	if (field.type === "number" || field.type === "integer") {
		return (
			<Input
				id={id}
				name={name}
				type="number"
				step={field.type === "integer" ? 1 : "any"}
				min={"minimum" in field ? field.minimum : undefined}
				max={"maximum" in field ? field.maximum : undefined}
				defaultValue={
					"default" in field && field.default !== undefined
						? String(field.default)
						: ""
				}
				onChange={(e) => {
					const v = e.target.value;
					if (v === "") return onChange(name, undefined);
					const n = Number(v);
					onChange(name, Number.isNaN(n) ? undefined : n);
				}}
			/>
		);
	}

	// Array of enum strings → multi-select
	if (field.type === "array") {
		const selected = Array.isArray(value) ? (value as string[]) : [];
		const options =
			"items" in field && "enum" in field.items
				? field.items.enum.map((v) => ({ const: v, title: v }))
				: "items" in field && "anyOf" in field.items
					? field.items.anyOf
					: [];
		return (
			<select
				id={id}
				name={name}
				multiple
				value={selected}
				onChange={(e) => {
					const picked = Array.from(e.target.selectedOptions).map(
						(o) => o.value,
					);
					onChange(name, picked);
				}}
				className="min-h-20 rounded-md border bg-transparent px-3 py-1 text-sm outline-none focus:ring-2 focus:ring-ring/20"
			>
				{options.map((o) => (
					<option key={o.const} value={o.const}>
						{o.title}
					</option>
				))}
			</select>
		);
	}

	// String variants
	if ("enum" in field) {
		const names = "enumNames" in field ? field.enumNames : undefined;
		return (
			<select
				id={id}
				name={name}
				value={(value as string | undefined) ?? field.default ?? ""}
				onChange={(e) => onChange(name, e.target.value)}
				className="h-9 rounded-md border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-ring/20"
			>
				<option value="" disabled>
					(select)
				</option>
				{field.enum.map((v, i) => (
					<option key={v} value={v}>
						{names?.[i] ?? v}
					</option>
				))}
			</select>
		);
	}
	if ("oneOf" in field) {
		return (
			<select
				id={id}
				name={name}
				value={(value as string | undefined) ?? field.default ?? ""}
				onChange={(e) => onChange(name, e.target.value)}
				className="h-9 rounded-md border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-ring/20"
			>
				<option value="" disabled>
					(select)
				</option>
				{field.oneOf.map((o) => (
					<option key={o.const} value={o.const}>
						{o.title}
					</option>
				))}
			</select>
		);
	}
	// Plain string (with optional format / length constraints)
	const inputType =
		"format" in field && field.format
			? field.format === "date"
				? "date"
				: field.format === "date-time"
					? "datetime-local"
					: field.format === "email"
						? "email"
						: field.format === "uri"
							? "url"
							: "text"
			: "text";
	return (
		<Input
			id={id}
			name={name}
			type={inputType}
			minLength={"minLength" in field ? field.minLength : undefined}
			maxLength={"maxLength" in field ? field.maxLength : undefined}
			defaultValue={"default" in field ? field.default : undefined}
			onChange={(e) => onChange(name, e.target.value)}
		/>
	);
};
