import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  requireAccessById: vi.fn(),
  requireManageAccessById: vi.fn(),
  deleteFiles: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    workspace: {
      findUnique: h.findUnique,
      update: h.update,
      delete: h.delete,
    },
    user: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock('@/server/gcsStorage', () => ({
  createGcsStorage: () => ({
    bucket: () => ({
      deleteFiles: h.deleteFiles,
      file: () => ({ save: vi.fn() }),
    }),
  }),
  getGcsBucketName: () => 'test-bucket',
}));

vi.mock('@/lib/workspaceAccess', () => ({
  requireWorkspaceAccessById: h.requireAccessById,
  requireWorkspaceManageAccessById: h.requireManageAccessById,
}));

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/auth', () => ({ authOptions: {} }));

import { DELETE, GET, PUT } from '../route.js';

const req = (url, body = {}) => ({
  url,
  json: async () => body,
});

const workspace = { id: 'ws-db-id', slug: 'team-slug', name: 'Team' };
const memberAccess = {
  ok: true,
  workspace,
  membership: { id: 'm1', role: 'member' },
};
const ownerAccess = {
  ok: true,
  workspace,
  membership: { id: 'm1', role: 'owner' },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAccessById.mockResolvedValue(memberAccess);
  h.requireManageAccessById.mockResolvedValue(ownerAccess);
  h.findUnique.mockResolvedValue({ ...workspace, repoUrl: null });
  h.update.mockResolvedValue({ ...workspace, name: 'Renamed' });
  h.delete.mockResolvedValue(workspace);
  h.deleteFiles.mockResolvedValue([]);
});

describe('/api/workspace id route authorization', () => {
  it('rejects GET without authentication before reading the workspace', async () => {
    h.requireAccessById.mockResolvedValue({ ok: false, status: 401, error: 'Authentication required' });

    const res = await GET(req('http://localhost/api/workspace?id=ws-db-id'));

    expect(res.status).toBe(401);
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it('returns the workspace after member access is verified', async () => {
    const res = await GET(req('http://localhost/api/workspace?id=ws-db-id'));

    expect(res.status).toBe(200);
    expect(h.requireAccessById).toHaveBeenCalledWith('ws-db-id');
    expect(h.findUnique).toHaveBeenCalledWith({ where: { id: 'ws-db-id' } });
    expect(await res.json()).toMatchObject({ id: 'ws-db-id', slug: 'team-slug' });
  });

  it('rejects PUT for non-managers before updating', async () => {
    h.requireManageAccessById.mockResolvedValue({ ok: false, status: 403, error: 'Only workspace owners can manage this workspace' });

    const res = await PUT(req('http://localhost/api/workspace?id=ws-db-id', { name: 'Renamed' }));

    expect(res.status).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('allows workspace managers to rename a workspace', async () => {
    const res = await PUT(req('http://localhost/api/workspace?id=ws-db-id', { name: 'Renamed' }));

    expect(res.status).toBe(200);
    expect(h.requireManageAccessById).toHaveBeenCalledWith('ws-db-id');
    expect(h.update).toHaveBeenCalledWith({
      where: { id: 'ws-db-id' },
      data: { name: 'Renamed' },
    });
  });

  it('deletes GCS objects using the authorized workspace slug, not the query id', async () => {
    const res = await DELETE(req('http://localhost/api/workspace?id=ws-db-id'));

    expect(res.status).toBe(200);
    expect(h.requireManageAccessById).toHaveBeenCalledWith('ws-db-id');
    expect(h.deleteFiles).toHaveBeenCalledWith({
      prefix: 'workspaces/team-slug/',
      force: true,
    });
    expect(h.delete).toHaveBeenCalledWith({ where: { id: 'ws-db-id' } });
  });

  it('rejects DELETE for non-managers before GCS or Prisma deletion', async () => {
    h.requireManageAccessById.mockResolvedValue({ ok: false, status: 403, error: 'Only workspace owners can manage this workspace' });

    const res = await DELETE(req('http://localhost/api/workspace?id=ws-db-id'));

    expect(res.status).toBe(403);
    expect(h.deleteFiles).not.toHaveBeenCalled();
    expect(h.delete).not.toHaveBeenCalled();
  });
});
