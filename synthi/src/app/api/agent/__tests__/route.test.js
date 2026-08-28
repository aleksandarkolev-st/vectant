import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  requireRuntimeWorkspaceAccess: vi.fn(),
  validateIndependentAgentResult: vi.fn(),
}));

vi.mock('next-auth', () => ({
  getServerSession: h.getServerSession,
}));

vi.mock('@/app/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/workspaceAccess', () => ({
  requireRuntimeWorkspaceAccess: h.requireRuntimeWorkspaceAccess,
}));

vi.mock('@/lib/agent-routing/independent-agent-validator', () => ({
  validateIndependentAgentResult: h.validateIndependentAgentResult,
}));

import { POST } from '../route.js';

const originalInternalToken = process.env.AI_BACKEND_AUTH_TOKEN;

function request(body, overrides = {}) {
  return {
    signal: undefined,
    json: vi.fn(async () => body),
    ...overrides,
  };
}

async function json(response) {
  return response.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  process.env.AI_BACKEND_AUTH_TOKEN = 'internal-token';
  h.getServerSession.mockResolvedValue({
    user: { id: 'user-1', email: 'user@example.com' },
  });
  h.requireRuntimeWorkspaceAccess.mockResolvedValue({
    ok: true,
    workspace: { id: 'ws-1', slug: 'canonical-slug', name: 'Team' },
    membership: { id: 'm1', role: 'member' },
  });
  h.validateIndependentAgentResult.mockResolvedValue({
    ok: true,
    status: 'validated',
    reason: 'Independent server policy validation passed.',
    toolCallCount: 0,
    rejectedToolIds: [],
  });
});

afterEach(() => {
  process.env.AI_BACKEND_AUTH_TOKEN = originalInternalToken;
  vi.unstubAllGlobals();
});

