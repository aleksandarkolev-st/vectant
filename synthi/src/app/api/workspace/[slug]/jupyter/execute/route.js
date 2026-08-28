import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { resolveJupyterServer } from '@/lib/jupyter/registry';
import { JupyterClient } from '@/lib/jupyter/client';
import { recordJupyterAudit } from '@/lib/jupyter/audit';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor || !(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const { serverId, path, code, kernelName } = body;
  if (!serverId || !String(path || '').endsWith('.ipynb') || !String(code || '').trim()) return NextResponse.json({ error: 'serverId, .ipynb path, and code are required' }, { status: 400 });
  const server = await resolveJupyterServer(serverId, slug);
  if (!server) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try {
    const client = new JupyterClient(server);
    const session = await client.connectKernel({ path, kernelName, signal: request.signal });
    const result = await client.execute({ kernelId: session.kernel?.id, code: String(code), signal: request.signal });
    void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'cell_executed', notebookPath: path, kernelId: session.kernel?.id, details: { codeBytes: Buffer.byteLength(String(code)), outputCount: result.outputs.length } });
    return NextResponse.json({ kernelId: session.kernel?.id, ...result });
  } catch (error) {
    void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'cell_execution_failed', notebookPath: path, details: { code: error.code || 'unknown' } });
    return NextResponse.json({ error: error.code || 'jupyter_execution_error', detail: error.message }, { status: error.status || 502 });
  }
}
