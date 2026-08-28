import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { getAdapter } from './adapters/index.js';

/** Auth + load (with secrets) + scope-check a git provider; returns {error?:Response, conn?, adapter?, actor?}. */
export async function loadOwnedProvider(id) {
  const actor = await resolveActor();
  if (!actor) return { error: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  const rl = checkLimit(`git:${actor.userId}:action`, RATE_LIMITS.git);
  if (!rl.ok) return { error: NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 }) };
  const conn = await prisma.gitProvider.findUnique({ where: { id }, include: { secret: true, refreshSecret: true } });
  if (!conn) return { error: NextResponse.json({ error: 'not_found' }, { status: 404 }) };
  const owns = conn.scope === 'workspace'
    ? await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: conn.workspaceSlug })
    : conn.ownerUserId === actor.userId;
  if (!owns) return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  return { actor, conn, adapter: getAdapter(conn.providerType) };
}

/** Map an adapter result to an HTTP response. */
export function respond(r, okStatus = 200) {
  if (r.ok) return NextResponse.json(r, { status: okStatus });
  return NextResponse.json({ error: r.error?.code || 'provider_error', message: r.error?.message }, { status: 502 });
}
