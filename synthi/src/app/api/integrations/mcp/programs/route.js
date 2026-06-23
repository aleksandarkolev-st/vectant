import { NextResponse } from 'next/server';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canReadScope } from '@/lib/integrations/scope';
import { listProgramSessions, listInstalls, toPublicInstall } from '@/lib/programs/store';
import { listProgramRuntimeSessions } from '@/lib/programs/runtimeClient';
import { mergeProgramSession } from '@/lib/programs/routeHelpers';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

/**
 * PAT-gated program inventory for the MCP `synthi_list_programs` tool
 * (GUI dev-tool streaming, Slice 3 / Group E). Member-readable; mirrors the
 * cookie-authenticated program-sessions GET (merging live runtime state) plus
 * the installed-programs catalog so the AI can discover what is running and
 * what it could launch.
 */
export async function GET(req) {
  const actor = await authenticatePat(req);
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const workspaceSlug = new URL(req.url).searchParams.get('workspaceSlug')?.trim();
  if (!workspaceSlug) return NextResponse.json({ error: 'workspace_required' }, { status: 400 });

  const rl = checkLimit(`cli:${actor.userId}:mcp-programs`, RATE_LIMITS.resolve);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  if (!(await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const [sessions, runtimeSessions, installs] = await Promise.all([
    listProgramSessions(workspaceSlug, { limit: 20 }),
    listProgramRuntimeSessions(workspaceSlug).catch(() => []),
    listInstalls(workspaceSlug),
  ]);
  const runtimeById = new Map(runtimeSessions.map((s) => [s.sessionId, s]));

  return NextResponse.json({
    sessions: sessions.map((s) => mergeProgramSession(s, runtimeById.get(s.id))),
    installed: installs.map(toPublicInstall),
  });
}
