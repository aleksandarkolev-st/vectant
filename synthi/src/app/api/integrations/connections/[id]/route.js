import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { getConnectionRow, updateConnection, deleteConnection } from '@/lib/integrations/connectionStore';
import { isAllowedHeaderName } from '@/lib/mcp-hub';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

async function authorize(id) {
  const actor = await resolveActor();
  if (!actor) return { status: 401, error: 'unauthenticated' };
  const rl = checkLimit(`user:${actor.userId}:crud`, RATE_LIMITS.crud);
  if (!rl.ok) return { status: 429, error: 'rate_limited', retryAfterMs: rl.retryAfterMs };
  const row = await getConnectionRow(id);
  if (!row) return { status: 404, error: 'not_found' };
  const allowed = await canWriteScope(actor, row);
  if (!allowed) return { status: 403, error: 'forbidden' };
  return { actor, row };
}

function gateResponse(gate) {
  const payload = { error: gate.error };
  if (gate.retryAfterMs !== undefined) payload.retryAfterMs = gate.retryAfterMs;
  return NextResponse.json(payload, { status: gate.status });
}

export async function PATCH(req, { params }) {
  const { id } = await params;
  const gate = await authorize(id);
  if (gate.error) return gateResponse(gate);

  const body = await req.json().catch(() => ({}));
  // R1-6: validate a provided header name before it can be persisted.
  if (typeof body.headerName === 'string' && body.headerName && !isAllowedHeaderName(body.headerName)) {
    return NextResponse.json({ error: 'invalid_header_name' }, { status: 400 });
  }
  const patch = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (Array.isArray(body.toolAllowlist)) patch.toolAllowlist = body.toolAllowlist.filter((t) => typeof t === 'string');
  if (typeof body.secret === 'string' && body.secret) patch.secret = body.secret;
  if (['none', 'bearer', 'header'].includes(body.authType)) patch.authType = body.authType;
  if (typeof body.headerName === 'string') patch.headerName = body.headerName;

  const updated = await updateConnection(id, patch);
  return NextResponse.json({ connection: updated });
}

export async function DELETE(_req, { params }) {
  const { id } = await params;
  const gate = await authorize(id);
  if (gate.error) return gateResponse(gate);
  await deleteConnection(id);
  return NextResponse.json({ ok: true });
}
