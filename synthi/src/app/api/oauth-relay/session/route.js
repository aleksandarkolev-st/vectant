import { NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/workspaceAccess';
import { createRelaySessionPayload } from '@/lib/oauthRelayServer';

export const runtime = 'nodejs';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const workspaceSlug = String(body?.workspaceSlug || '').trim();
  const access = await requireWorkspaceAccess(workspaceSlug);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error || 'workspace_access_denied' },
      { status: access.status || 403 },
    );
  }

  const session = createRelaySessionPayload({ access, requestBody: body });
  if (!session.ok) {
    return NextResponse.json(
      { error: session.error || 'oauth_relay_session_failed' },
      { status: session.status || 400 },
    );
  }

  return NextResponse.json({
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    expectedCallback: session.expectedCallback,
    workspaceSlug: session.payload.workspaceSlug,
    runtimeScope: session.payload.runtimeScope,
    providerOrigin: session.payload.providerOrigin,
  }, {
    headers: { 'cache-control': 'no-store' },
  });
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': '600',
    },
  });
}

