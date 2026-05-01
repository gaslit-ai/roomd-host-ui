"use client";

/**
 * Standalone UI resource browser.
 *
 * SEP-1865 says "UI resources are primarily discovered through tool metadata"
 * but does NOT preclude servers from exposing `ui://` resources directly via
 * `resources/list`. When that happens, the user may want to open them
 * independently — this panel provides the entrypoint.
 *
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import { LayersIcon } from "lucide-react";
import { type FC, useEffect, useMemo, useState } from "react";
import { HostAppRenderer } from "@/components/mcp/host-app-renderer";
import {
  type UIResourceInfo,
  useMcpClient,
  useUIResources,
} from "@/components/providers/mcp-client-provider";
import { useMcpHostContext } from "@/components/providers/mcp-host-context-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { childLog } from "@/lib/logger";
import {
  EMPTY_MCP_UI_RESOURCE_SANDBOX,
  type McpUiResourceSandboxConfig,
  readMcpUiResourceSandbox,
} from "@/lib/mcp/apps/resource-metadata";
import { buildMcpSandboxUrl } from "@/lib/mcp/apps/sandbox-url";
import { confirmAndOpenLink } from "@/lib/mcp/link-confirm";

const log = childLog("mcp-apps:resource-panel");
const STANDALONE_TOOL_NAME = "__ui_resource__";

export const ResourceUIPanel: FC = () => {
  const resources = useUIResources();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<UIResourceInfo | null>(null);

  if (resources.length === 0) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <LayersIcon className="size-4" />
            UI Resources ({resources.length})
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>UI Resources</DialogTitle>
          </DialogHeader>
          <ul className="flex flex-col gap-1">
            {resources.map((resource) => (
              <li key={resource.uri}>
                <button
                  type="button"
                  onClick={() => {
                    log.debug({ uri: resource.uri }, "open resource");
                    setSelected(resource);
                    setOpen(false);
                  }}
                  className="flex w-full flex-col items-start gap-0.5 rounded-md border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span className="font-medium">
                    {resource.title ?? resource.name}
                  </span>
                  <span className="truncate text-muted-foreground text-xs">
                    {resource.uri}
                  </span>
                  {resource.description ? (
                    <span className="text-muted-foreground text-xs">
                      {resource.description}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      {selected ? (
        <ResourceUIViewer
          resource={selected}
          onClose={() => {
            log.debug({ uri: selected.uri }, "close resource");
            setSelected(null);
          }}
        />
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------
// Viewer dialog — mounts AppRenderer against a synthetic tool for a resource.
// ---------------------------------------------------------------------------

interface ViewerProps {
  resource: UIResourceInfo;
  onClose: () => void;
}

const ResourceUIViewer: FC<ViewerProps> = ({ resource, onClose }) => {
  const {
    client,
    onResourceUpdated,
    onToolListChanged,
    onResourceListChanged,
    onPromptListChanged,
  } = useMcpClient();
  const { hostContext } = useMcpHostContext();
  const [resourceSandbox, setResourceSandbox] = useState<
    McpUiResourceSandboxConfig | "loading"
  >("loading");

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setResourceSandbox("loading");
    client
      .readResource({ uri: resource.uri })
      .then((read) => {
        if (!cancelled) setResourceSandbox(readMcpUiResourceSandbox(read));
      })
      .catch((err) => {
        if (cancelled) return;
        log.warn(
          { err, uri: resource.uri },
          "resource prefetch failed; sandbox will use default CSP + no permissions",
        );
        setResourceSandbox(EMPTY_MCP_UI_RESOURCE_SANDBOX);
      });
    return () => {
      cancelled = true;
    };
  }, [client, resource.uri]);

  const sandboxResult = useMemo(() => {
    if (resourceSandbox === "loading") return { url: null };
    return buildMcpSandboxUrl({
      csp: resourceSandbox.csp,
      resourceDomain: resourceSandbox.domain,
    });
  }, [resourceSandbox]);
  const sandboxUrl = sandboxResult.url;

  const hostCapabilities = useMemo<McpUiHostCapabilities>(() => {
    const cspGranted =
      resourceSandbox === "loading" ? null : resourceSandbox.csp;
    const permissions =
      resourceSandbox === "loading" ? null : resourceSandbox.permissions;
    const sandbox: McpUiHostCapabilities["sandbox"] | undefined =
      cspGranted || permissions
        ? {
            ...(cspGranted ? { csp: cspGranted } : {}),
            ...(permissions ? { permissions } : {}),
          }
        : undefined;
    return {
      openLinks: {},
      serverTools: { listChanged: true },
      serverResources: { listChanged: true },
      logging: {},
      message: { text: {} },
      ...(sandbox ? { sandbox } : {}),
    };
  }, [resourceSandbox]);

  if (!client) return null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[90vw] overflow-hidden p-0 sm:max-w-[90vw]">
        <DialogHeader className="border-b px-4 py-2">
          <DialogTitle className="text-sm">
            {resource.title ?? resource.name}
          </DialogTitle>
        </DialogHeader>
        <div className="h-[80vh] w-full">
          {sandboxUrl ? (
            <HostAppRenderer
              client={client}
              toolName={STANDALONE_TOOL_NAME}
              toolResourceUri={resource.uri}
              sandbox={{ url: sandboxUrl }}
              hostCapabilities={hostCapabilities}
              hostContext={hostContext}
              onResourceUpdated={onResourceUpdated}
              onToolListChanged={onToolListChanged}
              onResourceListChanged={onResourceListChanged}
              onPromptListChanged={onPromptListChanged}
              onOpenLink={async ({ url }) => {
                await confirmAndOpenLink(url);
                return {};
              }}
              onError={(err) =>
                log.warn({ err, uri: resource.uri }, "resource viewer error")
              }
            />
          ) : (
            <div
              role="alert"
              className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm"
            >
              MCP App unavailable:{" "}
              {sandboxResult.error ?? "sandbox URL is not ready."}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
