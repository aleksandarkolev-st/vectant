import { it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  canRead: vi.fn(),
  prisma: {
    mcpCallAudit: { create: vi.fn() },
    mcpConnection: { findUnique: vi.fn() },
    codeSiteProject: { findFirst: vi.fn() },
    codeSiteMutationTransaction: { findFirst: vi.fn() },
    codeSiteMutationLease: { findFirst: vi.fn() },
    codeSiteAgentSession: { findFirst: vi.fn() },
  },
}));
vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.auth }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead }));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));

import { POST } from '../route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

function req(body) {
  return new Request('http://x/api/integrations/mcp/audit', {
    method: 'POST', headers: { authorization: 'Bearer synthi_pat_xxxxxxxxxxxxxxxxxxxxxxxx', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetRateLimits(); vi.clearAllMocks();
  h.prisma.mcpCallAudit.create.mockResolvedValue({});
  h.prisma.mcpConnection.findUnique.mockResolvedValue({ id: 'c1', scope: 'personal', ownerUserId: 'u1', workspaceSlug: null });
  h.prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'project-1' });
  h.prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({ id: 'txn-1' });
  h.prisma.codeSiteMutationLease.findFirst.mockResolvedValue({ id: 'lease-1' });
  h.prisma.codeSiteAgentSession.findFirst.mockResolvedValue({ id: 'agent-1' });
});

it('401 when the PAT is invalid', async () => {
  h.auth.mockResolvedValue(null);
  expect((await POST(req({ outcome: 'ok' }))).status).toBe(401);
  expect(h.prisma.mcpCallAudit.create).not.toHaveBeenCalled();
});

it('writes a callerType=cli row with hash + sizes only', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  const res = await POST(req({ connId: 'c1', serverName: 'gh', toolName: 'create_pr', alias: 'ext_0', outcome: 'ok', durationMs: 12, argsHash: 'a'.repeat(64), argsBytes: 10, resultBytes: 20 }));
  expect(res.status).toBe(201);
  const data = h.prisma.mcpCallAudit.create.mock.calls[0][0].data;
  expect(data).toMatchObject({ connectionId: 'c1', serverName: 'gh', toolName: 'create_pr', userId: 'u1', callerType: 'cli', outcome: 'ok', alias: 'ext_0', argsHash: 'a'.repeat(64), argsBytes: 10, resultBytes: 20 });
  expect(data).not.toHaveProperty('args');
  expect(data).not.toHaveProperty('result');
});

it('nulls connectionId when the connection no longer exists', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.prisma.mcpConnection.findUnique.mockResolvedValue(null);
  await POST(req({ connId: 'gone', serverName: 'gh', toolName: 't', outcome: 'error', errorCode: 'tool_error' }));
  expect(h.prisma.mcpCallAudit.create.mock.calls[0][0].data.connectionId).toBe(null);
});

it('rejects audit rows for another user personal connection', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.prisma.mcpConnection.findUnique.mockResolvedValue({
    id: 'victim-conn',
    scope: 'personal',
    ownerUserId: 'u2',
    workspaceSlug: null,
  });

  const res = await POST(req({ connId: 'victim-conn', serverName: 'gh', toolName: 't', outcome: 'ok' }));

  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'forbidden_connection' });
  expect(h.prisma.mcpCallAudit.create).not.toHaveBeenCalled();
});

it('links workspace connections only after workspace membership is proven', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(true);
  h.prisma.mcpConnection.findUnique.mockResolvedValue({
    id: 'workspace-conn',
    scope: 'workspace',
    ownerUserId: null,
    workspaceSlug: 'team',
  });

  const res = await POST(req({ connId: 'workspace-conn', serverName: 'gh', toolName: 't', outcome: 'ok' }));

  expect(res.status).toBe(201);
  expect(h.canRead).toHaveBeenCalledWith({ userId: 'u1' }, { scope: 'workspace', workspaceSlug: 'team' });
  expect(h.prisma.mcpCallAudit.create.mock.calls[0][0].data.connectionId).toBe('workspace-conn');
});

it('rejects workspace connection audit links for non-members', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(false);
  h.prisma.mcpConnection.findUnique.mockResolvedValue({
    id: 'workspace-conn',
    scope: 'workspace',
    ownerUserId: null,
    workspaceSlug: 'team',
  });

  const res = await POST(req({ connId: 'workspace-conn', serverName: 'gh', toolName: 't', outcome: 'ok' }));

  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'forbidden_connection' });
  expect(h.prisma.mcpCallAudit.create).not.toHaveBeenCalled();
});

it('echoes workspaceSlug only for a member', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(false);
  await POST(req({ serverName: 'gh', toolName: 't', outcome: 'ok', workspaceSlug: 'team' }));
  expect(h.prisma.mcpCallAudit.create.mock.calls[0][0].data.workspaceSlug).toBe(null);
});

