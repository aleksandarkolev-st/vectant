import { NextResponse } from 'next/server';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canWriteScope } from '@/lib/integrations/scope';
import { listPermissionGrants } from '@/lib/programs/store';
import { execInWorkspaceRuntime } from '@/lib/programs/runtimeClient';
import { codeSiteContextFromBody, PROGRAM_LAUNCH_SCOPE } from '@/lib/programs/routeHelpers';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

/**
 * PAT-gated runtime command exec for the MCP `synthi_exec_in_runtime` tool
 * (GUI dev-tool streaming, Slice 3 / Group E).
 *
 * Runs a one-shot command INSIDE the workspace's Sysbox runtime pod — where the
 * workspace's own dockerd and its programs live — and returns stdout/stderr/
 * exitCode. Routing is by workspaceSlug → runtimeScope on the collab-server
 * (never a user id), so this reaches docker and needs no per-user filesystem
 * identity. Transient: no ProgramSession row is persisted.
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
  const codeSiteContext = codeSiteContextFromBody(body);
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

  try {
    const result = await execInWorkspaceRuntime(workspaceSlug, { command, timeout, codeSiteContext });
    return NextResponse.json({
      runtimeScope: result.runtimeScope ?? null,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode ?? null,
      timedOut: Boolean(result.timedOut),
    });
  } catch (error) {
    if (error?.status === 409) {
      return NextResponse.json({ error: error?.payload?.error || 'runtime_not_ready' }, { status: 409 });
    }
    return NextResponse.json(
      { error: 'runtime_exec_failed', message: error?.message || 'runtime exec failed' },
      { status: 502 },
    );
  }
}
