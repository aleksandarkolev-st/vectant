import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  authPat: vi.fn(),
  canWrite: vi.fn(),
  listPermissionGrants: vi.fn(),
  getInstall: vi.fn(),
  getProgramVersion: vi.fn(),
  createProgramSession: vi.fn(),
  updateProgramSession: vi.fn(),
  appendProgramRuntimeEvent: vi.fn(),
  launchInstalled: vi.fn(),
}));

vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.authPat }));
vi.mock('@/lib/integrations/scope', () => ({ canWriteScope: h.canWrite }));
vi.mock('@/lib/programs/store', () => ({
  listPermissionGrants: h.listPermissionGrants,
  getInstall: h.getInstall,
  getProgramVersion: h.getProgramVersion,
  createProgramSession: h.createProgramSession,
  updateProgramSession: h.updateProgramSession,
  appendProgramRuntimeEvent: h.appendProgramRuntimeEvent,
}));
vi.mock('@/lib/programs/runtimeClient', () => ({ launchInstalledProgram: h.launchInstalled }));

import { POST } from '../route.js';

const req = (body) => ({
  url: 'http://localhost/api/integrations/mcp/programs/launch',
  method: 'POST',
  headers: { get: () => 'Bearer synthi_pat_x' },
  json: async () => body,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.authPat.mockResolvedValue({ userId: 'u1' });
  h.canWrite.mockResolvedValue(true);
  h.listPermissionGrants.mockResolvedValue([{ id: 'g1', scopes: ['program.launch'] }]);
  h.getInstall.mockResolvedValue({ id: 'i1', workspaceSlug: 'team', programId: 'p1', version: '1.0.0' });
  h.getProgramVersion.mockResolvedValue({ manifestJson: JSON.stringify({ runtimeType: 'container', displayName: 'DBeaver' }) });
  h.createProgramSession.mockResolvedValue({ id: 'ps-9', workspaceSlug: 'team', runtimeType: 'container', state: 'starting' });
  h.appendProgramRuntimeEvent.mockResolvedValue({ id: 'evt' });
  h.launchInstalled.mockResolvedValue({ state: 'running', activePorts: [5900], webPort: 5900 });
  h.updateProgramSession.mockResolvedValue({ id: 'ps-9', workspaceSlug: 'team', runtimeType: 'container', state: 'running' });
});

describe('POST /api/integrations/mcp/programs/launch', () => {
  it('launches a container install (slug-routed, Prisma userId) and returns the merged session', async () => {
    const res = await POST(req({ workspaceSlug: 'team', installId: 'i1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toMatchObject({ id: 'ps-9', state: 'running', activePorts: [5900], webPort: 5900 });
    expect(h.launchInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceSlug: 'team', sessionId: 'ps-9', userId: 'u1' }),
    );
  });

  it('rejects an unauthenticated request', async () => {
    h.authPat.mockResolvedValue(null);
    expect((await POST(req({ workspaceSlug: 'team', installId: 'i1' }))).status).toBe(401);
    expect(h.launchInstalled).not.toHaveBeenCalled();
  });

  it('requires workspaceSlug and installId', async () => {
    expect((await POST(req({ installId: 'i1' }))).status).toBe(400);
    expect((await POST(req({ workspaceSlug: 'team' }))).status).toBe(400);
    expect(h.getInstall).not.toHaveBeenCalled();
  });

  it('rejects a plain member (owner/admin only)', async () => {
    h.canWrite.mockResolvedValue(false);
    expect((await POST(req({ workspaceSlug: 'team', installId: 'i1' }))).status).toBe(403);
    expect(h.launchInstalled).not.toHaveBeenCalled();
  });

  it('returns consent_required without a program.launch grant', async () => {
    h.listPermissionGrants.mockResolvedValue([]);
    expect((await POST(req({ workspaceSlug: 'team', installId: 'i1' }))).status).toBe(409);
    expect(h.launchInstalled).not.toHaveBeenCalled();
  });

  it('404s when the install is missing or belongs to another workspace', async () => {
    h.getInstall.mockResolvedValue({ id: 'i1', workspaceSlug: 'other' });
    expect((await POST(req({ workspaceSlug: 'team', installId: 'i1' }))).status).toBe(404);
    expect(h.launchInstalled).not.toHaveBeenCalled();
  });

  it('refuses non-container programs (AI launch is slug-routed; others need the UI)', async () => {
    h.getProgramVersion.mockResolvedValue({ manifestJson: JSON.stringify({ runtimeType: 'web' }) });
    const res = await POST(req({ workspaceSlug: 'team', installId: 'i1' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'unsupported_program_type' });
    expect(h.launchInstalled).not.toHaveBeenCalled();
  });

  it('maps a runtime launch failure to 502 and marks the session crashed', async () => {
    h.launchInstalled.mockRejectedValue(new Error('runtime_pod_not_ready'));
    const res = await POST(req({ workspaceSlug: 'team', installId: 'i1' }));
    expect(res.status).toBe(502);
    expect(h.updateProgramSession).toHaveBeenCalledWith('ps-9', expect.objectContaining({ state: 'crashed' }));
  });
});
