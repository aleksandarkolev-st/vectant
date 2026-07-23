import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { resolveJupyterServer } from '@/lib/jupyter/registry';
import { JupyterClient } from '@/lib/jupyter/client';
import { normalizeNotebook, revisionOf, serializeNotebook } from '@/lib/jupyter/notebook';

export const runtime = 'nodejs';
export async function POST(request, { params }) {
  const { slug } = await params; const actor = await resolveActor();
  if (!actor || !(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = await request.json().catch(() => ({})); const { serverId, path, notebook, expectedServerRevision } = body;
  if (!serverId || !path?.endsWith('.ipynb') || !notebook) return NextResponse.json({ error: 'serverId, .ipynb path, and notebook are required' }, { status: 400 });
  const server = await resolveJupyterServer(serverId, slug); if (!server) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try {
    const client = new JupyterClient(server); const current = await client.getNotebook(path, request.signal);
    if (expectedServerRevision && current.last_modified !== expectedServerRevision) return NextResponse.json({ error: 'server_newer', revision: current.last_modified }, { status: 409 });
    const normalized = normalizeNotebook(notebook); const saved = await client.saveNotebook(path, normalized, request.signal);
    const content = serializeNotebook(normalized); return NextResponse.json({ revision: revisionOf(content), serverRevision: saved.last_modified || null });
  } catch (error) { return NextResponse.json({ error: error.code || 'jupyter_error', detail: error.message }, { status: error.status || 502 }); }
}
