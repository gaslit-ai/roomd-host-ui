# `RunRegistry` — state machine and side channels

> Part of the [§4 proposed architecture](./README.md). Implements [P5 — progress is a fan-in](../principles.md), [P9 — memory and rate](../principles.md), and the host side of [P3 — logical operations span the user, not the session](../principles.md). Cross-references: [Run abstraction](./run-abstraction.md), [capability bundles](./capability-bundles.md) (which install the notification handlers that feed this registry), [§1.3 tasks](../spec/03-tasks.md), [§1.7 progress](../spec/07-progress.md).

## §4.6 — `RunRegistry`

```mermaid
classDiagram
    class RunRegistry {
        -Map~runId, RunImpl~ _runs
        -RingBuffer~RunSnapshot~ _history (cap=128)
        -Set~RegistryListener~ _listeners
        -ProgressMux _progressMux
        -ConcurrencyLimit _admitter
        +call(input, opts) Run
        +adopt(taskId) Run
        +get(runId) Run | undefined
        +subscribe(fn) UnsubFn
        +reattachInFlight() Promise~void~
        +pruneTerminal(maxAge: number) void
        +dispose() Promise~void~
    }

    class ProgressMux {
        +ingestTaskStatus(notification)
        +ingestProgress(notification)
        +ingestStreamMessage(runId, msg)
    }

    class CapabilityBundle {
        <<interface>>
        +capability: object
        +register(client: Client): void
    }

    class CapabilityRegistry {
        -Set~CapabilityBundle~ _bundles
        +add(bundle): this
        +materialize(): {capabilities, registerAll}
    }

    RunRegistry --> ProgressMux
    RunRegistry --> ConcurrencyLimit
    RunRegistry --> RunImpl
```

## §4.9 — `RunRegistry.call` happy path (TypeScript)

```ts
// lib/mcp/runs/registry.ts
class RunRegistryImpl implements RunRegistry {
  call(input: RunCallInput): Run {
    if (!this._admitter.admit(this._runs.size))
      throw new RunError("concurrency limit", "transport");

    const runId = nanoid();
    const ac = new AbortController();
    if (input.signal) chainSignal(input.signal, ac);

    const toolMeta = this._toolMetaFor(input.toolName);
    const useTaskPath = decideTaskPath(toolMeta, input.mode ?? "auto");

    const run = new RunImpl({
      runId,
      source: input.source ?? "agent",
      toolMeta,
      args: input.args,
      cancel: async (reason) => {
        ac.abort(reason);
        const tid = run.snapshot.taskId;
        if (tid) {
          await this._client.experimental.tasks.cancelTask(tid).catch(() => {});
        }
      },
    });

    this._runs.set(runId, run);
    this._emit();

    if (useTaskPath) {
      void this._driveTaskStream(run, ac.signal);
    } else {
      void this._drivePlainCall(run, ac.signal);
    }
    return run;
  }

  ingestTaskStatusNotification(p: TaskStatusNotificationParams): void {
    const run = this._findByTaskId(p.taskId);
    if (!run) return;
    // Push-only — no settle. See §1.3 race discussion and handle.ts:155-168.
    run._mut.update({
      phase: this._phaseFromStatus(p.status),
      statusMessage: p.statusMessage,
      ttlExpiresAt: p.ttl != null ? Date.now() + p.ttl : undefined,
    });
    this._emit();
  }

  ingestProgressNotification(p: ProgressNotificationParams): void {
    const runId = this._progressMux.runIdForToken(p.progressToken);
    if (!runId) return;
    const run = this._runs.get(runId);
    if (!run) return;
    run._mut.update({
      phase: "working",
      progress: { current: p.progress, total: p.total },
      statusMessage: p.message,
    });
    this._emit();
  }
}
```

Key details:

- `_progressMux.runIdForToken(token)` — when we open a non-task call, we set `onprogress` (which makes the SDK stamp `_meta.progressToken` on the request) and bind the token to the runId. P5: progress and task-status converge.
- `_admitter` is a simple `Math.min(_runs.size + 1, MAX) === MAX_CONCURRENT` admission gate (P9).
- Terminal pruning — a separate `pruneTerminal(maxAge)` ticked from a setInterval.

## §4.12 — `notifications/progress` integration (P5, gap #5)

```ts
// lib/mcp/runs/progress-mux.ts
export class ProgressMux {
  private readonly _tokenToRun = new Map<string | number, string /* runId */>();

  bind(progressToken: string | number, runId: string): void {
    this._tokenToRun.set(progressToken, runId);
  }
  unbind(progressToken: string | number): void {
    this._tokenToRun.delete(progressToken);
  }
  runIdForToken(t: string | number): string | undefined {
    return this._tokenToRun.get(t);
  }
}
```

Used in the plain-call driver:

