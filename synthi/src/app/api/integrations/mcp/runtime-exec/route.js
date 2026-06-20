import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canWriteScope } from '@/lib/integrations/scope';
import { listPermissionGrants } from '@/lib/programs/store';
import { launchProgramRuntime } from '@/lib/programs/runtimeClient';
import { PROGRAM_LAUNCH_SCOPE } from '@/lib/programs/routeHelpers';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

/**
 * PAT-gated runtime command exec for the MCP `synthi_exec_in_runtime` tool
 * (GUI dev-tool streaming, Slice 3 / Group E).
 *
 * Runs a one-shot command in the workspace's runtime sandbox — where docker and
 * the workspace's programs live — and returns its combined output. Unlike the
 * cookie-authenticated program-sessions POST, this is transient: it does NOT
 * persist a ProgramSession row (so AI execs don't pollute the session list); it
 * launches under an ephemeral `ai-*` runtime session id.
 *
 * Security: owner/admin scope (canWriteScope) + an existing `program.launch`
 * consent grant is required. A PAT never self-grants consent — a workspace must
 * have already granted program.launch (which happens the first time anyone
 * launches a program) before AI/CLI exec is allowed.
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
  const command = String(body.command || '').trim();
  if (!workspaceSlug) return NextResponse.json({ error: 'workspace_required' }, { status: 400 });
  if (!command) return NextResponse.json({ error: 'command_required' }, { status: 400 });

  const rl = checkLimit(`cli:${actor.userId}:runtime-exec`, RATE_LIMITS.extcall);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  if (!(await canWriteScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const grants = await listPermissionGrants({ workspaceSlug });
  if (!hasLaunchConsent(grants)) {
    return NextResponse.json({ error: 'consent_required' }, { status: 409 });
  }

  const timeout = Number.isFinite(Number(body.timeout)) ? Number(body.timeout) : undefined;
  const sessionId = `ai-${randomUUID().slice(0, 8)}`;

  try {
    const result = await launchProgramRuntime({
      workspaceSlug,
      sessionId,
      command,
      userId: actor.userId,
      title: 'ai-exec',
      ...(timeout !== undefined ? { timeout } : {}),
    });
    return NextResponse.json({
      sessionId: result.sessionId || sessionId,
      output: result.output || '',
      exitCode: result.exitCode ?? null,
      timedOut: Boolean(result.timedOut),
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'runtime_exec_failed', message: error?.message || 'runtime exec failed' },
      { status: 502 },
    );
  }
}
