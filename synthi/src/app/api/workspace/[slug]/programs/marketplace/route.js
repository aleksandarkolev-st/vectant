import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { listPublishedPrograms } from '@/lib/programs/store';

export const runtime = 'nodejs';

// GET /api/workspace/:slug/programs/marketplace?q=
// Member-readable: browse/search the global published catalog.
export async function GET(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const q = new URL(req.url).searchParams.get('q') || '';
  const programs = await listPublishedPrograms({ q });
  return NextResponse.json({ programs });
}
