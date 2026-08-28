import { NextResponse } from 'next/server';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canReadScope } from '@/lib/integrations/scope';
import { resolveToolConfigs } from '@/lib/integrations/connectionStore';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

export async function GET(req) {
  const actor = await authenticatePat(req);
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`cli:${actor.userId}:resolve`, RATE_LIMITS.resolve);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const requested = new URL(req.url).searchParams.get('workspaceSlug') || null;
  // Same defense-in-depth as the in-app path: a non-member slug degrades to personal-only.
  let workspaceSlug = null;
  if (requested && (await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: requested }))) {
    workspaceSlug = requested;
  }
  const configs = await resolveToolConfigs({ userId: actor.userId, workspaceSlug });
  return NextResponse.json({ configs });
}
