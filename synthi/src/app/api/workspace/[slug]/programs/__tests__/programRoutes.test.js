import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  canRead: vi.fn(),
  canWrite: vi.fn(),
  listLocalPrograms: vi.fn(),
  listInstalls: vi.fn(),
  listPermissionGrants: vi.fn(),
  createPermissionGrant: vi.fn(),
  upsertLocalProgram: vi.fn(),
  createInstall: vi.fn(),
  getInstall: vi.fn(),
  getProgramVersion: vi.fn(),
  publishProgram: vi.fn(),
  listPublishedPrograms: vi.fn(),
  getPublishedProgramVersion: vi.fn(),
  incrementInstallCount: vi.fn(),
  createProgramSession: vi.fn(),
  updateProgramSession: vi.fn(),
  appendProgramRuntimeEvent: vi.fn(),
  discoverManifest: vi.fn(),
  launchInstalledProgram: vi.fn(),
  scaffoldProgram: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead, canWriteScope: h.canWrite }));
vi.mock('@/lib/programs/store', () => ({
  listLocalPrograms: h.listLocalPrograms,
  listInstalls: h.listInstalls,
  listPermissionGrants: h.listPermissionGrants,
  createPermissionGrant: h.createPermissionGrant,
  upsertLocalProgram: h.upsertLocalProgram,
  createInstall: h.createInstall,
  getInstall: h.getInstall,
  getProgramVersion: h.getProgramVersion,
  createProgramSession: h.createProgramSession,
  updateProgramSession: h.updateProgramSession,
  appendProgramRuntimeEvent: h.appendProgramRuntimeEvent,
  publishProgram: h.publishProgram,
  listPublishedPrograms: h.listPublishedPrograms,
  getPublishedProgramVersion: h.getPublishedProgramVersion,
  incrementInstallCount: h.incrementInstallCount,
  // Real-ish projection so the install route can return a public install.
  toPublicInstall: (row) =>
    row
      ? { id: row.id, version: row.version, status: row.status, packageId: row.program?.packageId ?? null, publisher: row.program?.publisher ?? null }
      : row,
  // Pass-through projection for published programs in route tests.
  toPublicMarketplaceProgram: (row) => row,
}));
vi.mock('@/lib/programs/runtimeClient', () => ({
  discoverManifest: h.discoverManifest,
  launchInstalledProgram: h.launchInstalledProgram,
  scaffoldProgram: h.scaffoldProgram,
}));

import { GET as GET_MARKETPLACE } from '../marketplace/route.js';
import { GET as GET_INSTALLED } from '../installed/route.js';
import { POST as POST_INSTALL } from '../install/route.js';
import { POST as POST_LAUNCH } from '../[installId]/launch/route.js';
import { POST as POST_PUBLISH } from '../publish/route.js';
import { POST as POST_SCAFFOLD } from '../scaffold/route.js';

const req = (url, body, method = 'GET') => ({ url, method, json: async () => body });
const ctx = (params) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c', workspaceUserId: 'gh1' });
  h.canRead.mockResolvedValue(true);
  h.canWrite.mockResolvedValue(true);
  h.listPermissionGrants.mockResolvedValue([]);
  h.appendProgramRuntimeEvent.mockResolvedValue({ id: 'evt-1' });
});

