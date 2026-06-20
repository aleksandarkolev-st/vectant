import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  authPat: vi.fn(),
  canWrite: vi.fn(),
  listPermissionGrants: vi.fn(),
  launchRuntime: vi.fn(),
}));

vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.authPat }));
vi.mock('@/lib/integrations/scope', () => ({ canWriteScope: h.canWrite }));
vi.mock('@/lib/programs/store', () => ({ listPermissionGrants: h.listPermissionGrants }));
vi.mock('@/lib/programs/runtimeClient', () => ({ launchProgramRuntime: h.launchRuntime }));

import { POST } from '../route.js';

const req = (body) => ({
  url: 'http://localhost/api/integrations/mcp/runtime-exec',
  method: 'POST',
  headers: { get: () => 'Bearer synthi_pat_x' },
  json: async () => body,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.authPat.mockResolvedValue({ userId: 'u1' });
  h.canWrite.mockResolvedValue(true);
  h.listPermissionGrants.mockResolvedValue([{ id: 'g1', scopes: ['program.launch'] }]);
  h.launchRuntime.mockResolvedValue({ sessionId: 'ai-abc', output: 'hello\n', exitCode: 0, timedOut: false, runtimeSession: null });
});

describe('POST /api/integrations/mcp/runtime-exec', () => {
  it('runs a command in the workspace runtime and returns output/exitCode (no DB session row)', async () => {
    const res = await POST(req({ workspaceSlug: 'team', command: 'docker ps' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sessionId: 'ai-abc', output: 'hello\n', exitCode: 0, timedOut: false });
    expect(h.launchRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceSlug: 'team', command: 'docker ps', userId: 'u1' }),
    );
    // exec is transient: the runtime sessionId it launches under is ephemeral (ai-*).
    expect(h.launchRuntime.mock.calls[0][0].sessionId).toMatch(/^ai-/);
  });

  it('rejects an unauthenticated (no/invalid PAT) request', async () => {
    h.authPat.mockResolvedValue(null);
    const res = await POST(req({ workspaceSlug: 'team', command: 'docker ps' }));
    expect(res.status).toBe(401);
    expect(h.launchRuntime).not.toHaveBeenCalled();
  });

  it('requires a workspaceSlug and a command', async () => {
    expect((await POST(req({ command: 'x' }))).status).toBe(400);
    expect((await POST(req({ workspaceSlug: 'team' }))).status).toBe(400);
    expect(h.launchRuntime).not.toHaveBeenCalled();
  });

  it('rejects a plain member (owner/admin only)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST(req({ workspaceSlug: 'team', command: 'docker ps' }));
    expect(res.status).toBe(403);
    expect(h.launchRuntime).not.toHaveBeenCalled();
  });

  it('returns consent_required when the workspace has no program.launch grant', async () => {
    h.listPermissionGrants.mockResolvedValue([]);
    const res = await POST(req({ workspaceSlug: 'team', command: 'docker ps' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'consent_required' });
    expect(h.launchRuntime).not.toHaveBeenCalled();
  });

  it('does NOT auto-grant consent from a PAT (a grant lacking program.launch is insufficient)', async () => {
    h.listPermissionGrants.mockResolvedValue([{ id: 'g2', scopes: ['network.outbound'] }]);
    const res = await POST(req({ workspaceSlug: 'team', command: 'docker ps' }));
    expect(res.status).toBe(409);
    expect(h.launchRuntime).not.toHaveBeenCalled();
  });

  it('maps a runtime failure to 502', async () => {
    h.launchRuntime.mockRejectedValue(new Error('pod unreachable'));
    const res = await POST(req({ workspaceSlug: 'team', command: 'docker ps' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'runtime_exec_failed' });
  });
});
