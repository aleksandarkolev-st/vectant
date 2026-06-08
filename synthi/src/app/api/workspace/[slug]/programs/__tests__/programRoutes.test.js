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
  createProgramSession: vi.fn(),
  updateProgramSession: vi.fn(),
  appendProgramRuntimeEvent: vi.fn(),
  discoverManifest: vi.fn(),
  launchInstalledProgram: vi.fn(),
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
  // Real-ish projection so the install route can return a public install.
  toPublicInstall: (row) =>
    row
      ? { id: row.id, version: row.version, status: row.status, packageId: row.program?.packageId ?? null, publisher: row.program?.publisher ?? null }
      : row,
}));
vi.mock('@/lib/programs/runtimeClient', () => ({
  discoverManifest: h.discoverManifest,
  launchInstalledProgram: h.launchInstalledProgram,
}));

import { GET as GET_MARKETPLACE } from '../marketplace/route.js';
import { GET as GET_INSTALLED } from '../installed/route.js';
import { POST as POST_INSTALL } from '../install/route.js';
import { POST as POST_LAUNCH } from '../[installId]/launch/route.js';

const req = (url, body, method = 'GET') => ({ url, method, json: async () => body });
const ctx = (params) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c' });
  h.canRead.mockResolvedValue(true);
  h.canWrite.mockResolvedValue(true);
  h.listPermissionGrants.mockResolvedValue([]);
  h.appendProgramRuntimeEvent.mockResolvedValue({ id: 'evt-1' });
});

describe('GET /programs/marketplace', () => {
  it('lists local programs for a member', async () => {
    h.listLocalPrograms.mockResolvedValue([
      { id: 'prog1', packageId: 'local:team:web', publisher: 'local', verified: false, latestVersion: '1.0.0' },
    ]);

    const res = await GET_MARKETPLACE(req('http://x/api/workspace/team/programs/marketplace'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.programs[0]).toMatchObject({ packageId: 'local:team:web', publisher: 'local' });
  });

  it('rejects a non-member', async () => {
    h.canRead.mockResolvedValue(false);
    const res = await GET_MARKETPLACE(req('http://x/api/workspace/team/programs/marketplace'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.listLocalPrograms).not.toHaveBeenCalled();
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
    // Per-user repos require the actor's userId to resolve the workspace cwd.
    expect(h.discoverManifest).toHaveBeenCalledWith('team', 'u1');
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
    expect(h.launchInstalledProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', sessionId: 'ps1' }));
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
