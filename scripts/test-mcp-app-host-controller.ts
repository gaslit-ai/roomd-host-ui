import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { createMcpAppHostController } from "../lib/mcp/apps/host-controller.ts";

type RpcPredicate = (message: JSONRPCMessage) => boolean;

class ManualTransport implements Transport {
  sent: JSONRPCMessage[] = [];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  sessionId = "test-session";
  #waiters: Array<{
    predicate: RpcPredicate;
    resolve: (message: JSONRPCMessage) => void;
  }> = [];

  async start() {}

  async send(message: JSONRPCMessage) {
    const index = this.#waiters.findIndex((waiter) =>
      waiter.predicate(message),
    );
    if (index >= 0) {
      const [waiter] = this.#waiters.splice(index, 1);
      waiter.resolve(message);
      return;
    }
    this.sent.push(message);
  }

  async close() {
    this.onclose?.();
  }

  take(predicate: RpcPredicate) {
    const index = this.sent.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.sent.splice(index, 1)[0]);
    return new Promise<JSONRPCMessage>((resolve) => {
      this.#waiters.push({ predicate, resolve });
    });
  }

  takeAll(predicate: RpcPredicate) {
    const matches: JSONRPCMessage[] = [];
    this.sent = this.sent.filter((message) => {
      if (!predicate(message)) return true;
      matches.push(message);
      return false;
    });
    return matches;
  }
}

function tool(name: string, visibility?: Array<"model" | "app">): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
    ...(visibility
      ? {
          _meta: {
            ui: {
              resourceUri: `ui://test/${name}`,
              visibility,
            },
          },
        }
      : {}),
  };
}

function createMockClient(initialPages: Array<ReadonlyArray<Tool>>) {
  let pages = initialPages;
  const listToolsCalls: Array<unknown> = [];
  const requests: JSONRPCRequest[] = [];

  return {
    listToolsCalls,
    requests,
    setToolPages(nextPages: Array<ReadonlyArray<Tool>>) {
      pages = nextPages;
    },
    async listTools(params?: { cursor?: string }) {
      listToolsCalls.push(params ?? {});
      const index = params?.cursor ? Number(params.cursor) : 0;
      const page = pages[index] ?? [];
      const nextCursor =
        index + 1 < pages.length ? String(index + 1) : undefined;
      return { tools: [...page], nextCursor };
    },
    async request(request: JSONRPCRequest) {
      requests.push(request);
      switch (request.method) {
        case "tools/call":
          return {
            content: [{ type: "text", text: "ok" }],
            isError: false,
          };
        case "resources/subscribe":
        case "resources/unsubscribe":
          return { ok: true };
        case "resources/list":
          return { resources: [] };
        case "resources/templates/list":
          return { resourceTemplates: [] };
        case "resources/read":
          return { contents: [] };
        case "prompts/list":
          return { prompts: [] };
        default:
          return {};
      }
    },
  };
}

let nextRequestId = 1;

async function viewRequest(
  transport: ManualTransport,
  method: string,
  params: Record<string, unknown> = {},
) {
  const id = nextRequestId++;
  const responsePromise = transport.take(
    (message) => "id" in message && message.id === id,
  );
  transport.onmessage?.({ jsonrpc: "2.0", id, method, params });
  return responsePromise;
}

async function viewNotify(
  transport: ManualTransport,
  method: string,
  params: Record<string, unknown> = {},
) {
  transport.onmessage?.({ jsonrpc: "2.0", method, params });
  await Promise.resolve();
}

async function initializeView(
  controller: ReturnType<typeof createMcpAppHostController>,
  transport: ManualTransport,
  appCapabilities: Record<string, unknown> = {},
) {
  await controller.bridge.connect(transport);
  const initialized = await viewRequest(transport, "ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "test-view", version: "1.0.0" },
    appCapabilities,
  });
  assert.equal("error" in initialized, false);
  await viewNotify(transport, "ui/notifications/initialized");
}

function createController(
  client: ReturnType<typeof createMockClient>,
  options: Partial<Parameters<typeof createMcpAppHostController>[0]> = {},
) {
  return createMcpAppHostController({
    client: client as never,
    hostCapabilities: {
      serverTools: { listChanged: true },
      serverResources: { listChanged: true },
      logging: {},
    },
    ...options,
  });
}

function notificationMethods(transport: ManualTransport) {
  return transport
    .takeAll((message) => !("id" in message) && "method" in message)
    .map((message) => ("method" in message ? message.method : ""));
}

function toolNames(response: JSONRPCMessage) {
  assert.equal("error" in response, false);
  assert.equal("result" in response, true);
  return (
    (response as unknown as { result: { tools: Tool[] } }).result.tools ?? []
  ).map((item) => item.name);
}

