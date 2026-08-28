export interface McpToolConfig {
  id: string;
  name: string;
  url: string;
  transport?: "http" | "sse";
  authType?: "none" | "bearer" | "header";
  headerName?: string | null;
  secret?: string | null;
  allowlist?: string[];
}
export interface McpTool { name: string; description?: string; inputSchema?: unknown; }
export type HubResult<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message?: string } };

export function listTools(config: McpToolConfig, opts?: unknown): Promise<HubResult<{ tools: McpTool[] }>>;
export function callTool(config: McpToolConfig, toolName: string, args?: Record<string, unknown>, opts?: unknown): Promise<HubResult<{ data: unknown }>>;
export function testConnection(config: McpToolConfig, opts?: unknown): Promise<HubResult<{ serverInfo: unknown; toolCount: number }>>;
export function assertSafeUrl(url: string, opts?: { allowlist?: string[]; lookup?: unknown }): Promise<void>;
export function isBlockedIp(ip: string): boolean;
export function buildAuthHeaders(config: McpToolConfig): Record<string, string>;
export function jsonSchemaToGemini(schema: unknown, depth?: number): unknown;
export function isAllowedHeaderName(name: string): boolean;
