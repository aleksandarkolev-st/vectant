import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { listSubmissionsForWorkspace, toReviewQueueItem } from '@/lib/programs/store';

export const runtime = 'nodejs';

// GET /api/workspace/:slug/programs/submissions
// Member-readable: this workspace's submissions + their review state (redacted).
export async function GET(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const rows = await listSubmissionsForWorkspace(slug);
  return NextResponse.json({ submissions: rows.map(toReviewQueueItem) });
}
