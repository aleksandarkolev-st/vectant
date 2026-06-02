import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export const runtime = 'nodejs';

const num = (v) => (Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : null);

export async function POST(req) {
  const actor = await authenticatePat(req);
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`cli:${actor.userId}:audit`, RATE_LIMITS.audit);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const b = await req.json().catch(() => ({}));

  // Only link connectionId if the connection still exists (avoid FK violation on a stale id).
  let connectionId = null;
  if (str(b.connId)) {
    const conn = await prisma.mcpConnection.findUnique({ where: { id: b.connId } });
    connectionId = conn ? conn.id : null;
  }
  // Echo workspaceSlug only when the PAT's user is a member.
  let workspaceSlug = null;
  if (b.workspaceSlug && (await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: b.workspaceSlug }))) {
    workspaceSlug = b.workspaceSlug;
  }
  const outcome = ['ok', 'error', 'blocked'].includes(b.outcome) ? b.outcome : 'error';

  try {
    await prisma.mcpCallAudit.create({
      data: {
        connectionId,
        serverName: str(b.serverName) || 'unknown',
        toolName: str(b.toolName) || 'unknown',
        userId: actor.userId,
        workspaceSlug,
        outcome,
        errorCode: str(b.errorCode),
        alias: str(b.alias),
        callerType: 'cli',
        durationMs: num(b.durationMs),
        argsHash: str(b.argsHash),
        argsBytes: num(b.argsBytes),
        resultBytes: num(b.resultBytes),
      },
    });
  } catch {
    return NextResponse.json({ error: 'audit_write_failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}
