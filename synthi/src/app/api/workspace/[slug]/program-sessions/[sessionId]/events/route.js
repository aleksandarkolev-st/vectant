import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { getProgramSession, listProgramRuntimeEvents } from '@/lib/programs/store';
import { listProgramRuntimeSessionEvents } from '@/lib/programs/runtimeClient';
import { sanitizeProgramEvent, sortProgramEvents } from '@/lib/programs/routeHelpers';

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

  const [storedEvents, runtimeEvents] = await Promise.all([
    listProgramRuntimeEvents(sessionId),
    listProgramRuntimeSessionEvents(slug, sessionId).catch(() => []),
  ]);

  return NextResponse.json({
    events: sortProgramEvents([...storedEvents, ...runtimeEvents].map(sanitizeProgramEvent)),
  });
}