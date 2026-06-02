import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveActor } from '@/lib/integrations/session';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { generatePat } from '@/lib/integrations/pat';

export const runtime = 'nodejs';

export async function POST(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`user:${actor.userId}:crud`, RATE_LIMITS.crud);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const { token, tokenHash, last4 } = generatePat();
  const row = await prisma.personalAccessToken.create({
    data: { userId: actor.userId, name, tokenHash, last4 },
  });
  return NextResponse.json({ id: row.id, name: row.name, last4: row.last4, createdAt: row.createdAt, token }, { status: 201 });
}

export async function GET() {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`user:${actor.userId}:crud`, RATE_LIMITS.crud);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const tokens = await prisma.personalAccessToken.findMany({
    where: { userId: actor.userId },
    select: { id: true, name: true, last4: true, createdAt: true, lastUsedAt: true, revokedAt: true, tokenHash: false },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ tokens });
}
