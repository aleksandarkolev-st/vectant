import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints, oauthClient } from '@/lib/git/providerConfig.js';
import { upsertOAuthProvider } from '@/lib/git/store.js';
import { gitFetch } from '@/lib/git/safeFetch.js';

export const runtime = 'nodejs';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export async function POST(req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { provider } = await params;
  if (!['github', 'gitlab'].includes(provider)) return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  const b = await req.json().catch(() => ({}));
  if (!b.device_code) return NextResponse.json({ error: 'device_code required' }, { status: 400 });
  const { token } = oauthEndpoints(provider, null);
  const body = new URLSearchParams({ client_id: oauthClient(provider).id, device_code: b.device_code, grant_type: GRANT });
  const res = await gitFetch(token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const j = await res.json().catch(() => ({}));
  if (j.error === 'authorization_pending' || j.error === 'slow_down') return NextResponse.json({ status: j.error }, { status: 202 });
  if (!res.ok || !j.access_token) return NextResponse.json({ error: j.error || 'device_poll_failed' }, { status: 400 });

  const row = await upsertOAuthProvider({
    ownerUserId: actor.userId, providerType: provider,
    name: provider === 'gitlab' ? 'GitLab' : 'GitHub',
    accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in,
  }, { id: true, name: true, providerType: true });
  return NextResponse.json(row, { status: 201 });
}
