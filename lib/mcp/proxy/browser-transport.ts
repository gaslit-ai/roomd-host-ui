import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  JSONRPCResponse,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpProjectionEvent } from "@/lib/mcp/kernel/types";

export class BrowserMcpProxyTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  private events: EventSource | null = null;
  private protocolVersion: string | undefined;
  private started = false;

  constructor(
    private readonly postUrl = "/api/mcp/proxy",
    private readonly eventUrl = postUrl,
  ) {}

  async start(): Promise<void> {
    if (this.started)
      throw new Error("BrowserMcpProxyTransport already started");
    this.started = true;
    this.events = new EventSource(this.eventUrl);
    this.events.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as McpProjectionEvent;
        if (parsed.kind === "mcp") this.onmessage?.(parsed.message);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    };
    this.events.onerror = () => {
      this.onerror?.(new Error("MCP proxy event stream failed"));
    };
  }

  async send(message: JSONRPCMessage | JSONRPCMessage[]): Promise<void> {
    const response = await fetch(this.postUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(this.protocolVersion
          ? { "mcp-protocol-version": this.protocolVersion }
          : {}),
      },
      body: JSON.stringify(message),
    });
    if (response.status === 202 || response.status === 204) return;
    if (!response.ok) {
      throw new Error(`MCP proxy ${response.status}: ${response.statusText}`);
    }
    const body = (await response.json()) as JSONRPCMessage | JSONRPCMessage[];
    const messages = Array.isArray(body) ? body : [body];
    for (const item of messages) this.onmessage?.(item);
  }

  async close(): Promise<void> {
    this.events?.close();
    this.events = null;
    this.started = false;
    this.onclose?.();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }
}

export function isJsonRpcResponse(
  message: JSONRPCMessage,
): message is JSONRPCResponse {
  return "id" in message && ("result" in message || "error" in message);
}
