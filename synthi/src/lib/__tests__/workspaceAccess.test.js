import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findFirst = vi.fn();
const findUnique = vi.fn();
const getServerSession = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession,
}));

vi.mock('@/app/auth', () => ({
  authOptions: {},
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    workspace: {
      findFirst,
      findUnique,
    },
  },
}));

async function loadAccessModule() {
  return import('../workspaceAccess');
}

describe('workspaceAccess runtime authorization', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubEnv('COLLAB_SERVER_URL', 'http://collab.test');
    getServerSession.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'owner@example.test',
      },
    });
    findFirst.mockReset();
    findUnique.mockReset();
    fetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('keeps managed Prisma workspaces membership-gated', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'workspace-1',
      slug: 'managed-workspace',
      name: 'Managed workspace',
      memberships: [],
    });

    const { requireRuntimeWorkspaceAccess } = await loadAccessModule();
    const access = await requireRuntimeWorkspaceAccess('managed-workspace');

    expect(access).toMatchObject({
      ok: false,
      status: 404,
      error: 'Workspace not found',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows authenticated runtime access for DB-missing collab workspaces with files', async () => {
    findFirst.mockResolvedValueOnce(null);
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ files: [{ path: 'package.json' }] }),
    });

    const { requireRuntimeWorkspaceAccess } = await loadAccessModule();
    const access = await requireRuntimeWorkspaceAccess('collab-only-workspace');

    expect(access).toMatchObject({
      ok: true,
      email: 'owner@example.test',
      workspace: {
        id: 'collab-only-workspace',
        slug: 'collab-only-workspace',
        source: 'collab',
      },
      membership: {
        role: 'member',
        source: 'collab',
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://collab.test/git/collab-only-workspace/files-meta',
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-user-id': 'user-1' },
        cache: 'no-store',
      }),
    );
  });

  it('denies DB-missing runtime access when collab has no workspace files', async () => {
    findFirst.mockResolvedValueOnce(null);
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ files: [] }),
    });

    const { requireRuntimeWorkspaceAccess } = await loadAccessModule();
    const access = await requireRuntimeWorkspaceAccess('missing-workspace');

    expect(access).toMatchObject({
      ok: false,
      status: 404,
      error: 'Workspace not found',
    });
  });

  it('requires a membership for workspace access by id', async () => {
    findUnique.mockResolvedValueOnce({
      id: 'workspace-1',
      slug: 'team',
      name: 'Team',
      memberships: [],
    });

    const { requireWorkspaceAccessById } = await loadAccessModule();
    const access = await requireWorkspaceAccessById('workspace-1');

    expect(access).toMatchObject({
      ok: false,
      status: 404,
      error: 'Workspace not found',
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'workspace-1' },
      select: expect.objectContaining({
        id: true,
        slug: true,
        memberships: expect.objectContaining({
          where: { user: { email: 'owner@example.test' } },
        }),
      }),
    });
  });

  it('allows workspace manage access by id for owners and admins only', async () => {
    findUnique.mockResolvedValueOnce({
      id: 'workspace-1',
      slug: 'team',
      name: 'Team',
      memberships: [{ id: 'm1', role: 'owner' }],
    });

    const { requireWorkspaceManageAccessById } = await loadAccessModule();
    const access = await requireWorkspaceManageAccessById('workspace-1');

    expect(access).toMatchObject({
      ok: true,
      workspace: { id: 'workspace-1', slug: 'team' },
      membership: { role: 'owner' },
    });

    findUnique.mockResolvedValueOnce({
      id: 'workspace-1',
      slug: 'team',
      name: 'Team',
      memberships: [{ id: 'm2', role: 'member' }],
    });
    const denied = await requireWorkspaceManageAccessById('workspace-1');
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      error: 'Only workspace owners can manage this workspace',
    });
  });
});

// requireWorkspaceAccess() gates the file-tree and file-content routes
// (workspace/[slug]/route.js, workspace/[slug]/item/route.js). A collab
// guest never gets a Prisma WorkspaceMembership row, so without this
// fallback every one of those routes 404s for them regardless of what the
// host granted — see synthi/src/lib/collabGuestAccess.js.
describe('requireWorkspaceAccess collab-guest fallback', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubEnv('COLLAB_SERVER_URL', 'http://collab.test');
    vi.stubEnv('COLLAB_INTERNAL_TOKEN', 'shared-internal-secret');
    getServerSession.mockResolvedValue({
      user: { id: 'user-1', email: 'guest@example.test' },
    });
    findFirst.mockReset();
    fetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does not consult collab-server when a Prisma membership already exists', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'workspace-1',
      slug: 'team-workspace',
      name: 'Team',
      memberships: [{ id: 'm1', role: 'member' }],
    });

    const { requireWorkspaceAccess } = await loadAccessModule();
    const access = await requireWorkspaceAccess('team-workspace');

    expect(access).toMatchObject({ ok: true, membership: { role: 'member' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('404s without calling collab-server when the workspace itself does not exist', async () => {
    findFirst.mockResolvedValueOnce(null);

    const { requireWorkspaceAccess } = await loadAccessModule();
    const access = await requireWorkspaceAccess('nonexistent-workspace');

    expect(access).toMatchObject({ ok: false, status: 404, error: 'Workspace not found' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('grants a non-member real, permission-scoped access when they are an active collab guest', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'workspace-1',
      slug: 'team-workspace',
      name: 'Team',
      memberships: [],
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        role: 'guest',
        permissions: { canEdit: true, canFileOps: false, canTerminal: false, canGit: false },
      }),
    });

    const { requireWorkspaceAccess } = await loadAccessModule();
    const access = await requireWorkspaceAccess('team-workspace');

    expect(access).toMatchObject({
      ok: true,
      workspace: { slug: 'team-workspace' },
      membership: {
        role: 'collab-guest',
        collabPermissions: { canEdit: true, canFileOps: false },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetch.mock.calls[0];
    expect(String(calledUrl)).toBe('http://collab.test/session/workspace-access/user-1?slug=team-workspace');
    expect(calledInit).toMatchObject({
      method: 'GET',
      headers: { 'x-collab-internal-token': 'shared-internal-secret' },
      cache: 'no-store',
    });
  });

  it('still 404s a non-member with no active collab session for that workspace', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'workspace-1',
      slug: 'team-workspace',
      name: 'Team',
      memberships: [],
    });
    fetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const { requireWorkspaceAccess } = await loadAccessModule();
    const access = await requireWorkspaceAccess('team-workspace');

    expect(access).toMatchObject({ ok: false, status: 404, error: 'Workspace not found' });
  });

  it('fails closed (404, no throw) when the collab-server is unreachable', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'workspace-1',
      slug: 'team-workspace',
      name: 'Team',
      memberships: [],
    });
    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { requireWorkspaceAccess } = await loadAccessModule();
    const access = await requireWorkspaceAccess('team-workspace');

    expect(access).toMatchObject({ ok: false, status: 404, error: 'Workspace not found' });
  });
});
