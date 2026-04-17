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
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(code, { message });
}
