import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const DEFAULT_LOCAL_BRIDGE_URL = 'http://127.0.0.1:9466';

function normalizeBaseUrl(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\/+$/, '')
    : '';
}

function workflowBridgeBaseUrl() {
  const configured = normalizeBaseUrl(process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL);
  if (configured) return configured;

  const port = process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT;
  if (port) {
    const host = process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST || '127.0.0.1';
    return `http://${host}:${port}`;
  }

  return process.env.NODE_ENV === 'production' ? '' : DEFAULT_LOCAL_BRIDGE_URL;
}

function responseHeaders(upstream) {
  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-store');
  return headers;
}

async function proxyWorkflowBridge(request, context) {
  const baseUrl = workflowBridgeBaseUrl();
  if (!baseUrl) {
    return NextResponse.json(
      { error: 'workflow_bridge_not_configured' },
      { status: 503 },
    );
  }

  const params = await context.params;
  const path = Array.isArray(params?.path) ? params.path.join('/') : '';
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(`/browser-workflows/${path}`, baseUrl);
  upstreamUrl.search = incomingUrl.search;

  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);

  const serverToken = process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN;
  const browserToken = request.headers.get('x-synthi-workflow-token');
  if (serverToken) {
    headers.set('x-synthi-workflow-token', serverToken);
  } else if (browserToken) {
    headers.set('x-synthi-workflow-token', browserToken);
  }

  const init = {
    method: request.method,
    headers,
    cache: 'no-store',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  try {
    const upstream = await fetch(upstreamUrl, init);
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'workflow_bridge_unreachable', detail: err?.message || String(err) },
      { status: 502 },
    );
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, X-Synthi-Workflow-Token',
      'access-control-max-age': '600',
    },
  });
}

export const GET = proxyWorkflowBridge;
export const POST = proxyWorkflowBridge;
