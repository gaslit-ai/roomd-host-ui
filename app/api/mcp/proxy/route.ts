import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { getMcpHostKernel } from "@/lib/mcp/kernel/session";
import type { McpProjectionEvent } from "@/lib/mcp/kernel/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const kernel = await getMcpHostKernel();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: McpProjectionEvent) => {
        if (event.kind !== "mcp") return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      const unsubscribe = kernel.subscribe(send);
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

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as JSONRPCMessage | JSONRPCMessage[];
  const messages = Array.isArray(body) ? body : [body];
  const kernel = await getMcpHostKernel();
  const responses: JSONRPCMessage[] = [];
  for (const message of messages) {
    const next = await kernel.handleBrowserMessage(message);
    responses.push(...next);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