it('attaches CodeSite refs only after workspace membership is proven', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(true);
  await POST(req({
    serverName: 'codesite',
    toolName: 'synthi_launch_program',
    outcome: 'ok',
    workspaceSlug: 'team',
    codeSiteContext: {
      projectId: 'project-1',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      evidenceRefs: ['runtime:event:launch-1', 'runtime:event:launch-1'],
    },
  }));
  expect(h.prisma.codeSiteProject.findFirst).toHaveBeenCalledWith({
    where: { id: 'project-1', workspaceSlug: 'team' },
    select: { id: true },
  });
  expect(h.prisma.codeSiteMutationTransaction.findFirst).toHaveBeenCalledWith({
    where: { id: 'txn-1', projectId: 'project-1' },
    select: { id: true },
  });
  expect(h.prisma.mcpCallAudit.create.mock.calls[0][0].data).toMatchObject({
    workspaceSlug: 'team',
    codeSiteProjectId: 'project-1',
    codeSiteTransactionId: 'txn-1',
    codeSiteMutationLeaseId: 'lease-1',
    codeSiteAgentSessionId: 'agent-1',
    codeSiteEvidenceRefsJson: JSON.stringify(['runtime:event:launch-1']),
  });

  vi.clearAllMocks();
  h.prisma.mcpCallAudit.create.mockResolvedValue({});
  h.prisma.mcpConnection.findUnique.mockResolvedValue({ id: 'c1', scope: 'personal', ownerUserId: 'u1', workspaceSlug: null });
  h.prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'project-1' });
  h.prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({ id: 'txn-1' });
  h.prisma.codeSiteMutationLease.findFirst.mockResolvedValue({ id: 'lease-1' });
  h.prisma.codeSiteAgentSession.findFirst.mockResolvedValue({ id: 'agent-1' });
  h.canRead.mockResolvedValue(false);
  await POST(req({
    serverName: 'codesite',
    toolName: 'synthi_launch_program',
    outcome: 'ok',
    workspaceSlug: 'team',
    codeSiteProjectId: 'project-1',
    codeSiteTransactionId: 'txn-1',
    codeSiteMutationLeaseId: 'lease-1',
    codeSiteAgentSessionId: 'agent-1',
    codeSiteEvidenceRefs: ['runtime:event:launch-1'],
  }));
  expect(h.prisma.mcpCallAudit.create.mock.calls[0][0].data).toMatchObject({
    workspaceSlug: null,
    codeSiteProjectId: null,
    codeSiteTransactionId: null,
    codeSiteMutationLeaseId: null,
    codeSiteAgentSessionId: null,
    codeSiteEvidenceRefsJson: null,
  });
});

it('drops CodeSite refs when the referenced project is outside the authorized workspace', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(true);
  h.prisma.codeSiteProject.findFirst.mockResolvedValue(null);

  await POST(req({
    serverName: 'codesite',
    toolName: 'synthi_launch_program',
    outcome: 'ok',
    workspaceSlug: 'team-a',
    codeSiteProjectId: 'project-from-team-b',
    codeSiteTransactionId: 'txn-from-team-b',
    codeSiteMutationLeaseId: 'lease-from-team-b',
    codeSiteAgentSessionId: 'agent-from-team-b',
    codeSiteEvidenceRefs: ['runtime:event:foreign'],
  }));

  expect(h.prisma.codeSiteProject.findFirst).toHaveBeenCalledWith({
    where: { id: 'project-from-team-b', workspaceSlug: 'team-a' },
    select: { id: true },
  });
  expect(h.prisma.codeSiteMutationTransaction.findFirst).not.toHaveBeenCalled();
  expect(h.prisma.mcpCallAudit.create.mock.calls[0][0].data).toMatchObject({
    workspaceSlug: 'team-a',
    codeSiteProjectId: null,
    codeSiteTransactionId: null,
    codeSiteMutationLeaseId: null,
    codeSiteAgentSessionId: null,
    codeSiteEvidenceRefsJson: null,
  });
});

it('bounds untrusted strings: oversized / non-hex fields are rejected (storage-abuse guard)', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  await POST(req({ serverName: 'x'.repeat(300), toolName: 't', outcome: 'ok', argsHash: 'z'.repeat(64), alias: 'a'.repeat(300) }));
  const data = h.prisma.mcpCallAudit.create.mock.calls[0][0].data;
  expect(data.serverName).toBe('unknown'); // >255 chars rejected -> 'unknown' fallback
  expect(data.argsHash).toBe(null);        // 64 chars but non-hex -> rejected
  expect(data.alias).toBe(null);           // >255 chars rejected
});
