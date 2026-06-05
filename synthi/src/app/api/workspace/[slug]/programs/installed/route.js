import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { listInstalls, toPublicInstall } from '@/lib/programs/store';

export const runtime = 'nodejs';

// GET /api/workspace/:slug/programs/installed
// Member-readable list of persisted installs (public metadata only).
export async function GET(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const installs = (await listInstalls(slug)).map(toPublicInstall);
  return NextResponse.json({ installs });
}
