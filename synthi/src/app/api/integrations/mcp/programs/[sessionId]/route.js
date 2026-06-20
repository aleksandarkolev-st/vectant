import { NextResponse } from 'next/server';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canReadScope } from '@/lib/integrations/scope';
import { getProgramSession, listProgramRuntimeEvents } from '@/lib/programs/store';
import { getProgramRuntimeSession, listProgramRuntimeSessionEvents } from '@/lib/programs/runtimeClient';
import { mergeProgramSession, sanitizeProgramEvent, sortProgramEvents } from '@/lib/programs/routeHelpers';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

/**
 * PAT-gated single-session read for the MCP `synthi_read_session` tool
 * (GUI dev-tool streaming, Slice 3 / Group E). Member-readable; returns the
 * session merged with live runtime state plus its recent redacted events
 * (command/env stripped via sanitizeProgramEvent).
 */
export async function GET(req, { params }) {
  const { sessionId } = await params;
  const actor = await authenticatePat(req);
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const workspaceSlug = new URL(req.url).searchParams.get('workspaceSlug')?.trim();
  if (!workspaceSlug) return NextResponse.json({ error: 'workspace_required' }, { status: 400 });

  const rl = checkLimit(`cli:${actor.userId}:mcp-programs`, RATE_LIMITS.resolve);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  if (!(await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const session = await getProgramSession(sessionId);
  if (!session || session.workspaceSlug !== workspaceSlug) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const [runtimeSession, storedEvents, runtimeEvents] = await Promise.all([
    getProgramRuntimeSession(workspaceSlug, sessionId).catch(() => null),
    listProgramRuntimeEvents(sessionId),
    listProgramRuntimeSessionEvents(workspaceSlug, sessionId).catch(() => []),
  ]);

  return NextResponse.json({
    session: mergeProgramSession(session, runtimeSession),
    events: sortProgramEvents([...storedEvents, ...runtimeEvents].map(sanitizeProgramEvent)),
  });
}
