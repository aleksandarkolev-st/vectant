import { describe, it, expect, vi, beforeEach } from 'vitest';

// All mock handles via vi.hoisted so the hoisted vi.mock factories don't hit a TDZ.
const { resolveToolConfigsMock, listToolsMock, callToolMock, auditCreateMock, checkLimitMock, canReadScopeMock } = vi.hoisted(() => ({
  resolveToolConfigsMock: vi.fn(),
  listToolsMock: vi.fn(),
  callToolMock: vi.fn(),
  auditCreateMock: vi.fn(),
  checkLimitMock: vi.fn(),
  canReadScopeMock: vi.fn(),
}));
vi.mock('@/lib/integrations/connectionStore', () => ({ resolveToolConfigs: resolveToolConfigsMock }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: canReadScopeMock }));
vi.mock('@/lib/mcp-hub', () => ({ listTools: listToolsMock, callTool: callToolMock }));
vi.mock('@/lib/prisma', () => ({ default: { mcpCallAudit: { create: auditCreateMock } } }));
vi.mock('@/lib/integrations/rateLimit', () => ({
  checkLimit: checkLimitMock,
  RATE_LIMITS: { crud: { limit: 30, windowMs: 60000 }, test: { limit: 10, windowMs: 60000 }, extcall: { limit: 60, windowMs: 60000 } },
}));
// NOTE: jsonSchemaToGemini is imported from '@/lib/mcp-hub/helpers.js' (real, not mocked)
// so the schema-size-cap branch is exercised against the genuine converter.

import { buildExternalTools, isExternalToolName, callExternalTool } from '../externalTools.js';

beforeEach(() => {
  resolveToolConfigsMock.mockReset();
  listToolsMock.mockReset();
  callToolMock.mockReset();
  auditCreateMock.mockReset().mockResolvedValue({});
  checkLimitMock.mockReset().mockReturnValue({ ok: true });
  canReadScopeMock.mockReset().mockResolvedValue(true);
});

describe('isExternalToolName', () => {
  it('matches ext_<n> only', () => {
    expect(isExternalToolName('ext_0')).toBe(true);
    expect(isExternalToolName('ext_12')).toBe(true);
    expect(isExternalToolName('read_file')).toBe(false);
    expect(isExternalToolName('ext_x')).toBe(false);
  });
});

