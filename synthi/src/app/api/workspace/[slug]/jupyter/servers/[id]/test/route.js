import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { resolveJupyterServer } from '@/lib/jupyter/registry';
import { JupyterClient } from '@/lib/jupyter/client';
import { recordJupyterAudit } from '@/lib/jupyter/audit';

export const runtime = 'nodejs';
export async function POST(request, { params }) {
  const { slug, id } = await params; const actor = await resolveActor();
  if (!actor || !(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const server = await resolveJupyterServer(id, slug); if (!server) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try { const status = await new JupyterClient(server).status(request.signal); void recordJupyterAudit({ workspaceSlug: slug, serverId: id, actorUserId: actor.userId, eventType: 'connection_tested' }); return NextResponse.json({ ok: true, status: { started: status.started || null, lastActivity: status.last_activity || null } }); }
  catch (error) { void recordJupyterAudit({ workspaceSlug: slug, serverId: id, actorUserId: actor.userId, eventType: 'connection_test_failed', details: { code: error.code || 'unknown' } }); return NextResponse.json({ ok: false, error: error.code || 'unavailable' }, { status: error.status || 502 }); }
}
