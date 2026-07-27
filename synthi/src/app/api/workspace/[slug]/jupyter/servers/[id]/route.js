import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { revokeJupyterServer } from '@/lib/jupyter/registry';
export const runtime = 'nodejs';
export async function DELETE(_request, { params }) { const { slug, id } = await params; const actor = await resolveActor(); if (!actor || !(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); return (await revokeJupyterServer(id, slug)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 }); }

