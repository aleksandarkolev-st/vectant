import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  canRead: vi.fn(),
  canWrite: vi.fn(),
  listPermissionGrants: vi.fn(),
  createPermissionGrant: vi.fn(),
  createProgramSession: vi.fn(),
  getProgramSession: vi.fn(),
  listProgramSessions: vi.fn(),
  updateProgramSession: vi.fn(),
  appendProgramRuntimeEvent: vi.fn(),
  listProgramRuntimeEvents: vi.fn(),
  launchRuntime: vi.fn(),
  listRuntimeSessions: vi.fn(),
  getRuntimeSession: vi.fn(),
  stopRuntime: vi.fn(),
  restartRuntime: vi.fn(),
  listRuntimeEvents: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead, canWriteScope: h.canWrite }));
vi.mock('@/lib/programs/store', () => ({
  listPermissionGrants: h.listPermissionGrants,
  createPermissionGrant: h.createPermissionGrant,
  createProgramSession: h.createProgramSession,
  getProgramSession: h.getProgramSession,
  listProgramSessions: h.listProgramSessions,
  updateProgramSession: h.updateProgramSession,
  appendProgramRuntimeEvent: h.appendProgramRuntimeEvent,
  listProgramRuntimeEvents: h.listProgramRuntimeEvents,
}));
vi.mock('@/lib/programs/runtimeClient', () => ({
  launchProgramRuntime: h.launchRuntime,
  listProgramRuntimeSessions: h.listRuntimeSessions,
  getProgramRuntimeSession: h.getRuntimeSession,
  stopProgramRuntimeSession: h.stopRuntime,
  restartProgramRuntimeSession: h.restartRuntime,
  listProgramRuntimeSessionEvents: h.listRuntimeEvents,
}));

import { GET as GET_SESSIONS, POST as POST_SESSIONS } from '../route.js';
import { GET as GET_SESSION_EVENTS } from '../[sessionId]/events/route.js';
import { POST as POST_SESSION_STOP } from '../[sessionId]/stop/route.js';
import { POST as POST_SESSION_RESTART } from '../[sessionId]/restart/route.js';

const req = (url, body, method = 'GET') => ({
  url,
  method,
  json: async () => body,
});

const ctx = (params) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c' });
  h.canRead.mockResolvedValue(true);
  h.canWrite.mockResolvedValue(true);
  h.listPermissionGrants.mockResolvedValue([]);
  h.appendProgramRuntimeEvent.mockResolvedValue({ id: 'evt-1' });
  h.listProgramRuntimeEvents.mockResolvedValue([]);
  h.listRuntimeSessions.mockResolvedValue([]);
  h.getRuntimeSession.mockResolvedValue(null);
  h.listRuntimeEvents.mockResolvedValue([]);
});

