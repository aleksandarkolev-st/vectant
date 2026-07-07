import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { unpublishProgram } from '@/lib/programs/store';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/unpublish  { packageId }
// Owner/admin: take this workspace's published app down (drops it from the
// marketplace immediately). A workspace may only unpublish its OWN programs.
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }
  const packageId = typeof body.packageId === 'string' ? body.packageId : '';
  // A workspace owns only the `@<slug>/...` namespace — refuse anything else.
  if (!packageId.startsWith(`@${slug}/`)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const program = await unpublishProgram(packageId);
  return NextResponse.json({ program });
}
