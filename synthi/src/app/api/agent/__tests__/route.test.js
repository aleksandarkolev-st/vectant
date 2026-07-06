import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  requireRuntimeWorkspaceAccess: vi.fn(),
}));

vi.mock('next-auth', () => ({
  getServerSession: h.getServerSession,
}));

vi.mock('@/app/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/workspaceAccess', () => ({
  requireRuntimeWorkspaceAccess: h.requireRuntimeWorkspaceAccess,
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
      instruction: 'summarize active file',
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
      instruction: 'summarize active file',
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
});