```ts
private async _drivePlainCall(run: RunImpl, signal: AbortSignal): Promise<void> {
  const progressToken = `${run.snapshot.runId}/progress`;
  this._progressMux.bind(progressToken, run.snapshot.runId);
  try {
    const result = await this._client.callTool(
      { name: run.snapshot.toolMeta.name, arguments: run.snapshot.args },
      this._resultSchemaFor(run),
      {
        signal,
        timeout: this._options.timeoutMs,
        onprogress: (p) => {
          // The SDK already routes per-message-id progress; we just consume.
          run._mut.update({
            phase: "working",
            progress: { current: p.progress, total: p.total },
            statusMessage: p.message,
          });
          this._emit();
        },
        resetTimeoutOnProgress: true,
      },
    );
    run._mut.settle({ status: "completed", result });
  } catch (err) {
    run._mut.settle({ status: "failed", error: this._mapError(err) });
  } finally {
    this._progressMux.unbind(progressToken);
  }
}
```

For task-augmented calls, progress notifications still arrive through the same `_meta.progressToken` plumbing; the installed SDK stamps a progress token and stores a handler whenever `options.onprogress` is passed. We surface both `notifications/tasks/status` *and* `notifications/progress` updates into the same `Run`, with the latter acting as fine-grained percent-progress overlay. See [SDK-PROGRESS-REQUEST](../sources.md#sdk-progress-request).

## §4.14 — `tools/list_changed` honored on chat route (gap #8)

The current chat-route caches tools at module scope forever (`route.ts:68-104`). The fix is to attach a list_changed handler on the shared client and invalidate the cache.

```ts
// app/api/chat/route.ts (new)
let cachedToolsVersion = 0;
function setupToolsListChanged(): void {
  if (!cachedTaskClient) return;
  cachedTaskClient.setNotificationHandler(
    ToolListChangedNotificationSchema,
    async () => {
      cachedToolsVersion++;
      cachedMCPTools = null; // force refetch on next request
      cachedToolMeta = null;
      log.info("tools/list_changed; cache invalidated");
    },
  );
}
```

A subtler issue is that `@ai-sdk/mcp` caches its own tool descriptors internally; we may need to call `mcpClient.tools()` again (forcing a full refresh) on every list_changed.

## §4.15 — `tasks/list` filter (gap #9)

Per session, every task we created has its `runId` in `_runs`. On reattach we should not adopt arbitrary tasks — we should compare with what the registry expects (e.g., persistent in `localStorage` for the browser, or `Map<sessionId, Set<taskId>>` server-side):

```ts
async reattachInFlight(): Promise<void> {
  const ours = await this._loadOurTaskIds(); // e.g., from sessionStorage
  const { tasks } = await this._client.experimental.tasks.listTasks();
  for (const t of tasks) {
    if (!ours.has(t.taskId)) continue;          // ← spec-bounded
    if (isTerminal(t.status)) continue;
    if (this._findByTaskId(t.taskId)) continue;
    void this.adopt(t.taskId);
  }
}
```

`_loadOurTaskIds()` uses `sessionStorage` (browser) or in-memory record (server). On `taskCreated`, we add the id to that record; on terminal, we remove.

## §4.16 — TTL warning + cleanup (gap #10)

Each `Run.snapshot.ttlExpiresAt` is `Date.now() + Task.ttl` whenever a `Task` carries `ttl != null`. Once set, a per-Run timer fires at 80% of TTL and emits a `phase: "input_required"`-equivalent UX message ("This task expires soon — cancel or input?"). We do not auto-cancel client-side; we just surface.

## §4.27 — Memory and rate (P9, gaps #19, #20)

```ts
// lib/mcp/runs/admission.ts
export class ConcurrencyLimit {
  constructor(private readonly max: number) {}
  admit(currentSize: number): boolean {
    return currentSize < this.max;
  }
}

// lib/mcp/runs/ring-buffer.ts
export class RingBuffer<T> {
  private _buf: T[] = [];
  constructor(private readonly cap: number) {}
  push(item: T): void {
    this._buf.push(item);
    if (this._buf.length > this.cap) this._buf.shift();
  }
  values(): readonly T[] {
    return this._buf;
  }
}
```

`RunRegistry.pruneTerminal` runs on a `setInterval` of 60s, removing terminal `Run`s older than `5 * 60_000`ms from `_runs` and pushing their snapshots to a ring-buffer of size 128 (`_history`).

> **See also**
> - The schemas (`RunCallInput`, `RunRegistry` interface) are consolidated in [schemas.md](../schemas.md).
> - The notification handlers that feed `ingestTaskStatusNotification` and `ingestProgressNotification` are installed by [capability bundles](./capability-bundles.md) — that's how P1 and P5 link.
> - The [server-proxy](./server-proxy.md) provides the SSE channel that mirrors the registry from server to browser.
