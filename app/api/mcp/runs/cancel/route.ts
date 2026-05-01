import { getMcpHostKernel } from "@/lib/mcp/kernel/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { runId, reason } = (await req.json()) as {
    runId?: string;
    reason?: string;
  };
  if (!runId)
    return Response.json({ error: "runId is required" }, { status: 400 });
  const kernel = await getMcpHostKernel();
  const handle = kernel.runs.getHandle(runId);
  if (!handle)
    return Response.json({ error: "run not found" }, { status: 404 });
  await handle.cancel(reason ?? "user");
  return Response.json({});
}
