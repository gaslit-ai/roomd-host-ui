import { getMcpHostKernel } from "@/lib/mcp/kernel/session";
import type { McpProjectionEvent } from "@/lib/mcp/kernel/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const channel = url.searchParams.get("channel");
  const kernel = await getMcpHostKernel();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: McpProjectionEvent) => {
        if (channel === "mcp" && event.kind !== "mcp") return;
        if (channel === "runs" && event.kind !== "run") return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      const unsubscribe = kernel.subscribe(send);
      if (channel !== "mcp") {
        for (const snapshot of kernel.runs.snapshots) {
          send({ kind: "run", snapshot });
        }
      }
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 25_000);
      req.signal.addEventListener(
        "abort",
        () => {
          clearInterval(heartbeat);
          unsubscribe();
          controller.close();
        },
        { once: true },
      );
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
