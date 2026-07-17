export interface ToolContext {
  defaultSessionId?: string;
  defaultSignalingUrl: string;
}

export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse {
  content: ToolContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const PUBLIC_ERROR_DIAGNOSTIC_SCHEMA = "synthi.mcp.public_error_diagnostic.v1";
const publicErrorReferenceKey = randomBytes(32);

function exceptionClass(err: unknown): string {
  if (err instanceof TypeError) return "type_error";
  if (err instanceof RangeError) return "range_error";
  if (err instanceof SyntaxError) return "syntax_error";
  if (err instanceof AggregateError) return "aggregate_error";
  if (err instanceof Error && err.name === "AbortError") return "abort_error";
  if (err instanceof Error) return "runtime_error";
  return "non_error_throwable";
}

function errorMessage(err: unknown): string | null {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return null;
}

function errorMessageReference(message: string): string {
  const digest = createHmac("sha256", publicErrorReferenceKey)
    .update("mcp-tool-error\0")
    .update(message)
    .digest("hex");
  return `mcp-error-message-ref:sha256:${digest}`;
}

export function jsonResponse(obj: Record<string, unknown>): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
}

export function errorResponse(
  code: string,
  detail?: Record<string, unknown>
): ToolResponse {
  const payload = { error: code, ...(detail ?? {}) };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

export function imageAndTextResponse(
  base64Png: string,
  structured: Record<string, unknown>
): ToolResponse {
  return {
    content: [
      { type: "image", data: base64Png, mimeType: "image/png" },
      { type: "text", text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
}

export function errorFromException(code: string, err: unknown): ToolResponse {
  const message = errorMessage(err);
  return errorResponse(code, {
    schemaVersion: PUBLIC_ERROR_DIAGNOSTIC_SCHEMA,
    evidenceAuthority: "exception_class_only_not_runtime_or_gpu_hmr_proof",
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    exceptionClass: exceptionClass(err),
    messagePresent: message !== null,
    ...(message !== null ? { messageRef: errorMessageReference(message) } : {}),
  });
}
import { createHmac, randomBytes } from "node:crypto";
