import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findFirst = vi.fn();
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
});
