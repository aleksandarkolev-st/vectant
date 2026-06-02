import { it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  canRead: vi.fn(),
  prisma: { mcpCallAudit: { create: vi.fn() }, mcpConnection: { findUnique: vi.fn() } },
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
  h.prisma.mcpConnection.findUnique.mockResolvedValue({ id: 'c1' });
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

it('echoes workspaceSlug only for a member', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(false);
  await POST(req({ serverName: 'gh', toolName: 't', outcome: 'ok', workspaceSlug: 'team' }));
  expect(h.prisma.mcpCallAudit.create.mock.calls[0][0].data.workspaceSlug).toBe(null);
});

it('bounds untrusted strings: oversized / non-hex fields are rejected (storage-abuse guard)', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  await POST(req({ serverName: 'x'.repeat(300), toolName: 't', outcome: 'ok', argsHash: 'z'.repeat(64), alias: 'a'.repeat(300) }));
  const data = h.prisma.mcpCallAudit.create.mock.calls[0][0].data;
  expect(data.serverName).toBe('unknown'); // >255 chars rejected -> 'unknown' fallback
  expect(data.argsHash).toBe(null);        // 64 chars but non-hex -> rejected
  expect(data.alias).toBe(null);           // >255 chars rejected
});
