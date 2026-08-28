import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope, canWriteScope } from '@/lib/integrations/scope';
import { deleteProgramSession, getProgramSession } from '@/lib/programs/store';
import { getProgramRuntimeSession, stopProgramRuntimeSession } from '@/lib/programs/runtimeClient';
import { isActiveSessionState, mergeProgramSession } from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

export async function GET(_req, { params }) {
  const { slug, sessionId } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const session = await getProgramSession(sessionId);
  if (!session || session.workspaceSlug !== slug) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const runtimeSession = await getProgramRuntimeSession(slug, sessionId).catch(() => null);
  return NextResponse.json({ session: mergeProgramSession(session, runtimeSession) });
}

export async function DELETE(_req, { params }) {
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

  // A still-running session must be torn down before its record is removed.
  if (isActiveSessionState(session.state)) {
    await stopProgramRuntimeSession(slug, sessionId).catch(() => null);
  }

  await deleteProgramSession(sessionId);
  return NextResponse.json({ ok: true, deleted: sessionId });
}