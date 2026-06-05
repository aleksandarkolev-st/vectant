import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import {
  getInstall,
  getProgramVersion,
  createProgramSession,
  updateProgramSession,
  appendProgramRuntimeEvent,
} from '@/lib/programs/store';
import { launchInstalledProgram } from '@/lib/programs/runtimeClient';
import { mergeProgramSession } from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/:installId/launch
// Owner/admin: launch a persisted install from its stored recipe manifest.
export async function POST(_req, { params }) {
  const { slug, installId } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const install = await getInstall(installId);
  if (!install || install.workspaceSlug !== slug) {
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

  const session = await createProgramSession({
    installId: install.id,
    workspaceSlug: slug,
    runtimeType: String(config.runtimeType || 'cli'),
    startedByUserId: actor.userId,
    state: 'starting',
  });

  await appendProgramRuntimeEvent({
    sessionId: session.id,
    type: 'launch_requested',
    data: { installId: install.id, runtimeType: session.runtimeType },
  });

  try {
    const snapshot = await launchInstalledProgram({
      workspaceSlug: slug,
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