describe('GET /programs/marketplace', () => {
  it('returns the published catalog (search) for a member', async () => {
    h.listPublishedPrograms.mockResolvedValue([
      { id: 'p1', packageId: '@team/web', publisher: 'team', verified: false, latestVersion: '1.0.0', displayName: 'Web', description: null, installCount: 3 },
    ]);

    const res = await GET_MARKETPLACE(req('http://x/api/workspace/team/programs/marketplace?q=web'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.listPublishedPrograms).toHaveBeenCalledWith({ q: 'web' });
    const body = await res.json();
    expect(body.programs[0]).toMatchObject({ packageId: '@team/web', publisher: 'team', installCount: 3 });
  });

  it('rejects a non-member', async () => {
    h.canRead.mockResolvedValue(false);
    const res = await GET_MARKETPLACE(req('http://x/api/workspace/team/programs/marketplace'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.listPublishedPrograms).not.toHaveBeenCalled();
  });
});

describe('POST /programs/publish', () => {
  it('publishes the workspace manifest for an owner/admin', async () => {
    h.discoverManifest.mockResolvedValue({ config: { packageId: 'web', version: '1.0.0', displayName: 'Web', description: 'd', permissions: ['program.launch'] }, source: 'vectant.programs.json' });
    h.publishProgram.mockResolvedValue({ program: { id: 'p1', packageId: '@team/web', publisher: 'team', verified: false, latestVersion: '1.0.0', displayName: 'Web', description: 'd', installCount: 0 } });

    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.publishProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', publishedByUserId: 'u1' }));
    const body = await res.json();
    expect(body.program).toMatchObject({ packageId: '@team/web', publisher: 'team' });
  });

  it('rejects publish for a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.publishProgram).not.toHaveBeenCalled();
  });

  it('returns 404 when there is no workspace manifest to publish', async () => {
    h.discoverManifest.mockResolvedValue(null);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
  });
});

describe('GET /programs/installed', () => {
  it('lists installs (public projection) for a member', async () => {
    h.listInstalls.mockResolvedValue([
      { id: 'inst1', version: '1.0.0', status: 'installed', program: { packageId: 'local:team:web', publisher: 'local' } },
    ]);

    const res = await GET_INSTALLED(req('http://x/api/workspace/team/programs/installed'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installs[0]).toMatchObject({ id: 'inst1', packageId: 'local:team:web', status: 'installed' });
  });
});

describe('POST /programs/install', () => {
  const manifest = {
    config: {
      packageId: 'web', version: '1.0.0', displayName: 'Web', runtimeType: 'web',
      workingDir: '', install: ['npm ci'], launch: 'npm run dev', env: {}, ports: [3000],
      surfaces: [], health: null, permissions: ['program.launch', 'network.outbound'],
      source: 'vectant.programs.json', sourceHints: {},
    },
    source: 'vectant.programs.json',
  };

  it('installs for an owner/admin once consent covers the manifest scopes', async () => {
    h.discoverManifest.mockResolvedValue(manifest);
    h.createPermissionGrant.mockResolvedValue({ id: 'g1', scopes: ['program.launch', 'network.outbound'] });
    h.upsertLocalProgram.mockResolvedValue({ program: { id: 'prog1', packageId: 'local:team:web', publisher: 'local' }, version: { id: 'ver1' } });
    h.createInstall.mockResolvedValue({ id: 'inst1', version: '1.0.0', status: 'installed' });

    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { grantScopes: ['program.launch', 'network.outbound'] }, 'POST'),
      ctx({ slug: 'team' }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.install).toMatchObject({ id: 'inst1', packageId: 'local:team:web' });
    expect(body.grant).toMatchObject({ id: 'g1' });
    expect(h.createInstall).toHaveBeenCalledWith(expect.objectContaining({ programId: 'prog1', version: '1.0.0', grantId: 'g1', status: 'installed' }));
    // Per-user repos require the actor's workspaceUserId to resolve the workspace cwd.
    expect(h.discoverManifest).toHaveBeenCalledWith('team', 'gh1');
  });

  it('reuses an existing grant that already covers the manifest scopes', async () => {
    h.discoverManifest.mockResolvedValue(manifest);
    h.listPermissionGrants.mockResolvedValue([{ id: 'g0', scopes: ['program.launch', 'network.outbound'] }]);
    h.upsertLocalProgram.mockResolvedValue({ program: { id: 'prog1', packageId: 'local:team:web', publisher: 'local' } });
    h.createInstall.mockResolvedValue({ id: 'inst1', version: '1.0.0', status: 'installed' });

    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.createPermissionGrant).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.grant).toMatchObject({ id: 'g0' });
  });

  it('requires consent (409) listing the manifest scopes when none granted', async () => {
    h.discoverManifest.mockResolvedValue(manifest);

    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('consent_required');
    expect(body.requested).toEqual(['program.launch', 'network.outbound']);
    expect(h.createInstall).not.toHaveBeenCalled();
  });

  it('rejects install for a plain member', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.discoverManifest).not.toHaveBeenCalled();
  });

  it('returns 404 when no manifest is found', async () => {
    h.discoverManifest.mockResolvedValue(null);
    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', { grantScopes: ['program.launch'] }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
  });

  it('returns 422 manifest_invalid when the manifest fails validation', async () => {
    h.discoverManifest.mockRejectedValue(Object.assign(new Error('Invalid packageId'), {
      name: 'ProgramManifestError', code: 'invalid_field', field: 'packageId',
    }));
    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('manifest_invalid');
    expect(body.message).toBe('Invalid packageId');
  });

  it('returns 502 program_runtime_unreachable when discovery fails for a non-manifest reason', async () => {
    h.discoverManifest.mockRejectedValue(Object.assign(new Error('Collab runtime request failed (500)'), { status: 500 }));
    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('program_runtime_unreachable');
  });

  it('installs a published program by packageId+version and bumps installCount', async () => {
    h.getPublishedProgramVersion.mockResolvedValue({
      program: { id: 'pubprog', packageId: '@other/web', publisher: 'other' },
      version: { id: 'v1' },
      config: { packageId: 'web', version: '1.0.0', permissions: ['program.launch'] },
    });
    h.listPermissionGrants.mockResolvedValue([{ id: 'g0', scopes: ['program.launch'] }]);
    h.createInstall.mockResolvedValue({ id: 'inst2', version: '1.0.0', status: 'installed' });

    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { packageId: '@other/web', version: '1.0.0' }, 'POST'),
      ctx({ slug: 'team' }),
    );

    expect(res.status).toBe(200);
    expect(h.discoverManifest).not.toHaveBeenCalled();
    expect(h.createInstall).toHaveBeenCalledWith(expect.objectContaining({ programId: 'pubprog', version: '1.0.0', status: 'installed' }));
    expect(h.incrementInstallCount).toHaveBeenCalledWith('pubprog');
  });

  it('returns 404 when the published program/version is not found', async () => {
    h.getPublishedProgramVersion.mockResolvedValue(null);
    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { packageId: '@other/web', version: '9.9.9', grantScopes: ['program.launch'] }, 'POST'),
      ctx({ slug: 'team' }),
    );
    expect(res.status).toBe(404);
  });

  it('does not bump installCount for a local workspace-manifest install', async () => {
    h.discoverManifest.mockResolvedValue(manifest);
    h.listPermissionGrants.mockResolvedValue([{ id: 'g0', scopes: ['program.launch', 'network.outbound'] }]);
    h.upsertLocalProgram.mockResolvedValue({ program: { id: 'prog1', packageId: 'local:team:web', publisher: 'local' } });
    h.createInstall.mockResolvedValue({ id: 'inst1', version: '1.0.0', status: 'installed' });

    await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));
    expect(h.incrementInstallCount).not.toHaveBeenCalled();
  });
});

