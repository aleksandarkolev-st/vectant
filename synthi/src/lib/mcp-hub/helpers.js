/**
 * Build the auth headers for a resolved connection config.
 * @param {{authType:'none'|'bearer'|'header', headerName?:string, secret?:string}} config
 * @returns {Record<string,string>}
 */
export function buildAuthHeaders(config) {
  const { authType, headerName, secret } = config || {};
  if (authType === 'bearer' && secret) return { Authorization: `Bearer ${secret}` };
  if (authType === 'header' && headerName && secret) return { [headerName]: secret };
  return {};
}

/**
 * Convert a JSON Schema (MCP tool inputSchema) to Gemini's function-parameter
 * schema, which uses UPPERCASE type names. Recurses through properties + items.
 * Falls back to an empty OBJECT when the schema is missing.
 * @param {object|undefined} schema
 * @returns {object}
 */
export function jsonSchemaToGemini(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} };
  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = jsonSchemaToGemini(v);
    }
  }
  if (schema.items) out.items = jsonSchemaToGemini(schema.items);
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (out.type === 'OBJECT' && !out.properties) out.properties = {};
  return out;
}
