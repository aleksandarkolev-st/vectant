import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints, oauthClient } from '@/lib/git/providerConfig.js';
import { upsertOAuthProvider } from '@/lib/git/store.js';
import { gitFetch } from '@/lib/git/safeFetch.js';

export const runtime = 'nodejs';

export async function GET(req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { provider } = await params;
  if (!['github', 'gitlab'].includes(provider)) return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  const u = new URL(req.url);
  const code = u.searchParams.get('code'); const state = u.searchParams.get('state');
  const cookieState = req.headers.get('cookie')?.match(/git_oauth_state=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) return NextResponse.json({ error: 'invalid_state' }, { status: 400 });

  const { token: tokenUrl } = oauthEndpoints(provider, null);
  const redirectUri = `${process.env.NEXTAUTH_URL}/api/integrations/git/oauth/${provider}/callback`;
  const { id: clientId, secret: clientSecret } = oauthClient(provider);
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: clientId, client_secret: clientSecret,
  });
  const tokenRes = await gitFetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!tokenRes.ok) return NextResponse.json({ error: 'token_exchange_failed' }, { status: 502 });
  const j = await tokenRes.json();

  await upsertOAuthProvider({
    ownerUserId: actor.userId, providerType: provider,
    name: provider === 'gitlab' ? 'GitLab' : 'GitHub',
    accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in,
    oauthScopes: (j.scope || '').split(/[ ,]/).filter(Boolean),
  });
  const res = NextResponse.redirect(`${process.env.NEXTAUTH_URL}/workspace?git_connected=${provider}`, 302);
  res.cookies.set('git_oauth_state', '', { maxAge: 0, path: '/' });
  return res;
}
