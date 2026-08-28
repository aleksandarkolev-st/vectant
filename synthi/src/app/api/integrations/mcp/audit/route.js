import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canReadScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import {
  codeSiteEvidenceRefsJson,
  emptyCodeSiteIdentityFields,
  firstCodeSiteRef,
} from '@/lib/codesite/substrateIdentity';

export const runtime = 'nodejs';

const num = (v) => (Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : null);
// Bound untrusted client strings so an authenticated CLI cannot bloat the audit table.
const bounded = (v, max) => { const s = str(v); return s && s.length <= max ? s : null; };
const HASH_RE = /^[0-9a-f]{64}$/i; // sha-256 hex is always exactly 64 chars
const hex64 = (v) => { const s = str(v); return s && HASH_RE.test(s) ? s : null; };

async function canLinkConnection(actor, conn) {
  if (!actor?.userId || !conn) return false;
  if (conn.scope === 'personal') return conn.ownerUserId === actor.userId;
  if (conn.scope === 'workspace' && conn.workspaceSlug) {
    return canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: conn.workspaceSlug });
  }
  return false;
}

async function resolveTrustedCodeSiteRefs(workspaceSlug, body) {
  if (!workspaceSlug) return emptyCodeSiteIdentityFields();
  const codeSiteContext = body.codeSiteContext && typeof body.codeSiteContext === 'object' && !Array.isArray(body.codeSiteContext) ? body.codeSiteContext : {};
  const projectId = firstCodeSiteRef(body.codeSiteProjectId, body.code_site_project_id, body.projectId, codeSiteContext.codeSiteProjectId, codeSiteContext.projectId);
  if (!projectId) return emptyCodeSiteIdentityFields();

  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    select: { id: true },
  });
  if (!project) return emptyCodeSiteIdentityFields();

  const requestedTransactionId = firstCodeSiteRef(body.codeSiteTransactionId, body.code_site_transaction_id, body.transactionId, codeSiteContext.codeSiteTransactionId, codeSiteContext.transactionId);
  const requestedLeaseId = firstCodeSiteRef(body.codeSiteMutationLeaseId, body.code_site_mutation_lease_id, body.mutationLeaseId, body.mutation_lease_id, body.leaseId, codeSiteContext.codeSiteMutationLeaseId, codeSiteContext.mutationLeaseId, codeSiteContext.leaseId);
  const requestedAgentSessionId = firstCodeSiteRef(body.codeSiteAgentSessionId, body.code_site_agent_session_id, body.agentSessionId, body.agent_session_id, codeSiteContext.codeSiteAgentSessionId, codeSiteContext.agentSessionId);
  const [transaction, lease, agentSession] = await Promise.all([
    requestedTransactionId
      ? prisma.codeSiteMutationTransaction.findFirst({ where: { id: requestedTransactionId, projectId }, select: { id: true } })
      : null,
    requestedLeaseId
      ? prisma.codeSiteMutationLease.findFirst({ where: { id: requestedLeaseId, projectId }, select: { id: true } })
      : null,
    requestedAgentSessionId
      ? prisma.codeSiteAgentSession.findFirst({ where: { id: requestedAgentSessionId, projectId }, select: { id: true } })
      : null,
  ]);

  return {
    codeSiteProjectId: projectId,
    codeSiteTransactionId: transaction?.id || null,
    codeSiteMutationLeaseId: lease?.id || null,
    codeSiteAgentSessionId: agentSession?.id || null,
    codeSiteEvidenceRefsJson: codeSiteEvidenceRefsJson(body.codeSiteEvidenceRefs || body.code_site_evidence_refs || body.evidenceRefs || codeSiteContext.codeSiteEvidenceRefs || codeSiteContext.evidenceRefs),
  };
}

export async function POST(req) {
  const actor = await authenticatePat(req);
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = checkLimit(`cli:${actor.userId}:audit`, RATE_LIMITS.audit);
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { status: 429 });

  const b = await req.json().catch(() => ({}));

  // Only link connectionId if the connection exists and belongs to the PAT actor's scope.
  let connectionId = null;
  if (str(b.connId)) {
    const conn = await prisma.mcpConnection.findUnique({
      where: { id: b.connId },
      select: { id: true, scope: true, ownerUserId: true, workspaceSlug: true },
    });
    if (conn && !(await canLinkConnection(actor, conn))) {
      return NextResponse.json({ error: 'forbidden_connection' }, { status: 403 });
    }
    connectionId = conn?.id || null;
  }
  // Echo workspaceSlug only when the PAT's user is a member.
  let workspaceSlug = null;
  if (b.workspaceSlug && (await canReadScope({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: b.workspaceSlug }))) {
    workspaceSlug = b.workspaceSlug;
  }
  const outcome = ['ok', 'error', 'blocked'].includes(b.outcome) ? b.outcome : 'error';
  const codeSiteRefs = await resolveTrustedCodeSiteRefs(workspaceSlug, b);

  try {
    await prisma.mcpCallAudit.create({
      data: {
        connectionId,
        serverName: bounded(b.serverName, 255) || 'unknown',
        toolName: bounded(b.toolName, 255) || 'unknown',
        userId: actor.userId,
        workspaceSlug,
        outcome,
        errorCode: bounded(b.errorCode, 255),
        alias: bounded(b.alias, 255),
        callerType: 'cli',
        durationMs: num(b.durationMs),
        argsHash: hex64(b.argsHash),
        argsBytes: num(b.argsBytes),
        resultBytes: num(b.resultBytes),
        ...codeSiteRefs,
      },
    });
  } catch {
    return NextResponse.json({ error: 'audit_write_failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}
