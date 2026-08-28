import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  authPat: vi.fn(),
  canRead: vi.fn(),
  listProgramSessions: vi.fn(),
  listInstalls: vi.fn(),
  toPublicInstall: vi.fn(),
  getProgramSession: vi.fn(),
  listProgramRuntimeEvents: vi.fn(),
  listRuntimeSessions: vi.fn(),
  getRuntimeSession: vi.fn(),
  listRuntimeEvents: vi.fn(),
}));

vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.authPat }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead }));
vi.mock('@/lib/programs/store', () => ({
  listProgramSessions: h.listProgramSessions,
  listInstalls: h.listInstalls,
  toPublicInstall: h.toPublicInstall,
  getProgramSession: h.getProgramSession,
  listProgramRuntimeEvents: h.listProgramRuntimeEvents,
}));
vi.mock('@/lib/programs/runtimeClient', () => ({
  listProgramRuntimeSessions: h.listRuntimeSessions,
  getProgramRuntimeSession: h.getRuntimeSession,
  listProgramRuntimeSessionEvents: h.listRuntimeEvents,
}));

import { GET as GET_PROGRAMS } from '../route.js';
import { GET as GET_SESSION } from '../[sessionId]/route.js';

const req = (url) => ({ url, method: 'GET', headers: { get: () => 'Bearer synthi_pat_x' } });
const sessionCtx = (sessionId) => ({ params: Promise.resolve({ sessionId }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.authPat.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(true);
  h.listProgramSessions.mockResolvedValue([]);
  h.listInstalls.mockResolvedValue([]);
  h.toPublicInstall.mockImplementation((r) => r);
  h.listProgramRuntimeEvents.mockResolvedValue([]);
  h.listRuntimeSessions.mockResolvedValue([]);
  h.getRuntimeSession.mockResolvedValue(null);
  h.listRuntimeEvents.mockResolvedValue([]);
});

describe('GET /api/integrations/mcp/programs (list_programs)', () => {
  it('returns merged sessions + installed for a member, via PAT', async () => {
    h.listProgramSessions.mockResolvedValue([
      { id: 'ps-1', workspaceSlug: 'team', runtimeType: 'cli', state: 'starting' },
    ]);
    h.listRuntimeSessions.mockResolvedValue([
      { sessionId: 'ps-1', workspaceSlug: 'team', state: 'running', activePorts: [3000], webPort: 3000 },
    ]);
    h.listInstalls.mockResolvedValue([{ id: 'i1', packageId: '@vectant/dbeaver' }]);

    const res = await GET_PROGRAMS(req('http://localhost/api/integrations/mcp/programs?workspaceSlug=team'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions[0]).toMatchObject({ id: 'ps-1', state: 'running', activePorts: [3000], webPort: 3000 });
    expect(body.installed).toEqual([{ id: 'i1', packageId: '@vectant/dbeaver' }]);
  });

  it('rejects an unauthenticated request', async () => {
    h.authPat.mockResolvedValue(null);
    const res = await GET_PROGRAMS(req('http://localhost/api/integrations/mcp/programs?workspaceSlug=team'));
    expect(res.status).toBe(401);
  });

  it('requires a workspaceSlug query param', async () => {
    const res = await GET_PROGRAMS(req('http://localhost/api/integrations/mcp/programs'));
    expect(res.status).toBe(400);
    expect(h.listProgramSessions).not.toHaveBeenCalled();
  });

  it('rejects a non-member', async () => {
    h.canRead.mockResolvedValue(false);
    const res = await GET_PROGRAMS(req('http://localhost/api/integrations/mcp/programs?workspaceSlug=team'));
    expect(res.status).toBe(403);
    expect(h.listProgramSessions).not.toHaveBeenCalled();
  });
});

describe('GET /api/integrations/mcp/programs/[sessionId] (read_session)', () => {
  it('returns the merged session + redacted events', async () => {
    h.getProgramSession.mockResolvedValue({ id: 'ps-1', workspaceSlug: 'team', state: 'running' });
    h.getRuntimeSession.mockResolvedValue({ sessionId: 'ps-1', state: 'running', activePorts: [5173], webPort: 5173 });
    h.listProgramRuntimeEvents.mockResolvedValue([
      { id: 'db-1', type: 'launch_ack', createdAt: '2026-01-01T00:00:00.000Z', data: { state: 'running', command: 'psql -c secret' } },
    ]);

    const res = await GET_SESSION(req('http://localhost/api/integrations/mcp/programs/ps-1?workspaceSlug=team'), sessionCtx('ps-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toMatchObject({ id: 'ps-1', state: 'running', activePorts: [5173], webPort: 5173 });
    expect(body.events).toHaveLength(1);
    expect(body.events[0].data.command).toBeUndefined();
  });

  it('404s when the session is missing or belongs to another workspace', async () => {
    h.getProgramSession.mockResolvedValue({ id: 'ps-1', workspaceSlug: 'other', state: 'running' });
    const res = await GET_SESSION(req('http://localhost/api/integrations/mcp/programs/ps-1?workspaceSlug=team'), sessionCtx('ps-1'));
    expect(res.status).toBe(404);
  });

  it('requires a workspaceSlug query param', async () => {
    const res = await GET_SESSION(req('http://localhost/api/integrations/mcp/programs/ps-1'), sessionCtx('ps-1'));
    expect(res.status).toBe(400);
    expect(h.getProgramSession).not.toHaveBeenCalled();
  });

  it('rejects a non-member', async () => {
    h.canRead.mockResolvedValue(false);
    const res = await GET_SESSION(req('http://localhost/api/integrations/mcp/programs/ps-1?workspaceSlug=team'), sessionCtx('ps-1'));
    expect(res.status).toBe(403);
    expect(h.getProgramSession).not.toHaveBeenCalled();
  });
});
