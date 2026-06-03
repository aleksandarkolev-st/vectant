import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { encryptToken } from '@/lib/tokenCrypto';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints } from '@/lib/git/providerConfig.js';

export const runtime = 'nodejs';

export async function GET(req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { provider } = await params;
  const u = new URL(req.url);
  const code = u.searchParams.get('code'); const state = u.searchParams.get('state');
  const cookieState = req.headers.get('cookie')?.match(/git_oauth_state=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) return NextResponse.json({ error: 'invalid_state' }, { status: 400 });

  const { token: tokenUrl } = oauthEndpoints(provider, null);
  const redirectUri = `${process.env.NEXTAUTH_URL}/api/integrations/git/oauth/${provider}/callback`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: process.env[`${provider.toUpperCase()}_CLIENT_ID`] || '',
    client_secret: process.env[`${provider.toUpperCase()}_CLIENT_SECRET`] || '',
  });
  const tokenRes = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!tokenRes.ok) return NextResponse.json({ error: 'token_exchange_failed' }, { status: 502 });
  const j = await tokenRes.json();

  const sec = await prisma.encryptedSecret.create({ data: { cipher: encryptToken(j.access_token), last4: String(j.access_token).slice(-4) } });
  let refreshSecretId = null;
  if (j.refresh_token) { const r = await prisma.encryptedSecret.create({ data: { cipher: encryptToken(j.refresh_token), last4: String(j.refresh_token).slice(-4) } }); refreshSecretId = r.id; }
  await prisma.gitProvider.create({ data: {
    name: provider === 'gitlab' ? 'GitLab' : 'GitHub', providerType: provider, authType: 'oauth',
    scope: 'personal', ownerUserId: actor.userId, secretId: sec.id, refreshSecretId,
    accessTokenExpiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null,
    oauthScopes: (j.scope || '').split(/[ ,]/).filter(Boolean),
  } });
  const res = NextResponse.redirect(`${process.env.NEXTAUTH_URL}/workspace?git_connected=${provider}`, 302);
  res.cookies.set('git_oauth_state', '', { maxAge: 0, path: '/' });
  return res;
}
