import { NextResponse } from 'next/server';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canWriteScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { appendProgramRuntimeEvent, getProgramSession, updateProgramSession } from '@/lib/programs/store';
import { restartProgramRuntimeSession } from '@/lib/programs/runtimeClient';
import { codeSiteContextFromBody, mergeProgramSession } from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

export async function POST(req, { params }) {
  const { sessionId } = await params;
  const actor = await authenticatePat(req);
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceSlug = String(body.workspaceSlug || '').trim();
  if (!workspaceSlug) return NextResponse.json({ error: 'workspace_required' }, { status: 400 });
  const limit = checkLimit(`cli:${actor.userId}:mcp-program-restart`, RATE_LIMITS.extcall);
  if (!limit.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: limit.retryAfterMs }, { status: 429 });
  if (!(await canWriteScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug }))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await getProgramSession(sessionId);
  if (!session || session.workspaceSlug !== workspaceSlug) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const codeSiteContext = codeSiteContextFromBody(body);
  const runtimeSession = await restartProgramRuntimeSession(workspaceSlug, sessionId);
  const updated = await updateProgramSession(sessionId, { state: runtimeSession?.state || 'running', endedAt: null });
  await appendProgramRuntimeEvent({ sessionId, type: 'restart_ack', data: { state: runtimeSession?.state || 'running', via: 'mcp' }, codeSiteContext });
  return NextResponse.json({ session: mergeProgramSession(updated, runtimeSession) });
}
