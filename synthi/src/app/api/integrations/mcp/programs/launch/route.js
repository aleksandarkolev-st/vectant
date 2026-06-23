import { NextResponse } from 'next/server';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canWriteScope } from '@/lib/integrations/scope';
import {
  listPermissionGrants,
  getInstall,
  getProgramVersion,
  createProgramSession,
  updateProgramSession,
  appendProgramRuntimeEvent,
} from '@/lib/programs/store';
import { launchInstalledProgram } from '@/lib/programs/runtimeClient';
import { mergeProgramSession, PROGRAM_LAUNCH_SCOPE } from '@/lib/programs/routeHelpers';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

/**
 * PAT-gated program launch for the MCP `synthi_launch_program` tool
 * (GUI dev-tool streaming, Slice 3 / Group E). Lets the AI open a containerized
 * dev tool (e.g. DBeaver) by install id.
 *
 * Restricted to `runtimeType: 'container'` programs: those route into the
 * per-workspace Sysbox runtime pod by workspaceSlug → runtimeScope (never a user
 * id), so a PAT (which yields only the Prisma User.id, not the workspaceUserId)
 * launches them safely. Non-container programs take the headless/hybrid path
 * which IS user-id-routed, so they must be launched from the workspace UI.
 *
 * Security: owner/admin (canWriteScope) + an existing program.launch consent
 * grant. A PAT never self-grants.
 */

function hasLaunchConsent(grants) {
  return (
    Array.isArray(grants) &&
    grants.some((g) => Array.isArray(g?.scopes) && g.scopes.includes(PROGRAM_LAUNCH_SCOPE))
  );
}

export async function POST(req) {
  const actor = await authenticatePat(req);
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const workspaceSlug = String(body.workspaceSlug || '').trim();
  const installId = String(body.installId || '').trim();
  if (!workspaceSlug) return NextResponse.json({ error: 'workspace_required' }, { status: 400 });
  if (!installId) return NextResponse.json({ error: 'install_required' }, { status: 400 });

  const rl = checkLimit(`cli:${actor.userId}:program-launch`, RATE_LIMITS.extcall);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  if (!(await canWriteScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const grants = await listPermissionGrants({ workspaceSlug });
  if (!hasLaunchConsent(grants)) {
    return NextResponse.json({ error: 'consent_required' }, { status: 409 });
  }

  const install = await getInstall(installId);
  if (!install || install.workspaceSlug !== workspaceSlug) {
    return NextResponse.json({ error: 'install_not_found' }, { status: 404 });
  }

  const version = await getProgramVersion(install.programId, install.version);
  if (!version || !version.manifestJson) {
    return NextResponse.json({ error: 'manifest_unavailable' }, { status: 404 });
  }

  let config;
  try {
    config = JSON.parse(version.manifestJson);
  } catch {
    return NextResponse.json({ error: 'manifest_invalid' }, { status: 422 });
  }

  if (String(config.runtimeType || '') !== 'container') {
    return NextResponse.json({ error: 'unsupported_program_type' }, { status: 422 });
  }

  const session = await createProgramSession({
    installId: install.id,
    workspaceSlug,
    runtimeType: 'container',
    startedByUserId: actor.userId,
    state: 'starting',
  });

  await appendProgramRuntimeEvent({
    sessionId: session.id,
    type: 'launch_requested',
    data: { installId: install.id, runtimeType: 'container', via: 'mcp' },
  });

  try {
    const snapshot = await launchInstalledProgram({
      workspaceSlug,
      sessionId: session.id,
      config,
      userId: actor.userId,
      title: config.displayName || null,
    });
    const nextState = snapshot?.state || 'running';
    const updated = await updateProgramSession(session.id, { state: nextState });

    await appendProgramRuntimeEvent({
      sessionId: session.id,
      type: 'launch_ack',
      data: { state: nextState, activePorts: snapshot?.activePorts || [] },
    });

    return NextResponse.json({ session: mergeProgramSession(updated, snapshot) });
  } catch (error) {
    const failed = await updateProgramSession(session.id, { state: 'crashed', endedAt: new Date() });
    await appendProgramRuntimeEvent({
      sessionId: session.id,
      type: 'launch_failed',
      data: { message: error?.message || 'runtime launch failed' },
    });
    return NextResponse.json({ error: 'runtime_launch_failed', session: failed }, { status: 502 });
  }
}
