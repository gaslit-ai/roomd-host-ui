"use client";

import {
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  Loader2Icon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import { type FC, useCallback, useEffect, useState } from "react";
import { useCancelRun, useRunList } from "@/components/mcp/runs/context";
import { Button } from "@/components/ui/button";
import type { RunSnapshot } from "@/lib/mcp/kernel/types";
import { cn } from "@/lib/utils";

const TERMINAL_LINGER_MS = 5_000;

export const RunTray: FC = () => {
  const runs = useVisibleRuns(useRunList());
  const [expanded, setExpanded] = useState(false);
  if (runs.length === 0) return null;

  const active = runs.filter((run) => !isTerminal(run.phase));

  return (
    <div
      data-slot="run-tray"
      className="pointer-events-none fixed top-4 right-4 z-40 flex w-80 flex-col gap-1"
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setExpanded((value) => !value)}
        className="pointer-events-auto ml-auto flex items-center gap-2 shadow-sm"
      >
        <PlayIcon className="size-4" />
        <span>Runs</span>
        {active.length > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-primary-foreground text-xs">
            {active.length}
          </span>
        ) : null}
      </Button>
      {expanded ? (
        <div className="pointer-events-auto flex max-h-96 flex-col gap-1 overflow-y-auto rounded-md border bg-popover p-2 shadow-md">
          {runs.map((run) => (
            <RunRow key={run.runId} run={run} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const RunRow: FC<{ run: RunSnapshot }> = ({ run }) => {
  const cancelRun = useCancelRun();
  const terminal = isTerminal(run.phase);
  const onCancel = useCallback(() => {
    void cancelRun(run.runId, "user");
  }, [cancelRun, run.runId]);

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded px-2 py-1.5 text-xs",
        terminal && "opacity-60",
      )}
    >
      <StatusIcon phase={run.phase} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono font-medium">{run.toolName}</div>
        <div className="truncate text-muted-foreground">
          {run.statusMessage ??
            run.progress?.message ??
            run.error?.message ??
            defaultStatusMessage(run.phase)}
        </div>
      </div>
      <span className="shrink-0 text-muted-foreground">
        {formatElapsed(Date.now() - run.createdAt)}
      </span>
      {!terminal ? (
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 hover:bg-muted"
          aria-label="Cancel run"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
};

function useVisibleRuns(runs: readonly RunSnapshot[]): readonly RunSnapshot[] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const hasLingering = runs.some(
      (run) =>
        isTerminal(run.phase) &&
        run.completedAt !== undefined &&
        now - run.completedAt < TERMINAL_LINGER_MS,
    );
    if (!hasLingering) return;
    const id = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(id);
  }, [runs]);
  void tick;

  const now = Date.now();
  return runs.filter(
    (run) =>
      !isTerminal(run.phase) ||
      run.completedAt === undefined ||
      now - run.completedAt < TERMINAL_LINGER_MS,
  );
}

const StatusIcon: FC<{ phase: RunSnapshot["phase"] }> = ({ phase }) => {
  const cls = "size-3.5 shrink-0";
  switch (phase) {
    case "completed":
      return <CheckIcon className={cn(cls, "text-emerald-600")} />;
    case "failed":
      return <CircleXIcon className={cn(cls, "text-destructive")} />;
    case "cancelled":
      return <CircleAlertIcon className={cn(cls, "text-muted-foreground")} />;
    case "input_required":
      return <CircleAlertIcon className={cn(cls, "text-amber-600")} />;
    default:
      return <Loader2Icon className={cn(cls, "animate-spin text-primary")} />;
  }
};

function isTerminal(phase: RunSnapshot["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

function defaultStatusMessage(phase: RunSnapshot["phase"]): string {
  switch (phase) {
    case "queued":
      return "queued";
    case "input_streaming":
      return "reading input";
    case "working":
      return "working";
    case "input_required":
      return "waiting for input";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
