import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { publishProgram, toPublicMarketplaceProgram } from '@/lib/programs/store';
import { discoverManifest } from '@/lib/programs/runtimeClient';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/publish
// Owner/admin: publish this workspace's recipe to the catalog as @<slug>/<name>.
export async function POST(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let discovered;
  try {
    discovered = await discoverManifest(slug, actor.userId);
  } catch (error) {
    if (error?.name === 'ProgramManifestError') {
      return NextResponse.json({ error: 'manifest_invalid', code: error.code, field: error.field, message: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'program_runtime_unreachable', message: error?.message || 'program runtime error' }, { status: 502 });
  }
  if (!discovered) {
    return NextResponse.json({ error: 'manifest_not_found' }, { status: 404 });
  }

  const { program } = await publishProgram({
    workspaceSlug: slug,
    config: discovered.config,
    publishedByUserId: actor.userId,
  });

  return NextResponse.json({ program: toPublicMarketplaceProgram(program) });
}
