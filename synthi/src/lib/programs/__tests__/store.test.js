import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: {
    permissionGrant: { create: vi.fn(), findMany: vi.fn() },
    programSession: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    programRuntimeEvent: { create: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('@/lib/prisma', () => ({ default: h.prisma }));

import {
  appendProgramRuntimeEvent,
  createPermissionGrant,
  createProgramSession,
  listPermissionGrants,
  listProgramRuntimeEvents,
  listProgramSessions,
  updateProgramSession,
} from '../store';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createPermissionGrant', () => {
  it('stores scopes as JSON text and returns parsed scopes', async () => {
    const grantedAt = new Date('2026-06-03T12:00:00.000Z');
    h.prisma.permissionGrant.create.mockResolvedValue({
      id: 'pg1',
      workspaceSlug: 'team',
      scopesJson: '["filesystem.read","ports.expose"]',
      grantedByUserId: 'u1',
      grantedAt,
      createdAt: grantedAt,
    });

    const row = await createPermissionGrant({
      workspaceSlug: 'team',
      scopes: ['filesystem.read', 'ports.expose'],
      grantedByUserId: 'u1',
    });

    expect(h.prisma.permissionGrant.create).toHaveBeenCalledWith({
      data: {
        workspaceSlug: 'team',
        scopesJson: '["filesystem.read","ports.expose"]',
        grantedByUserId: 'u1',
      },
    });
    expect(row.scopes).toEqual(['filesystem.read', 'ports.expose']);
    expect(row.scopesJson).toBeUndefined();
  });
});

describe('listPermissionGrants', () => {
  it('lists grants for the workspace ordered by newest first with parsed scopes', async () => {
    h.prisma.permissionGrant.findMany.mockResolvedValue([
      { id: 'pg2', workspaceSlug: 'team', scopesJson: '["ports.expose"]', grantedByUserId: 'u2', grantedAt: new Date('2026-06-03T12:01:00.000Z'), createdAt: new Date('2026-06-03T12:01:00.000Z') },
    ]);

    const rows = await listPermissionGrants({ workspaceSlug: 'team' });

    expect(h.prisma.permissionGrant.findMany).toHaveBeenCalledWith({
      where: { workspaceSlug: 'team' },
      orderBy: { grantedAt: 'desc' },
    });
    expect(rows[0].scopes).toEqual(['ports.expose']);
  });
});

describe('createProgramSession', () => {
  it('creates a phase-1 session with a nullable installId and default starting state', async () => {
    const startedAt = new Date('2026-06-03T12:05:00.000Z');
    h.prisma.programSession.create.mockResolvedValue({
      id: 'ps1',
      installId: null,
      workspaceSlug: 'team',
      runtimeType: 'cli',
      state: 'starting',
      startedByUserId: 'u1',
      startedAt,
      endedAt: null,
      lastHealthState: null,
      lastHealthAt: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const row = await createProgramSession({ workspaceSlug: 'team', runtimeType: 'cli', startedByUserId: 'u1' });

    expect(h.prisma.programSession.create).toHaveBeenCalledWith({
      data: {
        installId: null,
        workspaceSlug: 'team',
        runtimeType: 'cli',
        state: 'starting',
        startedByUserId: 'u1',
      },
    });
    expect(row).toMatchObject({ id: 'ps1', installId: null, runtimeType: 'cli', state: 'starting' });
  });
});

describe('updateProgramSession', () => {
  it('updates session lifecycle and health fields', async () => {
    const lastHealthAt = new Date('2026-06-03T12:10:00.000Z');
    h.prisma.programSession.update.mockResolvedValue({
      id: 'ps1',
      installId: null,
      workspaceSlug: 'team',
      runtimeType: 'cli',
      state: 'running',
      startedByUserId: 'u1',
      startedAt: new Date('2026-06-03T12:05:00.000Z'),
      endedAt: null,
      lastHealthState: 'ok',
      lastHealthAt,
      createdAt: new Date('2026-06-03T12:05:00.000Z'),
      updatedAt: lastHealthAt,
    });

    const row = await updateProgramSession('ps1', { state: 'running', lastHealthState: 'ok', lastHealthAt });

    expect(h.prisma.programSession.update).toHaveBeenCalledWith({
      where: { id: 'ps1' },
      data: { state: 'running', lastHealthState: 'ok', lastHealthAt },
    });
    expect(row).toMatchObject({ id: 'ps1', state: 'running', lastHealthState: 'ok' });
  });
});

describe('listProgramSessions', () => {
  it('lists recent sessions for a workspace with optional state filtering', async () => {
    h.prisma.programSession.findMany.mockResolvedValue([
      { id: 'ps1', installId: null, workspaceSlug: 'team', runtimeType: 'cli', state: 'running', startedByUserId: 'u1', startedAt: new Date('2026-06-03T12:05:00.000Z'), endedAt: null, lastHealthState: 'ok', lastHealthAt: null, createdAt: new Date('2026-06-03T12:05:00.000Z'), updatedAt: new Date('2026-06-03T12:05:00.000Z') },
    ]);

    const rows = await listProgramSessions('team', { stateIn: ['running'], limit: 10 });

    expect(h.prisma.programSession.findMany).toHaveBeenCalledWith({
      where: { workspaceSlug: 'team', state: { in: ['running'] } },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
    expect(rows).toHaveLength(1);
  });
});

describe('appendProgramRuntimeEvent', () => {
  it('stores redacted event payloads as JSON text and returns parsed data', async () => {
    const createdAt = new Date('2026-06-03T12:15:00.000Z');
    h.prisma.programRuntimeEvent.create.mockResolvedValue({
      id: 'ev1',
      sessionId: 'ps1',
      type: 'running',
      dataJson: '{"surface":"terminal","truncated":true}',
      createdAt,
    });

    const row = await appendProgramRuntimeEvent({
      sessionId: 'ps1',
      type: 'running',
      data: { surface: 'terminal', truncated: true },
    });

    expect(h.prisma.programRuntimeEvent.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'ps1',
        type: 'running',
        dataJson: '{"surface":"terminal","truncated":true}',
      },
    });
    expect(row.data).toEqual({ surface: 'terminal', truncated: true });
    expect(row.dataJson).toBeUndefined();
  });
});

describe('listProgramRuntimeEvents', () => {
  it('lists session events chronologically and parses redacted payload JSON', async () => {
    h.prisma.programRuntimeEvent.findMany.mockResolvedValue([
      { id: 'ev1', sessionId: 'ps1', type: 'starting', dataJson: '{"surface":"terminal"}', createdAt: new Date('2026-06-03T12:15:00.000Z') },
      { id: 'ev2', sessionId: 'ps1', type: 'running', dataJson: '{"surface":"app","port":3000}', createdAt: new Date('2026-06-03T12:16:00.000Z') },
    ]);

    const rows = await listProgramRuntimeEvents('ps1');

    expect(h.prisma.programRuntimeEvent.findMany).toHaveBeenCalledWith({
      where: { sessionId: 'ps1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.data)).toEqual([
      { surface: 'terminal' },
      { surface: 'app', port: 3000 },
    ]);
  });

  it('falls back to null when stored event JSON is malformed', async () => {
    h.prisma.programRuntimeEvent.findMany.mockResolvedValue([
      { id: 'ev-bad', sessionId: 'ps1', type: 'crashed', dataJson: '{bad-json', createdAt: new Date('2026-06-03T12:17:00.000Z') },
    ]);

    const rows = await listProgramRuntimeEvents('ps1');

    expect(rows[0].data).toBeNull();
  });
});