describe('POST /programs/[installId]/launch', () => {
  it('launches an install from its stored manifest for an owner/admin', async () => {
    h.getInstall.mockResolvedValue({ id: 'inst1', programId: 'prog1', workspaceSlug: 'team', version: '1.0.0' });
    h.getProgramVersion.mockResolvedValue({ manifestJson: JSON.stringify({ runtimeType: 'web', displayName: 'Web', launch: 'npm run dev', ports: [3000] }) });
    h.createProgramSession.mockResolvedValue({ id: 'ps1', workspaceSlug: 'team', runtimeType: 'web', state: 'starting' });
    h.launchInstalledProgram.mockResolvedValue({ sessionId: 'ps1', state: 'running', activePorts: [3000], webPort: 3000 });
    h.updateProgramSession.mockResolvedValue({ id: 'ps1', workspaceSlug: 'team', state: 'running' });

    const res = await POST_LAUNCH(req('http://x/api/workspace/team/programs/inst1/launch', {}, 'POST'), ctx({ slug: 'team', installId: 'inst1' }));

    expect(res.status).toBe(200);
    expect(h.launchInstalledProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', sessionId: 'ps1', userId: 'gh1' }));
    const body = await res.json();
    expect(body.session).toMatchObject({ id: 'ps1', state: 'running', activePorts: [3000], webPort: 3000 });
  });

  it('rejects launch for a plain member', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_LAUNCH(req('http://x/api/workspace/team/programs/inst1/launch', {}, 'POST'), ctx({ slug: 'team', installId: 'inst1' }));
    expect(res.status).toBe(403);
    expect(h.getInstall).not.toHaveBeenCalled();
  });

  it('returns 404 when the install is missing', async () => {
    h.getInstall.mockResolvedValue(null);
    const res = await POST_LAUNCH(req('http://x/api/workspace/team/programs/inst1/launch', {}, 'POST'), ctx({ slug: 'team', installId: 'inst1' }));
    expect(res.status).toBe(404);
  });
});

describe('POST /programs/scaffold', () => {
  it('scaffolds a known default into the workspace for an owner/admin', async () => {
    h.scaffoldProgram.mockResolvedValue({ written: ['package.json', 'app/page.js'], skipped: [] });
    const res = await POST_SCAFFOLD(
      req('http://x/api/workspace/team/programs/scaffold', { packageId: '@vectant/nextjs-dev' }, 'POST'),
      ctx({ slug: 'team' }),
    );
    expect(res.status).toBe(200);
    expect(h.scaffoldProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', userId: 'gh1' }));
    const passed = h.scaffoldProgram.mock.calls[0][0];
    expect(passed.files.some((f) => f.path === 'package.json')).toBe(true);
    const body = await res.json();
    expect(body.written).toContain('package.json');
  });

  it('rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_SCAFFOLD(req('http://x/api/workspace/team/programs/scaffold', { packageId: '@vectant/nextjs-dev' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.scaffoldProgram).not.toHaveBeenCalled();
  });

  it('returns 404 for a packageId with no scaffold template', async () => {
    const res = await POST_SCAFFOLD(req('http://x/api/workspace/team/programs/scaffold', { packageId: '@vectant/lazygit' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
    expect(h.scaffoldProgram).not.toHaveBeenCalled();
  });
});
