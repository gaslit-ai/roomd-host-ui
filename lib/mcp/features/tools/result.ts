import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { RunError, RunResult } from "@/lib/mcp/kernel/types";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});
addFormats(ajv);

const validatorCache = new WeakMap<object, ValidateFunction>();

export interface ToolResultModel {
  readonly result: RunResult;
  readonly validationError?: RunError;
}

export function modelToolResult(
  result: CallToolResult,
  tool: Tool | undefined,
): ToolResultModel {
  const runResult: RunResult = {
    content: result.content,
    structuredContent: result.structuredContent,
    isError: result.isError ?? false,
    _meta: result._meta,
  };
  const outputSchema = tool?.outputSchema;
  if (!outputSchema) return { result: runResult };

  const value =
    result.structuredContent ??
    parseFirstTextContent(result.content)?.value ??
    undefined;
  const validation = validateJsonSchema(value, outputSchema, "$");
  if (validation.length === 0) return { result: runResult };
  return {
    result: runResult,
    validationError: {
      message: `Tool "${tool.name}" returned output that does not match outputSchema: ${validation[0]}`,
      data: validation,
    },
  };
}

export function mcpToModelOutput({ output }: { output: unknown }):
  | { type: "json"; value: unknown }
  | {
      type: "content";
      value: Array<
        | { type: "text"; text: string }
        | { type: "image-data"; data: string; mediaType: string }
      >;
    } {
  if (!isCallToolResultLike(output)) return { type: "json", value: output };
  if (output.structuredContent !== undefined) {
    return { type: "json", value: output.structuredContent };
  }
  const converted = output.content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    if (part.type === "image") {
      return {
        type: "image-data" as const,
        data: part.data,
        mediaType: part.mimeType,
      };
    }
    return { type: "text" as const, text: JSON.stringify(part) };
  });
  return { type: "content", value: converted };
}

function isCallToolResultLike(value: unknown): value is CallToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function parseFirstTextContent(
  content: CallToolResult["content"],
): { value: unknown } | undefined {
  const text = content.find((item) => item.type === "text");
  if (!text || text.type !== "text") return undefined;
  try {
    return { value: JSON.parse(text.text) };
  } catch {
    return undefined;
  }
}

function validateJsonSchema(
  value: unknown,
  schema: unknown,
  path: string,
): string[] {
  if (typeof schema !== "boolean" && !isRecord(schema)) return [];
  const validator = compileValidator(schema);
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error) => formatAjvError(error, path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compileValidator(schema: boolean | Record<string, unknown>) {
  if (typeof schema === "boolean") return ajv.compile(schema);
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const compiled = ajv.compile(schema);
  validatorCache.set(schema, compiled);
  return compiled;
}

function formatAjvError(error: ErrorObject, rootPath: string): string {
  const instancePath = error.instancePath
    ? `${rootPath}${error.instancePath.replaceAll("/", ".")}`
    : rootPath;
  if (error.keyword === "required") {
    const missing = error.params.missingProperty;
    return `${instancePath}.${missing} is required`;
  }
  return `${instancePath} ${error.message ?? `failed ${error.keyword} validation`}`;
}
