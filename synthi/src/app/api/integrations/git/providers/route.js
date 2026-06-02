import { NextResponse } from 'next/server';
import { assertSafeUrl } from '@synthi/mcp-hub';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { listProviders, createPatProvider } from '@/lib/git/store';

export const runtime = 'nodejs';
const limited = (actor) => checkLimit(`git:${actor.userId}:crud`, RATE_LIMITS.git);

export async function GET(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rl = limited(actor); if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const slug = new URL(req.url).searchParams.get('workspaceSlug') || null;
  let workspaceSlug = null;
  if (slug && (await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: slug }))) workspaceSlug = slug;
  return NextResponse.json({ providers: await listProviders(actor, workspaceSlug) });
}

export async function POST(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const rl = limited(actor); if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const b = await req.json().catch(() => ({}));
  const providerType = ['github', 'gitlab', 'generic'].includes(b.providerType) ? b.providerType : null;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const token = typeof b.token === 'string' ? b.token.trim() : '';
  if (!providerType || !name || !token) return NextResponse.json({ error: 'providerType, name, token required' }, { status: 400 });
  let baseUrl = typeof b.baseUrl === 'string' && b.baseUrl.trim() ? b.baseUrl.trim() : null;
  if (providerType === 'generic' && !baseUrl) return NextResponse.json({ error: 'baseUrl required for generic' }, { status: 400 });
  if (baseUrl) { try { await assertSafeUrl(baseUrl); } catch { return NextResponse.json({ error: 'unsafe_base_url' }, { status: 400 }); } }
  let workspaceSlug = null;
  if (b.workspaceSlug && (await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: b.workspaceSlug }))) workspaceSlug = b.workspaceSlug;
  const row = await createPatProvider(actor, { providerType, name, baseUrl, token, workspaceSlug });
  return NextResponse.json(row, { status: 201 });
}