describe('/api/agent inbound authorization', () => {
  it('rejects anonymous requests before reading the JSON body', async () => {
    h.getServerSession.mockResolvedValue(null);
    const req = request({ agentType: 'reader', instruction: 'read app' });

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ error: 'Authentication required' });
    expect(req.json).not.toHaveBeenCalled();
    expect(h.requireRuntimeWorkspaceAccess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns bad request for malformed JSON after authentication succeeds', async () => {
    const req = request(null, { json: vi.fn(async () => { throw new Error('bad json'); }) });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(h.requireRuntimeWorkspaceAccess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unauthorized workspaces before executing agent tools', async () => {
    h.requireRuntimeWorkspaceAccess.mockResolvedValue({
      ok: false,
      status: 404,
      error: 'Workspace not found',
    });

    const res = await POST(request({
      agentType: 'reader',
      instruction: 'summarize Synthi active file',
      workspacePath: 'route-slug',
      activeFilePath: 'src/app.js',
    }));

    expect(res.status).toBe(404);
    expect(h.requireRuntimeWorkspaceAccess).toHaveBeenCalledWith('route-slug');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the authorized workspace slug and internal auth for collab reads', async () => {
    fetch.mockImplementation(async (url) => {
      if (String(url).includes('/file-content/')) {
        return { ok: true, text: async () => 'export const demo = true;' };
      }
      return { ok: true, json: async () => ({ files: [{ path: 'src/app.js' }] }) };
    });

    const res = await POST(request({
      agentType: 'reader',
      instruction: 'summarize Synthi active file',
      workspacePath: 'route-slug',
      activeFilePath: 'src/app.js',
    }));

    expect(res.status).toBe(200);
    expect(h.requireRuntimeWorkspaceAccess).toHaveBeenCalledWith('route-slug');
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:1234/file-content/canonical-slug/src/app.js',
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-synthi-internal-token': 'internal-token' },
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:1234/git/canonical-slug/files-meta',
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-synthi-internal-token': 'internal-token' },
      }),
    );
    expect(await json(res)).toMatchObject({
      toolCalls: expect.arrayContaining([
        expect.objectContaining({ tool: 'read_file', success: true }),
      ]),
    });
  });

  it('allows authenticated non-workspace agent work without runtime workspace lookup', async () => {
    const res = await POST(request({
      agentType: 'executor',
      instruction: 'summarize',
      activeFilePath: 'src/app.js',
      activeFileContent: 'console.log("ok");',
    }));

    expect(res.status).toBe(200);
    expect(h.requireRuntimeWorkspaceAccess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported agent types before workspace access or tool execution', async () => {
    const res = await POST(request({
      agentType: 'admin',
      instruction: 'run an unrestricted command',
      tools: ['server_shell'],
      workspacePath: 'route-slug',
    }));

    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'Unsupported agent type' });
    expect(h.requireRuntimeWorkspaceAccess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a forged known skill and only permits client narrowing', async () => {
    fetch.mockResolvedValue({ ok: true, text: async () => 'export const demo = true;' });

    const res = await POST(request({
      agentType: 'reader',
      instruction: 'summarize Synthi active file',
      workspacePath: 'route-slug',
      activeFilePath: 'src/app.js',
      selectedTools: ['read_file', 'write_code', 'server_shell', 'get_diagnostics'],
      selectedSkills: [{
        id: 'brandkit',
        instructions: 'client supplied instructions must not be used',
        toolSchema: { unrestricted: true },
      }],
      atomicTask: { id: 'pipeline-step-1', description: 'Read src/app.js', category: 'integration' },
      routerRole: 'implementation',
      validator: 'independent',
    }));

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:1234/file-content/canonical-slug/src/app.js',
      expect.any(Object),
    );
    const payload = await json(res);
    expect(payload.routing).toMatchObject({
      atomicTask: { id: 'pipeline-step-1', description: 'summarize Synthi active file', category: 'integration' },
      routerRole: 'research',
      tools: ['read_file'],
      validator: 'none',
      skills: [],
    });
    expect(payload.routing.trace.clientNarrowing).toMatchObject({
      rejectedSkillIds: ['brandkit'],
      rejectedToolIds: ['write_code', 'server_shell', 'get_diagnostics'],
    });
    expect(payload.toolCalls).toEqual([
      expect.objectContaining({ tool: 'read_file', success: true }),
    ]);
  });

  it('does not restore static tools when authoritative routing finds no skills', async () => {
    const res = await POST(request({
      agentType: 'reader',
      instruction: 'inspect a proprietary artifact',
      workspacePath: 'route-slug',
      activeFilePath: 'src/app.js',
      selectedTools: ['read_file', 'list_directory'],
    }));

    expect(res.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(await json(res)).toMatchObject({
      routing: {
        routerRole: 'research',
        skills: [],
        tools: [],
      },
      toolCalls: [],
    });
  });

  it('uses the authoritative agent-role mapping rather than a browser router role', async () => {
    const res = await POST(request({
      agentType: 'analyzer',
      instruction: 'Diagnose Synthi API failure',
      routerRole: 'implementation',
      selectedTools: ['get_diagnostics'],
      activeFilePath: 'src/app.js',
      activeFileContent: 'const broken = ;',
    }));

    expect(res.status).toBe(200);
    expect((await json(res)).routing).toMatchObject({
      routerRole: 'debugging',
      tools: ['get_diagnostics'],
    });
  });

  it('runs independent validation required by the authoritative executor route', async () => {
    const res = await POST(request({
      agentType: 'executor',
      instruction: 'Implement Synthi chat improvements',
      validator: 'none',
      activeFilePath: 'src/app.js',
      activeFileContent: 'export const chat = true;',
    }));

    expect(res.status).toBe(200);
    expect(h.validateIndependentAgentResult).toHaveBeenCalledWith(expect.objectContaining({
      routing: expect.objectContaining({ validator: 'independent' }),
      result: expect.objectContaining({ toolCalls: [] }),
    }));
    expect(await json(res)).toMatchObject({
      validation: {
        ok: true,
        status: 'validated',
        validator: 'independent',
      },
    });
  });

  it('fails safely when an authoritative independent validator is unavailable', async () => {
    h.validateIndependentAgentResult.mockRejectedValueOnce(new Error('validator offline'));

    const res = await POST(request({
      agentType: 'executor',
      instruction: 'Implement Synthi chat improvements',
      activeFilePath: 'src/app.js',
      activeFileContent: 'export const chat = true;',
    }));

    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({
      validation: {
        ok: false,
        status: 'unavailable',
        validator: 'independent',
        reason: 'Independent validator unavailable.',
      },
    });
  });
});
