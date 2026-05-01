# UI surface unification

> Part of the [§4 proposed architecture](./README.md). Implements [P11 — single source of truth for the message-card](../principles.md) and [P12 — cancellation is bilateral](../principles.md). Cross-references: [Run abstraction](./run-abstraction.md), [Run registry](./run-registry.md), [tool result modeling](./tool-result-modeling.md), [cancel-from-tray sequence](./lifecycle-sequences.md#cancel-from-tray), gaps #12, #13, #14, #15, #16.

## §4.17 — UI surface unification (P11, gaps #12–#16)

**Single AI SDK part.** Replace `data-task-progress` + `data-task-terminal` with a single `data-run` part:

```ts
// lib/mcp/runs/ui-stream.ts
export const RUN_PART_TYPE = "data-run" as const;

export interface RunPartData {
  readonly runId: string;
  readonly toolName: string;
  readonly toolTitle?: string;
  readonly phase: RunPhase;
  readonly statusMessage?: string;
  readonly progress?: { current: number; total?: number };
  readonly elapsedMs: number;
  readonly destructive?: boolean;
  readonly result?: { isError: boolean; preview: string }; // light preview
  readonly error?: { kind: string; message: string };
}
```

The writer emits a single AI SDK data part with `type = "data-run"` and `id = runId`. AI SDK reconciles same-`type`/same-`id` data chunks before assistant-ui conversion. assistant-ui then renders data parts by `name` (`MessagePartsGrouped.d.ts:75-80`) and the converted data part no longer carries the AI SDK part `id`, so `RunPartData` must include `runId` for renderer lookup. See [AI-SDK-DATA-UPDATES](../sources.md#ai-sdk-data-updates) and [ASSISTANT-UI-DATA-RENDERING](../sources.md#assistant-ui-data-rendering).

**Tray + card share the same `Run` snapshots.** The tray is a flat list of all non-pruned snapshots; the card is `useRun(runId)` for the runId in the message part. Both subscribe to the same `Run` object.

**Cancel propagation.** Tray clicks `run.cancel()`. AI SDK's tool execute sees the abort signal (we wired it from `RunRegistry.call`), throws inside `execute`, AI SDK records a tool-result-error, the agent's next turn sees "this tool was cancelled" — naturally addresses gap #14.

**`input_required` inline.** When phase flips to `input_required`, the renderer adds an "awaiting your input" badge with a button that opens the dialog. (The dialog already opens; the badge is the inline tie-in — gap #15.)

**Terminal styling.** `RunPartData.error` non-null → red icon, error preview; `RunPartData.result.isError` → orange icon, "tool reported error"; `phase === "completed"` → green check + result preview. Distinct from progress-spinner (gap #16).

> **See also**
> - The full `RunCard` and `TaskTray` touchpoints are in [component-touchpoints.md §4.22.9–4.22.10](./component-touchpoints.md).
> - The phase-to-styling mapping (destructive vs read-only) consumes the annotations from [tool-result-modeling.md](./tool-result-modeling.md).
> - The cancel propagation end-to-end sequence lives in [lifecycle-sequences.md "Cancel from tray"](./lifecycle-sequences.md#cancel-from-tray).
