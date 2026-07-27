import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { resolveJupyterServer } from '@/lib/jupyter/registry';
import { JupyterClient } from '@/lib/jupyter/client';
import { recordJupyterAudit } from '@/lib/jupyter/audit';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const { slug, kernelId } = await params;
  const actor = await resolveActor();
  if (!actor || !(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const { serverId, path } = await request.json().catch(() => ({}));
  const server = await resolveJupyterServer(serverId, slug);
  if (!server || !kernelId) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try { await new JupyterClient(server).interruptKernel(kernelId, request.signal); void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'kernel_interrupted', notebookPath: path || null, kernelId }); return NextResponse.json({ ok: true }); }
  catch (error) { return NextResponse.json({ error: error.code || 'jupyter_error', detail: error.message }, { status: error.status || 502 }); }
}
