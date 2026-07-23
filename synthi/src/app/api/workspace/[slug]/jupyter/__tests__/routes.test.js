import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ actor: vi.fn(), read: vi.fn(), write: vi.fn(), list: vi.fn(), create: vi.fn(), resolve: vi.fn(), clientGet: vi.fn(), clientSave: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.read, canWriteScope: h.write }));
vi.mock('@/lib/jupyter/registry', () => ({ listJupyterServers: h.list, createJupyterServer: h.create, resolveJupyterServer: h.resolve }));
vi.mock('@/lib/jupyter/audit', () => ({ recordJupyterAudit: h.audit }));
vi.mock('@/lib/jupyter/client', () => ({ JupyterClient: class { getNotebook(...args) { return h.clientGet(...args); } saveNotebook(...args) { return h.clientSave(...args); } } }));

import { GET as listServers, POST as createServer } from '../servers/route.js';
import { GET as snapshot } from '../snapshot/route.js';
import { POST as save } from '../save/route.js';

const ctx = { params: Promise.resolve({ slug: 'team' }) };
const request = (url, body = {}) => ({ url, json: async () => body, signal: new AbortController().signal });
beforeEach(() => { vi.clearAllMocks(); h.actor.mockResolvedValue({ userId: 'user-1' }); h.read.mockResolvedValue(true); h.write.mockResolvedValue(true); h.resolve.mockResolvedValue({ id: 'server-1', origin: 'https://jupyter.test', token: null }); h.clientGet.mockResolvedValue({ type: 'notebook', content: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }, last_modified: 'rev-1' }); h.clientSave.mockResolvedValue({ last_modified: 'rev-2' }); });

describe('Jupyter workspace routes', () => {
  it('does not expose workspace servers to non-members', async () => { h.read.mockResolvedValue(false); const response = await listServers(request('http://app/api/workspace/team/jupyter/servers'), ctx); expect(response.status).toBe(403); expect(h.list).not.toHaveBeenCalled(); });
  it('creates a registration only after workspace write authorization', async () => { h.create.mockResolvedValue({ id: 'server-1', name: 'Research' }); const response = await createServer(request('http://app/api/workspace/team/jupyter/servers', { name: 'Research', origin: 'https://jupyter.test', token: 'secret' }), ctx); expect(response.status).toBe(201); expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', token: 'secret' })); expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'connection_created' })); });
  it('does not fetch a notebook from an unavailable or cross-workspace server', async () => { h.resolve.mockResolvedValue(null); const response = await snapshot(request('http://app/api/workspace/team/jupyter/snapshot?serverId=other&path=a.ipynb'), ctx); expect(response.status).toBe(404); expect(h.clientGet).not.toHaveBeenCalled(); });
  it('refuses a stale server revision before saving', async () => { h.clientGet.mockResolvedValue({ type: 'notebook', content: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }, last_modified: 'server-new' }); const response = await save(request('http://app/api/workspace/team/jupyter/save', { serverId: 'server-1', path: 'a.ipynb', notebook: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }, expectedServerRevision: 'old' }), ctx); expect(response.status).toBe(409); expect(h.clientSave).not.toHaveBeenCalled(); });
});
