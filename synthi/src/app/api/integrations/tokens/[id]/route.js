import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveActor } from '@/lib/integrations/session';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

export async function DELETE(_req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`user:${actor.userId}:crud`, RATE_LIMITS.crud);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const { id } = await params;
  const row = await prisma.personalAccessToken.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (row.userId !== actor.userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  await prisma.personalAccessToken.update({ where: { id }, data: { revokedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
