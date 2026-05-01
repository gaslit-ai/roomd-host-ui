"use client";

import {
  createContext,
  type FC,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { McpProjectionEvent, RunSnapshot } from "@/lib/mcp/kernel/types";

interface RunContextValue {
  readonly runs: readonly RunSnapshot[];
  readonly cancelRun: (runId: string, reason?: string) => Promise<void>;
}

const RunContext = createContext<RunContextValue | null>(null);

export const RunProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [byId, setById] = useState<Map<string, RunSnapshot>>(new Map());

  useEffect(() => {
    const events = new EventSource("/api/mcp/events?channel=runs");
    events.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as McpProjectionEvent;
      if (parsed.kind !== "run") return;
      setById((prev) => {
        const next = new Map(prev);
        next.set(parsed.snapshot.runId, parsed.snapshot);
        return next;
      });
    };
    return () => events.close();
  }, []);

  const value = useMemo<RunContextValue>(
    () => ({
      runs: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt),
      cancelRun: async (runId, reason) => {
        await fetch("/api/mcp/runs/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId, reason }),
        });
      },
    }),
    [byId],
  );

  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
};

export function useRunList(): readonly RunSnapshot[] {
  return useRunContext().runs;
}

export function useCancelRun(): RunContextValue["cancelRun"] {
  return useRunContext().cancelRun;
}

function useRunContext(): RunContextValue {
  const ctx = useContext(RunContext);
  if (!ctx) throw new Error("useRunContext must be used inside <RunProvider>");
  return ctx;
}
