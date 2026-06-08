import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import {
  listPermissionGrants,
  createPermissionGrant,
  upsertLocalProgram,
  createInstall,
  toPublicInstall,
  getPublishedProgramVersion,
  incrementInstallCount,
} from '@/lib/programs/store';
import { discoverManifest } from '@/lib/programs/runtimeClient';
import { normalizeGrantScopes, PROGRAM_LAUNCH_SCOPE } from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

function grantCoversScopes(grant, requiredScopes) {
  const scopes = Array.isArray(grant?.scopes) ? grant.scopes : [];
  return requiredScopes.every((scope) => scopes.includes(scope));
}

// POST /api/workspace/:slug/programs/install
// Owner/admin. Two paths, both gated by a consent PermissionGrant covering the
// manifest's declared scopes:
//   - published install: body { packageId, version } → manifest from the catalog
//   - local install:     no packageId → discover the workspace recipe
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));

  let config;
  let programId;
  let localProgram = null;
  let publishedProgramId = null;

  if (body.packageId && body.version) {
    // Published install: pull the already-validated manifest from the catalog.
    const found = await getPublishedProgramVersion(body.packageId, body.version);
    if (!found) {
      return NextResponse.json({ error: 'program_not_found' }, { status: 404 });
    }
    config = found.config;
    programId = found.program.id;
    publishedProgramId = found.program.id;
  } else {
    // Local install: discover the workspace recipe from its working tree.
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
    config = discovered.config;
    const { program } = await upsertLocalProgram({ workspaceSlug: slug, config });
    localProgram = program;
    programId = program.id;
  }

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

  const install = await createInstall({
    programId,
    workspaceSlug: slug,
    version: config.version,
    installedByUserId: actor.userId,
    grantId: grant.id,
    status: 'installed',
  });

  // Published installs bump the catalog reputation counter; local ones don't.
  if (publishedProgramId) {
    await incrementInstallCount(publishedProgramId);
  }

  const programForProjection = localProgram || { id: programId, packageId: body.packageId || null };
  return NextResponse.json({
    install: toPublicInstall({ ...install, program: programForProjection }),
    program: localProgram
      ? { id: localProgram.id, packageId: localProgram.packageId, publisher: localProgram.publisher }
      : { id: programId },
    grant,
  });
}