describe('GET /api/workspace/[slug]/program-sessions', () => {
  it('allows a workspace member to read sessions and merges live runtime data', async () => {
    h.listProgramSessions.mockResolvedValue([
      { id: 'ps-1', workspaceSlug: 'team', runtimeType: 'cli', state: 'starting' },
    ]);
    h.listRuntimeSessions.mockResolvedValue([
      { sessionId: 'ps-1', workspaceSlug: 'team', state: 'running', activePorts: [3000], webPort: 3000 },
    ]);

    const res = await GET_SESSIONS(req('http://localhost/api/workspace/team/program-sessions'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions[0]).toMatchObject({ id: 'ps-1', state: 'running', activePorts: [3000], webPort: 3000 });
  });

  it('rejects a non-member before reading sessions', async () => {
    h.canRead.mockResolvedValue(false);

    const res = await GET_SESSIONS(req('http://localhost/api/workspace/team/program-sessions'), ctx({ slug: 'team' }));

    expect(res.status).toBe(403);
    expect(h.listProgramSessions).not.toHaveBeenCalled();
  });
});

describe('POST /api/workspace/[slug]/program-sessions', () => {
  it('rejects launch without an existing or newly granted consent record', async () => {
    const res = await POST_SESSIONS(
      req('http://localhost/api/workspace/team/program-sessions', { command: 'npm run dev' }, 'POST'),
      ctx({ slug: 'team' }),
    );

    expect(res.status).toBe(409);
    expect(h.createProgramSession).not.toHaveBeenCalled();
    expect(h.launchRuntime).not.toHaveBeenCalled();
  });

  it('allows an owner/admin launch, records consent, and reuses the Prisma session id as the runtime session id', async () => {
    h.createPermissionGrant.mockResolvedValue({ id: 'grant-1', scopes: ['program.launch'] });
    h.createProgramSession.mockResolvedValue({
      id: 'ps-1',
      workspaceSlug: 'team',
      runtimeType: 'cli',
      state: 'starting',
      startedByUserId: 'u1',
    });
    h.launchRuntime.mockResolvedValue({
      sessionId: 'ps-1',
      output: 'ready',
      exitCode: 0,
      timedOut: false,
      runtimeSession: { sessionId: 'ps-1', workspaceSlug: 'team', state: 'running', activePorts: [5173], webPort: 5173, healthState: 'ok' },
    });
    h.updateProgramSession.mockResolvedValue({
      id: 'ps-1',
      workspaceSlug: 'team',
      runtimeType: 'cli',
      state: 'running',
      startedByUserId: 'u1',
    });

    const res = await POST_SESSIONS(
      req('http://localhost/api/workspace/team/program-sessions', {
        command: 'npm run dev',
        grantScopes: ['program.launch'],
      }, 'POST'),
      ctx({ slug: 'team' }),
    );

    expect(res.status).toBe(201);
    expect(h.launchRuntime).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', sessionId: 'ps-1', command: 'npm run dev' }));
    expect(h.appendProgramRuntimeEvent).toHaveBeenCalled();
    const body = await res.json();
    expect(body.session).toMatchObject({ id: 'ps-1', state: 'running', activePorts: [5173], webPort: 5173, lastHealthState: 'ok' });
    expect(body.grant).toMatchObject({ id: 'grant-1' });
  });

  it('rejects launch for a plain member even though read access exists', async () => {
    h.canWrite.mockResolvedValue(false);

    const res = await POST_SESSIONS(
      req('http://localhost/api/workspace/team/program-sessions', { command: 'npm run dev' }, 'POST'),
      ctx({ slug: 'team' }),
    );

    expect(res.status).toBe(403);
    expect(h.createProgramSession).not.toHaveBeenCalled();
  });
});

describe('POST session actions', () => {
  it('stops a session for an owner/admin and persists the stopped state', async () => {
    h.getProgramSession.mockResolvedValue({ id: 'ps-1', workspaceSlug: 'team', state: 'running' });
    h.stopRuntime.mockResolvedValue({ sessionId: 'ps-1', state: 'stopped' });
    h.updateProgramSession.mockResolvedValue({ id: 'ps-1', workspaceSlug: 'team', state: 'stopped' });

    const res = await POST_SESSION_STOP(req('http://localhost/api/workspace/team/program-sessions/ps-1/stop', {}, 'POST'), ctx({ slug: 'team', sessionId: 'ps-1' }));

    expect(res.status).toBe(200);
    expect(h.stopRuntime).toHaveBeenCalledWith('team', 'ps-1');
    const body = await res.json();
    expect(body.session).toMatchObject({ id: 'ps-1', state: 'stopped' });
  });

  it('restarts a session for an owner/admin and persists the new runtime state', async () => {
    h.getProgramSession.mockResolvedValue({ id: 'ps-1', workspaceSlug: 'team', state: 'stopped' });
    h.restartRuntime.mockResolvedValue({ sessionId: 'ps-1', state: 'running', activePorts: [3000], webPort: 3000 });
    h.updateProgramSession.mockResolvedValue({ id: 'ps-1', workspaceSlug: 'team', state: 'running' });

    const res = await POST_SESSION_RESTART(req('http://localhost/api/workspace/team/program-sessions/ps-1/restart', {}, 'POST'), ctx({ slug: 'team', sessionId: 'ps-1' }));

    expect(res.status).toBe(200);
    expect(h.restartRuntime).toHaveBeenCalledWith('team', 'ps-1');
    const body = await res.json();
    expect(body.session).toMatchObject({ id: 'ps-1', state: 'running', activePorts: [3000] });
  });
});

describe('GET /api/workspace/[slug]/program-sessions/[sessionId]/events', () => {
  it('returns redacted runtime events for any workspace member', async () => {
    h.getProgramSession.mockResolvedValue({ id: 'ps-1', workspaceSlug: 'team', state: 'running' });
    h.listProgramRuntimeEvents.mockResolvedValue([
      { id: 'db-1', type: 'launch_ack', createdAt: '2026-01-01T00:00:00.000Z', data: { state: 'running', command: 'npm run dev' } },
    ]);
    h.listRuntimeEvents.mockResolvedValue([
      { type: 'launched', createdAt: 1234, data: { title: 'npm run dev', command: 'npm run dev', env: { SECRET: 'x' } } },
    ]);

    const res = await GET_SESSION_EVENTS(req('http://localhost/api/workspace/team/program-sessions/ps-1/events'), ctx({ slug: 'team', sessionId: 'ps-1' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(2);
    expect(body.events[0].data.command).toBeUndefined();
    expect(body.events[1].data.command).toBeUndefined();
    expect(body.events[1].data.env).toBeUndefined();
  });
});