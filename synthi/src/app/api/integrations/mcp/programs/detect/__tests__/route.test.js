import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  auth: vi.fn(), read: vi.fn(), write: vi.fn(), grants: vi.fn(), detected: vi.fn(), createSession: vi.fn(), updateSession: vi.fn(), append: vi.fn(), launch: vi.fn(), merge: vi.fn(),
}));

vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.auth }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.read, canWriteScope: h.write }));
vi.mock('@/lib/programs/store', () => ({ listPermissionGrants: h.grants, createProgramSession: h.createSession, updateProgramSession: h.updateSession, appendProgramRuntimeEvent: h.append }));
vi.mock('@/lib/programs/runtimeClient', () => ({ fetchDetectedRepoProgram: h.detected, launchInstalledProgram: h.launch }));
vi.mock('@/lib/programs/routeHelpers', () => ({ codeSiteContextFromBody: () => null, mergeProgramSession: h.merge, PROGRAM_LAUNCH_SCOPE: 'program.launch' }));

import { GET, POST } from '../route.js';

const request = (url, body = {}) => ({ url, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ userId: 'u1' }); h.read.mockResolvedValue(true); h.write.mockResolvedValue(true);
  h.grants.mockResolvedValue([{ scopes: ['program.launch'] }]);
  h.detected.mockResolvedValue({ source: 'docker-compose', config: { runtimeType: 'container', displayName: 'App' } });
  h.createSession.mockResolvedValue({ id: 'ps-1', runtimeType: 'container' }); h.launch.mockResolvedValue({ state: 'running', activePorts: [3000] }); h.updateSession.mockResolvedValue({ id: 'ps-1', state: 'running' }); h.merge.mockImplementation((session, runtime) => ({ ...session, ...runtime }));
});

describe('MCP detected-program bridge', () => {
  it('returns a detected recipe to a read-authorized PAT caller', async () => {
    const response = await GET(request('http://app/api/integrations/mcp/programs/detect?workspaceSlug=team'));
    expect(response.status).toBe(200);
    expect((await response.json()).detected).toMatchObject({ source: 'docker-compose' });
    expect(h.detected).toHaveBeenCalledWith('team', 'u1');
  });

  it('requires an existing launch consent before creating a session', async () => {
    h.grants.mockResolvedValue([]);
    const response = await POST(request('http://app/api/integrations/mcp/programs/detect', { workspaceSlug: 'team' }));
    expect(response.status).toBe(409);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it('launches an already-detected recipe with a pre-existing consent', async () => {
    const response = await POST(request('http://app/api/integrations/mcp/programs/detect', { workspaceSlug: 'team' }));
    expect(response.status).toBe(200);
    expect(h.createSession).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', startedByUserId: 'u1' }));
    expect(h.launch).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', sessionId: 'ps-1' }));
  });
});
