import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { encryptToken } from '@/lib/tokenCrypto';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints } from '@/lib/git/providerConfig.js';

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
  const body = new URLSearchParams({ client_id: process.env[`${provider.toUpperCase()}_CLIENT_ID`] || '', device_code: b.device_code, grant_type: GRANT });
  const res = await fetch(token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const j = await res.json().catch(() => ({}));
  if (j.error === 'authorization_pending' || j.error === 'slow_down') return NextResponse.json({ status: j.error }, { status: 202 });
  if (!res.ok || !j.access_token) return NextResponse.json({ error: j.error || 'device_poll_failed' }, { status: 400 });

  const sec = await prisma.encryptedSecret.create({ data: { cipher: encryptToken(j.access_token), last4: String(j.access_token).slice(-4) } });
  let refreshSecretId = null;
  if (j.refresh_token) { const r = await prisma.encryptedSecret.create({ data: { cipher: encryptToken(j.refresh_token), last4: String(j.refresh_token).slice(-4) } }); refreshSecretId = r.id; }
  const row = await prisma.gitProvider.create({ data: {
    name: provider === 'gitlab' ? 'GitLab' : 'GitHub', providerType: provider, authType: 'oauth',
    scope: 'personal', ownerUserId: actor.userId, secretId: sec.id, refreshSecretId,
    accessTokenExpiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null,
  }, select: { id: true, name: true, providerType: true } });
  return NextResponse.json(row, { status: 201 });
}
