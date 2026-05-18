export function withInternalAiAuth(headers = {}) {
  const token = process.env.AI_BACKEND_AUTH_TOKEN || process.env.AI_ENGINE_AUTH_TOKEN;
  if (!token) return headers;
  return {
    ...headers,
    'x-synthi-internal-token': token,
  };
}
