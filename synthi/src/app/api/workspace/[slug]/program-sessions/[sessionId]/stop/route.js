import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { appendProgramRuntimeEvent, getProgramSession, updateProgramSession } from '@/lib/programs/store';
import { stopProgramRuntimeSession } from '@/lib/programs/runtimeClient';
import { mergeProgramSession } from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

export async function POST(_req, { params }) {
  const { slug, sessionId } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const session = await getProgramSession(sessionId);
  if (!session || session.workspaceSlug !== slug) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const runtimeSession = await stopProgramRuntimeSession(slug, sessionId);
  const updated = await updateProgramSession(sessionId, { state: runtimeSession?.state || 'stopped', endedAt: new Date() });
  await appendProgramRuntimeEvent({
    sessionId,
    type: 'stop_ack',
    data: { state: runtimeSession?.state || 'stopped' },
  });

  return NextResponse.json({ session: mergeProgramSession(updated, runtimeSession) });
}