describe('buildExternalTools', () => {
  it('builds aliased declarations limited to the allowlist; degrades on error', async () => {
    resolveToolConfigsMock.mockResolvedValue([
      { id: 'c1', name: 'GitHub', allowlist: ['create_issue'], url: 'https://gh', transport: 'http', authType: 'none' },
      { id: 'c2', name: 'Broken', allowlist: ['x'], url: 'https://b', transport: 'http', authType: 'none' },
    ]);
    listToolsMock.mockImplementation(async (cfg) => {
      if (cfg.id === 'c1') {
        return { ok: true, tools: [
          { name: 'create_issue', description: 'Create', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
          { name: 'secret_tool', description: 'hidden', inputSchema: { type: 'object' } },
        ] };
      }
      return { ok: false, error: { code: 'unreachable', message: 'down' } };
    });

    const { declarations, aliasMap } = await buildExternalTools({ userId: 'u1', workspaceSlug: 'w1' });
    expect(declarations).toHaveLength(1);
    expect(declarations[0].name).toBe('ext_0');
    expect(declarations[0].parameters.type).toBe('OBJECT');
    expect(aliasMap.ext_0).toMatchObject({ connId: 'c1', toolName: 'create_issue', connName: 'GitHub' });
  });

  it('returns empty when there are no resolved configs', async () => {
    resolveToolConfigsMock.mockResolvedValue([]);
    const { declarations } = await buildExternalTools({ userId: 'u1', workspaceSlug: null });
    expect(declarations).toEqual([]);
  });

  it('gates workspace tools behind membership: a non-member resolves personal-only (R1-9)', async () => {
    canReadScopeMock.mockResolvedValue(false);
    resolveToolConfigsMock.mockResolvedValue([]);
    await buildExternalTools({ userId: 'u1', workspaceSlug: 'team' });
    expect(resolveToolConfigsMock).toHaveBeenCalledWith({ userId: 'u1', workspaceSlug: null });
  });

  it('passes the workspace slug through for a member', async () => {
    canReadScopeMock.mockResolvedValue(true);
    resolveToolConfigsMock.mockResolvedValue([]);
    await buildExternalTools({ userId: 'u1', workspaceSlug: 'team' });
    expect(resolveToolConfigsMock).toHaveBeenCalledWith({ userId: 'u1', workspaceSlug: 'team' });
  });

  it('skips a tool whose converted schema exceeds the size cap (R1-7)', async () => {
    const bigProps = {};
    for (let k = 0; k < 600; k++) bigProps[`p${k}`] = { type: 'string' };
    resolveToolConfigsMock.mockResolvedValue([
      { id: 'c1', name: 'Big', allowlist: ['big', 'small'], url: 'https://x', transport: 'http', authType: 'none' },
    ]);
    listToolsMock.mockResolvedValue({ ok: true, tools: [
      { name: 'big', description: 'b', inputSchema: { type: 'object', properties: bigProps } },
      { name: 'small', description: 's', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
    ] });
    const { declarations, aliasMap } = await buildExternalTools({ userId: 'u1', workspaceSlug: null });
    expect(declarations).toHaveLength(1);
    expect(declarations[0].name).toBe('ext_0');
    expect(aliasMap.ext_0.toolName).toBe('small');
  });

  it('caps the number of tools per connection (R1-7)', async () => {
    const manyTools = Array.from({ length: 65 }, (_, k) => ({ name: `t${k}`, description: 'd', inputSchema: { type: 'object' } }));
    resolveToolConfigsMock.mockResolvedValue([
      { id: 'c1', name: 'Many', allowlist: manyTools.map((t) => t.name), url: 'https://x', transport: 'http', authType: 'none' },
    ]);
    listToolsMock.mockResolvedValue({ ok: true, tools: manyTools });
    const { declarations } = await buildExternalTools({ userId: 'u1', workspaceSlug: null });
    expect(declarations).toHaveLength(64);
  });
});

describe('callExternalTool', () => {
  const aliasMap = {
    ext_0: {
      connId: 'c1', connName: 'GitHub', toolName: 'create_issue',
      config: { id: 'c1', url: 'https://gh', transport: 'http', authType: 'none' },
    },
  };

  it('routes to the hub and writes an ok audit row', async () => {
    callToolMock.mockResolvedValue({ ok: true, data: { content: [{ type: 'text', text: 'done' }] } });
    const res = await callExternalTool('ext_0', { title: 't' }, aliasMap, { userId: 'u1', workspaceSlug: 'w1' });
    expect(callToolMock).toHaveBeenCalledWith(aliasMap.ext_0.config, 'create_issue', { title: 't' });
    expect(res).toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ connectionId: 'c1', toolName: 'create_issue', outcome: 'ok' }),
    }));
  });

  it('records the R1-8 audit enrichment fields on success', async () => {
    callToolMock.mockResolvedValue({ ok: true, data: { content: [{ type: 'text', text: 'done' }] } });
    await callExternalTool('ext_0', { title: 't' }, aliasMap, { userId: 'u1', workspaceSlug: 'w1' });
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        alias: 'ext_0',
        callerType: 'chat',
        argsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        argsBytes: expect.any(Number),
        resultBytes: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    }));
  });

  it('returns a structured error and audits failure for an unknown alias', async () => {
    const res = await callExternalTool('ext_99', {}, aliasMap, { userId: 'u1' });
    expect(res.error).toBeTruthy();
    expect(callToolMock).not.toHaveBeenCalled();
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome: 'error', errorCode: 'unknown_alias' }),
    }));
  });

  it('returns a structured rate_limited result without calling out (R1-A)', async () => {
    checkLimitMock.mockReturnValue({ ok: false, retryAfterMs: 5000 });
    const res = await callExternalTool('ext_0', { title: 't' }, aliasMap, { userId: 'u1' });
    expect(res).toMatchObject({ error: 'rate_limited', retryAfterMs: 5000 });
    expect(callToolMock).not.toHaveBeenCalled();
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome: 'blocked', errorCode: 'rate_limited' }),
    }));
  });

  it('enforces the per-turn execution cap without calling out (R1-11)', async () => {
    const turnState = { count: 8, max: 8 };
    const res = await callExternalTool('ext_0', {}, aliasMap, { userId: 'u1' }, turnState);
    expect(res.error).toBe('rate_limited');
    expect(callToolMock).not.toHaveBeenCalled();
    expect(turnState.count).toBe(8); // not incremented when capped
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome: 'blocked', errorCode: 'turn_cap' }),
    }));
  });

  it('increments the turn counter on a successful call', async () => {
    callToolMock.mockResolvedValue({ ok: true, data: { ok: 1 } });
    const turnState = { count: 0 };
    await callExternalTool('ext_0', {}, aliasMap, { userId: 'u1' }, turnState);
    expect(turnState.count).toBe(1);
  });

  it('returns a structured error and audits when the hub returns an error', async () => {
    callToolMock.mockResolvedValue({ ok: false, error: { code: 'tool_error', message: 'boom' } });
    const res = await callExternalTool('ext_0', {}, aliasMap, { userId: 'u1' });
    expect(res.error).toContain('create_issue');
    expect(callToolMock).toHaveBeenCalled();
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome: 'error', errorCode: 'tool_error' }),
    }));
  });

  it('catches a hub exception and returns a structured error (never throws)', async () => {
    callToolMock.mockRejectedValue(new Error('network blew up'));
    const res = await callExternalTool('ext_0', {}, aliasMap, { userId: 'u1' });
    expect(res.error).toBeTruthy();
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome: 'error', errorCode: 'protocol_error' }),
    }));
  });

  it('returns an empty object (not undefined) when a tool yields no data', async () => {
    callToolMock.mockResolvedValue({ ok: true, data: undefined });
    const res = await callExternalTool('ext_0', {}, aliasMap, { userId: 'u1' });
    expect(res).toEqual({});
  });
});
