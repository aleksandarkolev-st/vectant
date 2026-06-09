import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { getScaffoldTemplate } from '@/lib/programs/scaffoldTemplates';
import { scaffoldProgram } from '@/lib/programs/runtimeClient';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/scaffold  { packageId }
// Owner/admin: write a known default's starter files into the workspace (only
// missing files). The template is resolved SERVER-SIDE from packageId — client
// `files` are ignored — and written under the IDE's workspace dir (workspaceUserId).
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const files = getScaffoldTemplate(body.packageId);
  if (!files) {
    return NextResponse.json({ error: 'no_template' }, { status: 404 });
  }

  try {
    const result = await scaffoldProgram({ workspaceSlug: slug, userId: actor.workspaceUserId, files });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: 'scaffold_failed', message: error?.message || 'scaffold failed' },
      { status: 502 },
    );
  }
}
