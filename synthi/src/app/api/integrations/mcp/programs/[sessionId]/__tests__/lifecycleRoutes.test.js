import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ auth: vi.fn(), write: vi.fn(), getSession: vi.fn(), update: vi.fn(), append: vi.fn(), stop: vi.fn(), restart: vi.fn(), merge: vi.fn() }));
vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.auth }));
vi.mock('@/lib/integrations/scope', () => ({ canWriteScope: h.write }));
vi.mock('@/lib/programs/store', () => ({ getProgramSession: h.getSession, updateProgramSession: h.update, appendProgramRuntimeEvent: h.append }));
vi.mock('@/lib/programs/runtimeClient', () => ({ stopProgramRuntimeSession: h.stop, restartProgramRuntimeSession: h.restart }));
vi.mock('@/lib/programs/routeHelpers', () => ({ codeSiteContextFromBody: () => null, mergeProgramSession: h.merge }));

import { POST as STOP } from '../stop/route.js';
import { POST as RESTART } from '../restart/route.js';

const ctx = { params: Promise.resolve({ sessionId: 'ps-1' }) };
const request = (body = {}) => ({ json: async () => body });

beforeEach(() => {
  vi.clearAllMocks(); h.auth.mockResolvedValue({ userId: 'u1' }); h.write.mockResolvedValue(true);
  h.getSession.mockResolvedValue({ id: 'ps-1', workspaceSlug: 'team' }); h.stop.mockResolvedValue({ state: 'stopped' }); h.restart.mockResolvedValue({ state: 'running' }); h.update.mockResolvedValue({ id: 'ps-1' }); h.merge.mockImplementation((session, runtime) => ({ ...session, ...runtime }));
});

describe('MCP program lifecycle routes', () => {
  it('stops only a workspace-scoped session and records an MCP event', async () => {
    const response = await STOP(request({ workspaceSlug: 'team' }), ctx);
    expect(response.status).toBe(200); expect(h.stop).toHaveBeenCalledWith('team', 'ps-1');
    expect(h.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop_ack', data: expect.objectContaining({ via: 'mcp' }) }));
  });

  it('rejects a cross-workspace session before runtime control', async () => {
    h.getSession.mockResolvedValue({ id: 'ps-1', workspaceSlug: 'other' });
    const response = await RESTART(request({ workspaceSlug: 'team' }), ctx);
    expect(response.status).toBe(404); expect(h.restart).not.toHaveBeenCalled();
  });

  it('restarts only after workspace write authorization', async () => {
    h.write.mockResolvedValue(false);
    const response = await RESTART(request({ workspaceSlug: 'team' }), ctx);
    expect(response.status).toBe(403); expect(h.restart).not.toHaveBeenCalled();
  });
});
