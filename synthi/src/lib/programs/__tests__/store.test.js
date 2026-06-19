import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: {
    permissionGrant: { create: vi.fn(), findMany: vi.fn() },
    programSession: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    programRuntimeEvent: { create: vi.fn(), findMany: vi.fn() },
    marketplaceProgram: { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    programVersion: { upsert: vi.fn(), findUnique: vi.fn() },
    programInstall: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('@/lib/prisma', () => ({ default: h.prisma }));

import {
  appendProgramRuntimeEvent,
  createInstall,
  createPermissionGrant,
  createProgramSession,
  getInstall,
  getProgramVersion,
  getPublishedProgramVersion,
  incrementInstallCount,
  listInstalls,
  listLocalPrograms,
  listPermissionGrants,
  listProgramRuntimeEvents,
  listProgramSessions,
  listPublishedPrograms,
  publishProgram,
  toPublicInstall,
  toPublicMarketplaceProgram,
  updateInstallStatus,
  updateProgramSession,
  upsertLocalProgram,
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

describe('upsertLocalProgram', () => {
  it('namespaces the packageId per workspace and upserts program + version with the manifest', async () => {
    const config = {
      packageId: 'my-dev-server',
      version: '1.2.0',
      displayName: 'My Dev Server',
      runtimeType: 'web',
      workingDir: '',
      install: ['npm ci'],
      launch: 'npm run dev',
      env: {},
      ports: [3000],
      surfaces: [],
      health: null,
      permissions: ['program.launch'],
      source: 'vectant.programs.json',
      sourceHints: {},
    };
    h.prisma.marketplaceProgram.upsert.mockResolvedValue({
      id: 'prog1',
      packageId: 'local:team:my-dev-server',
      publisher: 'local',
      verified: false,
      latestVersion: '1.2.0',
    });
    h.prisma.programVersion.upsert.mockResolvedValue({ id: 'ver1', programId: 'prog1', version: '1.2.0' });

    const { program, version } = await upsertLocalProgram({ workspaceSlug: 'team', config });

    expect(h.prisma.marketplaceProgram.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { packageId: 'local:team:my-dev-server' },
        create: expect.objectContaining({ packageId: 'local:team:my-dev-server', publisher: 'local', verified: false, latestVersion: '1.2.0' }),
        update: expect.objectContaining({ latestVersion: '1.2.0' }),
      }),
    );
    expect(h.prisma.programVersion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { programId_version: { programId: 'prog1', version: '1.2.0' } },
        create: expect.objectContaining({ programId: 'prog1', version: '1.2.0', ports: ['3000'] }),
      }),
    );
    expect(program.id).toBe('prog1');
    expect(version.id).toBe('ver1');
    const upsertArg = h.prisma.programVersion.upsert.mock.calls[0][0];
    expect(JSON.parse(upsertArg.create.manifestJson).launch).toBe('npm run dev');
  });
});

describe('createInstall / updateInstallStatus', () => {
  it('creates an install in the installing state', async () => {
    h.prisma.programInstall.create.mockResolvedValue({
      id: 'inst1', programId: 'prog1', workspaceSlug: 'team', version: '1.2.0', status: 'installing', installedByUserId: 'u1', grantId: 'pg1',
    });

    const row = await createInstall({ programId: 'prog1', workspaceSlug: 'team', version: '1.2.0', installedByUserId: 'u1', grantId: 'pg1' });

    expect(h.prisma.programInstall.create).toHaveBeenCalledWith({
      data: { programId: 'prog1', workspaceSlug: 'team', version: '1.2.0', installedByUserId: 'u1', grantId: 'pg1', status: 'installing' },
    });
    expect(row.id).toBe('inst1');
  });

  it('updates install status', async () => {
    h.prisma.programInstall.update.mockResolvedValue({ id: 'inst1', status: 'installed' });

    const row = await updateInstallStatus('inst1', 'installed');

    expect(h.prisma.programInstall.update).toHaveBeenCalledWith({ where: { id: 'inst1' }, data: { status: 'installed' } });
    expect(row.status).toBe('installed');
  });
});

