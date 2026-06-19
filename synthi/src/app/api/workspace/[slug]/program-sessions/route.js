import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope, canWriteScope } from '@/lib/integrations/scope';
import {
  appendProgramRuntimeEvent,
  createPermissionGrant,
  createProgramSession,
  listPermissionGrants,
  listProgramSessions,
  updateProgramSession,
} from '@/lib/programs/store';
import {
  launchProgramRuntime,
  listProgramRuntimeSessions,
} from '@/lib/programs/runtimeClient';
import {
  mergeProgramSession,
  normalizeGrantScopes,
  PROGRAM_LAUNCH_SCOPE,
} from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

function selectConsentGrant(grants) {
  return Array.isArray(grants) && grants.length > 0 ? grants[0] : null;
}

export async function GET(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const [sessions, runtimeSessions] = await Promise.all([
    listProgramSessions(slug, { limit: 20 }),
    listProgramRuntimeSessions(slug).catch(() => []),
  ]);
  const runtimeById = new Map(runtimeSessions.map((session) => [session.sessionId, session]));

  return NextResponse.json({
    sessions: sessions.map((session) => mergeProgramSession(session, runtimeById.get(session.id))),
  });
}

export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const command = String(body.command || '').trim();
  if (!command) {
    return NextResponse.json({ error: 'command_required' }, { status: 400 });
  }

  const requestedScopes = normalizeGrantScopes(body.grantScopes);
  let grant = selectConsentGrant(await listPermissionGrants({ workspaceSlug: slug }));
  if (!grant) {
    if (!requestedScopes.length) {
      return NextResponse.json({ error: 'consent_required' }, { status: 409 });
    }
    const scopes = requestedScopes.includes(PROGRAM_LAUNCH_SCOPE)
      ? requestedScopes
      : [PROGRAM_LAUNCH_SCOPE, ...requestedScopes];
    grant = await createPermissionGrant({
      workspaceSlug: slug,
      scopes,
      grantedByUserId: actor.userId,
    });
  }

  const session = await createProgramSession({
    workspaceSlug: slug,
    runtimeType: String(body.runtimeType || 'cli'),
    startedByUserId: actor.userId,
    state: 'starting',
  });

  await appendProgramRuntimeEvent({
    sessionId: session.id,
    type: 'launch_requested',
    data: {
      grantId: grant.id,
      runtimeType: session.runtimeType,
    },
  });

  try {
    const runtime = await launchProgramRuntime({
      workspaceSlug: slug,
      sessionId: session.id,
      command,
      userId: actor.userId,
      title: body.title || null,
      timeout: body.timeout,
      env: body.env && typeof body.env === 'object' ? body.env : {},
    });
    const nextState = runtime.runtimeSession?.state || 'running';
    const updated = await updateProgramSession(session.id, { state: nextState });

    await appendProgramRuntimeEvent({
      sessionId: session.id,
      type: 'launch_ack',
      data: {
        state: nextState,
        exitCode: runtime.exitCode ?? null,
        timedOut: Boolean(runtime.timedOut),
        outputBytes: String(runtime.output || '').length,
      },
    });

    return NextResponse.json({
      session: mergeProgramSession(updated, runtime.runtimeSession),
      grant,
      launch: {
        sessionId: runtime.sessionId,
        exitCode: runtime.exitCode ?? null,
        timedOut: Boolean(runtime.timedOut),
        output: runtime.output || '',
      },
    }, { status: 201 });
  } catch (error) {
    const failed = await updateProgramSession(session.id, { state: 'crashed', endedAt: new Date() });
    await appendProgramRuntimeEvent({
      sessionId: session.id,
      type: 'launch_failed',
      data: {
        message: error?.message || 'runtime launch failed',
      },
    });
    return NextResponse.json({ error: 'runtime_launch_failed', session: failed }, { status: 502 });
  }
}