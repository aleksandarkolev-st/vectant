import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints, oauthClient } from '@/lib/git/providerConfig.js';

export const runtime = 'nodejs';
const SCOPES = { github: 'repo read:user', gitlab: 'api read_user' };

export async function GET(req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { provider } = await params;
  if (!['github', 'gitlab'].includes(provider)) return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${process.env.NEXTAUTH_URL}/api/integrations/git/oauth/${provider}/callback`;
  const { authorize } = oauthEndpoints(provider, null);
  const url = new URL(authorize);
  url.searchParams.set('client_id', oauthClient(provider).id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES[provider]);
  url.searchParams.set('state', state);
  const res = NextResponse.redirect(url.toString());
  res.cookies.set('git_oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });
  return res;
}
