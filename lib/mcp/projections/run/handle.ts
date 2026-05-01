import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  RunHandle,
  RunListener,
  RunSnapshot,
} from "@/lib/mcp/kernel/types";

export class RunHandleImpl implements RunHandle {
  private current: RunSnapshot;
  private readonly listeners = new Set<RunListener>();
  private readonly waiters: Array<{
    resolve: (result: CallToolResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private settled = false;

  constructor(
    snapshot: RunSnapshot,
    private readonly cancelFn: (reason?: string) => Promise<void>,
  ) {
    this.current = Object.freeze(snapshot);
  }

  get snapshot(): RunSnapshot {
    return this.current;
  }

  subscribe(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  waitForResult(): Promise<CallToolResult> {
    if (this.settled) {
      if (this.current.result) {
        return Promise.resolve({
          content: this.current.result.content,
          structuredContent: this.current.result.structuredContent,
          isError: this.current.result.isError,
          _meta: this.current.result._meta,
        });
      }
      return Promise.reject(
        new Error(this.current.error?.message ?? `Run ${this.current.phase}`),
      );
    }
    return new Promise<CallToolResult>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async cancel(reason?: string): Promise<void> {
    if (isTerminalRunPhase(this.current.phase)) return;
    this.patch({
      phase: "cancelled",
      error: { message: reason ?? "Run cancelled" },
      completedAt: Date.now(),
    });
    this.settled = true;
    this.rejectWaiters(new Error(reason ?? "Run cancelled"));
    await this.cancelFn(reason);
  }

  patch(patch: Partial<RunSnapshot>): void {
    this.current = Object.freeze({
      ...this.current,
      ...patch,
      updatedAt: Date.now(),
    });
    for (const listener of this.listeners) listener(this.current);
  }

  complete(result: CallToolResult): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveWaiters(result);
  }

  fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectWaiters(error);
  }

  private resolveWaiters(result: CallToolResult): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(result);
  }

  private rejectWaiters(error: unknown): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}

export function isTerminalRunPhase(phase: RunSnapshot["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}