test("filters model-only tools from app tools/list and rejects model-only tools/call", async () => {
  const client = createMockClient([
    [
      tool("visible-default"),
      tool("app-only", ["app"]),
      tool("model-only", ["model"]),
    ],
  ]);
  const controller = createController(client);
  const transport = new ManualTransport();

  await initializeView(controller, transport);

  const list = await viewRequest(transport, "tools/list");
  assert.deepEqual(toolNames(list), ["visible-default", "app-only"]);

  const rejected = await viewRequest(transport, "tools/call", {
    name: "model-only",
    arguments: {},
  });
  assert.equal("error" in rejected, true);
  assert.match(
    "error" in rejected ? rejected.error.message : "",
    /model-only and is not visible to MCP Apps/,
  );

  controller.dispose();
});

test("clears the per-view tool cache on tools/list_changed and refreshes paginated tools", async () => {
  const client = createMockClient([[tool("alpha")], [tool("beta")]]);
  const controller = createController(client);
  const transport = new ManualTransport();

  await initializeView(controller, transport);

  const first = await viewRequest(transport, "tools/list");
  assert.deepEqual(toolNames(first), ["alpha", "beta"]);
  assert.equal(client.listToolsCalls.length, 2);

  client.setToolPages([[tool("alpha")], [tool("beta")], [tool("gamma")]]);
  const cached = await viewRequest(transport, "tools/list");
  assert.deepEqual(toolNames(cached), ["alpha", "beta"]);
  assert.equal(client.listToolsCalls.length, 2);

  controller.sendToolListChanged();
  await Promise.resolve();
  transport.takeAll((message) => "method" in message);

  const refreshed = await viewRequest(transport, "tools/list");
  assert.deepEqual(toolNames(refreshed), ["alpha", "beta", "gamma"]);
  assert.equal(client.listToolsCalls.length, 5);

  controller.dispose();
});

test("buffers host-to-view lifecycle notifications until the view is initialized", async () => {
  const client = createMockClient([[tool("visible")]]);
  const controller = createController(client);
  const transport = new ManualTransport();

  controller.sendToolListChanged();
  controller.sendResourceListChanged();
  controller.sendPromptListChanged();
  controller.sendToolInputPartial({ arguments: { partial: true } });
  controller.sendToolCancelled({});
  await controller.bridge.connect(transport);
  assert.deepEqual(notificationMethods(transport), []);

  await viewRequest(transport, "ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "test-view", version: "1.0.0" },
    appCapabilities: {},
  });
  assert.deepEqual(notificationMethods(transport), []);

  await viewNotify(transport, "ui/notifications/initialized");
  assert.deepEqual(notificationMethods(transport).sort(), [
    "notifications/prompts/list_changed",
    "notifications/resources/list_changed",
    "notifications/tools/list_changed",
    "ui/notifications/tool-cancelled",
    "ui/notifications/tool-input-partial",
  ]);

  controller.dispose();
});

test("routes resource updates only for subscribed URIs and unsubscribes on dispose", async () => {
  const client = createMockClient([[tool("visible")]]);
  let resourceUpdated:
    | ((params: { uri: string; [key: string]: unknown }) => void)
    | undefined;
  let fanoutUnsubscribed = false;
  const controller = createController(client, {
    onResourceUpdated: (listener) => {
      resourceUpdated = listener;
      return () => {
        fanoutUnsubscribed = true;
      };
    },
  });
  const transport = new ManualTransport();

  await initializeView(controller, transport);
  await viewRequest(transport, "resources/subscribe", {
    uri: "resource://one",
  });

  resourceUpdated?.({ uri: "resource://two" });
  await Promise.resolve();
  assert.deepEqual(notificationMethods(transport), []);

  resourceUpdated?.({ uri: "resource://one" });
  await Promise.resolve();
  const routed = transport.takeAll(
    (message) =>
      "method" in message &&
      message.method === "notifications/resources/updated",
  );
  assert.equal(routed.length, 1);
  assert.deepEqual("params" in routed[0] ? routed[0].params : {}, {
    uri: "resource://one",
  });

  await viewRequest(transport, "resources/unsubscribe", {
    uri: "resource://one",
  });
  resourceUpdated?.({ uri: "resource://one" });
  await Promise.resolve();
  assert.deepEqual(notificationMethods(transport), []);

  await viewRequest(transport, "resources/subscribe", {
    uri: "resource://dispose-me",
  });
  controller.dispose();
  await Promise.resolve();

  assert.equal(fanoutUnsubscribed, true);
  assert.equal(
    client.requests.some(
      (request) =>
        request.method === "resources/unsubscribe" &&
        request.params?.uri === "resource://dispose-me",
    ),
    true,
  );
});
