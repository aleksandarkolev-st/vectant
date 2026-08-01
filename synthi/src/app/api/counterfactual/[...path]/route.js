import { NextResponse } from 'next/server';
import { proxyAiEngineRequest } from '@/lib/proxyAiEngine';

/**
 * Authenticated same-origin bridge for the counterfactual control plane.
 * The ai-engine remains the authority for workspace validation, retention,
 * deletion, and the telemetry-enabled switch.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function forward(request, { params }) {
  const { path = [] } = await params;
  const suffix = path.map(encodeURIComponent).join('/');
  if (!suffix) {
    return NextResponse.json({ error: 'counterfactual path is required' }, { status: 404 });
  }
  try {
    return await proxyAiEngineRequest(request, `/counterfactual/${suffix}`);
  } catch (error) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 502 });
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const DELETE = forward;
