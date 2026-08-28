import { withInternalAiAuth } from '@/lib/internalAiAuth';

const AI_ENGINE_BASE = (
  process.env.CODE_INTEL_URL
  || process.env.AI_ENGINE_URL
  || 'http://localhost:8000'
).replace(/\/$/, '');

const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control'];

export async function proxyAiEngineRequest(request, targetPath, options = {}) {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(targetPath, `${AI_ENGINE_BASE}/`);
  targetUrl.search = incomingUrl.search;

  const headers = {};
  const contentType = request.headers.get('content-type');
  const accept = request.headers.get('accept');
  if (contentType) headers['content-type'] = contentType;
  if (accept) headers.accept = accept;

  const init = {
    method: request.method,
    headers: withInternalAiAuth(headers),
    redirect: 'manual',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(targetUrl, init);
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  if (
    typeof options.transformJson === 'function'
    && (upstream.headers.get('content-type') || '').toLowerCase().includes('application/json')
  ) {
    const raw = await upstream.text();
    try {
      const body = raw ? JSON.parse(raw) : null;
      responseHeaders.set('content-type', 'application/json');
      return new Response(JSON.stringify(options.transformJson(body)), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch {
      return new Response(raw, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
