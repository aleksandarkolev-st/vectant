import { NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/workspaceAccess';
import {
  forwardRuntimeCallback,
  markRelaySessionConsumed,
  relaySessionConsumed,
  validateCallbackAgainstExpected,
} from '@/lib/oauthRelayServer';

export const runtime = 'nodejs';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const sessionId = String(body?.sessionId || '').trim();
  const callbackUrl = String(body?.callbackUrl || '').trim();
  if (!sessionId || !callbackUrl) {
    return NextResponse.json({ error: 'sessionId and callbackUrl are required' }, { status: 400 });
  }

  const session = relaySessionConsumed(sessionId);
  if (!session.ok) {
    return NextResponse.json(
      { error: session.error || 'invalid_relay_session' },
      { status: session.status || 400 },
    );
  }

  const payload = session.payload;
  if (body?.workspaceSlug && String(body.workspaceSlug).trim() !== payload.workspaceSlug) {
    return NextResponse.json({ error: 'workspace_scope_mismatch' }, { status: 403 });
  }

  const access = await requireWorkspaceAccess(payload.workspaceSlug);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error || 'workspace_access_denied' },
      { status: access.status || 403 },
    );
  }

  const validated = validateCallbackAgainstExpected(callbackUrl, payload.expectedCallback);
  if (!validated.ok) {
    return NextResponse.json(
      { error: validated.error || 'invalid_callback_url' },
      { status: validated.status || 400 },
    );
  }

  const forwarded = await forwardRuntimeCallback({
    runtimeScope: payload.runtimeScope,
    callbackUrl,
  });
  if (!forwarded.ok) {
    return NextResponse.json(
      { error: forwarded.error || 'runtime_callback_failed', statusCode: forwarded.statusCode },
      { status: forwarded.statusCode >= 400 && forwarded.statusCode < 600 ? forwarded.statusCode : 502 },
    );
  }

  markRelaySessionConsumed(sessionId);

  return NextResponse.json({
    ok: true,
    statusCode: forwarded.statusCode,
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

