# §1.5 — Sampling

> Part of the [§1 Spec inventory](./README.md). Cross-references: [§1.3 tasks](./03-tasks.md) (delivered through the `input_required` race), [capability bundles](../architecture/capability-bundles.md), [open question #6 on `tools` field](../open-questions.md).

**Capability advertisement.** Client `sampling` is an object. Bare `{}` means basic sampling support, but it is not the whole negotiation: `sampling.tools` declares support for tool-enabled sampling requests, and `sampling.context` exists as a soft-deprecated context inclusion capability. Our current `sampling: {}` is therefore a basic-sampling declaration only; the sampling handler should decline or reject tool-enabled sampling until `tools` and `toolChoice` are implemented. See [MCP-SAMPLING](../sources.md#mcp-sampling).

**Request shape.** `types.d.ts:3580-3950` (`CreateMessageRequestParamsSchema`):

```text
CreateMessageRequestParams {
  messages: SamplingMessage[]            // each has role + content (block-or-array)
  modelPreferences?: ModelPreferences,
  systemPrompt?: string,
  includeContext?: 'none' | 'thisServer' | 'allServers',
  temperature?: number,
  maxTokens: number,                     // REQUIRED
  stopSequences?: string[],
  metadata?: any,
  tools?: Tool[],                        // 2025-11 expansion (CreateMessageWithTools)
  toolChoice?: ...
}
```

`ModelPreferences` (`types.d.ts:2991+`) carries `hints: [{name}]`, `costPriority`, `speedPriority`, `intelligencePriority`. Our `app/api/sample/route.ts:21-24` honors hints only as a hint (correct per spec — "MAY use … not MUST").

**Response.** `types.d.ts:4317+`:

```text
CreateMessageResult {
  model: string,                          // REQUIRED — name of the model used
  role: 'user' | 'assistant',
  content: ContentBlock,                  // single block (text typical)
  stopReason?: 'maxTokens'|'endTurn'|'stopSequence'| string,
  _meta?: ...
}
```

**Consent model.** Spec §"Sampling" requires the host to "obtain user consent before invoking the LLM." Our `sampling-approval-dialog.tsx` is the consent surface. Spec is silent on whether decline yields `-32000` or another code; our `SamplingDeclinedError` (`sampling-approval-dialog.tsx:57-63`) chooses `-32000` which is in the JSON-RPC server-defined-error range, fine.
