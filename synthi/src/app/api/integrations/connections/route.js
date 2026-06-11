import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope, canWriteScope } from '@/lib/integrations/scope';
import { listConnections, createConnection } from '@/lib/integrations/connectionStore';
import { isAllowedHeaderName } from '@synthi/mcp-hub';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

export async function GET(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`user:${actor.userId}:crud`, RATE_LIMITS.crud);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const workspaceSlug = new URL(req.url).searchParams.get('workspaceSlug') || null;
  // R1-9: viewing a workspace's connections requires membership (any role).
  if (workspaceSlug && !(await canReadScope(actor, { scope: 'workspace', workspaceSlug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const connections = await listConnections({ userId: actor.userId, workspaceSlug });
  return NextResponse.json({ connections });
}

export async function POST(req) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`user:${actor.userId}:crud`, RATE_LIMITS.crud);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const { name, url, transport = 'http', scope, workspaceSlug = null, authType = 'none', headerName = null, secret = null } = body || {};

  if (!name || !url || !scope) {
    return NextResponse.json({ error: 'name, url and scope are required' }, { status: 400 });
  }
  if (!['http', 'sse'].includes(transport)) {
    return NextResponse.json({ error: 'invalid transport' }, { status: 400 });
  }
  if (!['none', 'bearer', 'header'].includes(authType)) {
    return NextResponse.json({ error: 'invalid authType' }, { status: 400 });
  }
  if (!['personal', 'workspace'].includes(scope)) {
    return NextResponse.json({ error: 'invalid scope' }, { status: 400 });
  }
  // R1-6: a dangerous/invalid custom header name must never reach the DB.
  if (authType === 'header' && (!headerName || !isAllowedHeaderName(headerName))) {
    return NextResponse.json({ error: 'invalid_header_name' }, { status: 400 });
  }
  if (headerName && !isAllowedHeaderName(headerName)) {
    return NextResponse.json({ error: 'invalid_header_name' }, { status: 400 });
  }

  const ownerUserId = scope === 'personal' ? actor.userId : null;
  const allowed = await canWriteScope(actor, { scope, ownerUserId, workspaceSlug });
  if (!allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // Fail-closed: a new connection starts with NO tools enabled.
  const created = await createConnection({
    name, url, transport, scope, ownerUserId, workspaceSlug, authType, headerName, secret, toolAllowlist: [], enabled: true,
  });
  return NextResponse.json({ connection: created }, { status: 201 });
}
