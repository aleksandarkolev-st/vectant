import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope, canWriteScope } from '@/lib/integrations/scope';
import { createJupyterServer, listJupyterServers } from '@/lib/jupyter/registry';
import { recordJupyterAudit } from '@/lib/jupyter/audit';

export const runtime = 'nodejs';
async function actorFor(slug, write = false) { const actor = await resolveActor(); if (!actor) return null; const allowed = await (write ? canWriteScope : canReadScope)(actor, { scope: 'workspace', workspaceSlug: slug }); return allowed ? actor : null; }
export async function GET(_request, { params }) { const { slug } = await params; if (!await actorFor(slug)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); return NextResponse.json({ servers: await listJupyterServers(slug) }); }
export async function POST(request, { params }) { const { slug } = await params; const actor = await actorFor(slug, true); if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); const body = await request.json().catch(() => ({})); if (!body.name || !body.origin) return NextResponse.json({ error: 'name and origin are required' }, { status: 400 }); try { const server = await createJupyterServer({ workspaceSlug: slug, name: body.name, origin: body.origin, token: typeof body.token === 'string' ? body.token : null, mountPath: body.mountPath }); void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'connection_created' }); return NextResponse.json({ server }, { status: 201 }); } catch (error) { if (error.code === 'P2002') { const origin = new URL(body.origin).origin; const server = (await listJupyterServers(slug)).find((candidate) => candidate.origin === origin); if (server) return NextResponse.json({ server, reused: true }); } return NextResponse.json({ error: error.message }, { status: 400 }); } }
