import { proxyAiEngineRequest } from '@/lib/proxyAiEngine';
import { resolveActor } from '@/lib/integrations/session';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return proxyAiEngineRequest(request, '/classify/intent');
}
