import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: {
    permissionGrant: { create: vi.fn(), findMany: vi.fn() },
    programSession: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    programRuntimeEvent: { create: vi.fn(), findMany: vi.fn() },
    marketplaceProgram: { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    programVersion: { upsert: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    programInstall: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    programReviewEvent: { create: vi.fn() },
    programPricing: { findMany: vi.fn() },
    entitlement: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/prisma', () => ({ default: h.prisma }));

import {
  appendProgramRuntimeEvent,
  createInstall,
  createPermissionGrant,
  createProgramSession,
  createSubmission,
  getInstall,
  getProgramVersion,
  getPublishedProgramVersion,
  getReviewVersionById,
  incrementInstallCount,
  listInstalls,
  listLocalPrograms,
  listPendingReview,
  listPermissionGrants,
  listProcessableSubmissions,
  listProgramRuntimeEvents,
  listProgramSessions,
  listPublishedPrograms,
  publishApprovedVersion,
  publishProgram,
  toPublicInstall,
  toPublicMarketplaceProgram,
  toReviewQueueItem,
  transitionReview,
  unpublishProgram,
  updateInstallStatus,
  updateProgramSession,
  upsertLocalProgram,
  listPricingForPrograms,
  listActiveEntitlementProgramIds,
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
        codeSiteProjectId: null,
        codeSiteTransactionId: null,
        codeSiteMutationLeaseId: null,
        codeSiteAgentSessionId: null,
        codeSiteEvidenceRefsJson: '[]',
      },
    });
    expect(row.data).toEqual({ surface: 'terminal', truncated: true });
    expect(row.codeSiteEvidenceRefs).toEqual([]);
    expect(row.dataJson).toBeUndefined();
  });

  it('stores CodeSite refs on runtime events for transaction-aware launches', async () => {
    const createdAt = new Date('2026-06-03T12:16:00.000Z');
    h.prisma.programRuntimeEvent.create.mockResolvedValue({
      id: 'ev-codesite',
      sessionId: 'ps1',
      type: 'exec',
      dataJson: '{"command":"npm test"}',
      codeSiteProjectId: 'project-1',
      codeSiteTransactionId: 'txn-1',
      codeSiteMutationLeaseId: 'lease-1',
      codeSiteAgentSessionId: 'agent-1',
      codeSiteEvidenceRefsJson: '["runtime:event:exec-1"]',
      createdAt,
    });

    const row = await appendProgramRuntimeEvent({
      sessionId: 'ps1',
      type: 'exec',
      data: { command: 'npm test' },
      codeSiteContext: {
        projectId: 'project-1',
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        evidenceRefs: ['runtime:event:exec-1', 'runtime:event:exec-1'],
      },
    });

    expect(h.prisma.programRuntimeEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        codeSiteProjectId: 'project-1',
        codeSiteTransactionId: 'txn-1',
        codeSiteMutationLeaseId: 'lease-1',
        codeSiteAgentSessionId: 'agent-1',
        codeSiteEvidenceRefsJson: JSON.stringify(['runtime:event:exec-1']),
      }),
    });
    expect(row).toMatchObject({
      codeSiteProjectId: 'project-1',
      codeSiteTransactionId: 'txn-1',
      codeSiteMutationLeaseId: 'lease-1',
      codeSiteAgentSessionId: 'agent-1',
      codeSiteEvidenceRefs: ['runtime:event:exec-1'],
    });
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
    expect(arg.where).toEqual({ publisher: { not: 'local' }, publishedVersion: { not: null } });
  });
});

