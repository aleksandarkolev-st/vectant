import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { getProgramSession } from '@/lib/programs/store';
import { getProgramRuntimeSession } from '@/lib/programs/runtimeClient';
import { mergeProgramSession } from '@/lib/programs/routeHelpers';

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