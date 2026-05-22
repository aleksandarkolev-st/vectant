import { proxyAiEngineRequest } from '@/lib/proxyAiEngine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function forward(request, { params }) {
  const data = await params;
  const segments = Array.isArray(data.path) ? data.path : [];
  const path = segments.map((segment) => encodeURIComponent(String(segment))).join('/');
  return proxyAiEngineRequest(request, `/provenance/${path}`);
}

export const GET = forward;
export const POST = forward;