describe('getPublishedProgramVersion', () => {
  it('resolves a published program + version + parsed config', async () => {
    h.prisma.marketplaceProgram.findUnique.mockResolvedValue({ id: 'p1', packageId: '@team/web', publisher: 'team', publishedVersion: '1.0.0' });
    h.prisma.programVersion.findUnique.mockResolvedValue({ id: 'v1', reviewState: 'published', manifestJson: JSON.stringify({ packageId: 'web', version: '1.0.0', launch: 'npm run dev', permissions: ['program.launch'] }) });

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

describe('createSubmission', () => {
  it('creates a submitted version with the source ref and submitter, bumping latestVersion', async () => {
    h.prisma.marketplaceProgram.upsert.mockResolvedValue({ id: 'prog1', packageId: '@team/tool', publisher: 'team' });
    h.prisma.programVersion.create.mockResolvedValue({ id: 'ver1', reviewState: 'submitted' });
    h.prisma.programReviewEvent.create.mockResolvedValue({ id: 'ev1' });
    const config = { packageId: 'tool', version: '1.0.0', displayName: 'Tool', description: 'd', runtimeType: 'container', launch: 'docker run reg.io/me/tool:1', ports: [6901] };

    const { program, version } = await createSubmission({
      workspaceSlug: 'team', config, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1',
    });

    expect(program.id).toBe('prog1');
    expect(version.id).toBe('ver1');
    const verArg = h.prisma.programVersion.create.mock.calls[0][0];
    expect(verArg.data).toMatchObject({ programId: 'prog1', version: '1.0.0', reviewState: 'submitted', sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' });
    // audit: null -> submitted
    expect(h.prisma.programReviewEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ versionId: 'ver1', fromState: null, toState: 'submitted', actorUserId: 'u1' }),
    }));
  });
});

describe('transitionReview', () => {
  it('guards on fromState, patches the version, and writes an audit event', async () => {
    h.prisma.programVersion.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.programReviewEvent.create.mockResolvedValue({ id: 'ev2' });

    const ok = await transitionReview('ver1', { fromState: 'submitted', toState: 'scanning', actorUserId: 'u1' });

    expect(ok).toBe(true);
    expect(h.prisma.programVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ver1', reviewState: 'submitted' },
      data: expect.objectContaining({ reviewState: 'scanning' }),
    }));
    expect(h.prisma.programReviewEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ versionId: 'ver1', fromState: 'submitted', toState: 'scanning' }),
    }));
  });

  it('is a no-op (returns false, no audit) when the guard does not match', async () => {
    h.prisma.programVersion.updateMany.mockResolvedValue({ count: 0 });
    const ok = await transitionReview('ver1', { fromState: 'submitted', toState: 'scanning' });
    expect(ok).toBe(false);
    expect(h.prisma.programReviewEvent.create).not.toHaveBeenCalled();
  });

  it('stores a redacted scan summary + notes via the patch', async () => {
    h.prisma.programVersion.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.programReviewEvent.create.mockResolvedValue({ id: 'ev3' });
    await transitionReview('ver1', {
      fromState: 'scanning', toState: 'rejected', actorUserId: null,
      reason: [{ code: 'cve', message: 'CVE-9' }],
      patch: { scanReportJson: JSON.stringify({ decisiveCves: ['CVE-9'] }) },
    });
    const arg = h.prisma.programVersion.updateMany.mock.calls[0][0];
    expect(arg.data.scanReportJson).toContain('CVE-9');
    expect(arg.data.reviewState).toBe('rejected');
  });
});

describe('publishApprovedVersion', () => {
  it('flips the version to published with the AR digest and points the program at it', async () => {
    h.prisma.programVersion.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.programReviewEvent.create.mockResolvedValue({ id: 'ev4' });
    h.prisma.marketplaceProgram.update.mockResolvedValue({ id: 'prog1', publishedVersion: '1.0.0' });

    await publishApprovedVersion('ver1', {
      programId: 'prog1', version: '1.0.0', actorUserId: 'admin1',
      hostedImageDigest: 'sha256:dead', publishedManifestJson: '{"launch":"docker run ar.host/x@sha256:dead"}',
    });

    const verArg = h.prisma.programVersion.updateMany.mock.calls[0][0];
    expect(verArg.where).toEqual({ id: 'ver1', reviewState: 'rehosting' });
    expect(verArg.data).toMatchObject({ reviewState: 'published', hostedImageDigest: 'sha256:dead' });
    expect(h.prisma.marketplaceProgram.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'prog1' },
      data: expect.objectContaining({ publishedVersion: '1.0.0', publishedDigest: 'sha256:dead' }),
    }));
  });
});

describe('listPendingReview / toReviewQueueItem', () => {
  it('lists pending_review versions joined with their program', async () => {
    h.prisma.programVersion.findMany.mockResolvedValue([
      { id: 'ver1', version: '1.0.0', reviewState: 'pending_review', submittedByUserId: 'u1', sourceImageRef: 'reg.io/me/tool:1', scanReportJson: '{"decisiveCves":[]}', program: { packageId: '@team/tool', publisher: 'team' } },
    ]);
    const rows = await listPendingReview();
    expect(h.prisma.programVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { reviewState: 'pending_review' },
      include: { program: true },
    }));
    expect(rows[0]).toMatchObject({ id: 'ver1', reviewState: 'pending_review' });
  });

  it('toReviewQueueItem allow-lists fields and never leaks raw manifest/secrets', () => {
    const item = toReviewQueueItem({
      id: 'ver1', version: '1.0.0', reviewState: 'pending_review', submittedByUserId: 'u1',
      sourceImageRef: 'reg.io/me/tool:1', manifestJson: '{"env":{"SECRET":"x"}}',
      scanReportJson: '{"decisiveCves":[],"severityCounts":{"HIGH":0}}',
      program: { packageId: '@team/tool', publisher: 'team', displayName: 'Tool' },
    });
    expect(item).toMatchObject({ versionId: 'ver1', packageId: '@team/tool', reviewState: 'pending_review' });
    expect(item.scanSummary).toMatchObject({ decisiveCves: [] });
    expect(JSON.stringify(item)).not.toContain('SECRET');
    expect(item).not.toHaveProperty('manifestJson');
  });

  it('includes a redacted aiSummary (riskScore + flags) and never raw provider text', () => {
    const item = toReviewQueueItem({
      id: 'ver1', version: '1.0.0', reviewState: 'ai_review', submittedByUserId: 'u1',
      scanReportJson: '{"decisiveCves":[]}',
      aiRiskJson: '{"riskScore":0.1,"flags":["x"],"rationale":"SENSITIVE-MODEL-TEXT"}',
      program: { packageId: '@team/tool', publisher: 'team' },
    });
    expect(item.aiSummary).toMatchObject({ riskScore: 0.1, flags: ['x'] });
    expect(JSON.stringify(item)).not.toContain('SENSITIVE-MODEL-TEXT'); // rationale not exposed
  });

  it('aiSummary is null when there is no aiRiskJson', () => {
    const item = toReviewQueueItem({ id: 'ver1', reviewState: 'pending_review', program: { packageId: '@team/tool' } });
    expect(item.aiSummary).toBeNull();
  });
});

