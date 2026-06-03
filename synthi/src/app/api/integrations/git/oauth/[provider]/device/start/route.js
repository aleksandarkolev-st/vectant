import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { oauthEndpoints } from '@/lib/git/providerConfig.js';

export const runtime = 'nodejs';
const SCOPES = { github: 'repo read:user', gitlab: 'api read_user' };

export async function POST(_req, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { provider } = await params;
  if (!['github', 'gitlab'].includes(provider)) return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  const { device } = oauthEndpoints(provider, null);
  const body = new URLSearchParams({ client_id: process.env[`${provider.toUpperCase()}_CLIENT_ID`] || '', scope: SCOPES[provider] });
  const res = await fetch(device, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!res.ok) return NextResponse.json({ error: 'device_start_failed' }, { status: 502 });
  const j = await res.json();
  return NextResponse.json({ device_code: j.device_code, user_code: j.user_code, verification_uri: j.verification_uri || j.verification_uri_complete, interval: j.interval || 5 });
}
