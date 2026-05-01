import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

const MCP_APPS_EXTENSION_CAPABILITIES = {
  "io.modelcontextprotocol/ui": {
    mimeTypes: ["text/html;profile=mcp-app"],
  },
};

export interface CapabilityBundle {
  readonly name: string;
  readonly capability: ClientCapabilities;
}

export const elicitationFormBundle: CapabilityBundle = {
  name: "elicitation.form",
  capability: {
    elicitation: { form: {} },
    tasks: {
      requests: {
        elicitation: { create: {} },
      },
    },
  },
};

export const basicSamplingBundle: CapabilityBundle = {
  name: "sampling.basic",
  capability: {
    sampling: {},
    tasks: {
      requests: {
        sampling: { createMessage: {} },
      },
    },
  },
};

export const clientTasksBundle: CapabilityBundle = {
  name: "tasks.client",
  capability: {
    tasks: {
      list: {},
      cancel: {},
    },
  },
};

export const mcpAppsBundle: CapabilityBundle = {
  name: "extensions.mcp-apps",
  capability: {
    extensions: MCP_APPS_EXTENSION_CAPABILITIES,
  },
};

export function composeClientCapabilities(
  bundles: readonly CapabilityBundle[],
): ClientCapabilities {
  return bundles.reduce<ClientCapabilities>(
    (acc, bundle) => mergeClientCapabilities(acc, bundle.capability),
    {},
  );
}

export function defaultHostCapabilities(): ClientCapabilities {
  return composeClientCapabilities([
    elicitationFormBundle,
    basicSamplingBundle,
    clientTasksBundle,
    mcpAppsBundle,
  ]);
}

function mergeClientCapabilities(
  left: ClientCapabilities,
  right: ClientCapabilities,
): ClientCapabilities {
  return deepMerge(left, right) as ClientCapabilities;
}

function deepMerge(left: unknown, right: unknown): unknown {
  if (!isRecord(left)) return clone(right);
  if (!isRecord(right)) return clone(left);
  const out: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    out[key] = key in out ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, clone(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
