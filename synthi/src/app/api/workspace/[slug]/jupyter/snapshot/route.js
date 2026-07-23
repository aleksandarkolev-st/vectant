import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { resolveJupyterServer } from '@/lib/jupyter/registry';
import { JupyterClient } from '@/lib/jupyter/client';
import { normalizeNotebook, revisionOf, serializeNotebook } from '@/lib/jupyter/notebook';
export const runtime = 'nodejs';
export async function GET(request, { params }) { const { slug } = await params; const actor = await resolveActor(); if (!actor || !(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); const url = new URL(request.url); const server = await resolveJupyterServer(url.searchParams.get('serverId'), slug); const path = url.searchParams.get('path'); if (!server || !path?.endsWith('.ipynb')) return NextResponse.json({ error: 'not_found' }, { status: 404 }); try { const snapshot = await new JupyterClient(server).getNotebook(path, request.signal); const content = serializeNotebook(normalizeNotebook(snapshot.content)); return NextResponse.json({ notebook: JSON.parse(content), revision: revisionOf(content), serverRevision: snapshot.last_modified || null }); } catch (error) { return NextResponse.json({ error: error.code || 'jupyter_error', detail: error.message }, { status: error.status || 502 }); } }
