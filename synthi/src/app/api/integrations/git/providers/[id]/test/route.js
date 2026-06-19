import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { getAdapter } from '@/lib/git/adapters/index.js';

export const runtime = 'nodejs';

export async function POST(_req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rl = checkLimit(`git:${actor.userId}:test`, RATE_LIMITS.git);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const { id } = await params;
  const conn = await prisma.gitProvider.findUnique({ where: { id }, include: { secret: true, refreshSecret: true } });
  if (!conn) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const owns = conn.scope === 'workspace'
    ? await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: conn.workspaceSlug })
    : conn.ownerUserId === actor.userId;
  if (!owns) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const r = await getAdapter(conn.providerType).testConnection(conn);
  await prisma.gitProvider.update({ where: { id }, data: { lastHealthState: r.ok ? 'ok' : 'error', lastHealthAt: new Date(), ...(r.ok ? { accountLogin: r.accountLogin } : {}) } });
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
