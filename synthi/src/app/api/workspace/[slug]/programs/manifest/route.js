import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { scaffoldProgram } from '@/lib/programs/runtimeClient';
import { parseProgramManifest, ProgramManifestError } from '@/lib/programs/manifest';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/manifest  { manifest }
// Owner/admin: re-validate then write vectant.programs.json (overwrite). Fail-closed
// — a manifest that fails schema / scope / host-escape is NEVER written; the client
// preview validation is convenience, this is the gate.
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }

  let normalized;
  try {
    normalized = parseProgramManifest(body.manifest);
  } catch (err) {
    if (err instanceof ProgramManifestError) {
      return NextResponse.json({ error: 'manifest_invalid', code: err.code, field: err.field, message: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'manifest_invalid', message: String(err?.message || err) }, { status: 422 });
  }

  try {
    const result = await scaffoldProgram({
      workspaceSlug: slug,
      userId: actor.workspaceUserId,
      files: [{ path: 'vectant.programs.json', contents: JSON.stringify(normalized, null, 2) }],
      overwrite: true,
    });
    return NextResponse.json({ written: result?.written || [] });
  } catch (error) {
    return NextResponse.json({ error: 'save_failed', message: error?.message || 'save failed' }, { status: 502 });
  }
}
