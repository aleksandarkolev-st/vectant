import { NextResponse } from 'next/server';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canReadScope, canWriteScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { listPermissionGrants, createProgramSession, updateProgramSession, appendProgramRuntimeEvent } from '@/lib/programs/store';
import { fetchDetectedRepoProgram, launchInstalledProgram } from '@/lib/programs/runtimeClient';
import { codeSiteContextFromBody, mergeProgramSession, PROGRAM_LAUNCH_SCOPE } from '@/lib/programs/routeHelpers';

export const runtime = 'nodejs';

function hasLaunchConsent(grants) {
  return Array.isArray(grants) && grants.some((grant) => Array.isArray(grant?.scopes) && grant.scopes.includes(PROGRAM_LAUNCH_SCOPE));
}

async function readActor(req, slug, write = false) {
  const actor = await authenticatePat(req);
  if (!actor) return { response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  if (!slug) return { response: NextResponse.json({ error: 'workspace_required' }, { status: 400 }) };
  const limit = checkLimit(`cli:${actor.userId}:mcp-program-detect`, write ? RATE_LIMITS.extcall : RATE_LIMITS.resolve);
  if (!limit.ok) return { response: NextResponse.json({ error: 'rate_limited', retryAfterMs: limit.retryAfterMs }, { status: 429 }) };
  const allowed = await (write ? canWriteScope : canReadScope)({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: slug });
  if (!allowed) return { response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  return { actor };
}

/** Read the server-detected runtime recipe without exposing workspace files. */
export async function GET(req) {
  const slug = new URL(req.url).searchParams.get('workspaceSlug')?.trim();
  const authorization = await readActor(req, slug);
  if (authorization.response) return authorization.response;
  const detected = await fetchDetectedRepoProgram(slug, authorization.actor.userId).catch(() => null);
  return NextResponse.json({ detected });
}

/**
 * Launch the server-detected runtime recipe. Unlike the UI endpoint, the MCP
 * boundary additionally requires an already-granted program.launch consent;
 * a PAT cannot create that grant for itself.
 */
export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const slug = String(body.workspaceSlug || '').trim();
  const authorization = await readActor(req, slug, true);
  if (authorization.response) return authorization.response;
  const actor = authorization.actor;
  const grants = await listPermissionGrants({ workspaceSlug: slug });
  if (!hasLaunchConsent(grants)) return NextResponse.json({ error: 'consent_required' }, { status: 409 });

  const detected = await fetchDetectedRepoProgram(slug, actor.userId).catch(() => null);
  if (!detected?.config) return NextResponse.json({ error: 'not_detected' }, { status: 404 });
  const session = await createProgramSession({ workspaceSlug: slug, runtimeType: String(detected.config.runtimeType || 'container'), startedByUserId: actor.userId, state: 'starting' });
  const codeSiteContext = codeSiteContextFromBody(body);
  await appendProgramRuntimeEvent({ sessionId: session.id, type: 'launch_requested', data: { source: detected.source, runtimeType: session.runtimeType, via: 'mcp' }, codeSiteContext });
  try {
    const runtimeSession = await launchInstalledProgram({ workspaceSlug: slug, sessionId: session.id, config: detected.config, userId: actor.userId, title: detected.config.displayName || detected.source, codeSiteContext });
    const state = runtimeSession?.state || 'starting';
    const updated = await updateProgramSession(session.id, { state });
    await appendProgramRuntimeEvent({ sessionId: session.id, type: 'launch_ack', data: { state, activePorts: runtimeSession?.activePorts || [], via: 'mcp' }, codeSiteContext });
    return NextResponse.json({ session: mergeProgramSession(updated, runtimeSession) });
  } catch (exception) {
    const failed = await updateProgramSession(session.id, { state: 'crashed', endedAt: new Date() });
    await appendProgramRuntimeEvent({ sessionId: session.id, type: 'launch_failed', data: { message: exception?.message || 'runtime launch failed', via: 'mcp' }, codeSiteContext });
    return NextResponse.json({ error: 'runtime_launch_failed', session: failed }, { status: 502 });
  }
}
