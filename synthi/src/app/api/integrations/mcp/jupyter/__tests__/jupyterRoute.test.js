import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  auth: vi.fn(), read: vi.fn(), write: vi.fn(), list: vi.fn(), resolve: vi.fn(), audit: vi.fn(),
  status: vi.fn(), getNotebook: vi.fn(), connect: vi.fn(), execute: vi.fn(), saveNotebook: vi.fn(), interrupt: vi.fn(), restart: vi.fn(),
}));

vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.auth }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.read, canWriteScope: h.write }));
vi.mock('@/lib/jupyter/registry', () => ({ listJupyterServers: h.list, resolveJupyterServer: h.resolve }));
vi.mock('@/lib/jupyter/audit', () => ({ recordJupyterAudit: h.audit }));
vi.mock('@/lib/jupyter/client', () => ({ JupyterClient: class {
  status(...args) { return h.status(...args); }
  getNotebook(...args) { return h.getNotebook(...args); }
  connectKernel(...args) { return h.connect(...args); }
  execute(...args) { return h.execute(...args); }
  saveNotebook(...args) { return h.saveNotebook(...args); }
  interruptKernel(...args) { return h.interrupt(...args); }
  restartKernel(...args) { return h.restart(...args); }
} }));

import { GET, POST } from '../route.js';

function request(url, body) {
  return { url, signal: new AbortController().signal, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ userId: 'u1' }); h.read.mockResolvedValue(true); h.write.mockResolvedValue(true);
  h.list.mockResolvedValue([{ id: 'server-1', hasToken: true }]);
  h.resolve.mockResolvedValue({ id: 'server-1', origin: 'https://jupyter.test', token: 'never-returned' });
  h.status.mockResolvedValue({ started: '2026-01-01', last_activity: '2026-01-02' });
  h.getNotebook.mockResolvedValue({ content: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }, last_modified: 'r1' });
  h.connect.mockResolvedValue({ kernel: { id: 'kernel-1' } }); h.execute.mockResolvedValue({ outputs: [], executionState: 'idle' });
  h.saveNotebook.mockResolvedValue({ last_modified: 'r2' }); h.restart.mockResolvedValue({ id: 'kernel-1' });
});

describe('PAT-gated MCP Jupyter bridge', () => {
  it('lists public server metadata for a read-authorized workspace member', async () => {
    const result = await GET(request('http://app/api/integrations/mcp/jupyter?workspaceSlug=team'));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ servers: [{ id: 'server-1', hasToken: true }] });
    expect(h.list).toHaveBeenCalledWith('team');
  });

  it('rejects unauthenticated callers before touching a Jupyter server', async () => {
    h.auth.mockResolvedValue(null);
    const result = await POST(request('http://app/api/integrations/mcp/jupyter', { operation: 'execute', workspaceSlug: 'team', serverId: 'server-1', path: 'a.ipynb', code: '1' }));
    expect(result.status).toBe(401);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('uses read scope for snapshots and records a redacted audit event', async () => {
    const result = await GET(request('http://app/api/integrations/mcp/jupyter?operation=snapshot&workspaceSlug=team&serverId=server-1&path=a.ipynb'));
    expect(result.status).toBe(200);
    expect(h.getNotebook).toHaveBeenCalledWith('a.ipynb', expect.anything());
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'notebook_read', details: expect.objectContaining({ via: 'mcp' }) }));
  });

  it('requires write authorization for execution', async () => {
    h.write.mockResolvedValue(false);
    const result = await POST(request('http://app/api/integrations/mcp/jupyter', { operation: 'execute', workspaceSlug: 'team', serverId: 'server-1', path: 'a.ipynb', code: 'print(1)' }));
    expect(result.status).toBe(403);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('executes a notebook cell and scopes the audit to the returned kernel', async () => {
    const result = await POST(request('http://app/api/integrations/mcp/jupyter', { operation: 'execute', workspaceSlug: 'team', serverId: 'server-1', path: 'a.ipynb', code: 'print(1)' }));
    expect(result.status).toBe(200);
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ipynb' }));
    expect(h.execute).toHaveBeenCalledWith(expect.objectContaining({ kernelId: 'kernel-1', code: 'print(1)' }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'cell_executed', kernelId: 'kernel-1' }));
  });

  it('refuses a stale notebook revision before save', async () => {
    h.getNotebook.mockResolvedValue({ content: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }, last_modified: 'newer' });
    const result = await POST(request('http://app/api/integrations/mcp/jupyter', { operation: 'save', workspaceSlug: 'team', serverId: 'server-1', path: 'a.ipynb', expectedServerRevision: 'old', notebook: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] } }));
    expect(result.status).toBe(409);
    expect(h.saveNotebook).not.toHaveBeenCalled();
  });

  it('interrupts only a server-scoped known kernel', async () => {
    const result = await POST(request('http://app/api/integrations/mcp/jupyter', { operation: 'interrupt', workspaceSlug: 'team', serverId: 'server-1', kernelId: 'kernel-1', path: 'a.ipynb' }));
    expect(result.status).toBe(200);
    expect(h.interrupt).toHaveBeenCalledWith('kernel-1', expect.anything());
  });
});
