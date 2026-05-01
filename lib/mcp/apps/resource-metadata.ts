import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";

export interface McpUiResourceSandboxConfig {
  readonly csp: McpUiResourceCsp | null;
  readonly permissions: McpUiResourcePermissions | null;
  readonly domain: string | null;
}

export const EMPTY_MCP_UI_RESOURCE_SANDBOX: McpUiResourceSandboxConfig =
  Object.freeze({
    csp: null,
    permissions: null,
    domain: null,
  });

export function readMcpUiResourceSandbox(result: {
  contents?: ReadonlyArray<{ _meta?: Record<string, unknown> }>;
}): McpUiResourceSandboxConfig {
  const content = result.contents?.[0];
  if (!content) return EMPTY_MCP_UI_RESOURCE_SANDBOX;
  const uiMeta = (
    content._meta as
      | {
          ui?: {
            csp?: unknown;
            permissions?: unknown;
            domain?: unknown;
          };
        }
      | undefined
  )?.ui;
  if (!uiMeta) return EMPTY_MCP_UI_RESOURCE_SANDBOX;
  return {
    csp: readResourceCsp(uiMeta.csp),
    permissions: readResourcePermissions(uiMeta.permissions),
    domain:
      typeof uiMeta.domain === "string" && uiMeta.domain.length > 0
        ? uiMeta.domain
        : null,
  };
}

function readResourceCsp(uiMetaCsp: unknown): McpUiResourceCsp | null {
  if (!uiMetaCsp || typeof uiMetaCsp !== "object") return null;
  const take = (key: string): string[] | undefined => {
    const v = (uiMetaCsp as Record<string, unknown>)[key];
    if (!Array.isArray(v)) return undefined;
    const out = v.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return out.length > 0 ? out : undefined;
  };
  const csp: McpUiResourceCsp = {
    resourceDomains: take("resourceDomains"),
    connectDomains: take("connectDomains"),
    frameDomains: take("frameDomains"),
    baseUriDomains: take("baseUriDomains"),
  };
  return csp.resourceDomains ||
    csp.connectDomains ||
    csp.frameDomains ||
    csp.baseUriDomains
    ? csp
    : null;
}

function readResourcePermissions(
  uiMetaPermissions: unknown,
): McpUiResourcePermissions | null {
  if (!uiMetaPermissions || typeof uiMetaPermissions !== "object") return null;
  const declared = (key: keyof McpUiResourcePermissions): boolean =>
    Object.hasOwn(uiMetaPermissions, key);
  const permissions: McpUiResourcePermissions = {
    ...(declared("camera") ? { camera: {} } : {}),
    ...(declared("microphone") ? { microphone: {} } : {}),
    ...(declared("geolocation") ? { geolocation: {} } : {}),
    ...(declared("clipboardWrite") ? { clipboardWrite: {} } : {}),
  };
  return permissions.camera ||
    permissions.microphone ||
    permissions.geolocation ||
    permissions.clipboardWrite
    ? permissions
    : null;
}
