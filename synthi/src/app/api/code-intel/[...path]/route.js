import { proxyAiEngineRequest } from '@/lib/proxyAiEngine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function forward(request, { params }) {
  const data = await params;
  const segments = Array.isArray(data.path) ? data.path : [];
  const path = segments.map((segment) => encodeURIComponent(String(segment))).join('/');
  const targetPath = segments.length === 1 && segments[0] === 'health'
    ? '/health'
    : `/code-intel/${path}`;
  return proxyAiEngineRequest(request, targetPath);
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const DELETE = forward;
