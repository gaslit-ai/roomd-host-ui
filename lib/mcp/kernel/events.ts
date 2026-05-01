import type { McpProjectionEvent } from "./types";

export type McpEventListener = (event: McpProjectionEvent) => void;

export class McpEventBus {
  private readonly listeners = new Set<McpEventListener>();

  emit(event: McpProjectionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: McpEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
