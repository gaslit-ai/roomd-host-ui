import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge";
import { isUnsafeEvalAllowed } from "@/lib/mcp/flags";

const SANDBOX_URL = process.env.NEXT_PUBLIC_MCP_SANDBOX_URL;
const SANDBOX_PATH = "/mcp-sandbox.html";

export interface BuildSandboxUrlOptions {
  readonly csp?: McpUiResourceCsp | null;
  readonly resourceDomain?: string | null;
}

export interface SandboxUrlResult {
  readonly url: URL | null;
  readonly error?: string;
}

export function buildMcpSandboxUrl(
  options: BuildSandboxUrlOptions = {},
): SandboxUrlResult {
  if (typeof window === "undefined") return { url: null };
  const base = resolveSandboxBase(options.resourceDomain);
  if (!base) {
    return {
      url: null,
      error:
        "MCP Apps require NEXT_PUBLIC_MCP_SANDBOX_URL or a resource-declared _meta.ui.domain.",
    };
  }
  if (base.origin === window.location.origin) {
    return {
      url: null,
      error: "MCP Apps sandbox origin must differ from the host origin.",
    };
  }

  const clientLevel = process.env.NEXT_PUBLIC_LOG_LEVEL;
  if (clientLevel) base.searchParams.set("logLevel", clientLevel);
  if (isUnsafeEvalAllowed()) base.searchParams.set("unsafeEval", "1");

  const set = (param: string, values: readonly string[] | undefined) => {
    if (values && values.length > 0)
      base.searchParams.set(param, values.join(","));
  };
  set("cspResources", options.csp?.resourceDomains);
  set("cspConnects", options.csp?.connectDomains);
  set("cspFrames", options.csp?.frameDomains);
  set("cspBases", options.csp?.baseUriDomains);
  return { url: base };
}

function resolveSandboxBase(resourceDomain?: string | null): URL | null {
  if (resourceDomain)
    return safeUrl(`https://${resourceDomain}${SANDBOX_PATH}`);
  if (SANDBOX_URL) return safeUrl(SANDBOX_URL);
  return defaultLocalSandboxUrl();
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value, window.location.href);
  } catch {
    return null;
  }
}

function defaultLocalSandboxUrl(): URL | null {
  if (process.env.NODE_ENV === "production") return null;
  if (window.location.protocol !== "http:") return null;
  const hostname = window.location.hostname;
  const alternateHost =
    hostname === "localhost" || hostname === "::1"
      ? "127.0.0.1"
      : hostname === "127.0.0.1"
        ? "localhost"
        : null;
  if (!alternateHost) return null;
  const port = window.location.port ? `:${window.location.port}` : "";
  return safeUrl(`http://${alternateHost}${port}${SANDBOX_PATH}`);
}
