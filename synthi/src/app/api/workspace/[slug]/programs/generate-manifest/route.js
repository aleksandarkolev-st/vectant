import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { fetchWorkspaceContext } from '@/lib/programs/runtimeClient';
import { generateManifestFromContext } from '@/lib/programs/manifestGenerator';
import { parseProgramManifest, ProgramManifestError } from '@/lib/programs/manifest';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/generate-manifest
// Owner/admin: draft a vectant.programs.json from the workspace's key files via
// Gemini. Returns { manifest, valid, errors? } — returned even when invalid so
// the user can fix it in the preview. Saving re-validates fail-closed.
export async function POST(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const files = await fetchWorkspaceContext(slug, actor.workspaceUserId).catch(() => ({}));
  const manifest = await generateManifestFromContext({ files, workspaceName: slug });
  if (!manifest) return NextResponse.json({ error: 'generation_failed' }, { status: 502 });

  try {
    const parsed = parseProgramManifest(manifest);
    return NextResponse.json({ manifest: parsed, valid: true });
  } catch (err) {
    if (err instanceof ProgramManifestError) {
      return NextResponse.json({ manifest, valid: false, errors: [{ code: err.code, field: err.field, message: err.message }] });
    }
    return NextResponse.json({ manifest, valid: false, errors: [{ code: 'invalid_manifest', message: String(err?.message || err) }] });
  }
}
