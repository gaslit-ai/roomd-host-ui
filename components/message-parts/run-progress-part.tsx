"use client";

import {
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  Loader2Icon,
} from "lucide-react";
import type { FC } from "react";
import type { DataRunPartData } from "@/lib/mcp/projections/run/ui-stream";
import { cn } from "@/lib/utils";

interface RunProgressPartProps {
  readonly type: "data";
  readonly name: string;
  readonly data: DataRunPartData;
}

export const RunProgressPart: FC<RunProgressPartProps> = ({ data }) => {
  return (
    <div
      data-slot="run-progress"
      className={cn(
        "my-1 flex items-center gap-2 rounded border bg-muted/30 px-3 py-1.5 text-xs",
        data.phase === "completed" && "opacity-60",
      )}
    >
      <StatusIcon phase={data.phase} />
      <span className="font-mono font-medium">{data.toolName}</span>
      <span className="min-w-0 truncate text-muted-foreground">
        {data.statusMessage ??
          data.progress?.message ??
          data.error?.message ??
          defaultStatusMessage(data.phase)}
      </span>
      <span className="ml-auto shrink-0 text-muted-foreground">
        {formatElapsed(Date.now() - data.createdAt)}
      </span>
    </div>
  );
};

const StatusIcon: FC<{ phase: DataRunPartData["phase"] }> = ({ phase }) => {
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

function defaultStatusMessage(phase: DataRunPartData["phase"]): string {
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