describe('getReviewVersionById', () => {
  it('fetches a version with its program joined', async () => {
    h.prisma.programVersion.findUnique.mockResolvedValue({ id: 'ver1', reviewState: 'pending_review', program: { id: 'prog1' } });
    const row = await getReviewVersionById('ver1');
    expect(h.prisma.programVersion.findUnique).toHaveBeenCalledWith({ where: { id: 'ver1' }, include: { program: true } });
    expect(row.id).toBe('ver1');
  });
});

describe('listPublishedPrograms (gated on live version)', () => {
  it('only lists programs that have a publishedVersion', async () => {
    h.prisma.marketplaceProgram.findMany.mockResolvedValue([]);
    await listPublishedPrograms({ q: 'web' });
    const arg = h.prisma.marketplaceProgram.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ publisher: { not: 'local' }, publishedVersion: { not: null } });
  });
});

describe('getPublishedProgramVersion (only serves published)', () => {
  it('returns null when the requested version is not in published state', async () => {
    h.prisma.marketplaceProgram.findUnique.mockResolvedValue({ id: 'p1', packageId: '@team/tool', publisher: 'team' });
    h.prisma.programVersion.findUnique.mockResolvedValue({ id: 'v1', reviewState: 'pending_review', manifestJson: '{"launch":"x"}' });
    const found = await getPublishedProgramVersion('@team/tool', '1.0.0');
    expect(found).toBeNull();
  });

  it('returns null when the requested version is not the live publishedVersion', async () => {
    h.prisma.marketplaceProgram.findUnique.mockResolvedValue({ id: 'p1', packageId: '@team/tool', publisher: 'team', publishedVersion: '2.0.0' });
    h.prisma.programVersion.findUnique.mockResolvedValue({ id: 'v1', reviewState: 'published', manifestJson: '{"launch":"x"}' });
    const found = await getPublishedProgramVersion('@team/tool', '1.0.0');
    expect(found).toBeNull();
  });
});

describe('unpublishProgram', () => {
  it('clears the live pointers (drops from marketplace)', async () => {
    h.prisma.marketplaceProgram.update.mockResolvedValue({ id: 'p1', publishedVersion: null });
    await unpublishProgram('@team/tool');
    expect(h.prisma.marketplaceProgram.update).toHaveBeenCalledWith({ where: { packageId: '@team/tool' }, data: { publishedVersion: null, publishedDigest: null } });
  });
});

describe('listProcessableSubmissions', () => {
  it('lists non-terminal submissions for the sweep, bounded + oldest-first', async () => {
    h.prisma.programVersion.findMany.mockResolvedValue([{ id: 'ver1', reviewState: 'submitted' }]);
    const rows = await listProcessableSubmissions(50);
    expect(h.prisma.programVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { reviewState: { in: ['submitted', 'scanning', 'ai_review'] } },
      orderBy: { submittedAt: 'asc' },
      take: 50,
    }));
    expect(rows[0].id).toBe('ver1');
  });
});

describe('listPricingForPrograms', () => {
  it('batches pricing by program ids', async () => {
    h.prisma.programPricing.findMany.mockResolvedValue([{ programId: 'p1', priceCents: 500 }]);
    const rows = await listPricingForPrograms(['p1', 'p2']);
    expect(rows).toHaveLength(1);
    expect(h.prisma.programPricing.findMany).toHaveBeenCalledWith({ where: { programId: { in: ['p1', 'p2'] } } });
  });
  it('short-circuits on an empty id list', async () => {
    expect(await listPricingForPrograms([])).toEqual([]);
    expect(h.prisma.programPricing.findMany).not.toHaveBeenCalled();
  });
});

describe('listActiveEntitlementProgramIds', () => {
  it('returns only active-entitled program ids for the subject', async () => {
    h.prisma.entitlement.findMany.mockResolvedValue([{ programId: 'p1' }]);
    const ids = await listActiveEntitlementProgramIds({ subjectId: 'u1', programIds: ['p1', 'p2'] });
    expect(ids).toEqual(['p1']);
    expect(h.prisma.entitlement.findMany).toHaveBeenCalledWith({
      where: { subjectType: 'user', subjectId: 'u1', status: 'active', programId: { in: ['p1', 'p2'] } },
      select: { programId: true },
    });
  });
  it('short-circuits without a subject or ids', async () => {
    expect(await listActiveEntitlementProgramIds({ subjectId: '', programIds: ['p1'] })).toEqual([]);
    expect(await listActiveEntitlementProgramIds({ subjectId: 'u1', programIds: [] })).toEqual([]);
  });
});
