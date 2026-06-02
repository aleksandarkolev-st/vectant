import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { getProvider, deleteProvider } from '@/lib/git/store';

export const runtime = 'nodejs';

export async function DELETE(_req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rl = checkLimit(`git:${actor.userId}:crud`, RATE_LIMITS.git);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const { id } = await params;
  const row = await getProvider(id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const owns = row.scope === 'workspace'
    ? await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: row.workspaceSlug })
    : row.ownerUserId === actor.userId;
  if (!owns) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  await deleteProvider(id);
  return NextResponse.json({ ok: true });
}