describe('getInstall / listInstalls', () => {
  it('gets an install with the program joined', async () => {
    h.prisma.programInstall.findUnique.mockResolvedValue({ id: 'inst1', program: { id: 'prog1', packageId: 'local:team:x', publisher: 'local' } });

    const row = await getInstall('inst1');

    expect(h.prisma.programInstall.findUnique).toHaveBeenCalledWith({ where: { id: 'inst1' }, include: { program: true } });
    expect(row.id).toBe('inst1');
  });

  it('lists workspace-local programs by namespaced packageId prefix', async () => {
    h.prisma.marketplaceProgram.findMany.mockResolvedValue([
      { id: 'prog1', packageId: 'local:team:web', publisher: 'local', verified: false, latestVersion: '1.0.0' },
    ]);

    const rows = await listLocalPrograms('team');

    expect(h.prisma.marketplaceProgram.findMany).toHaveBeenCalledWith({
      where: { packageId: { startsWith: 'local:team:' } },
      orderBy: { updatedAt: 'desc' },
    });
    expect(rows).toHaveLength(1);
  });

  it('fetches a program version by compound key', async () => {
    h.prisma.programVersion.findUnique.mockResolvedValue({ id: 'ver1', programId: 'prog1', version: '1.0.0', manifestJson: '{"launch":"npm run dev"}' });

    const row = await getProgramVersion('prog1', '1.0.0');

    expect(h.prisma.programVersion.findUnique).toHaveBeenCalledWith({
      where: { programId_version: { programId: 'prog1', version: '1.0.0' } },
    });
    expect(JSON.parse(row.manifestJson).launch).toBe('npm run dev');
  });

  it('lists workspace installs newest-first with the program joined', async () => {
    h.prisma.programInstall.findMany.mockResolvedValue([
      { id: 'inst1', programId: 'prog1', workspaceSlug: 'team', version: '1.2.0', status: 'installed', installedByUserId: 'u1', grantId: null, createdAt: new Date(), updatedAt: new Date(), program: { id: 'prog1', packageId: 'local:team:my-dev-server', publisher: 'local' } },
    ]);

    const rows = await listInstalls('team');

    expect(h.prisma.programInstall.findMany).toHaveBeenCalledWith({
      where: { workspaceSlug: 'team' },
      orderBy: { createdAt: 'desc' },
      include: { program: true },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('toPublicInstall', () => {
  it('returns only public install metadata and never raw manifest/env', () => {
    const pub = toPublicInstall({
      id: 'inst1',
      programId: 'prog1',
      workspaceSlug: 'team',
      version: '1.2.0',
      status: 'installed',
      installedByUserId: 'u1',
      grantId: 'pg1',
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
      updatedAt: new Date('2026-06-06T00:00:00.000Z'),
      program: { id: 'prog1', packageId: 'local:team:my-dev-server', publisher: 'local', versions: [{ manifestJson: '{"env":{"SECRET":"x"}}' }] },
    });

    expect(pub.packageId).toBe('local:team:my-dev-server');
    expect(pub.publisher).toBe('local');
    expect(pub.status).toBe('installed');
    expect(pub.version).toBe('1.2.0');
    expect(pub).not.toHaveProperty('program');
    expect(pub).not.toHaveProperty('manifestJson');
    expect(pub).not.toHaveProperty('env');
    expect(JSON.stringify(pub)).not.toContain('SECRET');
  });
});

describe('publishProgram', () => {
  it('publishes under the @slug/<name> namespace with publisher = slug', async () => {
    h.prisma.marketplaceProgram.upsert.mockResolvedValue({ id: 'prog1', packageId: '@team/web', publisher: 'team' });
    h.prisma.programVersion.upsert.mockResolvedValue({ id: 'ver1' });
    const config = { packageId: 'web', version: '1.2.0', displayName: 'Web', description: 'A dev server', launch: 'npm run dev', ports: [3000] };

    const { program } = await publishProgram({ workspaceSlug: 'team', config, publishedByUserId: 'u1' });

    expect(program.packageId).toBe('@team/web');
    const upsertArg = h.prisma.marketplaceProgram.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ packageId: '@team/web' });
    expect(upsertArg.create).toMatchObject({ packageId: '@team/web', publisher: 'team', publishedByUserId: 'u1', displayName: 'Web', description: 'A dev server', latestVersion: '1.2.0' });
    const verArg = h.prisma.programVersion.upsert.mock.calls[0][0];
    expect(verArg.where).toEqual({ programId_version: { programId: 'prog1', version: '1.2.0' } });
  });
});

describe('toPublicMarketplaceProgram', () => {
  it('allow-lists display/reputation fields and never leaks versions/manifest', () => {
    const pub = toPublicMarketplaceProgram({
      id: 'p1', packageId: '@team/web', publisher: 'team', verified: true, latestVersion: '1.0.0',
      displayName: 'Web', description: 'd', installCount: 7,
      versions: [{ manifestJson: 'SECRET' }], publishedByUserId: 'u1',
    });
    expect(pub).toEqual({ id: 'p1', packageId: '@team/web', publisher: 'team', verified: true, latestVersion: '1.0.0', displayName: 'Web', description: 'd', installCount: 7 });
    expect(pub.versions).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain('SECRET');
  });
});

describe('listPublishedPrograms', () => {
  it('returns published programs (publisher != local) filtered by query, ordered by installCount', async () => {
    h.prisma.marketplaceProgram.findMany.mockResolvedValue([
      { id: 'p1', packageId: '@team/web', publisher: 'team', verified: false, latestVersion: '1.0.0', displayName: 'Web', description: null, installCount: 5 },
    ]);

    const list = await listPublishedPrograms({ q: 'web', limit: 10 });

    const arg = h.prisma.marketplaceProgram.findMany.mock.calls[0][0];
    expect(arg.where.publisher).toEqual({ not: 'local' });
    expect(arg.where.OR).toEqual([
      { packageId: { contains: 'web', mode: 'insensitive' } },
      { displayName: { contains: 'web', mode: 'insensitive' } },
      { publisher: { contains: 'web', mode: 'insensitive' } },
    ]);
    expect(arg.orderBy).toEqual({ installCount: 'desc' });
    expect(arg.take).toBe(10);
    expect(list[0]).toEqual({ id: 'p1', packageId: '@team/web', publisher: 'team', verified: false, latestVersion: '1.0.0', displayName: 'Web', description: null, installCount: 5 });
  });

  it('omits the OR clause when no query is given', async () => {
    h.prisma.marketplaceProgram.findMany.mockResolvedValue([]);
    await listPublishedPrograms({});
    const arg = h.prisma.marketplaceProgram.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ publisher: { not: 'local' } });
  });
});

describe('getPublishedProgramVersion', () => {
  it('resolves a published program + version + parsed config', async () => {
    h.prisma.marketplaceProgram.findUnique.mockResolvedValue({ id: 'p1', packageId: '@team/web', publisher: 'team' });
    h.prisma.programVersion.findUnique.mockResolvedValue({ id: 'v1', manifestJson: JSON.stringify({ packageId: 'web', version: '1.0.0', launch: 'npm run dev', permissions: ['program.launch'] }) });

    const found = await getPublishedProgramVersion('@team/web', '1.0.0');

    expect(found.program.id).toBe('p1');
    expect(found.config.launch).toBe('npm run dev');
    expect(h.prisma.programVersion.findUnique).toHaveBeenCalledWith({ where: { programId_version: { programId: 'p1', version: '1.0.0' } } });
  });

  it('returns null for a local (non-published) packageId', async () => {
    h.prisma.marketplaceProgram.findUnique.mockResolvedValue({ id: 'p1', packageId: 'local:team:web', publisher: 'local' });
    const found = await getPublishedProgramVersion('local:team:web', '1.0.0');
    expect(found).toBeNull();
  });
});

describe('incrementInstallCount', () => {
  it('atomically increments the program installCount', async () => {
    h.prisma.marketplaceProgram.update.mockResolvedValue({ id: 'p1', installCount: 6 });
    await incrementInstallCount('p1');
    expect(h.prisma.marketplaceProgram.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { installCount: { increment: 1 } } });
  });
});