import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireAccess: vi.fn(),
  bucket: vi.fn(),
  file: vi.fn(),
  getFiles: vi.fn(),
  exists: vi.fn(),
  getMetadata: vi.fn(),
  createReadStream: vi.fn(),
  save: vi.fn(),
  move: vi.fn(),
  deleteFile: vi.fn(),
  createWriteStream: vi.fn(),
}));

vi.mock('@/lib/workspaceAccess', () => ({
  requireWorkspaceAccess: h.requireAccess,
}));

vi.mock('@/server/gcsStorage', () => ({
  createGcsStorage: () => ({ bucket: h.bucket }),
  getGcsBucketName: () => 'test-bucket',
}));

import { DELETE, GET, POST, PUT } from '../route.js';

const ctx = (slug = 'route-slug') => ({ params: Promise.resolve({ slug }) });

function request(url, { body = {}, form = null, headers = {} } = {}) {
  return {
    url,
    nextUrl: new URL(url),
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    json: async () => body,
    formData: async () => form,
    body: {
      pipeTo: vi.fn(async () => undefined),
    },
  };
}

function form(values) {
  return {
    get: (name) => values[name],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAccess.mockResolvedValue({
    ok: true,
    workspace: { id: 'ws1', slug: 'canonical-slug', name: 'Team' },
    membership: { id: 'm1', role: 'member' },
  });
  h.bucket.mockReturnValue({
    file: h.file,
    getFiles: h.getFiles,
  });
  h.file.mockImplementation((name) => ({
    name,
    exists: h.exists,
    getMetadata: h.getMetadata,
    createReadStream: h.createReadStream,
    save: h.save,
    move: h.move,
    delete: h.deleteFile,
    createWriteStream: h.createWriteStream,
  }));
  h.exists.mockResolvedValue([false]);
  h.getMetadata.mockResolvedValue([{ contentType: 'text/plain', size: '2' }]);
  h.save.mockResolvedValue(undefined);
  h.move.mockResolvedValue(undefined);
  h.deleteFile.mockResolvedValue(undefined);
  h.getFiles.mockResolvedValue([[]]);
});

describe('/api/workspace/[slug]/item authorization and path safety', () => {
  it('rejects unauthenticated GET before touching GCS', async () => {
    h.requireAccess.mockResolvedValue({ ok: false, status: 401, error: 'Authentication required' });

    const res = await GET(request('http://x/api/workspace/route-slug/item?filePath=src/app.js'), ctx());

    expect(res.status).toBe(401);
    expect(h.file).not.toHaveBeenCalled();
  });

  it('uses the authorized workspace slug for GET paths', async () => {
    const res = await GET(request('http://x/api/workspace/route-slug/item?filePath=src/app.js'), ctx());

    expect(res.status).toBe(404);
    expect(h.file).toHaveBeenCalledWith('workspaces/canonical-slug/src/app.js');
  });

  it('rejects traversal paths before creating GCS objects', async () => {
    const res = await POST(
      request('http://x/api/workspace/route-slug/item', {
        form: form({ filePath: '../secret.txt', file: { stream: vi.fn() } }),
      }),
      ctx(),
    );

    expect(res.status).toBe(400);
    expect(h.file).not.toHaveBeenCalled();
  });

  it('creates folder markers under the authorized workspace slug', async () => {
    const res = await POST(
      request('http://x/api/workspace/route-slug/item', {
        form: form({ filePath: 'docs/' }),
      }),
      ctx(),
    );

    expect(res.status).toBe(201);
    expect(h.file).toHaveBeenCalledWith('workspaces/canonical-slug/docs/');
    expect(h.save).toHaveBeenCalledWith('', expect.objectContaining({
      contentType: 'application/x-directory',
      resumable: false,
    }));
  });

  it('renames files within the authorized workspace slug', async () => {
    h.exists.mockResolvedValue([true]);

    const res = await PUT(
      request('http://x/api/workspace/route-slug/item', {
        body: { itemPath: 'src/old.js', newPath: 'src/new.js' },
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(h.file).toHaveBeenCalledWith('workspaces/canonical-slug/src/old.js');
    expect(h.move).toHaveBeenCalledWith('workspaces/canonical-slug/src/new.js');
  });

  it('deletes folders with a contained trailing-slash prefix', async () => {
    const deleted = { name: 'workspaces/canonical-slug/docs/a.txt', delete: vi.fn() };
    h.getFiles.mockResolvedValue([[deleted]]);

    const res = await DELETE(
      request('http://x/api/workspace/route-slug/item', {
        body: { itemPath: 'docs/' },
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(h.getFiles).toHaveBeenCalledWith({ prefix: 'workspaces/canonical-slug/docs/' });
    expect(deleted.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('rejects unauthorized DELETE before reading request body or touching GCS', async () => {
    const json = vi.fn(async () => ({ itemPath: 'src/app.js' }));
    h.requireAccess.mockResolvedValue({ ok: false, status: 404, error: 'Workspace not found' });

    const res = await DELETE({ ...request('http://x/api/workspace/route-slug/item'), json }, ctx());

    expect(res.status).toBe(404);
    expect(json).not.toHaveBeenCalled();
    expect(h.file).not.toHaveBeenCalled();
  });
});
