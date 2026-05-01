"use client";

/**
 * Mounts the two dialog providers (elicitation + sampling) and wires the
 * corresponding Client request handlers. MUST be rendered inside
 * `<McpClientProvider>` because the browser MCP proxy transport delivers
 * server-initiated requests to this client.
 *
 * Why this module exists: the SDK's `setRequestHandler` takes a (method,
 * handler) pair — exactly one handler per method. We own that registration
 * for `elicitation/create` and `sampling/createMessage` here, bridge into
 * React state, and show the appropriate modal.
 *
 * Spec:
 * - https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
 * - https://modelcontextprotocol.io/specification/2025-11-25/client/sampling
 *
 * Subjective: we mount the two sub-providers in a single component rather
 * than forcing consumers to nest both. Keeps `app/assistant.tsx` minimal.
 */

import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type FC, type ReactNode, useEffect } from "react";
import {
  ElicitationDialogProvider,
  useRequestElicitation,
} from "@/components/mcp/dialogs/elicitation-dialog";
import {
  type RequestSamplingFn,
  SamplingApprovalProvider,
  useRequestSampling,
} from "@/components/mcp/dialogs/sampling-approval-dialog";
import { useMcpClient } from "@/components/providers/mcp-client-provider";
import { childLog } from "@/lib/logger";

const log = childLog("request-dialog-handler");

export const RequestDialogHandler: FC<{ children: ReactNode }> = ({
  children,
}) => {
  return (
    <ElicitationDialogProvider>
      <SamplingApprovalProvider>
        <HandlerRegistrar />
        {children}
      </SamplingApprovalProvider>
    </ElicitationDialogProvider>
  );
};

// Inner component so the two hooks (useRequestElicitation / useRequestSampling)
// resolve inside their respective providers. A single outer component can't
// call these hooks — they'd see a null context.
const HandlerRegistrar: FC = () => {
  const { client } = useMcpClient();
  const requestElicitation = useRequestElicitation();
  const requestSampling = useRequestSampling();

  useEffect(() => {
    if (!client) return;

    // Spec §Elicitation: client returns an ElicitResult describing the
    // user's action + (on accept) the collected content.
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      log.debug(
        {
          relatedTaskId:
            request.params._meta?.["io.modelcontextprotocol/related-task"]
              ?.taskId,
          message:
            "message" in request.params ? request.params.message : undefined,
        },
        "elicitation/create",
      );
      return requestElicitation(request.params);
    });

    // Spec §Sampling: client MUST obtain user consent before invoking the
    // LLM. On approval we call `/api/sample`; on rejection we throw so the
    // SDK returns a JSON-RPC error to the server.
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      log.debug(
        {
          relatedTaskId:
            request.params._meta?.["io.modelcontextprotocol/related-task"]
              ?.taskId,
          messageCount: request.params.messages.length,
        },
        "sampling/createMessage",
      );
      return callSampling(request.params, requestSampling);
    });

    return () => {
      // Teardown: remove handlers so a subsequent client (after close +
      // reconnect) doesn't inherit stale references.
      client.removeRequestHandler("elicitation/create");
      client.removeRequestHandler("sampling/createMessage");
    };
  }, [client, requestElicitation, requestSampling]);

  return null;
};

// Small indirection so we can keep the call-site in `useEffect` tidy.
async function callSampling(
  params: Parameters<RequestSamplingFn>[0],
  requestSampling: RequestSamplingFn,
): ReturnType<RequestSamplingFn> {
  return requestSampling(params);
}
