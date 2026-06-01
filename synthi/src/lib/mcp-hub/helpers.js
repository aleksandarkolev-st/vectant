/** RFC 7230 token charset */
const HEADER_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** Header names that must never be forwarded on outbound server-side requests */
const HEADER_DENYLIST = new Set([
  'host', 'cookie', 'set-cookie', 'authorization', 'proxy-authorization',
  'content-length', 'content-type', 'connection', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'via', 'forwarded', 'x-real-ip',
]);

/**
 * Returns true only when `name` is a safe, non-sensitive HTTP header name:
 * - must be a non-empty string
 * - must match the RFC 7230 token charset
 * - must not be in the denylist (case-insensitive)
 * - must not start with "x-forwarded-" (case-insensitive)
 * @param {unknown} name
 * @returns {boolean}
 */
export function isAllowedHeaderName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (!HEADER_TOKEN_RE.test(name)) return false;
  const lower = name.toLowerCase();
  if (HEADER_DENYLIST.has(lower)) return false;
  if (lower.startsWith('x-forwarded-')) return false;
  return true;
}

/**
 * Build the auth headers for a resolved connection config.
 * @param {{authType:'none'|'bearer'|'header', headerName?:string, secret?:string}} config
 * @returns {Record<string,string>}
 */
export function buildAuthHeaders(config) {
  const { authType, headerName, secret } = config || {};
  if (authType === 'bearer' && secret) return { Authorization: `Bearer ${secret}` };
  if (authType === 'header' && headerName && secret && isAllowedHeaderName(headerName)) {
    return { [headerName]: secret };
  }
  return {};
}

const MAX_DEPTH = 8;

/**
 * Convert a JSON Schema (MCP tool inputSchema) to Gemini's function-parameter
 * schema, which uses UPPERCASE type names. Recurses through properties + items.
 * Falls back to an empty OBJECT when the schema is missing.
 * Bounded to MAX_DEPTH levels of recursion; drops unsupported keywords;
 * truncates description to at most 512 characters.
 * @param {object|undefined} schema
 * @param {number} [depth]
 * @returns {object}
 */
export function jsonSchemaToGemini(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
  if (depth >= MAX_DEPTH) return { type: 'STRING' };

  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) {
    const desc = String(schema.description);
    out.description = desc.length > 512 ? desc.slice(0, 512) : desc;
  }
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = jsonSchemaToGemini(v, depth + 1);
    }
  }
  if (schema.items) out.items = jsonSchemaToGemini(schema.items, depth + 1);
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (out.type === 'OBJECT' && !out.properties) out.properties = {};
  return out;
}
