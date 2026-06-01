import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { getConnectionRow, updateConnection } from '@/lib/integrations/connectionStore';
import { testConnection, listTools } from '@/lib/mcp-hub';
import { decryptToken } from '@/lib/tokenCrypto';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

export async function POST(_req, { params }) {
  const { id } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`user:${actor.userId}:test`, RATE_LIMITS.test);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const row = await getConnectionRow(id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // R1-9: testing (outbound health, no config mutation) is read-level -> any member.
  if (!(await canReadScope(actor, row))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const config = {
    url: row.url,
    transport: row.transport,
    authType: row.authType,
    headerName: row.headerName,
    secret: row.secret ? decryptToken(row.secret.cipher) : null,
  };

  const probe = await testConnection(config);
  const state = probe.ok ? 'ok' : (probe.error?.code || 'error');
  await updateConnection(id, { lastHealthState: state, lastHealthAt: new Date() });

  if (!probe.ok) return NextResponse.json({ ok: false, state, error: probe.error }, { status: 200 });

  const tools = await listTools(config);
  return NextResponse.json({
    ok: true,
    state,
    serverInfo: probe.serverInfo,
    toolCount: probe.toolCount,
    tools: tools.ok ? tools.tools.map((t) => ({ name: t.name, description: t.description || '' })) : [],
  });
}
