import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  requireRuntimeWorkspaceAccess: vi.fn(),
  buildExternalTools: vi.fn(),
  isExternalToolName: vi.fn(),
  callExternalTool: vi.fn(),
  executeTool: vi.fn(),
  isComplexTask: vi.fn(),
  resolveActor: vi.fn(),
  toolDeclarations: [],
}));

vi.mock('next-auth', () => ({
  getServerSession: h.getServerSession,
}));

vi.mock('@/app/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/workspaceAccess', () => ({
  requireRuntimeWorkspaceAccess: h.requireRuntimeWorkspaceAccess,
}));

vi.mock('../externalTools.js', () => ({
  buildExternalTools: h.buildExternalTools,
  isExternalToolName: h.isExternalToolName,
  callExternalTool: h.callExternalTool,
}));

vi.mock('../toolDefinitions.js', () => ({
  get TOOL_DECLARATIONS() { return h.toolDeclarations; },
  executeTool: h.executeTool,
  isComplexTask: h.isComplexTask,
}));

vi.mock('@/lib/integrations/session', () => ({
  resolveActor: h.resolveActor,
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

function upstreamStream(text = 'done') {
  return new ReadableStream({
    start(controller) {
      const payload = {
        candidates: [{
          content: { parts: [{ text }] },
          finishReason: 'STOP',
        }],
      };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
      controller.close();
    },
  });
}

function okJson(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_BACKEND_AUTH_TOKEN = 'internal-token';
  h.getServerSession.mockResolvedValue({
    user: { id: 'user-1', email: 'user@example.com' },
  });
  h.requireRuntimeWorkspaceAccess.mockResolvedValue({
    ok: true,
    session: { user: { id: 'user-1', email: 'user@example.com' } },
    email: 'user@example.com',
    workspace: { id: 'ws-1', slug: 'canonical-slug', name: 'Team' },
    membership: { id: 'm1', role: 'member' },
  });
  h.buildExternalTools.mockResolvedValue({ declarations: [], aliasMap: {} });
  h.isExternalToolName.mockReturnValue(false);
  h.isComplexTask.mockReturnValue(false);
  h.resolveActor.mockResolvedValue({ userId: 'actor-1' });
  h.toolDeclarations = [
    { name: 'create_file', description: 'Create a workspace file', parameters: { type: 'OBJECT' } },
    { name: 'create_directory', description: 'Create a workspace directory', parameters: { type: 'OBJECT' } },
    { name: 'run_command', description: 'Run a terminal command', parameters: { type: 'OBJECT' } },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const target = String(url);
    if (target.includes('/code-intel/context')) {
      return okJson({ context: '', sufficiency: 'ENOUGH', sources: [], tokens_used: 0, trace: [] });
    }
    if (target.includes('/file-content/')) {
      return { ok: true, status: 200, text: async () => 'server file content' };
    }
    if (target.includes('/files-meta')) {
      return okJson({ files: [] });
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      return { ok: true, status: 200, body: upstreamStream('model response') };
    }
    throw new Error(`unexpected fetch: ${target}`);
  }));
});

afterEach(() => {
  process.env.AI_BACKEND_AUTH_TOKEN = originalInternalToken;
  vi.unstubAllGlobals();
});

describe('/api/chat inbound authorization', () => {
  it('rejects anonymous requests before reading the JSON body', async () => {
    h.getServerSession.mockResolvedValue(null);
    const req = request({ prompt: 'hello', workspacePath: 'route-slug' });

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Authentication required' });
    expect(req.json).not.toHaveBeenCalled();
    expect(h.requireRuntimeWorkspaceAccess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unauthorized workspaces before code-intel, collab, or provider calls', async () => {
    h.requireRuntimeWorkspaceAccess.mockResolvedValue({
      ok: false,
      status: 404,
      error: 'Workspace not found',
    });

    const res = await POST(request({
      prompt: 'explain this',
      workspacePath: 'route-slug',
      focusPath: 'src/app.js',
      files: [{ path: 'src/app.js', content: 'client content' }],
      apiKey: 'gemini-key',
      useTools: false,
    }));

    expect(res.status).toBe(404);
    expect(h.requireRuntimeWorkspaceAccess).toHaveBeenCalledWith('route-slug');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the authorized workspace slug and server user id for workspace hydration', async () => {
    const res = await POST(request({
      prompt: 'explain this file',
      workspacePath: 'route-slug',
      focusPath: 'src/app.js',
      files: [{ path: 'src/app.js', content: 'client content' }],
      apiKey: 'gemini-key',
      useCodeIntel: true,
      useTools: false,
    }));

    expect(res.status).toBe(200);
    expect(h.requireRuntimeWorkspaceAccess).toHaveBeenCalledWith('route-slug');

    const codeIntelCall = fetch.mock.calls.find(([url]) => String(url).includes('/code-intel/context'));
    expect(codeIntelCall).toBeTruthy();
    expect(JSON.parse(codeIntelCall[1].body)).toMatchObject({
      workspace_path: 'canonical-slug/user-1',
      query: 'explain this file',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:1234/file-content/canonical-slug/src/app.js',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-user-id': 'user-1',
          'x-synthi-internal-token': 'internal-token',
        }),
      }),
    );
  });

  it('keeps authenticated non-workspace chat out of workspace authorization', async () => {
    const res = await POST(request({
      prompt: 'hello',
      apiKey: 'gemini-key',
      useTools: false,
    }));

    expect(res.status).toBe(200);
    expect(h.requireRuntimeWorkspaceAccess).not.toHaveBeenCalled();
    const providerCalls = fetch.mock.calls.filter(([url]) => String(url).includes('generativelanguage.googleapis.com'));
    expect(providerCalls).toHaveLength(1);
  });

  it('declares and executes only the tool subset selected by the atomic router', async () => {
    h.isComplexTask.mockReturnValue(true);
    let geminiCallCount = 0;
    let firstGeminiRequest = null;
    fetch.mockImplementation(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/files-meta')) return okJson({ files: [] });
      if (target.includes('/code-intel/context')) return okJson({ context: '', sufficiency: 'ENOUGH', sources: [], tokens_used: 0, trace: [] });
      if (target.includes('generativelanguage.googleapis.com')) {
        geminiCallCount += 1;
        if (geminiCallCount === 1) {
          firstGeminiRequest = JSON.parse(options.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name: 'run_command', args: { command: 'npm test' } } }] } }] }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: 'Created the component.' }] } }] }),
        };
      }
      throw new Error(`unexpected fetch: ${target}`);
    });

    const response = await POST(request({
      prompt: 'Create a new component.',
      workspacePath: 'route-slug',
      apiKey: 'gemini-key',
      provider: 'gemini',
      useTools: true,
    }));
    const body = await response.text();
    const events = body.trim().split('\n').map((line) => JSON.parse(line));

    expect(firstGeminiRequest.tools[0].functionDeclarations.map((tool) => tool.name))
      .toEqual(['create_file', 'create_directory']);
    expect(firstGeminiRequest.systemInstruction.parts[0].text).not.toContain('run_command(command)');
    expect(firstGeminiRequest.systemInstruction.parts[0].text).toContain('passive workspace instruction documents');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('.synthi/AGENTS.md'))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      toolCall: expect.objectContaining({ tool: 'run_command', status: 'rejected' }),
    }));
    expect(h.executeTool).not.toHaveBeenCalled();
  });
});
