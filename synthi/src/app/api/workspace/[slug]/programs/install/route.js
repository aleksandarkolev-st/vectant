import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import {
  listPermissionGrants,
  createPermissionGrant,
  upsertLocalProgram,
  createInstall,
  toPublicInstall,
} from '@/lib/programs/store';
import { discoverManifest } from '@/lib/programs/runtimeClient';
import { normalizeGrantScopes, PROGRAM_LAUNCH_SCOPE } from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

function grantCoversScopes(grant, requiredScopes) {
  const scopes = Array.isArray(grant?.scopes) ? grant.scopes : [];
  return requiredScopes.every((scope) => scopes.includes(scope));
}

// POST /api/workspace/:slug/programs/install
// Owner/admin: discover the workspace recipe, gate on a consent PermissionGrant
// that covers the manifest's declared scopes, persist a local program + install.
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));

  let discovered;
  try {
    // Pass the actor's userId so per-user workspace repos resolve correctly.
    discovered = await discoverManifest(slug, actor.userId);
  } catch (error) {
    // A manifest that fails validation is the caller's problem (422); any other
    // failure (collab unreachable, cwd/fs error) is infrastructure (502).
    if (error?.name === 'ProgramManifestError') {
      return NextResponse.json(
        { error: 'manifest_invalid', code: error.code, field: error.field, message: error.message },
        { status: 422 },
      );
    }
    return NextResponse.json(
      { error: 'program_runtime_unreachable', message: error?.message || 'program runtime error' },
      { status: 502 },
    );
  }
  if (!discovered) {
    return NextResponse.json({ error: 'manifest_not_found' }, { status: 404 });
  }

  const config = discovered.config;
  const requiredScopes = Array.isArray(config.permissions) && config.permissions.length
    ? config.permissions
    : [PROGRAM_LAUNCH_SCOPE];

  // Consent: reuse a grant that already covers the required scopes, else create
  // one from the user's explicitly approved grantScopes (must cover required).
  const existingGrants = await listPermissionGrants({ workspaceSlug: slug });
  let grant = existingGrants.find((candidate) => grantCoversScopes(candidate, requiredScopes)) || null;

  if (!grant) {
    const requestedScopes = normalizeGrantScopes(body.grantScopes);
    const coversRequired = requiredScopes.every((scope) => requestedScopes.includes(scope));
    if (!coversRequired) {
      return NextResponse.json(
        { error: 'consent_required', code: 'consent_required', requested: requiredScopes },
        { status: 409 },
      );
    }
    const scopes = requestedScopes.includes(PROGRAM_LAUNCH_SCOPE)
      ? requestedScopes
      : [PROGRAM_LAUNCH_SCOPE, ...requestedScopes];
    grant = await createPermissionGrant({ workspaceSlug: slug, scopes, grantedByUserId: actor.userId });
  }

  const { program } = await upsertLocalProgram({ workspaceSlug: slug, config });
  const install = await createInstall({
    programId: program.id,
    workspaceSlug: slug,
    version: config.version,
    installedByUserId: actor.userId,
    grantId: grant.id,
    status: 'installed',
  });

  return NextResponse.json({
    install: toPublicInstall({ ...install, program }),
    program: { id: program.id, packageId: program.packageId, publisher: program.publisher },
    grant,
  });
}
