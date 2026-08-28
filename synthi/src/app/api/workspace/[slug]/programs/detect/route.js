import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope, canWriteScope } from '@/lib/integrations/scope';
import { createProgramSession, updateProgramSession, appendProgramRuntimeEvent } from '@/lib/programs/store';
import { fetchDetectedRepoProgram, launchInstalledProgram } from '@/lib/programs/runtimeClient';
import { codeSiteContextFromBody, mergeProgramSession } from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

// GET /api/workspace/[slug]/programs/detect
// Slice 1 (real programs): report the container program auto-detected in the
// workspace (docker-compose / devcontainer / Dockerfile), or null. The collab-server
// owns the container-runtime capability; this route just proxies + authorizes.
export async function GET(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const detected = await fetchDetectedRepoProgram(slug, actor.workspaceUserId || actor.userId).catch(() => null);
  return NextResponse.json({ detected });
}

// POST /api/workspace/[slug]/programs/detect
// Owner/admin: launch the auto-detected container program. The config is
// RE-DETECTED server-side (never trusted from the client) and launched through
// the collab managed-runtime launch-program path (→ sysbox pod when enabled).
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const codeSiteContext = codeSiteContextFromBody(body);

  const userId = actor.workspaceUserId || actor.userId;
  const detected = await fetchDetectedRepoProgram(slug, userId).catch(() => null);
  if (!detected || !detected.config) {
    return NextResponse.json({ error: 'not_detected' }, { status: 404 });
  }
  const { config, source } = detected;

  const session = await createProgramSession({
    workspaceSlug: slug,
    runtimeType: String(config.runtimeType || 'container'),
    startedByUserId: actor.userId,
    state: 'starting',
  });

  await appendProgramRuntimeEvent({
    sessionId: session.id,
    type: 'launch_requested',
    data: { source, runtimeType: session.runtimeType },
    codeSiteContext,
  });

  try {
    const snapshot = await launchInstalledProgram({
      workspaceSlug: slug,
      sessionId: session.id,
      config,
      userId,
      title: config.displayName || source,
      codeSiteContext,
    });
    const nextState = snapshot?.state || 'starting';
    const updated = await updateProgramSession(session.id, { state: nextState });

    await appendProgramRuntimeEvent({
      sessionId: session.id,
      type: 'launch_ack',
      data: { state: nextState, activePorts: snapshot?.activePorts || [] },
      codeSiteContext,
    });

    return NextResponse.json({ session: mergeProgramSession(updated, snapshot) });
  } catch (error) {
    const failed = await updateProgramSession(session.id, { state: 'crashed', endedAt: new Date() });
    await appendProgramRuntimeEvent({
      sessionId: session.id,
      type: 'launch_failed',
      data: { message: error?.message || 'runtime launch failed' },
      codeSiteContext,
    });
    return NextResponse.json({ error: 'runtime_launch_failed', session: failed }, { status: 502 });
  }
}
